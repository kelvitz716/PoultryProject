const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { migratePaymentImports } = require('../../migrations/payment-imports');
const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { ingestPaymentImport, listPaymentImports } = require('../../services/payment-imports');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { createPaymentImportApprovalService } = require('../../services/payment-import-approval');
const { rejectPaymentImport, PaymentImportStateConflictError } = require('../../services/payment-import-review');

const PRE_19C_PAYMENT_IMPORT_SCHEMA = `CREATE TABLE payment_imports (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(source IN ('manual', 'webhook')),
    source_message_id TEXT, sender_masked TEXT, device_id TEXT, sim_slot TEXT,
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
    counterparty_name TEXT, counterparty_phone_masked TEXT, reference_masked TEXT,
    parse_warnings TEXT NOT NULL DEFAULT '[]', redacted_evidence TEXT NOT NULL,
    raw_retention_policy TEXT NOT NULL DEFAULT 'not_retained' CHECK(raw_retention_policy = 'not_retained'),
    has_conflict INTEGER NOT NULL DEFAULT 0 CHECK(has_conflict IN (0, 1)),
    conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0),
    conflict_fields TEXT NOT NULL DEFAULT '[]' CHECK(CASE WHEN json_valid(conflict_fields) THEN json_type(conflict_fields) = 'array' ELSE 0 END),
    last_conflict_at DATETIME,
    duplicate_of_id TEXT REFERENCES payment_imports(id) ON DELETE SET NULL,
    reversal_of_id TEXT REFERENCES payment_imports(id) ON DELETE SET NULL,
    reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at DATETIME, review_notes TEXT, approved_at DATETIME, rejected_at DATETIME, reversed_at DATETIME,
    buyer_name TEXT, batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
    created_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
    created_account_event_id TEXT REFERENCES customer_account_events(id) ON DELETE RESTRICT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function adapter(db) {
    return {
        runQuery: (sql, params = []) => run(db, sql, params),
        getQuery: (sql, params = []) => get(db, sql, params),
        allQuery: (sql, params = []) => all(db, sql, params)
    };
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function databaseSnapshot(db) {
    const schema = await all(db, `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`);
    const rows = {};
    for (const table of schema.filter(object => object.type === 'table').map(object => object.name)) {
        assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/);
        rows[table] = await all(db, `SELECT rowid, * FROM ${table} ORDER BY rowid`);
    }
    return { schema, rows };
}

async function assertMigrationFailsWithoutMutation(t, name, setup, expectedError) {
    await t.test(name, async st => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-fail-closed-'));
        const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
        st.after(async () => {
            await close(db);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
        await run(db, 'PRAGMA foreign_keys = ON');
        await setup(db);
        const before = await databaseSnapshot(db);
        await assert.rejects(migratePaymentImports(db), expectedError);
        assert.equal((await get(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
        assert.deepEqual(await databaseSnapshot(db), before);
    });
}

async function setupProvableApprovedFixture(db, importId = 'approved-fixture') {
    const digest = crypto.createHash('sha256').update(`payment-import-approval:${importId}`).digest('hex');
    const eventId = `payment:${digest.slice(0, 40)}`;
    const eventKey = `payment:${digest.slice(0, 48)}`;
    const ledgerId = `ledger-payment:${digest.slice(0, 36)}`;
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
    await run(db, "INSERT INTO users VALUES ('reviewer-1')");
    await run(db, "INSERT INTO customers VALUES ('customer-1')");
    await run(db, `CREATE TABLE payment_imports (
        id TEXT PRIMARY KEY, status TEXT, receipt_code TEXT, amount_minor INTEGER,
        reviewer_user_id TEXT, customer_id TEXT, created_account_event_id TEXT,
        created_transaction_id TEXT, reversal_of_id TEXT, redacted_evidence TEXT
    )`);
    await run(db, `INSERT INTO payment_imports VALUES
        (?, 'approved', 'APR1234XYZ', 10000, 'reviewer-1', 'customer-1', ?, NULL, NULL,
         'APR1234XYZ Confirmed. Ksh100.00 received.')`, [importId, eventId]);
    await run(db, `CREATE TABLE customer_account_events (
        id TEXT PRIMARY KEY, customer_id TEXT, currency TEXT, side TEXT, kind TEXT, status TEXT,
        amount_minor INTEGER, method TEXT, external_reference TEXT, payment_import_id TEXT,
        idempotency_key TEXT, created_by_user_id TEXT, reviewer_user_id TEXT
    )`);
    await run(db, `INSERT INTO customer_account_events VALUES
        (?, 'customer-1', 'KES', 'credit', 'payment', 'posted', 10000, 'mpesa',
         'APR1234XYZ', ?, ?, 'reviewer-1', 'reviewer-1')`, [eventId, importId, eventKey]);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
        customer_account_event_id TEXT
    )`);
    await run(db, `INSERT INTO ledger_transactions VALUES
        (?, '2026-01-01', 'payment_import_approval', ?, ?)`, [ledgerId, importId, eventId]);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT, account_id TEXT, entry_type TEXT,
        amount REAL, amount_minor INTEGER, reconciliation_status TEXT
    )`);
    await run(db, `INSERT INTO ledger_entries VALUES
        (?, ?, '1010', 'debit', 100, 10000, 'exact'),
        (?, ?, '1200', 'credit', 100, 10000, 'exact')`,
    [`${ledgerId}:dr`, ledgerId, `${ledgerId}:cr`, ledgerId]);
    return { importId, eventId, eventKey, ledgerId };
}

async function setupCanonicalApprovedFixture(db, importId = 'canonical-approved') {
    const digest = crypto.createHash('sha256').update(`payment-import-approval:${importId}`).digest('hex');
    const eventId = `payment:${digest.slice(0, 40)}`;
    const eventKey = `payment:${digest.slice(0, 48)}`;
    const ledgerId = `ledger-payment:${digest.slice(0, 36)}`;
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
    await run(db, `CREATE TABLE customer_account_events (
        id TEXT PRIMARY KEY, customer_id TEXT, currency TEXT, side TEXT, kind TEXT, status TEXT,
        amount_minor INTEGER, method TEXT, external_reference TEXT, payment_import_id TEXT,
        idempotency_key TEXT, created_by_user_id TEXT, reviewer_user_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
        customer_account_event_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT, account_id TEXT, entry_type TEXT,
        amount REAL, amount_minor INTEGER, reconciliation_status TEXT
    )`);
    await run(db, "INSERT INTO users VALUES ('reviewer-1')");
    await run(db, "INSERT INTO customers VALUES ('customer-1')");
    await migratePaymentImports(db);
    await run(db, `INSERT INTO customer_account_events VALUES
        (?, 'customer-1', 'KES', 'credit', 'payment', 'posted', 10000, 'mpesa',
         'APR1234XYZ', ?, ?, 'reviewer-1', 'reviewer-1')`, [eventId, importId, eventKey]);
    await run(db, `INSERT INTO payment_imports
        (id, source, status, parser_version, message_fingerprint, dedupe_identity, receipt_code,
         direction, event_kind, amount_minor, currency, parse_warnings, redacted_evidence,
         reviewer_user_id, customer_id, created_account_event_id)
        VALUES (?, 'manual', 'approved', 'mpesa-sms-v2', ?, 'receipt:APR1234XYZ',
                'APR1234XYZ', 'received', 'customer_receipt', 10000, 'KES', '[]',
                'APR1234XYZ Confirmed. Ksh100.00 received.', 'reviewer-1', 'customer-1', ?)`,
    [importId, crypto.createHash('sha256').update(importId).digest('hex'), eventId]);
    await run(db, `INSERT INTO ledger_transactions VALUES
        (?, '2026-01-01', 'payment_import_approval', ?, ?)`, [ledgerId, importId, eventId]);
    await run(db, `INSERT INTO ledger_entries VALUES
        (?, ?, '1010', 'debit', 100, 10000, 'exact'),
        (?, ?, '1200', 'credit', 100, 10000, 'exact')`,
    [`${ledgerId}:dr`, ledgerId, `${ledgerId}:cr`, ledgerId]);
    return { importId, eventId, ledgerId };
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
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL)');
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
        /payment import canonical shape is invalid|CHECK constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, amount_minor, parse_warnings, redacted_evidence) VALUES ('bad-amount', 'manual', 'needs_review', 'v1', 'f2', 'd2', 'unknown', 'unknown', -1, '[]', 'redacted')"),
        /payment import canonical shape is invalid|CHECK constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO payment_imports (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind, parse_warnings, conflict_fields, redacted_evidence) VALUES ('bad-conflict-json', 'manual', 'needs_review', 'v1', 'f3', 'd3', 'unknown', 'unknown', '[]', '{bad', 'redacted')"),
        /conflict_fields must be a JSON array|malformed JSON|CHECK constraint failed/
    );
});

test('partial legacy schema upgrades every row, reconciles unsafe dedupe identities, ingests, and reruns after restart', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-upgrade-'));
    const filename = path.join(tempDir, 'payment-imports.sqlite');
    let db = await openDatabase(filename);
    t.after(async () => {
        if (db) await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY)');
    await run(db, "INSERT INTO users VALUES ('valid-user')");
    await run(db, "INSERT INTO batches VALUES ('valid-batch')");
    await run(db, "INSERT INTO transactions VALUES ('valid-transaction')");
    await run(db, "INSERT INTO customers VALUES ('valid-customer')");
    await run(db, "INSERT INTO customer_account_events VALUES ('valid-event')");
    await run(db, `CREATE TABLE payment_imports (
        id TEXT PRIMARY KEY,
        source TEXT,
        status TEXT,
        message_fingerprint TEXT,
        dedupe_identity TEXT,
        parse_warnings TEXT,
        redacted_evidence TEXT,
        raw_body TEXT,
        raw_sms TEXT,
        reviewer_user_id TEXT,
        batch_id TEXT,
        created_transaction_id TEXT,
        customer_id TEXT,
        created_account_event_id TEXT,
        duplicate_of_id TEXT,
        reversal_of_id TEXT,
        created_at DATETIME
    )`);
    const legacyRows = [
        ['legacy-a', 'manual', 'received', 'fp-a', 'receipt:DUP001', '[]', 'DUP001 Confirmed. Ksh100.00 received.', 'RAW PHONE 0711111111', 'RAW SECRET A', 'valid-user', 'valid-batch', null, null, null, null, null, '2025-01-01 10:00:00'],
        ['legacy-b', 'webhook', 'received', 'fp-b', 'receipt:DUP001', '["legacy_warning","missing_amount"]', 'DUP001 duplicate redacted evidence.', 'RAW PHONE 0722222222', 'RAW SECRET B', 'missing-user', 'missing-batch', 'missing-transaction', 'missing-customer', 'missing-event', 'missing-import', 'missing-import', '2025-01-02 10:00:00'],
        ['legacy-c', 'daraja', 'received', null, null, 'bad-json', 'Legacy C redacted evidence.', 'RAW PHONE 0733333333', 'RAW SECRET C', null, null, null, null, null, 'legacy-a', null, '2025-01-03 10:00:00'],
        ['legacy-d', 'manual', 'rejected', 'fp-d', '   ', '[]', 'Legacy D redacted evidence.', 'RAW PHONE 0744444444', 'RAW SECRET D', null, null, null, null, null, null, null, '2025-01-04 10:00:00']
    ];
    for (const row of legacyRows) {
        await run(db, `INSERT INTO payment_imports
            (id, source, status, message_fingerprint, dedupe_identity, parse_warnings, redacted_evidence,
             raw_body, raw_sms, reviewer_user_id, batch_id, created_transaction_id, customer_id,
             created_account_event_id, duplicate_of_id, reversal_of_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row);
    }

    await migratePaymentImports(db);
    assert.equal((await get(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
    const requiredColumns = [
        'id', 'source', 'source_message_id', 'sender_masked', 'device_id', 'sim_slot',
        'sent_at_ms', 'received_at_ms', 'transaction_at_ms', 'status', 'parser_version',
        'message_fingerprint', 'dedupe_identity', 'receipt_code', 'direction', 'event_kind',
        'amount_minor', 'currency', 'counterparty_name', 'counterparty_phone_masked',
        'reference_masked', 'parse_warnings', 'redacted_evidence', 'raw_retention_policy',
        'has_conflict', 'conflict_count', 'conflict_fields', 'last_conflict_at',
        'duplicate_of_id', 'reversal_of_id', 'reviewer_user_id', 'reviewed_at', 'review_notes',
        'approved_at', 'rejected_at', 'reversed_at', 'buyer_name', 'batch_id',
        'created_transaction_id', 'customer_id', 'created_account_event_id', 'created_at', 'updated_at'
    ];
    const columns = (await all(db, 'PRAGMA table_info(payment_imports)')).map(column => column.name);
    for (const name of requiredColumns) assert.ok(columns.includes(name), `missing upgraded column ${name}`);
    assert.equal(columns.some(name => /raw.*sms|raw.*body/i.test(name)), false);
    const rebuiltSchemaAndRows = JSON.stringify({
        schema: await all(db, "SELECT sql FROM sqlite_master WHERE tbl_name = 'payment_imports'"),
        rows: await all(db, 'SELECT * FROM payment_imports')
    });
    assert.doesNotMatch(rebuiltSchemaAndRows, /RAW PHONE|RAW SECRET|0711111111|0722222222|0733333333|0744444444/);

    const upgraded = await all(db, `SELECT id, source, status, message_fingerprint, dedupe_identity,
        duplicate_of_id, parse_warnings, redacted_evidence, raw_retention_policy
        FROM payment_imports ORDER BY created_at, id`);
    assert.equal(upgraded.length, legacyRows.length);
    assert.deepEqual(upgraded.map(row => row.redacted_evidence), legacyRows.map(row => row[6]));
    assert.equal(new Set(upgraded.map(row => row.dedupe_identity)).size, legacyRows.length);
    assert.ok(upgraded.every(row => typeof row.dedupe_identity === 'string' && row.dedupe_identity.trim()));
    assert.deepEqual(upgraded.map(row => row.status), ['needs_review', 'needs_review', 'needs_review', 'rejected']);
    assert.ok(upgraded.every(row => row.raw_retention_policy === 'not_retained'));
    assert.equal(upgraded[0].dedupe_identity, 'receipt:DUP001');
    assert.equal(upgraded[1].duplicate_of_id, 'legacy-a');
    assert.match(upgraded[2].message_fingerprint, /^legacy:[0-9a-f]{48}$/);
    assert.ok(upgraded.every(row => JSON.parse(row.parse_warnings).includes('legacy_schema_upgrade')));
    assert.ok(upgraded.every(row => JSON.parse(row.parse_warnings).includes('legacy_raw_fields_removed')));
    assert.equal(JSON.parse(upgraded[1].parse_warnings).includes('legacy_warning'), false);
    assert.ok(JSON.parse(upgraded[1].parse_warnings).includes('missing_amount'));
    assert.ok(JSON.parse(upgraded[1].parse_warnings).includes('legacy_parse_warnings_redacted'));
    const retainedLinks = await get(db, `SELECT reviewer_user_id, batch_id, created_transaction_id,
        customer_id, created_account_event_id FROM payment_imports WHERE id = 'legacy-a'`);
    assert.deepEqual(Object.values(retainedLinks), ['valid-user', 'valid-batch', null, null, null]);
    const clearedLinks = await get(db, `SELECT reviewer_user_id, batch_id, created_transaction_id,
        customer_id, created_account_event_id, duplicate_of_id, reversal_of_id, parse_warnings
        FROM payment_imports WHERE id = 'legacy-b'`);
    assert.deepEqual([
        clearedLinks.reviewer_user_id, clearedLinks.batch_id, clearedLinks.created_transaction_id,
        clearedLinks.customer_id, clearedLinks.created_account_event_id,
        clearedLinks.duplicate_of_id, clearedLinks.reversal_of_id
    ], [null, null, null, null, null, 'legacy-a', null]);
    assert.ok(JSON.parse(clearedLinks.parse_warnings).includes('invalid_reviewer_link_cleared'));
    assert.ok(JSON.parse(clearedLinks.parse_warnings).includes('invalid_customer_link_cleared'));
    assert.ok(JSON.parse(clearedLinks.parse_warnings).includes('invalid_event_link_cleared'));
    const duplicateEvent = await get(db, "SELECT created_account_event_id, duplicate_of_id FROM payment_imports WHERE id = 'legacy-c'");
    assert.equal(duplicateEvent.created_account_event_id, null);
    assert.equal(duplicateEvent.duplicate_of_id, 'legacy-a');

    const firstIngestion = await ingestPaymentImport({
        source: 'manual',
        sender: 'MPESA',
        text: 'NEW1234ABC Confirmed. Ksh250.00 received from TEST BUYER 0712345678 on 6/9/26 at 10:30 AM.'
    }, adapter(db));
    assert.equal(firstIngestion.created, true);
    assert.equal(firstIngestion.payment_import.raw_retention_policy, 'not_retained');
    assert.notEqual(firstIngestion.payment_import.created_at, '1970-01-01 00:00:00');
    const stableBeforeRestart = await all(db, `SELECT id, dedupe_identity, status, parse_warnings, redacted_evidence
        FROM payment_imports WHERE id LIKE 'legacy-%' ORDER BY id`);

    await close(db);
    db = null;
    db = await openDatabase(filename);
    await migratePaymentImports(db);
    assert.deepEqual(await all(db, `SELECT id, dedupe_identity, status, parse_warnings, redacted_evidence
        FROM payment_imports WHERE id LIKE 'legacy-%' ORDER BY id`), stableBeforeRestart);
    assert.equal((await get(db, 'SELECT status FROM payment_imports WHERE id = ?', [firstIngestion.payment_import.id])).status, 'received');
    const secondIngestion = await ingestPaymentImport({
        source: 'webhook',
        source_message_id: 'restart-message-1',
        device_id: 'test-device',
        sim: 1,
        text: 'RST1234ABC Confirmed. Ksh75.00 received from TEST BUYER 0712345678 on 7/9/26 at 11:30 AM.'
    }, adapter(db));
    assert.equal(secondIngestion.created, true);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 6);
    const indexes = await all(db, 'PRAGMA index_list(payment_imports)');
    assert.ok(indexes.some(index => index.name === 'idx_payment_imports_dedupe_identity_unique' && index.unique === 1));
});

