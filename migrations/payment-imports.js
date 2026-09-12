/**
 * Rerunnable schema migration for reviewed payment-import evidence.
 * Full raw SMS bodies and integration secrets are intentionally not represented.
 */

function run(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, error => error ? reject(error) : resolve());
    });
}

function all(db, sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

async function tableExists(db, name) {
    const rows = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '" + name.replace(/'/g, "''") + "'");
    return rows.length > 0;
}

async function ensureColumn(db, table, name, definition) {
    const columns = await all(db, `PRAGMA table_info(${table})`);
    if (!columns.some(column => column.name === name)) {
        await run(db, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

async function migratePaymentImports(db) {
    const hasCustomers = await tableExists(db, 'customers');
    const hasCustomerEvents = await tableExists(db, 'customer_account_events');
    const customerReference = hasCustomers ? ' REFERENCES customers(id) ON DELETE RESTRICT' : '';
    const eventReference = hasCustomerEvents ? ' REFERENCES customer_account_events(id) ON DELETE RESTRICT' : '';
    await run(db, `
        CREATE TABLE IF NOT EXISTS payment_imports (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL CHECK(source IN ('manual', 'webhook')),
            source_message_id TEXT,
            sender_masked TEXT,
            device_id TEXT,
            sim_slot TEXT,
            sent_at_ms INTEGER CHECK(sent_at_ms IS NULL OR sent_at_ms >= 0),
            received_at_ms INTEGER CHECK(received_at_ms IS NULL OR received_at_ms >= 0),
            transaction_at_ms INTEGER CHECK(transaction_at_ms IS NULL OR transaction_at_ms >= 0),
            status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status IN ('received', 'needs_review', 'approved', 'duplicate', 'rejected', 'reversed')),
            parser_version TEXT NOT NULL,
            message_fingerprint TEXT NOT NULL,
            dedupe_identity TEXT NOT NULL CHECK(length(trim(dedupe_identity)) > 0),
            receipt_code TEXT,
            direction TEXT NOT NULL CHECK(direction IN ('received', 'sent', 'paid', 'reversed', 'unknown')),
            event_kind TEXT NOT NULL CHECK(event_kind IN ('customer_receipt', 'send_to_person', 'paybill_payment', 'buy_goods_payment', 'reversal', 'unknown')),
            amount_minor INTEGER CHECK(amount_minor IS NULL OR amount_minor >= 0),
            currency TEXT CHECK(currency IS NULL OR currency = 'KES'),
            counterparty_name TEXT,
            counterparty_phone_masked TEXT,
            reference_masked TEXT,
            parse_warnings TEXT NOT NULL DEFAULT '[]',
            redacted_evidence TEXT NOT NULL,
            raw_retention_policy TEXT NOT NULL DEFAULT 'not_retained' CHECK(raw_retention_policy = 'not_retained'),
            has_conflict INTEGER NOT NULL DEFAULT 0 CHECK(has_conflict IN (0, 1)),
            conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0),
            conflict_fields TEXT NOT NULL DEFAULT '[]' CHECK(CASE WHEN json_valid(conflict_fields) THEN json_type(conflict_fields) = 'array' ELSE 0 END),
            last_conflict_at DATETIME,
            duplicate_of_id TEXT REFERENCES payment_imports(id) ON DELETE SET NULL,
            reversal_of_id TEXT REFERENCES payment_imports(id) ON DELETE SET NULL,
            reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at DATETIME,
            review_notes TEXT,
            approved_at DATETIME,
            rejected_at DATETIME,
            reversed_at DATETIME,
            buyer_name TEXT,
            batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
            created_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            customer_id TEXT${customerReference},
            created_account_event_id TEXT${eventReference},
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await ensureColumn(db, 'payment_imports', 'has_conflict', 'INTEGER NOT NULL DEFAULT 0 CHECK(has_conflict IN (0, 1))');
    await ensureColumn(db, 'payment_imports', 'conflict_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0)');
    await ensureColumn(db, 'payment_imports', 'conflict_fields', "TEXT NOT NULL DEFAULT '[]'");
    await ensureColumn(db, 'payment_imports', 'last_conflict_at', 'DATETIME');
    await ensureColumn(db, 'payment_imports', 'customer_id', `TEXT${customerReference}`);
    await ensureColumn(db, 'payment_imports', 'created_account_event_id', `TEXT${eventReference}`);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_conflict_fields_json_insert
        BEFORE INSERT ON payment_imports
        WHEN json_valid(NEW.conflict_fields) = 0 OR json_type(NEW.conflict_fields) <> 'array'
        BEGIN
            SELECT RAISE(ABORT, 'conflict_fields must be a JSON array');
        END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_conflict_fields_json_update
        BEFORE UPDATE OF conflict_fields ON payment_imports
        WHEN json_valid(NEW.conflict_fields) = 0 OR json_type(NEW.conflict_fields) <> 'array'
        BEGIN
            SELECT RAISE(ABORT, 'conflict_fields must be a JSON array');
        END
    `);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_status_created ON payment_imports(status, created_at DESC)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_fingerprint ON payment_imports(message_fingerprint)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_receipt_code ON payment_imports(receipt_code) WHERE receipt_code IS NOT NULL');
    await run(db, 'DROP INDEX IF EXISTS idx_payment_imports_dedupe_identity');
    await run(db, 'DROP INDEX IF EXISTS idx_payment_imports_dedupe_identity_unique');
    await run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_imports_dedupe_identity_unique ON payment_imports(dedupe_identity)');
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_dedupe_identity_nonempty_insert
        BEFORE INSERT ON payment_imports
        WHEN length(trim(NEW.dedupe_identity)) = 0
        BEGIN
            SELECT RAISE(ABORT, 'dedupe_identity must be non-empty');
        END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_dedupe_identity_nonempty_update
        BEFORE UPDATE OF dedupe_identity ON payment_imports
        WHEN length(trim(NEW.dedupe_identity)) = 0
        BEGIN
            SELECT RAISE(ABORT, 'dedupe_identity must be non-empty');
        END
    `);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_duplicate_of ON payment_imports(duplicate_of_id) WHERE duplicate_of_id IS NOT NULL');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_reversal_of ON payment_imports(reversal_of_id) WHERE reversal_of_id IS NOT NULL');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_customer ON payment_imports(customer_id) WHERE customer_id IS NOT NULL');
    await run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_imports_created_account_event ON payment_imports(created_account_event_id) WHERE created_account_event_id IS NOT NULL');

    // The generic ledger table is created by db.js before this migration in
    // production. Keep isolated migration tests and older partial schemas
    // rerunnable by adding the trace link only when that table exists.
    if (await tableExists(db, 'ledger_transactions')) {
        await ensureColumn(db, 'ledger_transactions', 'customer_account_event_id', `TEXT${eventReference}`);
        await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_customer_account_event
            ON ledger_transactions(customer_account_event_id)
            WHERE customer_account_event_id IS NOT NULL`);
    }

    // ALTER TABLE cannot add foreign-key constraints to older import tables.
    // These guards make both fresh and upgraded tables reject dangling links
    // once the customer-settlement tables are available.
    if (hasCustomers && hasCustomerEvents) {
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_customer_link_insert
            BEFORE INSERT ON payment_imports
            WHEN NEW.customer_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id)
            BEGIN SELECT RAISE(ABORT, 'payment import customer link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_customer_link_update
            BEFORE UPDATE OF customer_id ON payment_imports
            WHEN NEW.customer_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id)
            BEGIN SELECT RAISE(ABORT, 'payment import customer link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_event_link_insert
            BEFORE INSERT ON payment_imports
            WHEN NEW.created_account_event_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.created_account_event_id)
            BEGIN SELECT RAISE(ABORT, 'payment import event link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_event_link_update
            BEFORE UPDATE OF created_account_event_id ON payment_imports
            WHEN NEW.created_account_event_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.created_account_event_id)
            BEGIN SELECT RAISE(ABORT, 'payment import event link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS customers_payment_import_link_restrict_delete
            BEFORE DELETE ON customers
            WHEN EXISTS (SELECT 1 FROM payment_imports WHERE customer_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer is linked to a payment import'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS customer_events_payment_import_link_restrict_delete
            BEFORE DELETE ON customer_account_events
            WHEN EXISTS (SELECT 1 FROM payment_imports WHERE created_account_event_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer event is linked to a payment import'); END`);
        if (await tableExists(db, 'ledger_transactions')) {
            await run(db, `CREATE TRIGGER IF NOT EXISTS ledger_transactions_event_link_insert
                BEFORE INSERT ON ledger_transactions
                WHEN NEW.customer_account_event_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.customer_account_event_id)
                BEGIN SELECT RAISE(ABORT, 'ledger customer event link is invalid'); END`);
            await run(db, `CREATE TRIGGER IF NOT EXISTS ledger_transactions_event_link_update
                BEFORE UPDATE OF customer_account_event_id ON ledger_transactions
                WHEN NEW.customer_account_event_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.customer_account_event_id)
                BEGIN SELECT RAISE(ABORT, 'ledger customer event link is invalid'); END`);
            await run(db, `CREATE TRIGGER IF NOT EXISTS customer_events_ledger_link_restrict_delete
                BEFORE DELETE ON customer_account_events
                WHEN EXISTS (SELECT 1 FROM ledger_transactions WHERE customer_account_event_id = OLD.id)
                BEGIN SELECT RAISE(ABORT, 'customer event is linked to a ledger transaction'); END`);
        }
    }
}

module.exports = { migratePaymentImports };
