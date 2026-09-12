/** Rerunnable normalized customer-settlement schema. All money is integer KES cents. */

function run(db, sql) {
    return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
}
function all(db, sql) { return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows))); }
async function ensureColumn(db, table, name, definition) {
    const columns = await all(db, `PRAGMA table_info(${table})`);
    if (!columns.some(column => column.name === name)) await run(db, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

async function migrateCustomerSettlement(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            created_by_user_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await ensureColumn(db, 'customers', 'is_active', 'INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1))');
    await ensureColumn(db, 'customers', 'payment_terms_days', 'INTEGER NOT NULL DEFAULT 0 CHECK(payment_terms_days BETWEEN 0 AND 365)');
    await ensureColumn(db, 'customers', 'contact_phone', 'TEXT');
    await ensureColumn(db, 'customers', 'updated_by_user_id', 'TEXT');
    await run(db, `CREATE TABLE IF NOT EXISTS customer_registry_operations (
        idempotency_key TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'deactivate')),
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT, fingerprint TEXT NOT NULL,
        result_snapshot TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await ensureColumn(db, 'customer_registry_operations', 'result_snapshot', "TEXT NOT NULL DEFAULT '{}'");
    await run(db, `
        CREATE TABLE IF NOT EXISTS legacy_customer_links (
            source_key TEXT NOT NULL DEFAULT 'poultryFarmProfile' CHECK(source_key = 'poultryFarmProfile'),
            legacy_record_identity TEXT NOT NULL,
            occurrence_ordinal INTEGER NOT NULL CHECK(occurrence_ordinal >= 0),
            customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            created_by_user_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(source_key, legacy_record_identity, occurrence_ordinal),
            UNIQUE(customer_id)
        )
    `);
    await run(db, `
        CREATE TABLE IF NOT EXISTS customer_account_events (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            currency TEXT NOT NULL DEFAULT 'KES' CHECK(currency = 'KES'),
            side TEXT NOT NULL CHECK(side IN ('debit', 'credit')),
            kind TEXT NOT NULL CHECK(kind IN ('invoice', 'debit_note', 'refund', 'payment_reversal', 'payment', 'credit_note', 'write_off')),
            status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('draft', 'posted')),
            amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
            method TEXT CHECK(method IS NULL OR method IN ('cash', 'mpesa', 'bank')),
            external_reference TEXT,
            payment_import_id TEXT REFERENCES payment_imports(id) ON DELETE RESTRICT,
            source_transaction_id TEXT,
            original_event_id TEXT REFERENCES customer_account_events(id) ON DELETE RESTRICT,
            reason_code TEXT,
            idempotency_key TEXT NOT NULL UNIQUE,
            created_by_user_id TEXT,
            reviewer_user_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            posted_at DATETIME,
            reversed_at DATETIME,
            CHECK((side = 'debit' AND kind IN ('invoice', 'debit_note', 'refund', 'payment_reversal'))
               OR (side = 'credit' AND kind IN ('payment', 'credit_note', 'write_off'))),
            CHECK((kind IN ('payment', 'refund', 'payment_reversal') AND method IS NOT NULL)
               OR (kind NOT IN ('payment', 'refund', 'payment_reversal') AND method IS NULL)),
            CHECK(payment_import_id IS NULL OR (kind = 'payment' AND method = 'mpesa')),
            CHECK((kind IN ('credit_note', 'payment_reversal') AND original_event_id IS NOT NULL)
               OR (kind NOT IN ('credit_note', 'payment_reversal') AND original_event_id IS NULL))
        )
    `);
    await ensureColumn(db, 'customer_account_events', 'payment_import_id', 'TEXT');
    await ensureColumn(db, 'customer_account_events', 'source_transaction_id', 'TEXT');
    await ensureColumn(db, 'customer_account_events', 'original_event_id', 'TEXT');
    await ensureColumn(db, 'customer_account_events', 'reviewer_user_id', 'TEXT');
    await ensureColumn(db, 'customer_account_events', 'reason_code', 'TEXT');
    await run(db, `
        CREATE TABLE IF NOT EXISTS customer_account_allocations (
            id TEXT PRIMARY KEY,
            credit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
            debit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
            amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'reversed')),
            idempotency_key TEXT NOT NULL UNIQUE,
            created_by_user_id TEXT,
            reversed_by_user_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reversed_at DATETIME,
            CHECK(credit_event_id <> debit_event_id)
        )
    `);
    await run(db, `
        CREATE TABLE IF NOT EXISTS customer_allocation_operations (
            idempotency_key TEXT PRIMARY KEY,
            allocation_id TEXT NOT NULL UNIQUE REFERENCES customer_account_allocations(id) ON DELETE RESTRICT,
            credit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
            debit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
            amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
            created_by_user_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await run(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_events_payment_import ON customer_account_events(payment_import_id) WHERE payment_import_id IS NOT NULL");
    await run(db, 'DROP INDEX IF EXISTS idx_customer_events_payment_reference');
    await run(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_events_payment_reference ON customer_account_events(method, external_reference) WHERE kind = 'payment' AND external_reference IS NOT NULL");
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_customers_normalized_name ON customers(normalized_name)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_legacy_customer_links_customer ON legacy_customer_links(customer_id)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_customer_events_customer ON customer_account_events(customer_id, currency, status)');
    await run(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_events_invoice_source_transaction ON customer_account_events(source_transaction_id) WHERE kind = 'invoice' AND source_transaction_id IS NOT NULL");
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_customer_allocations_credit ON customer_account_allocations(credit_event_id, status)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_customer_allocations_debit ON customer_account_allocations(debit_event_id, status)');
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS customer_events_immutable_posted
        BEFORE UPDATE OF customer_id, currency, side, kind, amount_minor, method, external_reference, payment_import_id, source_transaction_id, original_event_id, idempotency_key
        ON customer_account_events WHEN OLD.status IN ('posted', 'reversed')
        BEGIN SELECT RAISE(ABORT, 'posted customer events are immutable'); END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS customer_events_provenance_shape_insert
        BEFORE INSERT ON customer_account_events
        WHEN (NEW.payment_import_id IS NOT NULL AND NOT (NEW.kind = 'payment' AND NEW.method = 'mpesa'))
          OR (NEW.kind IN ('credit_note', 'payment_reversal') AND NEW.original_event_id IS NULL)
          OR (NEW.kind NOT IN ('credit_note', 'payment_reversal') AND NEW.original_event_id IS NOT NULL)
          OR (NEW.kind = 'credit_note' AND (NEW.reason_code IS NULL OR NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')))
          OR (NEW.kind <> 'credit_note' AND NEW.reason_code IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'invalid customer event provenance'); END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS customer_events_provenance_shape_update
        BEFORE UPDATE OF kind, method, payment_import_id, original_event_id, reason_code ON customer_account_events
        WHEN (NEW.payment_import_id IS NOT NULL AND NOT (NEW.kind = 'payment' AND NEW.method = 'mpesa'))
          OR (NEW.kind IN ('credit_note', 'payment_reversal') AND NEW.original_event_id IS NULL)
          OR (NEW.kind NOT IN ('credit_note', 'payment_reversal') AND NEW.original_event_id IS NOT NULL)
          OR (NEW.kind = 'credit_note' AND (NEW.reason_code IS NULL OR NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')))
          OR (NEW.kind <> 'credit_note' AND NEW.reason_code IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'invalid customer event provenance'); END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS customer_allocations_immutable_links
        BEFORE UPDATE OF credit_event_id, debit_event_id, amount_minor, idempotency_key
        ON customer_account_allocations
        BEGIN SELECT RAISE(ABORT, 'customer allocation links are immutable'); END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS customer_allocations_reversal_shape_insert
        BEFORE INSERT ON customer_account_allocations
        WHEN (NEW.status = 'active' AND (NEW.reversed_by_user_id IS NOT NULL OR NEW.reversed_at IS NOT NULL))
          OR (NEW.status = 'reversed' AND (NEW.reversed_by_user_id IS NULL OR NEW.reversed_at IS NULL))
        BEGIN SELECT RAISE(ABORT, 'invalid customer allocation reversal provenance'); END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS customer_allocations_reversal_shape_update
        BEFORE UPDATE OF status, reversed_by_user_id, reversed_at ON customer_account_allocations
        WHEN (NEW.status = 'active' AND (NEW.reversed_by_user_id IS NOT NULL OR NEW.reversed_at IS NOT NULL))
          OR (NEW.status = 'reversed' AND (NEW.reversed_by_user_id IS NULL OR NEW.reversed_at IS NULL))
        BEGIN SELECT RAISE(ABORT, 'invalid customer allocation reversal provenance'); END
    `);
}

module.exports = { migrateCustomerSettlement };