test('migration fails closed rather than making posted accounting reviewable', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-posted-state-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, "INSERT INTO transactions VALUES ('posted-transaction')");
    await run(db, `CREATE TABLE payment_imports (
        id TEXT PRIMARY KEY, status TEXT, created_transaction_id TEXT, redacted_evidence TEXT
    )`);
    await run(db, `INSERT INTO payment_imports VALUES
        ('reviewable-posted-row', 'received', 'posted-transaction', 'Redacted evidence')`);
    const schemaBefore = (await get(db, `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'payment_imports'`)).sql;
    const rowsBefore = await all(db, 'SELECT * FROM payment_imports');

    await assert.rejects(
        migratePaymentImports(db),
        /accounting on a non-approved state/
    );

    assert.equal((await get(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
    assert.equal((await get(db, `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'payment_imports'`)).sql, schemaBefore);
    assert.deepEqual(await all(db, 'SELECT * FROM payment_imports'), rowsBefore);
});

test('reverse event and ledger accounting references cannot be reopened by a partial-schema rebuild', async t => {
    await assertMigrationFailsWithoutMutation(t, 'draft customer event points back to a rejected import', async db => {
        await run(db, `CREATE TABLE payment_imports (
            id TEXT PRIMARY KEY, status TEXT, customer_id TEXT, created_account_event_id TEXT,
            created_transaction_id TEXT, redacted_evidence TEXT
        )`);
        await run(db, `INSERT INTO payment_imports VALUES
            ('reverse-event-import', 'rejected', NULL, NULL, NULL, 'Redacted evidence')`);
        await run(db, `CREATE TABLE customer_account_events (
            id TEXT PRIMARY KEY, status TEXT, payment_import_id TEXT
        )`);
        await run(db, `INSERT INTO customer_account_events VALUES
            ('draft-event', 'draft', 'reverse-event-import')`);
    }, /accounting on a non-approved state/);

    await assertMigrationFailsWithoutMutation(t, 'approval ledger points back to a needs-review import', async db => {
        await run(db, `CREATE TABLE payment_imports (
            id TEXT PRIMARY KEY, status TEXT, customer_id TEXT, created_account_event_id TEXT,
            created_transaction_id TEXT, redacted_evidence TEXT
        )`);
        await run(db, `INSERT INTO payment_imports VALUES
            ('reverse-ledger-import', 'needs_review', NULL, NULL, NULL, 'Redacted evidence')`);
        await run(db, `CREATE TABLE ledger_transactions (
            id TEXT PRIMARY KEY, date TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
            customer_account_event_id TEXT
        )`);
        await run(db, `INSERT INTO ledger_transactions VALUES
            ('posted-ledger', '2026-01-01', 'payment_import_approval', 'reverse-ledger-import', NULL)`);
    }, /accounting on a non-approved state/);
});

test('terminal imports with missing forward provenance fail closed', async t => {
    for (const missing of ['event', 'customer']) {
        await assertMigrationFailsWithoutMutation(t, `approved import missing ${missing} provenance`, async db => {
            await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
            await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY)');
            await run(db, "INSERT INTO customers VALUES ('customer-1')");
            await run(db, "INSERT INTO customer_account_events VALUES ('event-1')");
            await run(db, `CREATE TABLE payment_imports (
                id TEXT PRIMARY KEY, status TEXT, customer_id TEXT, created_account_event_id TEXT,
                redacted_evidence TEXT
            )`);
            await run(db, `INSERT INTO payment_imports VALUES (?, 'approved', ?, ?, 'Redacted evidence')`, [
                `approved-missing-${missing}`,
                missing === 'customer' ? null : 'customer-1',
                missing === 'event' ? null : 'event-1'
            ]);
        }, /cannot prove approved accounting provenance/);
    }

    for (const reversal of [null, 'missing-import']) {
        await assertMigrationFailsWithoutMutation(t,
            `reversed import has ${reversal === null ? 'missing' : 'invalid'} reversal provenance`, async db => {
                await run(db, `CREATE TABLE payment_imports (
                    id TEXT PRIMARY KEY, status TEXT, reversal_of_id TEXT, redacted_evidence TEXT
                )`);
                await run(db, `INSERT INTO payment_imports VALUES
                    ('reversed-import', 'reversed', ?, 'Redacted evidence')`, [reversal]);
            }, /incoherent reversal provenance/);
    }

    await assertMigrationFailsWithoutMutation(t, 'reversed import owns a transaction link', async db => {
        await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
        await run(db, "INSERT INTO transactions VALUES ('reversal-transaction')");
        await run(db, `CREATE TABLE payment_imports (
            id TEXT PRIMARY KEY, status TEXT, reversal_of_id TEXT,
            created_transaction_id TEXT, redacted_evidence TEXT
        )`);
        await run(db, `INSERT INTO payment_imports VALUES
            ('reversed-import', 'reversed', 'approved-import', 'reversal-transaction', 'Redacted'),
            ('approved-import', 'approved', NULL, NULL, 'Redacted')`);
    }, /accounting on a non-approved state/);

    await assertMigrationFailsWithoutMutation(t, 'reversed import targets a non-approved import', async db => {
        await run(db, `CREATE TABLE payment_imports (
            id TEXT PRIMARY KEY, status TEXT, reversal_of_id TEXT, redacted_evidence TEXT
        )`);
        await run(db, `INSERT INTO payment_imports VALUES
            ('reversed-import', 'reversed', 'received-import', 'Redacted'),
            ('received-import', 'received', NULL, 'Redacted')`);
    }, /incoherent reversal provenance/);
});

