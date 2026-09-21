const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const {
    LEGACY_DARAJA_ENTITY_KEYS,
    isLegacyDarajaEntityKey
} = require('../../services/legacy-daraja-credentials');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filename, error => {
            if (error) reject(error);
            else resolve(database);
        });
    });
}

function run(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function all(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows);
        });
    });
}

function closeDatabase(database) {
    return new Promise((resolve, reject) => {
        database.close(error => error ? reject(error) : resolve());
    });
}

async function request(baseUrl, pathname, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON response */ }
    return {
        status: response.status,
        json,
        text,
        cookie: response.headers.get('set-cookie')?.split(';')[0] || null
    };
}

async function waitForServer(baseUrl, child, readOutput) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`Disposable server stopped during startup:\n${readOutput()}`);
        }
        try {
            const result = await request(baseUrl, '/api/auth/me');
            if (result.status === 200) return;
        } catch (_) { /* server is still starting */ }
        await wait(50);
    }
    throw new Error(`Disposable server did not start in time:\n${readOutput()}`);
}

function copyDisposableProject(target) {
    fs.cpSync(root, target, {
        recursive: true,
        filter(source) {
            const relative = path.relative(root, source);
            return !['.git', '.env', 'data', 'evidence'].includes(relative)
                && !relative.startsWith(`.git${path.sep}`)
                && !relative.startsWith(`data${path.sep}`)
                && !relative.startsWith(`evidence${path.sep}`);
        }
    });
}

