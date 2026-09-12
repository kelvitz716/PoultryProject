const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const { migratePaymentImports } = require('../../migrations/payment-imports');
const paymentImports = require('../../services/payment-imports');
const paymentImportReview = require('../../services/payment-import-review');
const {
    MAX_WEBHOOK_BYTES,
    webhookConfiguration,
    verifyWebhookSignature,
    mapWebhookPayload,
    registerPaymentImportWebhook,
    registerPaymentImportApi
} = require('../../services/payment-import-http');

const secret = 'payment-import-test-secret-at-least-32-characters';
const env = { PAYMENT_IMPORT_WEBHOOK_SECRET: secret, PAYMENT_IMPORT_ALLOWED_SENDERS: 'MPESA,M-PESA' };
const incoming = 'HTP1234XYZ Confirmed. Ksh125.50 received from HTTP BUYER 0712345678 on 6/9/26 at 10:30 AM.';

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

function sign(body, signingSecret = secret) {
    return crypto.createHmac('sha256', signingSecret).update(body).digest('hex');
}

function request(server, { method = 'GET', pathname, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const req = http.request({ host: '127.0.0.1', port: address.port, method, path: pathname, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

async function temporaryHttpApp(t, configuredEnv = env, serviceOverrides = {}, reviewOverrides = {}, approvalOverrides = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-import-http-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await migratePaymentImports(db);
    const adapter = {
        runQuery: (sql, params) => run(db, sql, params),
        getQuery: (sql, params) => get(db, sql, params),
        allQuery: (sql, params) => all(db, sql, params)
    };
    const paymentService = {
        ingestPaymentImport: input => paymentImports.ingestPaymentImport(input, adapter),
        getPaymentImport: id => paymentImports.getPaymentImport(id, adapter),
        listPaymentImports: options => paymentImports.listPaymentImports(options, adapter),
        ...serviceOverrides
    };
    const reviewService = {
        rejectPaymentImport: input => paymentImportReview.rejectPaymentImport(input, adapter),
        ...reviewOverrides
    };
    const approvalService = {
        approvePaymentImport: async () => { throw new Error('approval test service was not configured'); },
        ...approvalOverrides
    };
    const app = express();
    app.use((req, res, next) => {
        const role = req.headers['x-test-role'];
        req.session = role ? { userId: 'test-user', userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    registerPaymentImportWebhook(app, { paymentService, env: configuredEnv });
    app.use(express.json({ limit: '1mb' }));
    registerPaymentImportApi(app, { paymentService, reviewService, approvalService, requireRole });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    return { db, server };
}

test('HMAC verification is exact-byte, fixed-shape, and configuration fails closed', () => {
    const body = Buffer.from('{"from":"MPESA","text":"x"}', 'utf8');
    assert.equal(verifyWebhookSignature(body, sign(body), secret), true);
    assert.equal(verifyWebhookSignature(Buffer.from('{"from":"MPESA","text":"y"}'), sign(body), secret), false);
    assert.equal(verifyWebhookSignature(body, `sha256=${sign(body)}`, secret), false);
    assert.equal(verifyWebhookSignature(body, 'a'.repeat(63), secret), false);
    assert.equal(verifyWebhookSignature(body, 'g'.repeat(64), secret), false);
    assert.equal(verifyWebhookSignature(body, sign(body, `${secret}-wrong`), secret), false);
    assert.equal(webhookConfiguration({}), null);
    assert.equal(webhookConfiguration({ PAYMENT_IMPORT_WEBHOOK_SECRET: secret, PAYMENT_IMPORT_ALLOWED_SENDERS: 'MPESA,*' }), null);
    assert.equal(webhookConfiguration({ PAYMENT_IMPORT_WEBHOOK_SECRET: secret, PAYMENT_IMPORT_ALLOWED_SENDERS: 'MPESA, M-PESA' }).allowedSenders.has('M-PESA'), true);
    assert.equal(webhookConfiguration({ PAYMENT_IMPORT_WEBHOOK_SECRET: secret, PAYMENT_IMPORT_ALLOWED_SENDERS: 'MPESA,,M-PESA' }), null);
    assert.equal(webhookConfiguration({ PAYMENT_IMPORT_WEBHOOK_SECRET: secret, PAYMENT_IMPORT_ALLOWED_SENDERS: 'MPESA,mpesa' }), null);
    assert.equal(webhookConfiguration(env).allowedSenders.has('M-PESA'), true);
});

test('maps only documented upstream fields and rejects alias conflicts or dangerous payload keys', () => {
    assert.deepEqual(mapWebhookPayload({ from: 'MPESA', text: 'x', sentStamp: 1, receivedStamp: 2, sim: 'SIM 1', device_id: 'android:1', source_message_id: 'source:1' }), {
        source: 'webhook', text: 'x', sender: 'MPESA', sent_at_ms: 1, received_at_ms: 2,
        sim: 'SIM 1', device_id: 'android:1', source_message_id: 'source:1'
    });
    assert.throws(() => mapWebhookPayload({ from: 'MPESA', sender: 'M-PESA', text: 'x' }), /conflicting aliases/);
    assert.throws(() => mapWebhookPayload({ from: 'MPESA', text: 'x', status: 'approved' }), /unsupported payload field/);
    assert.throws(() => mapWebhookPayload(JSON.parse('{"from":"MPESA","text":"x","__proto__":{}}')), /invalid payload shape/);
});

test('manual/read endpoints enforce roles, force source, reject smuggling, and preserve normal retry codes', async (t) => {
    const { server } = await temporaryHttpApp(t);
    const manualBody = JSON.stringify({ text: incoming, sender: 'MPESA', source: 'webhook', status: 'approved' });
    assert.equal((await request(server, { pathname: '/api/payment-imports' })).status, 401);
    assert.equal((await request(server, { pathname: '/api/payment-imports', headers: { 'x-test-role': 'viewer' } })).status, 403);
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/manual', headers: { 'content-type': 'application/json', 'x-test-role': 'farmer' }, body: manualBody })).status, 400);

    const cleanManual = JSON.stringify({ text: incoming, sender: 'MPESA', source_message_id: 'manual:1', device_id: 'android:1', sim: 'SIM 1' });
    const created = await request(server, { method: 'POST', pathname: '/api/payment-imports/manual', headers: { 'content-type': 'application/json', 'x-test-role': 'farmer' }, body: cleanManual });
    const retry = await request(server, { method: 'POST', pathname: '/api/payment-imports/manual', headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: cleanManual });
    assert.equal(created.status, 201);
    assert.equal(created.body.payment_import.source, 'manual');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.conflict, false);
    assert.doesNotMatch(JSON.stringify(created.body), /0712345678/);

    const listing = await request(server, { pathname: '/api/payment-imports?limit=1', headers: { 'x-test-role': 'super_admin' } });
    assert.equal(listing.status, 200);
    assert.equal(listing.body.items.length, 1);
    assert.equal((await request(server, { pathname: `/api/payment-imports/${created.body.payment_import.id}`, headers: { 'x-test-role': 'farmer' } })).status, 200);
});

test('manual receipt collisions return 409 without changing the canonical evidence', async (t) => {
    const { server } = await temporaryHttpApp(t);
    const headers = { 'content-type': 'application/json', 'x-test-role': 'farmer' };
    const first = await request(server, { method: 'POST', pathname: '/api/payment-imports/manual', headers, body: JSON.stringify({ text: 'MAN1234XYZ Confirmed. Ksh100 received from BUYER A 0712345678.' }) });
    const collision = await request(server, { method: 'POST', pathname: '/api/payment-imports/manual', headers, body: JSON.stringify({ text: 'MAN1234XYZ Confirmed. Ksh900 received from BUYER B 0712349999.' }) });
    assert.equal(first.status, 201);
    assert.equal(collision.status, 409);
    assert.equal(collision.body.conflict, true);
    assert.equal(collision.body.payment_import.amount_minor, 10000);
    assert.deepEqual([collision.body.payment_import.status, collision.body.payment_import.has_conflict, collision.body.payment_import.conflict_count], ['needs_review', 1, 1]);
    assert.doesNotMatch(JSON.stringify(collision.body), /BUYER B|900|0712349999/);
    const laterGet = await request(server, { pathname: `/api/payment-imports/${first.body.payment_import.id}`, headers: { 'x-test-role': 'farmer' } });
    const laterList = await request(server, { pathname: '/api/payment-imports', headers: { 'x-test-role': 'farmer' } });
    assert.deepEqual([laterGet.body.has_conflict, laterGet.body.conflict_count, laterList.body.items[0].has_conflict], [1, 1, 1]);
});

test('rejection endpoint is admin-only, idempotent, and returns safe transition errors', async (t) => {
    const { server, db } = await temporaryHttpApp(t);
    const createHeaders = { 'content-type': 'application/json', 'x-test-role': 'farmer' };
    const created = await request(server, {
        method: 'POST', pathname: '/api/payment-imports/manual', headers: createHeaders,
        body: JSON.stringify({ text: 'REJHTTP12 Confirmed. Ksh100 received from REJECT HTTP 0712345678.' })
    });
    const rejectionPath = `/api/payment-imports/${created.body.payment_import.id}/reject`;
    assert.equal((await request(server, { method: 'POST', pathname: rejectionPath, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await request(server, { method: 'POST', pathname: rejectionPath, headers: { 'content-type': 'application/json', 'x-test-role': 'viewer' }, body: '{}' })).status, 403);
    assert.equal((await request(server, { method: 'POST', pathname: rejectionPath, headers: createHeaders, body: '{}' })).status, 403);
    const rejected = await request(server, { method: 'POST', pathname: rejectionPath, headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: JSON.stringify({ review_notes: 'No matching order.' }) });
    const retry = await request(server, { method: 'POST', pathname: rejectionPath, headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: JSON.stringify({ review_notes: 'Attempted overwrite.' }) });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.idempotent, false);
    assert.equal(retry.body.idempotent, true);
    assert.equal(retry.body.payment_import.review_notes, 'No matching order.');
    assert.doesNotMatch(JSON.stringify(rejected.body), /0712345678/);
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/missing-import/reject', headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: '{}' })).status, 404);
    assert.equal((await request(server, { method: 'POST', pathname: rejectionPath, headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: JSON.stringify({ review_notes: 'x'.repeat(501) }) })).status, 400);

    const terminal = await request(server, {
        method: 'POST', pathname: '/api/payment-imports/manual', headers: createHeaders,
        body: JSON.stringify({ text: 'TERHTTP12 Confirmed. Ksh100 received from TERMINAL HTTP 0712345678.' })
    });
    await run(db, "UPDATE payment_imports SET status = 'approved' WHERE id = ?", [terminal.body.payment_import.id]);
    assert.equal((await request(server, { method: 'POST', pathname: `/api/payment-imports/${terminal.body.payment_import.id}/reject`, headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: '{}' })).status, 409);
});

test('unexpected rejection-service failures return a sanitized 500 response', async (t) => {
    const failure = new Error(`review database failure ${incoming} ${secret}`);
    const { server } = await temporaryHttpApp(t, env, {}, {
        rejectPaymentImport: async () => { throw failure; }
    });
    const response = await request(server, {
        method: 'POST', pathname: '/api/payment-imports/import-1/reject',
        headers: { 'content-type': 'application/json', 'x-test-role': 'admin' }, body: '{}'
    });
    assert.deepEqual([response.status, response.body], [500, { error: 'Payment import service unavailable' }]);
    assert.doesNotMatch(JSON.stringify(response.body), /0712345678|payment-import-test-secret|review database failure/);
});

test('service/database failures are sanitized as 500 while client input errors remain 400', async (t) => {
    const unsafeError = new Error(`database outage ${incoming} ${secret}`);
    const headers = { 'content-type': 'application/json', 'x-test-role': 'farmer' };
    const manual = await temporaryHttpApp(t, env, { ingestPaymentImport: async () => { throw unsafeError; } });
    const manualResult = await request(manual.server, { method: 'POST', pathname: '/api/payment-imports/manual', headers, body: JSON.stringify({ text: incoming }) });
    assert.deepEqual([manualResult.status, manualResult.body], [500, { error: 'Payment import service unavailable' }]);

    const webhook = await temporaryHttpApp(t, env, { ingestPaymentImport: async () => { throw unsafeError; } });
    const webhookBody = Buffer.from(JSON.stringify({ from: 'MPESA', text: incoming }));
    const webhookResult = await request(webhook.server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(webhookBody) }, body: webhookBody });
    assert.deepEqual([webhookResult.status, webhookResult.body], [500, { error: 'Payment import service unavailable' }]);

    const list = await temporaryHttpApp(t, env, { listPaymentImports: async () => { throw unsafeError; } });
    const listResult = await request(list.server, { pathname: '/api/payment-imports', headers: { 'x-test-role': 'farmer' } });
    assert.deepEqual([listResult.status, listResult.body], [500, { error: 'Payment import service unavailable' }]);

    const getById = await temporaryHttpApp(t, env, { getPaymentImport: async () => { throw unsafeError; } });
    const getResult = await request(getById.server, { pathname: '/api/payment-imports/import-1', headers: { 'x-test-role': 'farmer' } });
    assert.deepEqual([getResult.status, getResult.body], [500, { error: 'Payment import service unavailable' }]);
    for (const result of [manualResult, webhookResult, listResult, getResult]) {
        assert.doesNotMatch(JSON.stringify(result.body), /0712345678|payment-import-test-secret|database outage/);
    }

    const valid = await temporaryHttpApp(t);
    assert.equal((await request(valid.server, { method: 'POST', pathname: '/api/payment-imports/manual', headers, body: JSON.stringify({ text: '' }) })).status, 400);
    const invalidWebhook = Buffer.from(JSON.stringify({ from: 'MPESA', text: '' }));
    assert.equal((await request(valid.server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(invalidWebhook) }, body: invalidWebhook })).status, 400);
    assert.equal((await request(valid.server, { pathname: '/api/payment-imports?limit=bad', headers: { 'x-test-role': 'farmer' } })).status, 400);
    assert.equal((await request(valid.server, { pathname: `/api/payment-imports/${'x'.repeat(129)}`, headers: { 'x-test-role': 'farmer' } })).status, 400);
});

test('webhook verifies before JSON parsing, maps default payload, and handles cross-source retries', async (t) => {
    const { server, db } = await temporaryHttpApp(t);
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values) => logs.push(values.join(' '));
    console.error = (...values) => logs.push(values.join(' '));
    let manual;
    let webhook;
    try {
    const malformed = Buffer.from('{"from":', 'utf8');
    const invalidFirst = await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': '0'.repeat(64) }, body: malformed });
    assert.equal(invalidFirst.status, 401);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 0);

    manual = await request(server, { method: 'POST', pathname: '/api/payment-imports/manual', headers: { 'content-type': 'application/json', 'x-test-role': 'farmer' }, body: JSON.stringify({ text: incoming, sender: 'MPESA' }) });
    const body = Buffer.from(JSON.stringify({ from: 'mpesa', text: incoming, sentStamp: 1780000000000, receivedStamp: 1780000000100, sim: 'SIM 1', device_id: 'android:1', source_message_id: 'source:1' }));
    webhook = await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(body) }, body });
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.equal(manual.status, 201);
    assert.equal(webhook.status, 200);
    assert.equal(webhook.body.duplicate, true);
    assert.equal(webhook.body.conflict, false);
    assert.doesNotMatch(JSON.stringify(webhook.body), /0712345678|payment-import-test-secret/);
    assert.doesNotMatch(logs.join('\n'), /0712345678|payment-import-test-secret/);
    assert.doesNotMatch(JSON.stringify(await all(db, 'SELECT * FROM payment_imports')), /0712345678|payment-import-test-secret/);
});