test('approved imports require the complete event, ledger, and entry provenance predicate', async t => {
    await assertMigrationFailsWithoutMutation(t, 'approved import has only a partial event schema', async db => {
        await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
        await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
        await run(db, "INSERT INTO users VALUES ('reviewer-1')");
        await run(db, "INSERT INTO customers VALUES ('customer-1')");
        await run(db, `CREATE TABLE payment_imports (
            id TEXT PRIMARY KEY, status TEXT, receipt_code TEXT, amount_minor INTEGER,
            reviewer_user_id TEXT, customer_id TEXT, created_account_event_id TEXT,
            redacted_evidence TEXT
        )`);
        await run(db, `INSERT INTO payment_imports VALUES
            ('partial-approved', 'approved', 'APR1234XYZ', 10000, 'reviewer-1',
             'customer-1', 'partial-event', 'Redacted')`);
        await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY)');
        await run(db, "INSERT INTO customer_account_events VALUES ('partial-event')");
    }, /cannot prove approved accounting provenance/);

    await assertMigrationFailsWithoutMutation(t, 'approved import is missing its reviewer', async db => {
        await setupProvableApprovedFixture(db);
        await run(db, "UPDATE payment_imports SET reviewer_user_id = NULL WHERE id = 'approved-fixture'");
    }, /cannot prove approved accounting provenance/);

    const eventCorruptions = [
        ['amount', "amount_minor = 9999"],
        ['reference', "external_reference = 'WRONG1234'"],
        ['idempotency', "idempotency_key = 'wrong-key'"],
        ['creator actor', "created_by_user_id = 'other-user'"],
        ['reviewer actor', "reviewer_user_id = 'other-user'"]
    ];
    for (const [label, assignment] of eventCorruptions) {
        await assertMigrationFailsWithoutMutation(t, `approved event has corrupt ${label}`, async db => {
            const fixture = await setupProvableApprovedFixture(db);
            await run(db, `UPDATE customer_account_events SET ${assignment} WHERE id = ?`, [fixture.eventId]);
        }, /cannot prove approved accounting provenance/);
    }

    const ledgerCorruptions = [
        ['missing header', async (db, fixture) => run(db, 'DELETE FROM ledger_transactions WHERE id = ?', [fixture.ledgerId])],
        ['wrong header', async (db, fixture) => run(db, "UPDATE ledger_transactions SET ref_type = 'wrong' WHERE id = ?", [fixture.ledgerId])],
        ['missing entry', async (db, fixture) => run(db, "DELETE FROM ledger_entries WHERE id = ?", [`${fixture.ledgerId}:cr`])],
        ['wrong entry', async (db, fixture) => run(db, "UPDATE ledger_entries SET amount_minor = 9999 WHERE id = ?", [`${fixture.ledgerId}:cr`])]
    ];
    for (const [label, corrupt] of ledgerCorruptions) {
        await assertMigrationFailsWithoutMutation(t, `approved import has ${label}`, async db => {
            const fixture = await setupProvableApprovedFixture(db);
            await corrupt(db, fixture);
        }, /cannot prove approved accounting provenance/);
    }
});

