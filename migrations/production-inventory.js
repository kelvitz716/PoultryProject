'use strict';

function run(db, sql) { return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve())); }

async function migrateProductionInventory(db) {
    await run(db, "INSERT OR IGNORE INTO ledger_accounts (id, name, type, code) VALUES ('1320', 'Batch Production WIP', 'asset', '1320')");
    await run(db, "INSERT OR IGNORE INTO ledger_accounts (id, name, type, code) VALUES ('5050', 'Egg Cost of Goods Sold', 'expense', '5050')");
    // This is deliberately a prospective sub-ledger.  It is not derived from
    // older logs or transactions: the activation row establishes a zero
    // opening balance on the migration date.
    await run(db, `CREATE TABLE IF NOT EXISTS production_inventory_policy (
        id TEXT PRIMARY KEY CHECK(id = 'prospective_weighted_average_v1'),
        starts_on TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `INSERT OR IGNORE INTO production_inventory_policy (id, starts_on)
        VALUES ('prospective_weighted_average_v1', date('now'))`);
    await run(db, `CREATE TABLE IF NOT EXISTS production_inventory_movements (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, item_type TEXT NOT NULL CHECK(item_type IN ('feed', 'eggs')),
        movement_type TEXT NOT NULL CHECK(movement_type IN ('purchase', 'consumption', 'collection', 'sale')),
        quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
        value_minor INTEGER NOT NULL CHECK(value_minor >= 0), source_id TEXT NOT NULL UNIQUE,
        occurred_on TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `CREATE INDEX IF NOT EXISTS idx_production_inventory_batch_item
        ON production_inventory_movements (batch_id, item_type, movement_type)`);
    await run(db, `CREATE TRIGGER IF NOT EXISTS production_inventory_movements_immutable
        BEFORE UPDATE ON production_inventory_movements BEGIN SELECT RAISE(ABORT, 'production inventory movements are immutable'); END`);
    await run(db, `CREATE TRIGGER IF NOT EXISTS production_inventory_movements_restrict_delete
        BEFORE DELETE ON production_inventory_movements BEGIN SELECT RAISE(ABORT, 'production inventory movements cannot be deleted'); END`);
}

module.exports = { migrateProductionInventory };
