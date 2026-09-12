const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { migratePaymentImports } = require('../../migrations/payment-imports');
const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, error => error ? reject(error) : resolve());
    });
}

function all(db, sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

test('payment-import migration is rerunnable, constrained, indexed, and has no raw SMS column', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await migratePaymentImports(db);
    await migratePaymentImports(db);

    const columns = await all(db, 'PRAGMA table_info(payment_imports)');
    const names = columns.map(column => column.name);
    for (const required of ['id', 'source', 'sender_masked', 'device_id', 'sim_slot', 'sent_at_ms', 'received_at_ms', 'status', 'parser_version', 'message_fingerprint', 'dedupe_identity', 'receipt_code', 'direction', 'event_kind', 'amount_minor', 'currency', 'counterparty_name', 'reference_masked', 'parse_warnings', 'redacted_evidence', 'has_conflict', 'conflict_count', 'conflict_fields', 'last_conflict_at', 'duplicate_of_id', 'reversal_of_id', 'reviewer_user_id', 'buyer_name', 'batch_id', 'created_transaction_id', 'customer_id', 'created_account_event_id', 'created_at', 'updated_at']) {
        assert.ok(names.includes(required), `missing ${required}`);
    }
    assert.ok(!names.some(name => /raw.*sms|raw.*body/i.test(name)));
    const schema = await all(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_imports'");
    assert.match(schema[0].sql, /dedupe_identity TEXT NOT NULL CHECK\(length\(trim\(dedupe_identity\)\) > 0\)/);

    const indexes = await all(db, 'PRAGMA index_list(payment_imports)');
    assert.ok(indexes.some(index => index.name === 'idx_payment_imports_fingerprint'));
    assert.ok(indexes.some(index => index.name === 'idx_payment_imports_receipt_code'));
    assert.ok(indexes.some(index => index.name === 'idx_payment_imports_dedupe_identity_unique' && index.unique === 1));
    assert.ok(indexes.some(index => index.name === 'idx_payment_imports_created_account_event' && index.unique === 1));

    await run(db, "INSERT INTO users (id) VALUES ('reviewer-1')");
    await run(db, "INSERT INTO batches (id) VALUES ('batch-1')");
    await run(db, "INSERT INTO transactions (id) VALUES ('transaction-1')");
    await run(db, `
        INSERT INTO payment_imports (
            id, source, sender_masked, status, parser_version, message_fingerprint,
            dedupe_identity, direction, event_kind, amount_minor, currency,
            parse_warnings, redacted_evidence, reviewer_user_id, batch_id, created_transaction_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ['import-1', 'manual', '••••5678', 'received', 'mpesa-sms-v1', 'fingerprint-1', 'receipt:QWE123ABC', 'received', 'customer_receipt', 125050, 'KES', '[]', 'QWE123ABC Confirmed. Ksh1,250.50 received.', 'reviewer-1', 'batch-1', 'transaction-1']);
    const imported = await all(db, "SELECT has_conflict, conflict_count, conflict_fields, last_conflict_at FROM payment_imports WHERE id = 'import-1'");
    assert.deepEqual(imported[0], { has_conflict: 0, conflict_count: 0, conflict_fields: '[]', last_conflict_at: null });

    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, parse_warnings, redacted_evidence) VALUES ('duplicate-dedupe', 'webhook', 'duplicate', 'v1', 'fingerprint-2', 'receipt:QWE123ABC', 'unknown', 'unknown', '[]', 'redacted')"),
        /UNIQUE constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, parse_warnings, redacted_evidence) VALUES ('empty-dedupe', 'manual', 'needs_review', 'v1', 'fingerprint-3', '', 'unknown', 'unknown', '[]', 'redacted')"),
        /dedupe_identity must be non-empty|CHECK constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, parse_warnings, redacted_evidence) VALUES ('blank-dedupe', 'manual', 'needs_review', 'v1', 'fingerprint-4', '   ', 'unknown', 'unknown', '[]', 'redacted')"),
        /dedupe_identity must be non-empty|CHECK constraint failed/
    );

    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, parse_warnings, redacted_evidence) VALUES ('bad-source', 'daraja', 'needs_review', 'v1', 'f', 'd', 'unknown', 'unknown', '[]', 'redacted')"),
        /CHECK constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, amount_minor, parse_warnings, redacted_evidence) VALUES ('bad-amount', 'manual', 'needs_review', 'v1', 'f2', 'd2', 'unknown', 'unknown', -1, '[]', 'redacted')"),
        /CHECK constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, parse_warnings, conflict_fields, redacted_evidence) VALUES ('bad-conflict-json', 'manual', 'needs_review', 'v1', 'f3', 'd3', 'unknown', 'unknown', '[]', '{bad', 'redacted')"),
        /conflict_fields must be a JSON array|malformed JSON|CHECK constraint failed/
    );
});

test('adds durable conflict metadata to an existing payment-import table without rewriting its row', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-existing-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, `
        CREATE TABLE payment_imports (
            id TEXT PRIMARY KEY, status TEXT, created_at DATETIME,
            message_fingerprint TEXT, receipt_code TEXT, dedupe_identity TEXT,
            duplicate_of_id TEXT, reversal_of_id TEXT
        )
    `);
    await run(db, "INSERT INTO payment_imports (id, status, created_at, message_fingerprint, dedupe_identity) VALUES ('legacy-1', 'received', CURRENT_TIMESTAMP, 'fp', 'receipt:LEGACY001')");
    await migratePaymentImports(db);
    const row = (await all(db, "SELECT id, status, has_conflict, conflict_count, conflict_fields, last_conflict_at FROM payment_imports WHERE id = 'legacy-1'"))[0];
    assert.deepEqual(row, { id: 'legacy-1', status: 'received', has_conflict: 0, conflict_count: 0, conflict_fields: '[]', last_conflict_at: null });
});

test('actual production migration order enforces durable customer, event, and ledger link guards', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-import-link-order-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT)');
    await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, transaction_id TEXT, account_id TEXT, entry_type TEXT, amount REAL)');
    await migrateCustomerSettlement(db);
    await migratePaymentImports(db);
    await migratePaymentImports(db);
    await run(db, "INSERT INTO customers (id, display_name, normalized_name) VALUES ('customer-1', 'Customer 1', 'CUSTOMER 1')");
    await run(db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, idempotency_key)
        VALUES ('event-1', 'customer-1', 'KES', 'debit', 'invoice', 'posted', 100, 'invoice-event-1')`);
    await run(db, `INSERT INTO payment_imports
        (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind,
         parse_warnings, redacted_evidence, customer_id, created_account_event_id)
        VALUES ('import-link-1', 'manual', 'received', 'v1', 'fingerprint-link-1', 'receipt:LINK1234',
                'received', 'customer_receipt', '[]', 'LINK1234 Confirmed.', 'customer-1', 'event-1')`);
    await assert.rejects(run(db, "UPDATE payment_imports SET customer_id = 'missing' WHERE id = 'import-link-1'"), /customer link is invalid|FOREIGN KEY/);
    await assert.rejects(run(db, "UPDATE payment_imports SET created_account_event_id = 'missing' WHERE id = 'import-link-1'"), /event link is invalid|FOREIGN KEY/);
    await assert.rejects(run(db, "INSERT INTO ledger_transactions (id, date, customer_account_event_id) VALUES ('bad-ledger', CURRENT_TIMESTAMP, 'missing')"), /ledger customer event link is invalid|FOREIGN KEY/);
    await assert.rejects(run(db, "DELETE FROM customers WHERE id = 'customer-1'"), /linked to a payment import|FOREIGN KEY/);
    await assert.rejects(run(db, "DELETE FROM customer_account_events WHERE id = 'event-1'"), /linked to a payment import|linked to a ledger transaction|FOREIGN KEY/);
    const ledgerColumns = await all(db, 'PRAGMA table_info(ledger_transactions)');
    assert.ok(ledgerColumns.some(column => column.name === 'customer_account_event_id'));
    const ledgerIndexes = await all(db, 'PRAGMA index_list(ledger_transactions)');
    assert.ok(ledgerIndexes.some(index => index.name === 'idx_ledger_transactions_customer_account_event' && index.unique === 1));
    const triggers = await all(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%payment_import%link%' OR name LIKE '%ledger_transactions_event_link%'");
    assert.deepEqual(new Set(triggers.map(trigger => trigger.name)).has('payment_imports_customer_link_update'), true);
    assert.deepEqual(new Set(triggers.map(trigger => trigger.name)).has('payment_imports_event_link_update'), true);
    assert.deepEqual(new Set(triggers.map(trigger => trigger.name)).has('ledger_transactions_event_link_insert'), true);
});
