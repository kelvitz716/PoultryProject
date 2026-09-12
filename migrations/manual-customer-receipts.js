/** Rerunnable foundation for manually recorded incoming cash and bank receipts. */

function run(db, sql) {
    return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
}

async function migrateManualCustomerReceipts(db) {
    await run(db, `CREATE TABLE IF NOT EXISTS manual_customer_receipt_operations (
        idempotency_key TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        customer_account_event_id TEXT NOT NULL UNIQUE REFERENCES customer_account_events(id) ON DELETE RESTRICT,
        ledger_transaction_id TEXT NOT NULL UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
        method TEXT NOT NULL CHECK(method IN ('cash', 'bank')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        external_reference TEXT,
        created_by_user_id TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `CREATE INDEX IF NOT EXISTS idx_manual_customer_receipt_customer
        ON manual_customer_receipt_operations(customer_id, created_at DESC)`);
    // Single-bank-account scope for this batch. Existing account/ledger rows are
    // preserved; this is an additive seed that can safely rerun.
    await run(db, `INSERT OR IGNORE INTO ledger_accounts (id, name, type, code)
        VALUES ('1020', 'Bank Account', 'asset', '1020')`);
}

module.exports = { migrateManualCustomerReceipts };
