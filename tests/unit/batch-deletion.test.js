const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { createBatchDeletionService } = require('../../services/batch-deletion');
const { registerBatchDeletionApi } = require('../../services/batch-deletion-http');

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filename, error => error ? reject(error) : resolve(database));
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

function get(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function closeDatabase(database) {
    return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

async function execute(filename, sql, params = []) {
    const database = await openDatabase(filename);
    try {
        await run(database, 'PRAGMA foreign_keys=ON');
        return await run(database, sql, params);
    } finally {
        await closeDatabase(database);
    }
}

async function scalar(filename, sql, params = []) {
    const database = await openDatabase(filename);
    try {
        return (await get(database, sql, params)).value;
    } finally {
        await closeDatabase(database);
    }
}

async function initializeDatabase(filename) {
    const database = await openDatabase(filename);
    try {
        await run(database, 'PRAGMA foreign_keys=ON');
        for (const sql of [
            'CREATE TABLE batches (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
            'CREATE TABLE logs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL)',
            'CREATE TABLE health_logs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL)',
            'CREATE TABLE transactions (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL)',
            'CREATE TABLE staging (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL)',
            'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY, source_transaction_id TEXT)',
            `CREATE TABLE customer_account_allocations (
                id TEXT PRIMARY KEY,
                credit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
                debit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT
            )`,
            'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, ref_id TEXT)',
            `CREATE TABLE ledger_entries (
                id TEXT PRIMARY KEY,
                transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE
            )`,
            `CREATE TABLE payment_imports (
                id TEXT PRIMARY KEY,
                batch_id TEXT,
                created_transaction_id TEXT
            )`
        ]) await run(database, sql);

        for (const id of [
            'protected-sale',
            'protected-purchase',
            'protected-import-transaction',
            'protected-import-batch',
            'protected-staging',
            'safe-mixed',
            'legacy-safe.0'
        ]) {
            await run(database, 'INSERT INTO batches (id, data) VALUES (?, ?)', [id, JSON.stringify({ id })]);
        }
        for (const [id, batchId, type] of [
            ['sale-1', 'protected-sale', 'sale'],
            ['purchase-1', 'protected-purchase', 'purchase'],
            ['import-transaction-1', 'protected-import-transaction', 'legacy'],
            ['safe-mixed-tx', 'safe-mixed', 'legacy'],
            ['legacy-safe-tx', 'legacy-safe.0', 'legacy']
        ]) {
            await run(database, 'INSERT INTO transactions (id, batch_id, data) VALUES (?, ?, ?)', [
                id,
                batchId,
                JSON.stringify({ id, type })
            ]);
        }
        await run(database, "INSERT INTO customer_account_events (id, source_transaction_id) VALUES ('invoice-1', 'sale-1')");
        await run(database, "INSERT INTO customer_account_events (id, source_transaction_id) VALUES ('payment-1', NULL)");
        await run(database, "INSERT INTO customer_account_allocations (id, credit_event_id, debit_event_id) VALUES ('allocation-1', 'payment-1', 'invoice-1')");
        await run(database, "INSERT INTO ledger_transactions (id, ref_id) VALUES ('ledger-purchase-1', 'purchase-1')");
        await run(database, "INSERT INTO ledger_entries (id, transaction_id) VALUES ('purchase-1-dr', 'ledger-purchase-1')");
        await run(database, "INSERT INTO ledger_entries (id, transaction_id) VALUES ('purchase-1-cr', 'ledger-purchase-1')");
        await run(database, "INSERT INTO payment_imports (id, created_transaction_id) VALUES ('payment-import-transaction-1', 'import-transaction-1')");
        await run(database, "INSERT INTO payment_imports (id, batch_id) VALUES ('payment-import-batch-1', 'protected-import-batch')");
        await run(database, "INSERT INTO staging (id, batch_id) VALUES ('staging-1', 'protected-staging')");
        for (const [id, batchId] of [
            ['safe-mixed-log', 'safe-mixed'],
            ['legacy-safe-log', 'legacy-safe.0']
        ]) await run(database, 'INSERT INTO logs (id, batch_id, data) VALUES (?, ?, ?)', [id, batchId, '{}']);
        await run(database, "INSERT INTO health_logs (id, batch_id, data) VALUES ('legacy-safe-health', 'legacy-safe.0', '{}')");
    } finally {
        await closeDatabase(database);
    }
}

function request(server, method, pathname, { role, confirm } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method,
            path: pathname,
            headers: {
                ...(role ? { 'x-role': role } : {}),
                ...(confirm ? { 'x-confirm-delete': 'true' } : {})
            }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString() || '{}')
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('batch deletion routes atomically protect customer and ledger evidence while deleting safe legacy batches', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-batch-deletion-'));
    const filename = path.join(directory, 'test.db');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await initializeDatabase(filename);

    const boundary = createDedicatedTransactionBoundary(filename);
    const batchDeletionService = createBatchDeletionService({
        withDedicatedTransaction: boundary.withDedicatedTransaction
    });
    const app = express();
    app.use((req, _res, next) => {
        const role = req.headers['x-role'];
        req.session = role ? { userId: `user-${role}`, userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    const requireConfirm = (req, res, next) => req.headers['x-confirm-delete'] === 'true'
        ? next()
        : res.status(403).json({ error: 'Confirmation required' });
    registerBatchDeletionApi(app, { batchDeletionService, requireRole, requireConfirm });
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => server.close());

    assert.equal((await request(server, 'DELETE', '/api/batches/protected-sale')).status, 401);
    assert.equal((await request(server, 'DELETE', '/api/batches/protected-sale', { role: 'farmer' })).status, 403);

    const namedSale = await request(server, 'DELETE', '/api/batches/protected-sale', { role: 'admin' });
    assert.deepEqual(namedSale, {
        status: 409,
        body: { error: 'Batch deletion conflicts with retained records' }
    });
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM batches WHERE id = 'protected-sale'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM transactions WHERE id = 'sale-1'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM customer_account_events WHERE id = 'invoice-1'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM customer_account_allocations WHERE id = 'allocation-1'"), 1);

    const purchase = await request(server, 'DELETE', '/api/batches/protected-purchase', { role: 'super_admin' });
    assert.equal(purchase.status, 409);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM transactions WHERE id = 'purchase-1'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM ledger_transactions WHERE id = 'ledger-purchase-1'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM ledger_entries WHERE transaction_id = 'ledger-purchase-1'"), 2);

    for (const id of ['protected-import-transaction', 'protected-import-batch', 'protected-staging']) {
        assert.equal((await request(server, 'DELETE', `/api/batches/${id}`, { role: 'admin' })).status, 409);
        assert.equal(await scalar(filename, 'SELECT COUNT(*) AS value FROM batches WHERE id = ?', [id]), 1);
    }
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM payment_imports WHERE id = 'payment-import-transaction-1'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM payment_imports WHERE id = 'payment-import-batch-1'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM staging WHERE id = 'staging-1'"), 1);

    assert.equal((await request(server, 'DELETE', '/api/batches', { role: 'admin' })).status, 403);
    const mixedBulk = await request(server, 'DELETE', '/api/batches', { role: 'admin', confirm: true });
    assert.equal(mixedBulk.status, 409);
    assert.equal(await scalar(filename, 'SELECT COUNT(*) AS value FROM batches'), 7);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM transactions WHERE id = 'safe-mixed-tx'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM logs WHERE id = 'safe-mixed-log'"), 1);

    const safe = await request(server, 'DELETE', '/api/batches/legacy-safe', { role: 'admin' });
    assert.deepEqual(safe, { status: 200, body: { success: true } });
    for (const [table, column, value] of [
        ['batches', 'id', 'legacy-safe.0'],
        ['transactions', 'id', 'legacy-safe-tx'],
        ['logs', 'id', 'legacy-safe-log'],
        ['health_logs', 'id', 'legacy-safe-health']
    ]) {
        assert.equal(await scalar(filename, `SELECT COUNT(*) AS value FROM ${table} WHERE ${column} = ?`, [value]), 0);
    }
});

test('batch deletion transaction rolls back earlier operational deletes when a later database write fails', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-batch-deletion-rollback-'));
    const filename = path.join(directory, 'test.db');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await initializeDatabase(filename);
    await execute(filename, `CREATE TRIGGER reject_safe_transaction_delete
        BEFORE DELETE ON transactions WHEN OLD.id = 'legacy-safe-tx'
        BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END`);
    const boundary = createDedicatedTransactionBoundary(filename);
    const service = createBatchDeletionService({ withDedicatedTransaction: boundary.withDedicatedTransaction });

    await assert.rejects(service.deleteBatch('legacy-safe'), /injected transaction failure/);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM batches WHERE id = 'legacy-safe.0'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM logs WHERE id = 'legacy-safe-log'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM health_logs WHERE id = 'legacy-safe-health'"), 1);
    assert.equal(await scalar(filename, "SELECT COUNT(*) AS value FROM transactions WHERE id = 'legacy-safe-tx'"), 1);
});
