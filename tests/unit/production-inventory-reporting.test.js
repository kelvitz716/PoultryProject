'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const test = require('node:test');
const { migrateProductionInventory } = require('../../migrations/production-inventory');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const {
    ProductionInventoryReportingNotFoundError,
    createProductionInventoryReportingService
} = require('../../services/production-inventory-reporting');

function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve())); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

test('production inventory reporting returns prospective balances and ordered immutable movements for one batch', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-production-inventory-reporting-'));
    const file = path.join(directory, 'reporting.sqlite');
    const db = await open(file);
    t.after(async () => { await close(db); fs.rmSync(directory, { recursive: true, force: true }); });
    await run(db, 'CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, code TEXT UNIQUE)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await migrateProductionInventory(db);
    await run(db, "UPDATE production_inventory_policy SET starts_on = '2026-09-19'");
    await run(db, "INSERT INTO batches (id, data) VALUES ('batch-1', '{}')");
    const rows = [
        ['feed-buy', 'batch-1', 'feed', 'purchase', 100000, 100000, 'transaction:feed-buy', '2026-09-19', 'operator:one'],
        ['feed-use', 'batch-1', 'feed', 'consumption', 40000, 40000, 'staging-feed:use', '2026-09-20', 'operator:one'],
        ['egg-collect', 'batch-1', 'eggs', 'collection', 100000, 40000, 'staging-eggs:collect', '2026-09-20', 'operator:one'],
        ['egg-sale', 'batch-1', 'eggs', 'sale', 25000, 10000, 'transaction:egg-sale', '2026-09-21', 'operator:two']
    ];
    for (const row of rows) await run(db, `INSERT INTO production_inventory_movements
        (id, batch_id, item_type, movement_type, quantity_milli, value_minor, source_id, occurred_on, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row);
    const service = createProductionInventoryReportingService({
        withDedicatedReadTransaction: createDedicatedTransactionBoundary(file).withDedicatedReadTransaction
    });
    const report = await service.getBatchInventory({ batch_id: 'batch-1', limit: 10 });
    assert.deepEqual(report.policy, { id: 'prospective_weighted_average_v1', starts_on: '2026-09-19' });
    assert.deepEqual(report.balances, {
        feed_inventory: { quantity_milli: 60000, value_minor: 60000 },
        batch_wip: { value_minor: 0 },
        egg_inventory: { quantity_milli: 75000, value_minor: 30000 },
        egg_cogs: { value_minor: 10000 }
    });
    assert.deepEqual(report.movements.map(row => row.id), ['egg-sale', 'feed-use', 'egg-collect', 'feed-buy']);
    await assert.rejects(service.getBatchInventory({ batch_id: 'missing' }), ProductionInventoryReportingNotFoundError);
});