test('canonical no-rebuild reruns reject corrupt accounting state without logical mutation', async t => {
    await assertMigrationFailsWithoutMutation(t, 'canonical needs-review row has forward and reverse accounting', async db => {
        await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
        await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
        await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
        await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
        await run(db, `CREATE TABLE customer_account_events (
            id TEXT PRIMARY KEY, status TEXT, payment_import_id TEXT
        )`);
        await run(db, `CREATE TABLE ledger_transactions (
            id TEXT PRIMARY KEY, date TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
            customer_account_event_id TEXT
        )`);
        await run(db, "INSERT INTO customers VALUES ('customer-1')");
        await run(db, `INSERT INTO customer_account_events VALUES
            ('draft-event', 'draft', 'canonical-needs-review')`);
        await migratePaymentImports(db);
        await run(db, `INSERT INTO payment_imports
            (id, source, status, parser_version, message_fingerprint, dedupe_identity,
             direction, event_kind, parse_warnings, redacted_evidence, customer_id,
             created_account_event_id)
            VALUES ('canonical-needs-review', 'manual', 'needs_review', 'mpesa-sms-v2', ?,
                    'receipt:CAN1234XYZ', 'received', 'customer_receipt', '[]', 'Redacted',
                    'customer-1', 'draft-event')`, [crypto.createHash('sha256').update('canonical-needs-review').digest('hex')]);
        await run(db, `INSERT INTO ledger_transactions VALUES
            ('reverse-ledger', '2026-01-01', 'payment_import_approval',
             'canonical-needs-review', 'draft-event')`);
    }, /accounting on a non-approved state/);

    for (const corruption of ['event amount', 'ledger entry']) {
        await assertMigrationFailsWithoutMutation(t, `canonical approved row has corrupt ${corruption}`, async db => {
            const fixture = await setupCanonicalApprovedFixture(db);
            if (corruption === 'event amount') {
                await run(db, 'UPDATE customer_account_events SET amount_minor = 9999 WHERE id = ?', [fixture.eventId]);
            } else {
                await run(db, "UPDATE ledger_entries SET reconciliation_status = 'estimated' WHERE id = ?",
                    [`${fixture.ledgerId}:cr`]);
            }
        }, /cannot prove approved accounting provenance/);
    }
});

