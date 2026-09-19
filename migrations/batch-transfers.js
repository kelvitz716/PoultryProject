'use strict';

function run(db, sql) {
    return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
}

async function migrateBatchTransfers(db) {
    await run(db, `CREATE TABLE IF NOT EXISTS batch_transfers (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        cohort_id TEXT NOT NULL,
        source_location_id TEXT NOT NULL,
        destination_location_id TEXT NOT NULL,
        transfer_date TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        reason TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(source_location_id <> destination_location_id)
    )`);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_batch_transfers_batch_date ON batch_transfers(batch_id, transfer_date, id)');
    await run(db, `CREATE TRIGGER IF NOT EXISTS batch_transfers_immutable
        BEFORE UPDATE ON batch_transfers
        BEGIN SELECT RAISE(ABORT, 'batch transfers are immutable'); END`);
    await run(db, `CREATE TRIGGER IF NOT EXISTS batch_transfers_restrict_delete
        BEFORE DELETE ON batch_transfers
        BEGIN SELECT RAISE(ABORT, 'batch transfers cannot be deleted'); END`);
}

module.exports = { migrateBatchTransfers };
