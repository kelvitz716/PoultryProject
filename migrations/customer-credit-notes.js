/** Rerunnable schema for posted commercial customer credit notes. */

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

const BASE_EVENT_IMMUTABILITY_TRIGGER = `CREATE TRIGGER customer_events_immutable_posted
    BEFORE UPDATE OF customer_id, currency, side, kind, amount_minor, method, external_reference,
                     payment_import_id, source_transaction_id, original_event_id, idempotency_key
    ON customer_account_events WHEN OLD.status IN ('posted', 'reversed')
    BEGIN SELECT RAISE(ABORT, 'posted customer events are immutable'); END`;

async function restoreAccidentallyReplacedBaseTrigger(db) {
    const rows = await all(db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_events_immutable_posted'");
    // A prior local draft of this migration replaced the shared base trigger to
    // add reason_code. Repair only that recognizable draft form, atomically;
    // normal runs never drop or replace the base trigger.
    if (!rows[0]?.sql || !/reason_code/i.test(rows[0].sql)) return;
    await run(db, 'SAVEPOINT restore_customer_events_immutable_posted');
    try {
        await run(db, 'DROP TRIGGER customer_events_immutable_posted');
        await run(db, BASE_EVENT_IMMUTABILITY_TRIGGER);
        await run(db, 'RELEASE SAVEPOINT restore_customer_events_immutable_posted');
    } catch (error) {
        await run(db, 'ROLLBACK TO SAVEPOINT restore_customer_events_immutable_posted').catch(() => {});
        await run(db, 'RELEASE SAVEPOINT restore_customer_events_immutable_posted').catch(() => {});
        throw error;
    }
}

const CREDIT_NOTE_TRIGGER_NAMES = [
    'customer_credit_note_immutable_posted',
    'customer_event_reason_provenance_insert',
    'customer_event_reason_provenance_update',
    'customer_credit_note_shape_insert',
    'customer_credit_note_shape_update'
];

const CREDIT_NOTE_TRIGGER_DDL = [
    `CREATE TRIGGER customer_credit_note_immutable_posted
        BEFORE UPDATE OF customer_id, currency, side, kind, status, amount_minor, method, external_reference,
                         payment_import_id, source_transaction_id, original_event_id, reason_code, idempotency_key,
                         created_by_user_id, reviewer_user_id, created_at, posted_at, reversed_at
        ON customer_account_events WHEN OLD.kind = 'credit_note' AND OLD.status = 'posted'
        BEGIN SELECT RAISE(ABORT, 'posted customer credit notes are immutable'); END`,
    `CREATE TRIGGER customer_event_reason_provenance_insert
        BEFORE INSERT ON customer_account_events
        WHEN (NEW.kind = 'credit_note' AND (NEW.reason_code IS NULL OR NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')))
          OR (NEW.kind <> 'credit_note' AND NEW.reason_code IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'invalid customer event reason provenance'); END`,
    `CREATE TRIGGER customer_event_reason_provenance_update
        BEFORE UPDATE OF kind, reason_code ON customer_account_events
        WHEN (NEW.kind = 'credit_note' AND (NEW.reason_code IS NULL OR NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')))
          OR (NEW.kind <> 'credit_note' AND NEW.reason_code IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'invalid customer event reason provenance'); END`,
    `CREATE TRIGGER customer_credit_note_shape_insert
        BEFORE INSERT ON customer_account_events
        WHEN NEW.kind = 'credit_note' AND (
            NEW.reason_code IS NULL
            OR NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')
            OR NOT EXISTS (
                SELECT 1 FROM customer_account_events original
                WHERE original.id = NEW.original_event_id
                  AND original.customer_id = NEW.customer_id
                  AND original.currency = 'KES'
                  AND original.side = 'debit'
                  AND original.kind = 'invoice'
                  AND original.status = 'posted'
            )
        )
        BEGIN SELECT RAISE(ABORT, 'invalid customer credit note evidence'); END`,
    `CREATE TRIGGER customer_credit_note_shape_update
        BEFORE UPDATE OF kind, customer_id, currency, side, status, original_event_id, reason_code
        ON customer_account_events
        WHEN NEW.kind = 'credit_note' AND (
            NEW.reason_code IS NULL
            OR NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')
            OR NOT EXISTS (
                SELECT 1 FROM customer_account_events original
                WHERE original.id = NEW.original_event_id
                  AND original.customer_id = NEW.customer_id
                  AND original.currency = 'KES'
                  AND original.side = 'debit'
                  AND original.kind = 'invoice'
                  AND original.status = 'posted'
            )
        )
        BEGIN SELECT RAISE(ABORT, 'invalid customer credit note evidence'); END`
];

async function refreshCreditNoteSpecificTriggers(db) {
    // Earlier local drafts created these trigger names with weaker predicates.
    // They are owned by this migration, so replace them as one savepoint-backed
    // unit instead of leaving stale definitions behind on a rerun.
    await run(db, 'SAVEPOINT refresh_customer_credit_note_triggers');
    try {
        for (const name of CREDIT_NOTE_TRIGGER_NAMES) {
            await run(db, `DROP TRIGGER IF EXISTS ${name}`);
        }
        for (const ddl of CREDIT_NOTE_TRIGGER_DDL) {
            await run(db, ddl);
        }
        await run(db, 'RELEASE SAVEPOINT refresh_customer_credit_note_triggers');
    } catch (error) {
        await run(db, 'ROLLBACK TO SAVEPOINT refresh_customer_credit_note_triggers').catch(() => {});
        await run(db, 'RELEASE SAVEPOINT refresh_customer_credit_note_triggers').catch(() => {});
        throw error;
    }
}

async function migrateCustomerCreditNotes(db) {
    await ensureColumn(db, 'customer_account_events', 'reason_code', 'TEXT');
    if (await tableExists(db, 'ledger_transactions')) {
        await ensureColumn(db, 'ledger_transactions', 'customer_account_event_id', 'TEXT');
        await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_customer_account_event
            ON ledger_transactions(customer_account_event_id)
            WHERE customer_account_event_id IS NOT NULL`);
    }
    await run(db, `CREATE TABLE IF NOT EXISTS customer_credit_note_operations (
        idempotency_key TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        invoice_event_id TEXT NOT NULL REFERENCES customer_account_events(id) ON DELETE RESTRICT,
        credit_note_event_id TEXT NOT NULL UNIQUE REFERENCES customer_account_events(id) ON DELETE RESTRICT,
        ledger_transaction_id TEXT NOT NULL UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
        auto_allocation_id TEXT UNIQUE REFERENCES customer_account_allocations(id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        automatically_allocated_minor INTEGER NOT NULL CHECK(automatically_allocated_minor >= 0),
        remaining_credit_minor INTEGER NOT NULL CHECK(remaining_credit_minor >= 0),
        reason_code TEXT NOT NULL CHECK(reason_code IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')),
        external_reference TEXT,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK(automatically_allocated_minor + remaining_credit_minor = amount_minor),
        CHECK((auto_allocation_id IS NULL AND automatically_allocated_minor = 0)
           OR (auto_allocation_id IS NOT NULL AND automatically_allocated_minor > 0))
    )`);
    await run(db, `CREATE INDEX IF NOT EXISTS idx_customer_credit_note_operations_invoice
        ON customer_credit_note_operations(invoice_event_id, created_at DESC)`);
    await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_credit_note_reference
        ON customer_account_events(external_reference)
        WHERE kind = 'credit_note' AND external_reference IS NOT NULL`);
    await restoreAccidentallyReplacedBaseTrigger(db);
    // Add credit-note-specific guards without altering the shared base event
    // trigger. This repair also upgrades weak early local trigger definitions.
    await refreshCreditNoteSpecificTriggers(db);
    await run(db, `CREATE TRIGGER IF NOT EXISTS customer_credit_note_event_restrict_delete
        BEFORE DELETE ON customer_account_events
        WHEN EXISTS (SELECT 1 FROM customer_credit_note_operations WHERE credit_note_event_id = OLD.id OR invoice_event_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'customer event is linked to a credit note'); END`);
    if (await tableExists(db, 'ledger_transactions')) {
        await run(db, `CREATE TRIGGER IF NOT EXISTS customer_credit_note_ledger_restrict_delete
            BEFORE DELETE ON ledger_transactions
            WHEN EXISTS (SELECT 1 FROM customer_credit_note_operations WHERE ledger_transaction_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'ledger transaction is linked to a credit note'); END`);
    }
    await run(db, `INSERT OR IGNORE INTO ledger_accounts (id, name, type, code)
        VALUES ('4050', 'Sales Returns and Allowances', 'revenue', '4050')`);
}

module.exports = { migrateCustomerCreditNotes };