test('canonical no-rebuild rerun scrubs injected raw prose without changing approved accounting', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-canonical-privacy-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const fixture = await setupCanonicalApprovedFixture(db, 'canonical-privacy');
    const raw = 'RAW1234XYZ Confirmed. Ksh500.00 received from SECRET BUYER 0712345678';
    const rootPage = (await get(db, `SELECT rootpage FROM sqlite_master
        WHERE type = 'table' AND name = 'payment_imports'`)).rootpage;
    const accountingBefore = await all(db, `SELECT id, customer_id, currency, side, kind, status,
        amount_minor, method, external_reference, payment_import_id, idempotency_key,
        created_by_user_id, reviewer_user_id FROM customer_account_events ORDER BY id`);
    await run(db, `UPDATE payment_imports
        SET counterparty_name = ?, buyer_name = ?, review_notes = ?
        WHERE id = ?`, [raw, raw, raw, fixture.importId]);

    await migratePaymentImports(db);

    const stored = await get(db, `SELECT counterparty_name, buyer_name, review_notes
        FROM payment_imports WHERE id = ?`, [fixture.importId]);
    assert.deepEqual(stored, { counterparty_name: null, buyer_name: null, review_notes: null });
    assert.equal((await get(db, `SELECT rootpage FROM sqlite_master
        WHERE type = 'table' AND name = 'payment_imports'`)).rootpage, rootPage);
    assert.deepEqual(await all(db, `SELECT id, customer_id, currency, side, kind, status,
        amount_minor, method, external_reference, payment_import_id, idempotency_key,
        created_by_user_id, reviewer_user_id FROM customer_account_events ORDER BY id`), accountingBefore);
});

test('canonical no-rebuild privacy scrub rolls back when final accounting validation fails', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-canonical-privacy-rollback-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const fixture = await setupCanonicalApprovedFixture(db, 'canonical-privacy-rollback');
    const raw = 'RAW1234XYZ Confirmed. Ksh500.00 received from SECRET BUYER 0712345678';
    await run(db, `UPDATE payment_imports
        SET counterparty_name = ?, buyer_name = ?, review_notes = ?
        WHERE id = ?`, [raw, raw, raw, fixture.importId]);
    await run(db, 'UPDATE customer_account_events SET amount_minor = 9999 WHERE id = ?', [fixture.eventId]);
    const before = await databaseSnapshot(db);

    await assert.rejects(migratePaymentImports(db), /cannot prove approved accounting provenance/);

    assert.deepEqual(await databaseSnapshot(db), before);
    assert.equal((await get(db, `SELECT counterparty_name FROM payment_imports WHERE id = ?`, [fixture.importId])).counterparty_name, raw);
});