async function seedLegacyDatabase(filename) {
    const database = await openDatabase(filename);
    try {
        await run(database, `
            CREATE TABLE entities (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(database, `
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                created_by TEXT,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        const passwordHash = await bcrypt.hash('LegacyTestPass123!', 4);
        for (const role of ['super_admin', 'admin', 'farmer', 'viewer']) {
            await run(
                database,
                'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
                [`legacy-${role}`, `legacy-${role}`, passwordHash, role]
            );
        }
        for (const [index, key] of LEGACY_DARAJA_ENTITY_KEYS.entries()) {
            await run(database, 'INSERT INTO entities (key, value) VALUES (?, ?)', [key, JSON.stringify(`legacy-secret-${index}`)]);
        }
        await run(database, 'INSERT INTO entities (key, value) VALUES (?, ?)', ['farm_name', JSON.stringify('Legacy Farm')]);
    } finally {
        await closeDatabase(database);
    }
}

test('Daraja callback and callback-only reconciliation surfaces remain removed', () => {
    const server = read('server.js');
    const api = read('js/api.js');
    const settings = read('js/settings.js');
    const page = read('index.html');

    assert.equal(fs.existsSync(path.join(root, 'services/mpesa.js')), false);
    assert.doesNotMatch(server, /app\.post\('\/api\/payments\/mpesa-callback'/);
    assert.doesNotMatch(server, /app\.get\('\/api\/ledger\/reconciliation'/);
    assert.doesNotMatch(server, /app\.post\('\/api\/ledger\/reconcile'/);
    assert.doesNotMatch(server, /handleMpesaCallback/);
    assert.doesNotMatch(api, /ledger\/reconciliation|ledger\/reconcile/);
    assert.doesNotMatch(settings, /reconciliation-console|reconcileTransaction/);
    assert.doesNotMatch(page, /M-Pesa Daraja API Integration|reconciliation-console-card/);
});

test('generic ledger and transaction routes continue to use the generic ledger service', () => {
    const server = read('server.js');
    const transactionRoutes = read('services/transaction-persistence-http.js');

    assert.match(server, /require\('\.\/services\/ledger'\)/);
    assert.match(server, /app\.get\('\/api\/ledger\/accounts'/);
    assert.match(server, /app\.get\('\/api\/transactions\/:batchId'/);
    assert.match(server, /registerTransactionPersistenceApi\(app/);
    assert.match(transactionRoutes, /app\.post\('\/api\/transactions\/:batchId'/);
    assert.match(transactionRoutes, /app\.delete\('\/api\/transactions\/:batchId\/:id'/);
});

test('legacy Daraja entity policy is exact and does not block unrelated settings', () => {
    assert.deepEqual(LEGACY_DARAJA_ENTITY_KEYS, [
        'mpesa_consumer_key',
        'mpesa_consumer_secret',
        'mpesa_passkey',
        'mpesa_shortcode'
    ]);
    for (const key of LEGACY_DARAJA_ENTITY_KEYS) assert.equal(isLegacyDarajaEntityKey(key), true);
    assert.equal(isLegacyDarajaEntityKey('farm_name'), false);
    assert.equal(isLegacyDarajaEntityKey('telegram_chat_id'), false);
    assert.equal(isLegacyDarajaEntityKey('MPESA_CONSUMER_KEY'), false);
});

test('legacy database upgrade purges Daraja credentials and generic APIs cannot restore or read them for any role', async t => {
    const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-daraja-upgrade-'));
    const appDir = path.join(disposableRoot, 'app');
    copyDisposableProject(appDir);
    fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
    const databasePath = path.join(appDir, 'data', 'poultry.db');
    await seedLegacyDatabase(databasePath);

    const port = 35000 + Math.floor(Math.random() * 3000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const environment = {
        ...process.env,
        PORT: String(port),
        SESSION_SECRET: 'daraja-upgrade-session-secret-0123456789'
    };
    delete environment.E2E_TEST_PASSWORD;
    delete environment.NODE_ENV;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: appDir,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
    });
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

    await waitForServer(baseUrl, child, () => output);

    const databaseAfterUpgrade = await openDatabase(databasePath);
    try {
        const placeholders = LEGACY_DARAJA_ENTITY_KEYS.map(() => '?').join(', ');
        const forbiddenRows = await all(
            databaseAfterUpgrade,
            `SELECT key, value FROM entities WHERE key IN (${placeholders})`,
            LEGACY_DARAJA_ENTITY_KEYS
        );
        assert.deepEqual(forbiddenRows, []);
        assert.deepEqual(
            await all(databaseAfterUpgrade, 'SELECT key, value FROM entities WHERE key = ?', ['farm_name']),
            [{ key: 'farm_name', value: JSON.stringify('Legacy Farm') }]
        );
    } finally {
        await closeDatabase(databaseAfterUpgrade);
    }

    const sessions = new Map();
    for (const role of ['super_admin', 'admin', 'farmer', 'viewer']) {
        const login = await request(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: `legacy-${role}`, password: 'LegacyTestPass123!' }
        });
        assert.equal(login.status, 200, `${role} login failed: ${login.text}`);
        assert.ok(login.cookie);
        sessions.set(role, login.cookie);

        for (const [index, key] of LEGACY_DARAJA_ENTITY_KEYS.entries()) {
            const result = await request(baseUrl, `/api/entities/${encodeURIComponent(key)}`, { cookie: login.cookie });
            assert.equal(result.status, 404, `${role} could query ${key}`);
            assert.doesNotMatch(result.text, new RegExp(`legacy-secret-${index}`));
        }
    }

    for (const role of ['super_admin', 'admin', 'farmer']) {
        for (const key of LEGACY_DARAJA_ENTITY_KEYS) {
            const result = await request(baseUrl, `/api/entities/${encodeURIComponent(key)}`, {
                method: 'POST',
                cookie: sessions.get(role),
                body: { value: `replacement-from-${role}` }
            });
            assert.equal(result.status, 404, `${role} could restore ${key}`);
        }
    }
    assert.equal((await request(baseUrl, '/api/entities/mpesa_consumer_secret', {
        method: 'POST',
        cookie: sessions.get('viewer'),
        body: { value: 'replacement-from-viewer' }
    })).status, 404);

    const preserved = await request(baseUrl, '/api/entities/farm_name', { cookie: sessions.get('viewer') });
    assert.equal(preserved.status, 200);
    assert.equal(preserved.json, 'Legacy Farm');
    const deniedLegacyWrite = await request(baseUrl, '/api/entities/farm_name', {
        method: 'POST',
        cookie: sessions.get('farmer'),
        body: { value: 'Upgraded Farm' }
    });
    assert.equal(deniedLegacyWrite.status, 404);
    assert.equal((await request(baseUrl, '/api/entities/farm_name', { cookie: sessions.get('viewer') })).json, 'Legacy Farm');
    for (const role of ['farmer', 'viewer']) {
        assert.equal((await request(baseUrl, '/api/entities/poultryFarmProfile', {
            method: 'POST', cookie: sessions.get(role), body: { value: { flockSize: 20 } }
        })).status, 403, `${role} may not change farm-wide settings`);
    }
    assert.equal((await request(baseUrl, '/api/entities/arbitrary_browser_key', {
        method: 'POST', cookie: sessions.get('super_admin'), body: { value: 'nope' }
    })).status, 404);

    const finalDatabase = await openDatabase(databasePath);
    try {
        const placeholders = LEGACY_DARAJA_ENTITY_KEYS.map(() => '?').join(', ');
        assert.deepEqual(await all(
            finalDatabase,
            `SELECT key FROM entities WHERE key IN (${placeholders})`,
            LEGACY_DARAJA_ENTITY_KEYS
        ), []);
    } finally {
        await closeDatabase(finalDatabase);
    }
});
