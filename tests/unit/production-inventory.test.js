'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { migrateProductionInventory } = require('../../migrations/production-inventory');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const {
    ProductionInventoryValidationError,
    ProductionInventoryConflictError,
    createProductionInventoryService
} = require('../../services/production-inventory');
const { createTransactionPersistenceService, TransactionPersistenceConflictError } = require('../../services/transaction-persistence');
const { resolveTransactionCustomer } = require('../../services/transaction-customer-validation');
const { syncTransactionToLedgerWithAdapter } = require('../../services/ledger');
const { recordCustomerAccountEventWithAdapter } = require('../../services/customer-settlement');

function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db));
    });
}
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve())); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function all(db, sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-production-inventory-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, code TEXT UNIQUE)');
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT REFERENCES ledger_transactions(id) ON DELETE CASCADE,
        account_id TEXT, entry_type TEXT, amount REAL NOT NULL, amount_minor INTEGER,
        reconciliation_status TEXT
    )`);
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, payment_terms_days INTEGER NOT NULL, is_active INTEGER NOT NULL)');
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, `CREATE TABLE customer_account_events (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, currency TEXT NOT NULL, side TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT,
        external_reference TEXT, payment_import_id TEXT, source_transaction_id TEXT, original_event_id TEXT,
        reason_code TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_by_user_id TEXT,
        reviewer_user_id TEXT, created_at TEXT, posted_at TEXT, reversed_at TEXT
    )`);
    await run(db, 'CREATE TABLE customer_account_allocations (id TEXT PRIMARY KEY, credit_event_id TEXT, debit_event_id TEXT, amount_minor INTEGER, status TEXT, idempotency_key TEXT, created_by_user_id TEXT)');
    await migrateProductionInventory(db);
    await run(db, "UPDATE production_inventory_policy SET starts_on = '2026-09-19' WHERE id = 'prospective_weighted_average_v1'");
    const boundary = createDedicatedTransactionBoundary(file);
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    return { db, boundary };
}

function adapterService(boundary) {
    return createProductionInventoryService();
}

async function invoke(boundary, work) {
    return boundary.withDedicatedTransaction(work);
}

test('prospective feed, WIP, eggs, and COGS retain a weighted-average auditable cost trail', async t => {
    const s = await store(t);
    const service = adapterService(s.boundary);
    await invoke(s.boundary, async adapter => {
        await service.recordTransactionWithAdapter(adapter, 'batch-1', {
            id: 'feed-buy-1', type: 'purchase', category: 'feed', qty: 100, date: '2026-09-19T09:00:00Z'
        }, 100000, 'operator:one');
        await service.recordFeedConsumptionWithAdapter(adapter, {
            batchId: 'batch-1', sourceId: 'feed-event-1', kilograms: 40, occurredOn: '2026-09-19', actor: 'operator:one'
        });
        await service.recordEggCollectionWithAdapter(adapter, {
            batchId: 'batch-1', sourceId: 'egg-event-1', eggs: 100, occurredOn: '2026-09-19', actor: 'operator:one'
        });
        await service.recordTransactionWithAdapter(adapter, 'batch-1', {
            id: 'egg-sale-1', type: 'sale', category: 'eggs', qty: 25, date: '2026-09-19T18:00:00Z'
        }, 75000, 'operator:one');
    });

    const rows = await all(s.db, `SELECT item_type, movement_type, quantity_milli, value_minor, source_id
        FROM production_inventory_movements ORDER BY source_id`);
    assert.deepEqual(rows.map(row => [row.item_type, row.movement_type, row.quantity_milli, row.value_minor]), [
        ['eggs', 'collection', 100000, 40000],
        ['feed', 'consumption', 40000, 40000],
        ['eggs', 'sale', 25000, 10000],
        ['feed', 'purchase', 100000, 100000]
    ]);
    const accounts = await all(s.db, `SELECT account_id, entry_type, amount_minor FROM ledger_entries
        WHERE transaction_id LIKE 'inventory:%' ORDER BY account_id, entry_type`);
    assert.deepEqual(accounts.map(row => [row.account_id, row.entry_type, row.amount_minor]), [
        ['1300', 'credit', 10000], ['1300', 'debit', 40000],
        ['1310', 'credit', 40000], ['1320', 'credit', 40000], ['1320', 'debit', 40000], ['5050', 'debit', 10000]
    ]);
    const physical = await get(s.db, `SELECT
        SUM(CASE WHEN item_type = 'eggs' AND movement_type = 'collection' THEN quantity_milli
                 WHEN item_type = 'eggs' AND movement_type = 'sale' THEN -quantity_milli ELSE 0 END) AS egg_qty,
        SUM(CASE WHEN item_type = 'eggs' AND movement_type = 'collection' THEN value_minor
                 WHEN item_type = 'eggs' AND movement_type = 'sale' THEN -value_minor ELSE 0 END) AS egg_value
        FROM production_inventory_movements`);
    assert.deepEqual(physical, { egg_qty: 75000, egg_value: 30000 });
});

test('the cutover skips historical events, is idempotent for retries, and rejects stock underflow', async t => {
    const s = await store(t);
    const service = adapterService(s.boundary);
    await invoke(s.boundary, async adapter => {
        const historical = await service.recordTransactionWithAdapter(adapter, 'batch-1', {
            id: 'old-feed', type: 'purchase', category: 'feed', qty: 50, date: '2026-09-18T10:00:00Z'
        }, 10000, 'operator:one');
        assert.equal(historical.tracked, false);
        await service.recordTransactionWithAdapter(adapter, 'batch-1', {
            id: 'feed-buy', type: 'purchase', category: 'feed', qty: 10, date: '2026-09-19T10:00:00Z'
        }, 10000, 'operator:one');
        await service.recordFeedConsumptionWithAdapter(adapter, {
            batchId: 'batch-1', sourceId: 'feed-event', kilograms: 2.5, occurredOn: '2026-09-19', actor: 'operator:one'
        });
        await service.recordFeedConsumptionWithAdapter(adapter, {
            batchId: 'batch-1', sourceId: 'feed-event', kilograms: 2.5, occurredOn: '2026-09-19', actor: 'operator:one'
        });
        await assert.rejects(service.recordFeedConsumptionWithAdapter(adapter, {
            batchId: 'batch-1', sourceId: 'too-much-feed', kilograms: 8, occurredOn: '2026-09-19', actor: 'operator:one'
        }), ProductionInventoryValidationError);
    });
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM production_inventory_movements')).n, 2);
    await assert.rejects(run(s.db, "UPDATE production_inventory_movements SET value_minor = 1 WHERE source_id = 'transaction:feed-buy'"), /immutable/);
    await assert.rejects(run(s.db, "DELETE FROM production_inventory_movements WHERE source_id = 'transaction:feed-buy'"), /cannot be deleted/);
});

test('inventory-backed transaction retries are safe but edits and deletion are rejected', async t => {
    const s = await store(t);
    const inventory = createProductionInventoryService();
    const persistence = createTransactionPersistenceService({
        withDedicatedTransaction: s.boundary.withDedicatedTransaction,
        resolveTransactionCustomer,
        syncTransactionToLedgerWithAdapter,
        recordCustomerAccountEventWithAdapter,
        productionInventory: inventory
    });
    const legacy = { id: 'legacy-feed', type: 'purchase', category: 'feed', qty: 5, amount: 500, payment_method: 'cash', date: '2026-09-18T10:00:00Z' };
    await persistence.createOrUpdateTransaction('batch-1', legacy, 'operator:one');
    // A corrected legacy JSON must never become an invented opening balance.
    await persistence.createOrUpdateTransaction('batch-1', { ...legacy, date: '2026-09-19T10:00:00Z', amount: 550 }, 'operator:one');
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM production_inventory_movements')).n, 0);
    const purchase = { id: 'purchase-1', type: 'purchase', category: 'feed', qty: 10, amount: 1000, payment_method: 'cash', date: '2026-09-19T10:00:00Z' };
    await persistence.createOrUpdateTransaction('batch-1', purchase, 'operator:one');
    await persistence.createOrUpdateTransaction('batch-1', purchase, 'operator:two');
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM production_inventory_movements')).n, 1);
    await assert.rejects(
        persistence.createOrUpdateTransaction('batch-1', { ...purchase, amount: 1200 }, 'operator:one'),
        TransactionPersistenceConflictError
    );
    await assert.rejects(persistence.deleteTransaction('batch-1', 'purchase-1'), TransactionPersistenceConflictError);
    await assert.rejects(s.boundary.withDedicatedTransaction(adapter => inventory.assertBatchTransactionsDeletableWithAdapter(adapter, ['batch-1'])), ProductionInventoryConflictError);
});