test('exact pre-19C schema strengthening preserves valid terminal states and approved financial provenance', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-pre19c-'));
    const filename = path.join(tempDir, 'payment-imports.sqlite');
    const db = await openDatabase(filename);
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL)');
    await run(db, `CREATE TABLE customer_account_events (
        id TEXT PRIMARY KEY, customer_id TEXT, currency TEXT, side TEXT, kind TEXT, status TEXT,
        amount_minor INTEGER, method TEXT, external_reference TEXT, payment_import_id TEXT,
        idempotency_key TEXT, created_by_user_id TEXT, reviewer_user_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT,
        customer_account_event_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT, account_id TEXT, entry_type TEXT,
        amount REAL, amount_minor INTEGER, reconciliation_status TEXT
    )`);
    await run(db, "INSERT INTO users VALUES ('reviewer-1')");
    await run(db, "INSERT INTO batches VALUES ('batch-1')");
    await run(db, "INSERT INTO transactions VALUES ('transaction-1')");
    await run(db, "INSERT INTO customers VALUES ('customer-1', 1)");
    await run(db, PRE_19C_PAYMENT_IMPORT_SCHEMA);
    await run(db, 'CREATE UNIQUE INDEX idx_payment_imports_dedupe_identity_unique ON payment_imports(dedupe_identity)');
    await run(db, `CREATE UNIQUE INDEX idx_payment_imports_created_account_event
        ON payment_imports(created_account_event_id) WHERE created_account_event_id IS NOT NULL`);

    const approvedId = 'approved-import';
    const approvalDigest = crypto.createHash('sha256').update(`payment-import-approval:${approvedId}`).digest('hex');
    const eventId = `payment:${approvalDigest.slice(0, 40)}`;
    const eventKey = `payment:${approvalDigest.slice(0, 48)}`;
    const ledgerId = `ledger-payment:${approvalDigest.slice(0, 36)}`;
    const imports = [
        ['received-import', 'received', 'receipt:REC1234XYZ', 'REC1234XYZ', 'received', 'customer_receipt', null, null, null, null, null, null, null],
        [approvedId, 'approved', 'receipt:APR1234XYZ', 'APR1234XYZ', 'received', 'customer_receipt', 'reviewer-1', 'customer-1', eventId, 'transaction-1', null, null, '2026-01-02 12:00:00'],
        ['rejected-import', 'rejected', 'receipt:REJ1234XYZ', 'REJ1234XYZ', 'received', 'customer_receipt', 'reviewer-1', null, null, null, null, 'Rejected after manual verification', '2026-01-03 12:00:00'],
        ['reversed-import', 'reversed', 'reversal:REV1234XYZ', 'REV1234XYZ', 'reversed', 'reversal', 'reviewer-1', null, null, null, approvedId, null, '2026-01-04 12:00:00'],
        ['duplicate-import', 'duplicate', 'receipt:DUP1234XYZ', 'DUP1234XYZ', 'received', 'customer_receipt', null, null, null, null, 'received-import', null, null]
    ];
    await run(db, 'PRAGMA foreign_keys = OFF');
    for (const [id, status, dedupe, receipt, direction, eventKind, reviewer, customer, createdEvent, transaction, related, note, terminalAt] of imports) {
        await run(db, `INSERT INTO payment_imports (
            id, source, status, parser_version, message_fingerprint, dedupe_identity, receipt_code,
            direction, event_kind, amount_minor, currency, parse_warnings, redacted_evidence,
            raw_retention_policy, has_conflict, conflict_count, conflict_fields, reviewer_user_id,
            customer_id, created_account_event_id, created_transaction_id, duplicate_of_id,
            reversal_of_id, review_notes, reviewed_at, approved_at, rejected_at, reversed_at,
            created_at, updated_at
        ) VALUES (?, 'manual', ?, 'mpesa-sms-v2', ?, ?, ?, ?, ?, 10000, 'KES', '[]', ?,
                  'not_retained', 0, 0, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` , [
            id, status, crypto.createHash('sha256').update(id).digest('hex'), dedupe, receipt,
            direction, eventKind, `${receipt} Confirmed. Ksh100.00 received.`, reviewer, customer,
            createdEvent, transaction, status === 'duplicate' ? related : null,
            status === 'reversed' ? related : null, note, terminalAt, status === 'approved' ? terminalAt : null,
            status === 'rejected' ? terminalAt : null, status === 'reversed' ? terminalAt : null,
            `2026-01-0${imports.indexOf(imports.find(item => item[0] === id)) + 1} 10:00:00`,
            `2026-01-0${imports.indexOf(imports.find(item => item[0] === id)) + 1} 11:00:00`
        ]);
    }
    const rawPrivacyPayload = 'RAW1234XYZ Confirmed. Ksh500.00 received from SECRET BUYER 0712345678';
    await run(db, `UPDATE payment_imports
        SET message_fingerprint = ?, counterparty_name = ?, buyer_name = ?
        WHERE id = ?`, [rawPrivacyPayload, rawPrivacyPayload, rawPrivacyPayload, approvedId]);
    await run(db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, method, external_reference,
         payment_import_id, idempotency_key, created_by_user_id, reviewer_user_id)
        VALUES (?, 'customer-1', 'KES', 'credit', 'payment', 'posted', 10000, 'mpesa',
                'APR1234XYZ', ?, ?, 'reviewer-1', 'reviewer-1')`, [eventId, approvedId, eventKey]);
    await run(db, `INSERT INTO ledger_transactions
        (id, date, description, ref_type, ref_id, customer_account_event_id)
        VALUES (?, '2026-01-02', 'Approved M-Pesa customer payment', 'payment_import_approval', ?, ?)`,
    [ledgerId, approvedId, eventId]);
    await run(db, `INSERT INTO ledger_entries VALUES
        (?, ?, '1010', 'debit', 100, 10000, 'exact'),
        (?, ?, '1200', 'credit', 100, 10000, 'exact')`, [`${ledgerId}:dr`, ledgerId, `${ledgerId}:cr`, ledgerId]);
    await run(db, 'PRAGMA foreign_keys = ON');

    const preservedColumns = `id, status, dedupe_identity, reviewer_user_id, reviewed_at, approved_at,
        rejected_at, reversed_at, review_notes, duplicate_of_id, reversal_of_id, customer_id,
        created_account_event_id, created_transaction_id, has_conflict, conflict_count,
        conflict_fields, last_conflict_at, created_at, updated_at`;
    const before = await all(db, `SELECT ${preservedColumns} FROM payment_imports ORDER BY id`);
    await migratePaymentImports(db);
    assert.deepEqual(await all(db, `SELECT ${preservedColumns} FROM payment_imports ORDER BY id`), before);
    const sanitizedApproved = await get(db, `SELECT status, message_fingerprint, counterparty_name, buyer_name
        FROM payment_imports WHERE id = ?`, [approvedId]);
    assert.equal(sanitizedApproved.status, 'approved');
    assert.match(sanitizedApproved.message_fingerprint, /^legacy:[a-f0-9]{48}$/);
    assert.deepEqual([sanitizedApproved.counterparty_name, sanitizedApproved.buyer_name], [null, null]);
    const rootPage = (await get(db, "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'payment_imports'")).rootpage;
    const afterFirst = JSON.stringify(await all(db, 'SELECT * FROM payment_imports ORDER BY id'));
    await migratePaymentImports(db);
    assert.equal(JSON.stringify(await all(db, 'SELECT * FROM payment_imports ORDER BY id')), afterFirst);
    assert.equal((await get(db, "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'payment_imports'")).rootpage, rootPage);

    const countBeforeRetry = {
        imports: (await get(db, 'SELECT COUNT(*) AS n FROM payment_imports')).n,
        events: (await get(db, 'SELECT COUNT(*) AS n FROM customer_account_events')).n,
        ledgers: (await get(db, 'SELECT COUNT(*) AS n FROM ledger_transactions')).n,
        entries: (await get(db, 'SELECT COUNT(*) AS n FROM ledger_entries')).n
    };
    await assert.rejects(
        rejectPaymentImport({
            id: approvedId,
            reviewer_user_id: 'reviewer-1',
            review_notes: 'Cannot reject posted accounting'
        }, adapter(db)),
        PaymentImportStateConflictError
    );
    assert.equal((await get(db, 'SELECT status FROM payment_imports WHERE id = ?', [approvedId])).status, 'approved');
    const approval = createPaymentImportApprovalService({
        withDedicatedTransaction: createDedicatedTransactionBoundary(filename).withDedicatedTransaction
    });
    const retry = await approval.approvePaymentImport({
        id: approvedId, customer_id: 'customer-1', reviewer_user_id: 'reviewer-1', created_by_user_id: 'reviewer-1'
    });
    assert.equal(retry.idempotent, true);
    assert.deepEqual({
        imports: (await get(db, 'SELECT COUNT(*) AS n FROM payment_imports')).n,
        events: (await get(db, 'SELECT COUNT(*) AS n FROM customer_account_events')).n,
        ledgers: (await get(db, 'SELECT COUNT(*) AS n FROM ledger_transactions')).n,
        entries: (await get(db, 'SELECT COUNT(*) AS n FROM ledger_entries')).n
    }, countBeforeRetry);
});

test('rebuild removes raw prose hidden in canonical-looking safe-selected fields', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-hidden-raw-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, `CREATE TABLE payment_imports (
        id TEXT, source TEXT, status TEXT, message_fingerprint TEXT, dedupe_identity TEXT,
        parse_warnings TEXT, redacted_evidence TEXT, review_notes TEXT,
        counterparty_name TEXT, buyer_name TEXT
    )`);
    const raw = 'RAW1234XYZ Confirmed. Ksh500.00 received from SECRET BUYER 0712345678';
    await run(db, `INSERT INTO payment_imports VALUES
        ('unsafe-row', 'manual', 'received', ?, ?, '[]', 'Redacted evidence retained.', ?, ?, ?)`,
    [raw, raw, raw, raw, raw]);
    await migratePaymentImports(db);
    const stored = JSON.stringify(await all(db, 'SELECT * FROM payment_imports'));
    const selected = JSON.stringify(await listPaymentImports({}, adapter(db)));
    for (const unsafe of [raw, '0712345678', 'SECRET BUYER']) {
        assert.doesNotMatch(stored, new RegExp(unsafe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(selected, new RegExp(unsafe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const repaired = await get(db, 'SELECT status, message_fingerprint, dedupe_identity, review_notes, counterparty_name, buyer_name FROM payment_imports');
    assert.equal(repaired.status, 'needs_review');
    assert.match(repaired.message_fingerprint, /^legacy:[a-f0-9]{48}$/);
    assert.match(repaired.dedupe_identity, /^legacy-review:[a-f0-9]{48}$/);
    assert.deepEqual([repaired.review_notes, repaired.counterparty_name, repaired.buyer_name], [null, null, null]);
});

test('rerun repairs weak same-name dedupe index and validation trigger', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-weak-objects-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY)');
    await run(db, "INSERT INTO customer_account_events VALUES ('event-1')");
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL)');
    await migratePaymentImports(db);
    await run(db, 'DROP INDEX idx_payment_imports_dedupe_identity_unique');
    await run(db, 'CREATE INDEX idx_payment_imports_dedupe_identity_unique ON payment_imports(dedupe_identity)');
    await run(db, 'DROP TRIGGER payment_imports_safe_shape_insert');
    await run(db, `CREATE TRIGGER payment_imports_safe_shape_insert BEFORE INSERT ON payment_imports
        WHEN 0 BEGIN SELECT RAISE(ABORT, 'weak'); END`);
    await run(db, 'DROP INDEX idx_ledger_transactions_customer_account_event');
    await run(db, `CREATE INDEX idx_ledger_transactions_customer_account_event
        ON ledger_transactions(customer_account_event_id)`);
    await run(db, 'DROP TRIGGER ledger_transactions_event_link_insert');
    await run(db, `CREATE TRIGGER ledger_transactions_event_link_insert
        BEFORE INSERT ON ledger_transactions WHEN 0 BEGIN SELECT RAISE(ABORT, 'weak'); END`);
    const insert = `INSERT INTO payment_imports
        (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind,
         parse_warnings, redacted_evidence) VALUES (?, 'manual', 'received', 'mpesa-sms-v2', ?,
         'receipt:WEAK1234', 'received', 'customer_receipt', '[]', 'Safe redacted evidence')`;
    await run(db, insert, ['weak-a', crypto.createHash('sha256').update('weak-a').digest('hex')]);
    await run(db, insert, ['weak-b', crypto.createHash('sha256').update('weak-b').digest('hex')]);
    await migratePaymentImports(db);
    const indexes = await all(db, 'PRAGMA index_list(payment_imports)');
    assert.ok(indexes.some(index => index.name === 'idx_payment_imports_dedupe_identity_unique' && index.unique === 1));
    const ledgerIndexes = await all(db, 'PRAGMA index_list(ledger_transactions)');
    assert.ok(ledgerIndexes.some(index => index.name === 'idx_ledger_transactions_customer_account_event' && index.unique === 1));
    assert.equal(new Set((await all(db, 'SELECT dedupe_identity FROM payment_imports')).map(row => row.dedupe_identity)).size, 2);
    await run(db, "INSERT INTO ledger_transactions (id, date, customer_account_event_id) VALUES ('ledger-a', '2026-01-01', 'event-1')");
    await assert.rejects(
        run(db, "INSERT INTO ledger_transactions (id, date, customer_account_event_id) VALUES ('ledger-b', '2026-01-02', 'event-1')"),
        /UNIQUE constraint failed/
    );
    await assert.rejects(
        run(db, "INSERT INTO ledger_transactions (id, date, customer_account_event_id) VALUES ('ledger-invalid', '2026-01-03', 'missing-event')"),
        /ledger customer event link is invalid/
    );
    await assert.rejects(run(db, `INSERT INTO payment_imports
        (id, source, status, parser_version, message_fingerprint, dedupe_identity, direction, event_kind,
         parse_warnings, redacted_evidence) VALUES ('bad-shape', 'daraja', 'received', 'v', 'f',
         'receipt:BAD1234', 'received', 'customer_receipt', '[]', 'Safe')`),
    /canonical shape is invalid|CHECK constraint failed/);
});

test('event and ledger guards are repaired without a customers table', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-ledger-guards-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY)');
    await run(db, "INSERT INTO customer_account_events VALUES ('event-1')");
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL)');
    await migratePaymentImports(db);
    for (const trigger of [
        'ledger_transactions_event_link_insert',
        'ledger_transactions_event_link_update',
        'customer_events_ledger_link_restrict_delete'
    ]) {
        await run(db, `DROP TRIGGER ${trigger}`);
    }
    await run(db, `CREATE TRIGGER ledger_transactions_event_link_insert
        BEFORE INSERT ON ledger_transactions WHEN 0 BEGIN SELECT RAISE(ABORT, 'weak'); END`);
    await run(db, `CREATE TRIGGER ledger_transactions_event_link_update
        BEFORE UPDATE ON ledger_transactions WHEN 0 BEGIN SELECT RAISE(ABORT, 'weak'); END`);
    await run(db, `CREATE TRIGGER customer_events_ledger_link_restrict_delete
        BEFORE DELETE ON customer_account_events WHEN 0 BEGIN SELECT RAISE(ABORT, 'weak'); END`);

    await migratePaymentImports(db);
    await run(db, `INSERT INTO ledger_transactions (id, date, customer_account_event_id)
        VALUES ('valid-ledger', '2026-01-01', 'event-1')`);
    await assert.rejects(
        run(db, `INSERT INTO ledger_transactions (id, date, customer_account_event_id)
            VALUES ('invalid-ledger', '2026-01-02', 'missing-event')`),
        /ledger customer event link is invalid/
    );
    await assert.rejects(
        run(db, "UPDATE ledger_transactions SET customer_account_event_id = 'missing-event' WHERE id = 'valid-ledger'"),
        /ledger customer event link is invalid/
    );
    await assert.rejects(
        run(db, "DELETE FROM customer_account_events WHERE id = 'event-1'"),
        /customer event is linked to a ledger transaction/
    );
});

test('injected migration failure rolls back partial schema and data exactly', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-rollback-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, `CREATE TABLE payment_imports (
        id TEXT PRIMARY KEY,
        status TEXT,
        dedupe_identity TEXT,
        redacted_evidence TEXT
    )`);
    await run(db, `CREATE INDEX legacy_payment_status ON payment_imports(status)`);
    await run(db, `INSERT INTO payment_imports (id, status, dedupe_identity, redacted_evidence)
        VALUES ('rollback-1', 'received', NULL, 'Rollback evidence must survive.')`);
    const schemaBefore = await all(db, `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE tbl_name = 'payment_imports' ORDER BY type, name`);
    const rowsBefore = await all(db, 'SELECT rowid, * FROM payment_imports ORDER BY rowid');

    await assert.rejects(migratePaymentImports(db, {
        afterReconciliation: async () => { throw new Error('injected migration failure'); }
    }), /injected migration failure/);

    assert.deepEqual(await all(db, `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE tbl_name = 'payment_imports' ORDER BY type, name`), schemaBefore);
    assert.deepEqual(await all(db, 'SELECT rowid, * FROM payment_imports ORDER BY rowid'), rowsBefore);
    assert.deepEqual((await all(db, 'PRAGMA table_info(payment_imports)')).map(column => column.name), [
        'id', 'status', 'dedupe_identity', 'redacted_evidence'
    ]);
    assert.equal((await get(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
});

test('savepoint creation failure still restores foreign-key enforcement', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-imports-savepoint-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE payment_imports (id TEXT, dedupe_identity TEXT)');
    const originalRun = db.run;
    db.run = function injectedRun(sql, ...args) {
        if (sql === 'SAVEPOINT migrate_payment_imports') {
            const callback = args.at(-1);
            queueMicrotask(() => callback.call(this, new Error('injected savepoint failure')));
            return this;
        }
        return originalRun.call(this, sql, ...args);
    };
    try {
        await assert.rejects(migratePaymentImports(db), /injected savepoint failure/);
    } finally {
        db.run = originalRun;
    }
    assert.equal((await get(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
    assert.deepEqual((await all(db, 'PRAGMA table_info(payment_imports)')).map(column => column.name), ['id', 'dedupe_identity']);
});

test('canonical rebuild adds durable conflict metadata and marks the legacy row for review', async (t) => {
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
    assert.deepEqual(row, { id: 'legacy-1', status: 'needs_review', has_conflict: 0, conflict_count: 0, conflict_fields: '[]', last_conflict_at: null });
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
