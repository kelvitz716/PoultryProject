const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { handleE2ETestSeedFailure } = require('../../services/e2e-test-seed-policy');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function request(baseUrl, pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let json = null;
    try { json = await response.json(); } catch (_) { json = null; }
    const setCookie = response.headers.get('set-cookie') || '';
    return { status: response.status, json, cookie: setCookie.split(';')[0] || null, setCookie };
}

async function waitForServer(baseUrl, child, getOutput = () => '') {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Disposable server stopped before accepting requests: ${getOutput()}`);
        try {
            const result = await request(baseUrl, '/api/auth/me');
            if (result.status === 200) return result;
        } catch (_) { /* server is still starting */ }
        await wait(50);
    }
    throw new Error('Disposable server did not start in time');
}

function copyDisposableProject(target) {
    fs.cpSync(root, target, {
        recursive: true,
        filter(source) {
            const relative = path.relative(root, source);
            return !['.git', 'data', '.env'].includes(relative)
                && !relative.startsWith(`.git${path.sep}`)
                && !relative.startsWith(`data${path.sep}`);
        }
    });
}

test('production startup keeps E2E seeding optional and registers the release migrations in dependency order', () => {
    const server = read('server.js');
    const db = read('db.js');
    assert.doesNotMatch(server, /E2E_TEST_PASSWORD environment variable is required/);
    const migrations = [
        'migrateCustomerSettlement(db)',
        'migratePaymentImports(db)',
        'migrateLedgerMinorUnits(db)',
        'migrateManualCustomerReceipts(db)',
        'migrateCustomerCreditNotes(db)',
        'migrateCustomerRefunds(db)'
    ];
    let previous = -1;
    for (const migration of migrations) {
        const current = db.indexOf(migration);
        assert.ok(current > previous, `${migration} must follow its prerequisite migration`);
        previous = current;
    }
});

test('E2E seed failure policy preserves the original error and only suppresses it in production', () => {
    const original = new Error('seed write failed');
    const logged = [];
    const logger = { error: (...args) => logged.push(args) };
    assert.throws(() => handleE2ETestSeedFailure(original, { isProduction: false, logger }), error => error === original);
    assert.doesNotThrow(() => handleE2ETestSeedFailure(original, { isProduction: true, logger }));
    assert.equal(logged.length, 2);
    assert.equal(logged[0][1], 'seed write failed');
});

test('production server and browser wire every bounded payment and settlement surface', () => {
    const server = read('server.js');
    const app = read('js/app.js');
    const timeline = read('js/customer-settlement-timeline.js');
    const webhook = server.indexOf('registerPaymentImportWebhook(app');
    const json = server.indexOf('app.use(express.json');
    assert.ok(webhook >= 0 && webhook < json, 'webhook must preserve raw bytes before JSON parsing');
    for (const registration of [
        'registerPaymentImportApi(app',
        'registerManualCustomerReceiptApi(app',
        'registerCustomerSettlementApi(app',
        'registerCustomerReconciliationSuggestionsApi(app',
        'registerCustomerCreditNoteApi(app',
        'registerCustomerRefundApi(app',
        'registerCustomerRegistryApi(app',
        'registerLegacyCustomerBootstrapApi(app',
        'registerTransactionPersistenceApi(app',
        'registerBatchClosureApi(app',
        'registerBatchTransferApi(app'
    ]) assert.ok(server.includes(registration), `${registration} must be registered`);
    assert.match(app, /initPaymentInboxView\(\);/);
    assert.match(app, /initCustomerSettlementTimelineView\(\);/);
    assert.match(app, /viewId === 'payment-inbox'\) loadPaymentInbox\(\);/);
    assert.match(app, /viewId === 'customer-accounts'\) loadCustomerSettlementTimeline\(\);/);
    assert.match(timeline, /refundPending/);
    assert.match(timeline, /creditNotePending/);
    assert.match(timeline, /allocationPending/);
    assert.match(timeline, /receiptPending/);
});

test('production deployment is private-by-default and accepts sessions only through its HTTPS proxy', () => {
    const server = read('server.js');
    const compose = read('docker-compose.yml');
    const deploy = read('deploy.sh');
    assert.match(compose, /127\.0\.0\.1:8089:80/);
    assert.match(compose, /NODE_ENV:\s*production/);
    assert.match(compose, /HOST:\s*0\.0\.0\.0/);
    assert.match(compose, /IMAGE_REF: \$\{IMAGE_REF:\?IMAGE_REF must be an immutable/);
    assert.match(server, /app\.set\('trust proxy', 1\)/);
    assert.match(server, /secure:\s*isProduction/);
    assert.match(server, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1'/);
    assert.match(deploy, /tailscale funnel reset/);
    assert.match(deploy, /tailscale serve --bg --https=443 --set-path=\/ http:\/\/127\.0\.0\.1:8089/);
    assert.doesNotMatch(deploy, /tailscale funnel --bg on/);
});

test('production releases pin the exact CI-built image digest and serialize deployment', () => {
    const server = read('server.js');
    const compose = read('docker-compose.yml');
    const deploy = read('deploy.sh');
    const workflow = read('.github/workflows/deploy.yml');
    assert.match(compose, /image:\s*\$\{IMAGE_REF:\?IMAGE_REF must be an immutable/);
    assert.doesNotMatch(compose, /:latest/);
    assert.match(workflow, /concurrency:\s*[\s\S]*group: poultry-dss-production/);
    assert.match(workflow, /image_digest: \$\{\{ steps\.build_image\.outputs\.digest \}\}/);
    assert.match(workflow, /IMAGE_REF: \$\{\{ format\('\{0\}@\{1\}', env\.IMAGE, needs\.build\.outputs\.image_digest\) \}\}/);
    assert.match(workflow, /envs: IMAGE_REF/);
    assert.match(workflow, /source: docker-compose\.yml,deploy\.sh/);
    assert.match(workflow, /IMAGE_REF="\$IMAGE_REF" bash deploy\.sh/);
    assert.doesNotMatch(workflow, /:latest/);
    assert.match(deploy, /IMAGE_REF is required and must be an immutable image digest/);
    assert.match(deploy, /sha256:\[a-f0-9\]\{64\}/);
    assert.match(server, /PRODUCTION_IMAGE_REF/);
    assert.match(deploy, /docker pull "\$IMAGE_REF"/);
    assert.match(deploy, /docker compose up --no-build --pull never -d --force-recreate poultry-dss/);
    assert.match(deploy, /docker image inspect --format '\{\{\.Id\}\}'/);
    assert.match(deploy, /docker inspect --format '\{\{\.Image\}\}' poultry-dss/);
    assert.match(deploy, /rollback_previous\(\)/);
    assert.match(deploy, /wait_for_healthy\(\)/);
    assert.doesNotMatch(deploy, /up --build/);
});

test('production container and SQLite data mount run with least privilege', () => {
    const dockerfile = read('Dockerfile');
    const compose = read('docker-compose.yml');
    const deploy = read('deploy.sh');
    const workflow = read('.github/workflows/deploy.yml');
    assert.match(dockerfile, /EXPOSE 8080/);
    assert.match(dockerfile, /USER node/);
    assert.match(dockerfile, /COPY --chown=node:node/);
    assert.match(compose, /127\.0\.0\.1:8089:8080/);
    assert.match(compose, /user: "\$\{PUID:-1000\}:\$\{PGID:-1000\}"/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(compose, /tmpfs:\s*\n\s*- \/tmp:mode=1777,noexec,nosuid,nodev,size=64m/);
    assert.match(compose, /\.\/data:\/app\/data:Z/);
    assert.match(compose, /PORT: 8080/);
    assert.match(deploy, /umask 077/);
    assert.match(deploy, /export PUID="\$\(id -u\)"/);
    assert.match(deploy, /docker stop poultry-dss/);
    assert.match(deploy, /docker run --rm --network none --user 0:0/);
    assert.doesNotMatch(deploy, /chmod 777/);
    assert.match(workflow, /source: docker-compose\.yml,deploy\.sh/);
    assert.match(workflow, /IMAGE_REF="\$IMAGE_REF" bash deploy\.sh/);
});

test('disposable real-server smoke starts without E2E credentials and reaches authenticated release routes safely', async t => {
    const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-release-smoke-'));
    const appDir = path.join(disposableRoot, 'app');
    const port = 33000 + Math.floor(Math.random() * 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    copyDisposableProject(appDir);
    const environment = { ...process.env, PORT: String(port), NODE_ENV: 'production', IMAGE_REF: `ghcr.io/kelvitz716/poultryproject@sha256:${'a'.repeat(64)}`, SESSION_SECRET: 'release-smoke-session-secret-0123456789' };
    delete environment.E2E_TEST_PASSWORD;
    const child = spawn(process.execPath, ['server.js'], { cwd: appDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    t.after(async () => {
        if (child.exitCode === null) {
            await new Promise(resolve => {
                child.once('exit', resolve);
                child.kill('SIGTERM');
            });
        }
        fs.rmSync(disposableRoot, { recursive: true, force: true });
    });

    const health = await waitForServer(baseUrl, child, () => output);
    assert.deepEqual(health.json, { setupRequired: true });
    const staticPage = await fetch(`${baseUrl}/`);
    assert.equal(staticPage.status, 200);
    assert.match(await staticPage.text(), /Poultry DSS/);
    assert.equal((await request(baseUrl, '/api/payment-imports?limit=1')).status, 401);

    const setup = await request(baseUrl, '/api/auth/setup', {
        method: 'POST', body: { username: 'smoke-admin', password: 'SmokePass123!' }, headers: { 'X-Forwarded-Proto': 'https' }
    });
    assert.equal(setup.status, 200);
    assert.equal(setup.json?.user?.role, 'super_admin');
    assert.ok(setup.cookie);
    assert.match(setup.setCookie, /; Secure(?:;|$)/);
    const directHttpLogin = await request(baseUrl, '/api/auth/login', {
        method: 'POST', body: { username: 'smoke-admin', password: 'SmokePass123!' }
    });
    assert.equal(directHttpLogin.status, 200);
    assert.equal(directHttpLogin.cookie, null, 'direct HTTP must not establish a production session');
    const cookie = setup.cookie;
    assert.equal((await request(baseUrl, '/api/auth/me', { cookie })).json?.user?.role, 'super_admin');
    const unsafeUsername = await request(baseUrl, '/api/auth/users', {
        method: 'POST', cookie,
        body: { username: '<img src=x onerror=alert(1)>', password: 'UnsafeUserPass123!', role: 'viewer' }
    });
    assert.equal(unsafeUsername.status, 400, 'stored markup must not enter the user registry');

    for (const [username, mutation] of [
        ['session-password', { pathname: 'password', body: { password: 'UpdatedPass123!' } }],
        ['session-role', { pathname: 'role', body: { role: 'farmer' } }],
        ['session-active', { pathname: 'active', body: { isActive: false } }]
    ]) {
        const created = await request(baseUrl, '/api/auth/users', {
            method: 'POST', cookie,
            body: { username, password: 'SessionVictimPass123!', role: 'viewer' }
        });
        assert.equal(created.status, 200);
        const victim = await request(baseUrl, '/api/auth/login', {
            method: 'POST', body: { username, password: 'SessionVictimPass123!' }, headers: { 'X-Forwarded-Proto': 'https' }
        });
        assert.ok(victim.cookie);
        assert.equal((await request(baseUrl, '/api/auth/me', { cookie: victim.cookie })).json?.user?.id, created.json?.user?.id);
        const changed = await request(baseUrl, `/api/auth/users/${created.json.user.id}/${mutation.pathname}`, {
            method: 'PUT', cookie, body: mutation.body
        });
        assert.equal(changed.status, 200);
        assert.equal((await request(baseUrl, '/api/auth/me', { cookie: victim.cookie })).json?.user, null, `${mutation.pathname} must revoke the previous session`);
    }

    assert.equal((await request(baseUrl, '/api/batches', {
        method: 'POST', cookie,
        body: { id: 'smoke-closed-bypass', status: 'completed', cohort_id: 'cohort:smoke', location_id: 'house:smoke' }
    })).status, 400);
    assert.equal((await request(baseUrl, '/api/batches', {
        method: 'POST', cookie,
        body: { id: 'smoke-close', status: 'post_batch', cohort_id: 'cohort:smoke', location_id: 'house:smoke' }
    })).status, 200);
    const closure = await request(baseUrl, '/api/batches/smoke-close/close', { method: 'POST', cookie, body: {} });
    assert.equal(closure.status, 201);
    assert.equal(closure.json?.batch?.closure_review?.status, 'exact');
    assert.equal(closure.json?.batch?.closure_review?.reviewed_by_user_id, setup.json?.user?.id);
    assert.equal((await request(baseUrl, '/api/batches', {
        method: 'POST', cookie,
        body: { id: 'smoke-transfer', status: 'active', cohort_id: 'cohort:transfer', location_id: 'house:a', size: 20, stats: { birdsAlive: 20 } }
    })).status, 200);
    const transfer = await request(baseUrl, '/api/batches/smoke-transfer/transfers', {
        method: 'POST', cookie,
        body: { source_location_id: 'house:a', destination_location_id: 'house:b', transfer_date: '2026-09-19', quantity: 5, reason: 'Separate flock groups.', idempotency_key: 'smoke-transfer-001' }
    });
    assert.equal(transfer.status, 201);
    assert.equal(transfer.json?.transfer?.created_by_user_id, setup.json?.user?.id);

    const customer = await request(baseUrl, '/api/customers', {
        method: 'POST', cookie,
        body: { display_name: 'Smoke Customer', payment_terms_days: 30, contact_phone: '0712345678', idempotency_key: 'smoke-customer-create-001' }
    });
    assert.equal(customer.status, 201);
    const customerId = customer.json?.customer?.id;
    assert.match(customerId, /^customer:/);

    const receipt = await request(baseUrl, '/api/customer-receipts/manual', {
        method: 'POST', cookie,
        body: { customer_id: customerId, method: 'cash', amount: '10.12', external_reference: null, idempotency_key: 'smoke-receipt-cash-001' }
    });
    assert.equal(receipt.status, 201);
    assert.equal(receipt.json?.receipt?.amount_minor, 1012);
    const refund = await request(baseUrl, '/api/customer-refunds', {
        method: 'POST', cookie,
        body: {
            customer_id: customerId,
            method: 'cash',
            amount: '0.07',
            sources: [{ credit_event_id: receipt.json.customer_account_event_id, amount: '0.07' }],
            reason_code: 'overpayment',
            external_reference: null,
            acknowledge_method_difference: false,
            idempotency_key: 'smoke-refund-001'
        }
    });
    assert.equal(refund.status, 201);
    assert.equal(refund.json?.amount_minor, 7);

    const settlement = await request(baseUrl, `/api/customers/${encodeURIComponent(customerId)}/settlement`, { cookie });
    const suggestions = await request(baseUrl, `/api/customers/${encodeURIComponent(customerId)}/reconciliation-suggestions?limit=5`, { cookie });
    const accounts = await request(baseUrl, '/api/ledger/accounts', { cookie });
    assert.equal(settlement.status, 200);
    assert.equal(settlement.json?.status, 'exact');
    assert.equal(suggestions.status, 200);
    assert.equal(suggestions.json?.status, 'exact');
    assert.equal(accounts.status, 200);
    assert.ok(accounts.json?.some(account => account.code === '1020' && account.status === 'exact'));

    const paymentImport = await request(baseUrl, '/api/payment-imports/manual', {
        method: 'POST', cookie,
        body: { text: 'SMK1234XYZ Confirmed. Ksh20 received from SMOKE BUYER 0712345678 on 6/9/26 at 10:30 AM.', sender: 'MPESA' }
    });
    assert.equal(paymentImport.status, 201);
    assert.equal(Object.hasOwn(paymentImport.json?.payment_import || {}, 'text'), false);
    const importId = paymentImport.json?.payment_import?.id;
    assert.match(importId, /^[0-9a-f-]{36}$/i);
    const approval = await request(baseUrl, `/api/payment-imports/${encodeURIComponent(importId)}/approve`, {
        method: 'POST', cookie, body: { customer_id: customerId }
    });
    assert.equal(approval.status, 200);
    assert.equal(approval.json?.payment_import?.status, 'approved');

    const rejectableImport = await request(baseUrl, '/api/payment-imports/manual', {
        method: 'POST', cookie, body: { text: 'not a payment message', sender: 'MPESA' }
    });
    assert.equal(rejectableImport.status, 201);
    const rejection = await request(baseUrl, `/api/payment-imports/${encodeURIComponent(rejectableImport.json?.payment_import?.id)}/reject`, {
        method: 'POST', cookie, body: { review_notes: null }
    });
    assert.equal(rejection.status, 200);
    assert.equal(rejection.json?.payment_import?.status, 'rejected');

    assert.equal((await request(baseUrl, '/api/customer-credit-notes', {
        method: 'POST', cookie,
        body: { customer_id: customerId, invoice_event_id: 'invoice:missing', amount: '1.00', reason_code: 'other', idempotency_key: 'smoke-credit-note-001' }
    })).status, 404);
    assert.equal((await request(baseUrl, '/api/customer-settlement/allocations', {
        method: 'POST', cookie,
        body: { credit_event_id: receipt.json.customer_account_event_id, debit_event_id: 'invoice:missing', amount: '1.00', idempotency_key: 'smoke-allocation-001' }
    })).status, 404);
    assert.equal((await request(baseUrl, '/api/payment-imports/webhook', {
        method: 'POST', body: { from: 'MPESA', text: 'x' }
    })).status, 503);
    assert.equal(child.exitCode, null, output);
});
