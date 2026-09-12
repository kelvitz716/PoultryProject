/** Rerunnable provenance and integrity guards for explicit customer refunds. */

function run(db, sql) {
    return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
}

function all(db, sql) {
    return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function tableExists(db, table) {
    const rows = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '" + table + "'");
    return rows.length > 0;
}

async function ensureColumn(db, table, name, definition) {
    const columns = await all(db, `PRAGMA table_info(${table})`);
    if (!columns.some(column => column.name === name)) {
        await run(db, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

const REFUND_TRIGGER_NAMES = [
    'customer_refund_immutable_posted',
    'customer_refund_event_shape_insert',
    'customer_refund_event_shape_update',
    'customer_refund_event_restrict_delete',
    'customer_refund_ledger_restrict_delete',
    'customer_refund_allocation_restrict_delete',
    'customer_refund_allocation_immutable',
    'customer_refund_allocation_operation_immutable',
    'customer_refund_allocation_operation_restrict_delete',
    'customer_refund_operation_shape_insert',
    'customer_refund_operation_shape_update',
    'customer_refund_operation_immutable',
    'customer_refund_operation_restrict_delete',
    'customer_refund_source_allocation_shape_insert',
    'customer_refund_source_allocation_shape_update',
    'customer_refund_source_allocation_immutable',
    'customer_refund_source_allocation_restrict_delete'
];

async function refreshRefundTriggers(db, hasLedgerTransactions) {
    const ddl = [
        `CREATE TRIGGER customer_refund_immutable_posted
            BEFORE UPDATE OF customer_id, currency, side, kind, status, amount_minor, method, external_reference,
                             payment_import_id, source_transaction_id, original_event_id, reason_code, idempotency_key,
                             created_by_user_id, reviewer_user_id, created_at, posted_at, reversed_at
            ON customer_account_events WHEN OLD.kind = 'refund' AND OLD.status = 'posted'
            BEGIN SELECT RAISE(ABORT, 'posted customer refunds are immutable'); END`,
        `CREATE TRIGGER customer_refund_event_shape_insert
            BEFORE INSERT ON customer_account_events
            WHEN NEW.kind = 'refund' AND (
                NEW.customer_id IS NULL OR NEW.currency <> 'KES' OR NEW.side <> 'debit' OR NEW.status <> 'posted'
                OR NEW.method NOT IN ('cash', 'mpesa', 'bank')
                OR (NEW.method IN ('bank', 'mpesa') AND (NEW.external_reference IS NULL OR length(trim(NEW.external_reference)) = 0))
                OR NEW.reason_code IS NOT NULL
                OR NEW.payment_import_id IS NOT NULL OR NEW.source_transaction_id IS NOT NULL OR NEW.original_event_id IS NOT NULL
            )
            BEGIN SELECT RAISE(ABORT, 'invalid customer refund evidence'); END`,
        `CREATE TRIGGER customer_refund_event_shape_update
            BEFORE UPDATE OF customer_id, currency, side, kind, status, method, external_reference, payment_import_id,
                             source_transaction_id, original_event_id, reason_code
            ON customer_account_events
            WHEN NEW.kind = 'refund' AND (
                NEW.customer_id IS NULL OR NEW.currency <> 'KES' OR NEW.side <> 'debit' OR NEW.status <> 'posted'
                OR NEW.method NOT IN ('cash', 'mpesa', 'bank')
                OR (NEW.method IN ('bank', 'mpesa') AND (NEW.external_reference IS NULL OR length(trim(NEW.external_reference)) = 0))
                OR NEW.reason_code IS NOT NULL
                OR NEW.payment_import_id IS NOT NULL OR NEW.source_transaction_id IS NOT NULL OR NEW.original_event_id IS NOT NULL
            )
            BEGIN SELECT RAISE(ABORT, 'invalid customer refund evidence'); END`,
        `CREATE TRIGGER customer_refund_event_restrict_delete
            BEFORE DELETE ON customer_account_events
            WHEN EXISTS (SELECT 1 FROM customer_refund_operations WHERE refund_event_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer event is linked to a refund'); END`,
        `CREATE TRIGGER customer_refund_allocation_restrict_delete
            BEFORE DELETE ON customer_account_allocations
            WHEN EXISTS (SELECT 1 FROM customer_refund_source_allocations WHERE allocation_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer allocation is linked to a refund'); END`,
        `CREATE TRIGGER customer_refund_allocation_immutable
            BEFORE UPDATE OF status, reversed_by_user_id, reversed_at ON customer_account_allocations
            WHEN EXISTS (SELECT 1 FROM customer_refund_source_allocations WHERE allocation_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer allocation is linked to a refund'); END`,
        `CREATE TRIGGER customer_refund_allocation_operation_immutable
            BEFORE UPDATE ON customer_allocation_operations
            WHEN EXISTS (SELECT 1 FROM customer_refund_source_allocations links WHERE links.allocation_id = OLD.allocation_id)
            BEGIN SELECT RAISE(ABORT, 'customer allocation operation is linked to a refund'); END`,
        `CREATE TRIGGER customer_refund_allocation_operation_restrict_delete
            BEFORE DELETE ON customer_allocation_operations
            WHEN EXISTS (SELECT 1 FROM customer_refund_source_allocations links WHERE links.allocation_id = OLD.allocation_id)
            BEGIN SELECT RAISE(ABORT, 'customer allocation operation is linked to a refund'); END`,
        `CREATE TRIGGER customer_refund_operation_shape_insert
            BEFORE INSERT ON customer_refund_operations
            WHEN NEW.method NOT IN ('cash', 'mpesa', 'bank')
              OR NEW.amount_minor <= 0
              OR NEW.reason_code NOT IN ('overpayment', 'duplicate_payment', 'customer_request', 'returned_goods', 'other')
              OR NEW.method_difference NOT IN (0, 1)
              OR NEW.acknowledge_method_difference NOT IN (0, 1)
              OR (NEW.method_difference = 1 AND NEW.acknowledge_method_difference <> 1)
              OR (NEW.method IN ('bank', 'mpesa') AND (NEW.external_reference IS NULL OR length(trim(NEW.external_reference)) = 0))
            BEGIN SELECT RAISE(ABORT, 'invalid customer refund operation'); END`,
        `CREATE TRIGGER customer_refund_operation_shape_update
            BEFORE UPDATE OF method, amount_minor, external_reference, reason_code, method_difference, acknowledge_method_difference
            ON customer_refund_operations
            WHEN NEW.method NOT IN ('cash', 'mpesa', 'bank')
              OR NEW.amount_minor <= 0
              OR NEW.reason_code NOT IN ('overpayment', 'duplicate_payment', 'customer_request', 'returned_goods', 'other')
              OR NEW.method_difference NOT IN (0, 1)
              OR NEW.acknowledge_method_difference NOT IN (0, 1)
              OR (NEW.method_difference = 1 AND NEW.acknowledge_method_difference <> 1)
              OR (NEW.method IN ('bank', 'mpesa') AND (NEW.external_reference IS NULL OR length(trim(NEW.external_reference)) = 0))
            BEGIN SELECT RAISE(ABORT, 'invalid customer refund operation'); END`,
        `CREATE TRIGGER customer_refund_operation_immutable
            BEFORE UPDATE ON customer_refund_operations
            BEGIN SELECT RAISE(ABORT, 'customer refund operation is immutable'); END`,
        `CREATE TRIGGER customer_refund_operation_restrict_delete
            BEFORE DELETE ON customer_refund_operations
            BEGIN SELECT RAISE(ABORT, 'customer refund operation cannot be deleted'); END`,
        `CREATE TRIGGER customer_refund_source_allocation_shape_insert
            BEFORE INSERT ON customer_refund_source_allocations
            WHEN NEW.source_ordinal < 0 OR NEW.source_ordinal > 49 OR NEW.amount_minor <= 0
            BEGIN SELECT RAISE(ABORT, 'invalid customer refund source evidence'); END`,
        `CREATE TRIGGER customer_refund_source_allocation_shape_update
            BEFORE UPDATE OF source_ordinal, amount_minor ON customer_refund_source_allocations
            WHEN NEW.source_ordinal < 0 OR NEW.source_ordinal > 49 OR NEW.amount_minor <= 0
            BEGIN SELECT RAISE(ABORT, 'invalid customer refund source evidence'); END`,
        `CREATE TRIGGER customer_refund_source_allocation_immutable
            BEFORE UPDATE ON customer_refund_source_allocations
            BEGIN SELECT RAISE(ABORT, 'customer refund source evidence is immutable'); END`,
        `CREATE TRIGGER customer_refund_source_allocation_restrict_delete
            BEFORE DELETE ON customer_refund_source_allocations
            BEGIN SELECT RAISE(ABORT, 'customer refund source evidence cannot be deleted'); END`
    ];
    if (hasLedgerTransactions) ddl.splice(4, 0, `CREATE TRIGGER customer_refund_ledger_restrict_delete
        BEFORE DELETE ON ledger_transactions
        WHEN EXISTS (SELECT 1 FROM customer_refund_operations WHERE ledger_transaction_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'ledger transaction is linked to a refund'); END`);
    await run(db, 'SAVEPOINT refresh_customer_refund_triggers');
    try {
        for (const name of REFUND_TRIGGER_NAMES) await run(db, `DROP TRIGGER IF EXISTS ${name}`);
        for (const statement of ddl) await run(db, statement);
        await run(db, 'RELEASE SAVEPOINT refresh_customer_refund_triggers');
    } catch (error) {
        await run(db, 'ROLLBACK TO SAVEPOINT refresh_customer_refund_triggers').catch(() => {});
        await run(db, 'RELEASE SAVEPOINT refresh_customer_refund_triggers').catch(() => {});
        throw error;
    }
}

async function migrateCustomerRefunds(db) {
    if (await tableExists(db, 'ledger_transactions')) {
        await ensureColumn(db, 'ledger_transactions', 'customer_account_event_id', 'TEXT');
        await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_customer_account_event
            ON ledger_transactions(customer_account_event_id)
            WHERE customer_account_event_id IS NOT NULL`);
    }

    await run(db, `CREATE TABLE IF NOT EXISTS customer_refund_operations (
        idempotency_key TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        refund_event_id TEXT NOT NULL UNIQUE REFERENCES customer_account_events(id) ON DELETE RESTRICT,
        ledger_transaction_id TEXT NOT NULL UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
        method TEXT NOT NULL CHECK(method IN ('cash', 'mpesa', 'bank')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        external_reference TEXT,
        reason_code TEXT NOT NULL CHECK(reason_code IN ('overpayment', 'duplicate_payment', 'customer_request', 'returned_goods', 'other')),
        method_difference INTEGER NOT NULL CHECK(method_difference IN (0, 1)),
        acknowledge_method_difference INTEGER NOT NULL CHECK(acknowledge_method_difference IN (0, 1)),
        sources_json TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK(method_difference = 0 OR acknowledge_method_difference = 1),
        CHECK(method = 'cash' OR external_reference IS NOT NULL)
    )`);
    await run(db, `CREATE TABLE IF NOT EXISTS customer_refund_source_allocations (
        refund_idempotency_key TEXT NOT NULL REFERENCES customer_refund_operations(idempotency_key) ON DELETE RESTRICT,
        source_ordinal INTEGER NOT NULL CHECK(source_ordinal BETWEEN 0 AND 49),
        credit_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
        allocation_id TEXT NOT NULL UNIQUE REFERENCES customer_account_allocations(id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        PRIMARY KEY(refund_idempotency_key, source_ordinal),
        UNIQUE(refund_idempotency_key, credit_event_id)
    )`);
    await run(db, `CREATE INDEX IF NOT EXISTS idx_customer_refund_operations_customer
        ON customer_refund_operations(customer_id, created_at DESC)`);
    await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_events_refund_reference
        ON customer_account_events(method, external_reference)
        WHERE kind = 'refund' AND external_reference IS NOT NULL`);

    // These guards are additive and only govern refund evidence. They do not
    // replace the shared settlement or credit-note trigger set. Replace only
    // this migration's names, inside a savepoint, to repair weak local drafts.
    await refreshRefundTriggers(db, await tableExists(db, 'ledger_transactions'));
}

module.exports = { migrateCustomerRefunds };
