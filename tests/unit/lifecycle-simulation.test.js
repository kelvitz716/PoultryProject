const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { createLifecycleSimulationService, LifecycleSimulationContextError } = require('../../services/lifecycle-simulation');

function open(filename) { return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, error => error ? reject(error) : resolve(database));
}); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve())); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-simulator-'));
    const filename = path.join(dir, 'fixture.sqlite');
    const db = await open(filename);
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    for (const sql of [
        'CREATE TABLE batches (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
        'CREATE TABLE logs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL, date TEXT NOT NULL, logged_by TEXT, updated_at TEXT)',
        'CREATE TABLE transactions (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT)',
        'CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT, normalized_name TEXT, payment_terms_days INTEGER, is_active INTEGER, created_by_user_id TEXT, updated_by_user_id TEXT)',
        'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, date TEXT, description TEXT, ref_type TEXT, ref_id TEXT)',
        'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, transaction_id TEXT, account_id TEXT, entry_type TEXT, amount REAL, amount_minor INTEGER, reconciliation_status TEXT)',
        `CREATE TABLE customer_account_events (id TEXT PRIMARY KEY, customer_id TEXT, currency TEXT, side TEXT, kind TEXT, status TEXT, amount_minor INTEGER, method TEXT, external_reference TEXT, payment_import_id TEXT, source_transaction_id TEXT, original_event_id TEXT, idempotency_key TEXT UNIQUE, created_by_user_id TEXT, reviewer_user_id TEXT, reason_code TEXT, posted_at TEXT, reversed_at TEXT)`
    ]) await run(db, sql);
    await run(db, 'INSERT INTO batches (id, data) VALUES (?, ?)', ['batch:opaque-1', JSON.stringify({ id: 'batch:opaque-1', size: 40, stats: { birdsAlive: 40 } })]);
    return { db, filename };
}

function service(filename, extra = {}) {
    return createLifecycleSimulationService({
        databasePath: filename,
        environment: { NODE_ENV: 'test', POULTRY_SIMULATOR_CONTEXT: 'disposable' },
        withDedicatedTransaction: createDedicatedTransactionBoundary(filename).withDedicatedTransaction,
        ...extra
    });
}

test('normal contexts fail closed before a transaction or mutation', async () => {
    let opened = 0;
    const unsafe = createLifecycleSimulationService({
        databasePath: '/var/lib/poultry.db', environment: { NODE_ENV: 'production', POULTRY_SIMULATOR_CONTEXT: 'disposable' },
        withDedicatedTransaction: async () => { opened += 1; }
    });
    await assert.rejects(unsafe.simulate('batch:opaque-1', 'user:admin'), LifecycleSimulationContextError);
    assert.equal(opened, 0);
});

test('disposable simulation writes valid opaque customer invoices, logs, transactions, and batch state atomically', async t => {
    const { db, filename } = await fixture(t);
    const result = await service(filename).simulate('batch:opaque-1', 'user:admin');
    assert.deepEqual([result.logs, result.transactions, result.batch.stats.birdsAlive], [60, 31, 37]);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM logs')).count, 60);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM transactions')).count, 31);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM customer_account_events WHERE kind = "invoice"')).count, 30);
    const sale = JSON.parse((await get(db, "SELECT data FROM transactions WHERE id LIKE 'simulation:sale:%' LIMIT 1")).data);
    assert.match(sale.id, /^simulation:sale:[a-f0-9]{32}:\d+$/);
    assert.match(sale.customerId, /^customer:simulation:[a-f0-9]{32}$/);
    assert.equal(sale.status, 'unpaid');
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM ledger_entries')).count, 62);
});

test('an injected write failure rolls back every generated row and batch mutation', async t => {
    const { db, filename } = await fixture(t);
    const failing = service(filename, { afterWrite: async stage => { if (stage === 'transactions') throw new Error('injected failure'); } });
    await assert.rejects(failing.simulate('batch:opaque-1', 'user:admin'), /injected failure/);
    for (const table of ['customers', 'logs', 'transactions', 'ledger_transactions', 'ledger_entries', 'customer_account_events']) {
        assert.equal((await get(db, `SELECT COUNT(*) AS count FROM ${table}`)).count, 0, table);
    }
    assert.equal(JSON.parse((await get(db, 'SELECT data FROM batches WHERE id = ?', ['batch:opaque-1'])).data).stats.birdsAlive, 40);
});