test('webhook fails safely for config, sender, media, size, signatures, and preserves conflict as 202', async (t) => {
    const disabled = await temporaryHttpApp(t, {});
    const disabledBody = Buffer.from(JSON.stringify({ from: 'MPESA', text: incoming }));
    assert.equal((await request(disabled.server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(disabledBody) }, body: disabledBody })).status, 503);

    const { server, db } = await temporaryHttpApp(t);
    const payload = Buffer.from(JSON.stringify({ from: 'OTHER', text: incoming }));
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(payload) }, body: payload })).status, 403);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 0);
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(payload, `${secret}-wrong`) }, body: payload })).status, 401);
    const spacedSender = Buffer.from(JSON.stringify({ from: 'MPESA ', text: incoming }));
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(spacedSender) }, body: spacedSender })).status, 403);
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'text/plain', 'x-signature': sign(payload) }, body: payload })).status, 415);
    const oversized = Buffer.alloc(MAX_WEBHOOK_BYTES + 1, 'x');
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(oversized), 'content-length': oversized.length }, body: oversized })).status, 413);

    const firstBody = Buffer.from(JSON.stringify({ from: 'MPESA', text: 'WEB1234XYZ Confirmed. Ksh100 received from BUYER A 0712345678.' }));
    const collisionBody = Buffer.from(JSON.stringify({ from: 'MPESA', text: 'WEB1234XYZ Confirmed. Ksh900 received from BUYER B 0712349999.' }));
    assert.equal((await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(firstBody) }, body: firstBody })).status, 201);
    const collision = await request(server, { method: 'POST', pathname: '/api/payment-imports/webhook', headers: { 'content-type': 'application/json', 'x-signature': sign(collisionBody) }, body: collisionBody });
    assert.equal(collision.status, 202);
    assert.equal(collision.body.conflict, true);
});

test('server registers the raw webhook before global JSON parsing', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
    const webhookIndex = server.indexOf('registerPaymentImportWebhook(app');
    const jsonIndex = server.indexOf('app.use(express.json');
    const apiIndex = server.indexOf('registerPaymentImportApi(app');
    assert.ok(webhookIndex < jsonIndex);
    assert.ok(apiIndex > jsonIndex);
});
