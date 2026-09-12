const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { migratePaymentImports } = require('../../migrations/payment-imports');
const {
    MAX_SMS_LENGTH,
    ingestPaymentImport,
    getPaymentImport,
    listPaymentImports
} = require('../../services/payment-imports');

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function temporaryStore(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-import-service-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    const calls = [];
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await migratePaymentImports(db);
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    return {
        db,
        calls,
        adapter: {
            runQuery: async (sql, params = []) => {
                calls.push({ kind: 'run', sql, params });
                return run(db, sql, params);
            },
            getQuery: async (sql, params = []) => {
                calls.push({ kind: 'get', sql, params });
                return get(db, sql, params);
            },
            allQuery: async (sql, params = []) => {
                calls.push({ kind: 'all', sql, params });
                return all(db, sql, params);
            }
        }
    };
}

const incoming = 'QWE123ABC Confirmed. You have received Ksh1,250.50 from JANE DOE 0712345678 on 6/9/26 at 10:30 AM.';

test('ingests a manual SMS as one redacted canonical row with no transaction or ledger activity', async (t) => {
    const store = await temporaryStore(t);
    const result = await ingestPaymentImport({
        source: 'manual', text: incoming, sender: 'M-PESA', source_message_id: 'android:de305d54-75b4-431b-adb2-eb6b9e546014',
        device_id: 'android:device-01', sim: 'SIM 1', sent_at_ms: 1700000000000, received_at_ms: 1700000000100
    }, store.adapter);

    assert.equal(result.created, true);
    assert.equal(result.duplicate, false);
    assert.deepEqual(
        [result.payment_import.source, result.payment_import.status, result.payment_import.dedupe_identity, result.payment_import.sender_masked],
        ['manual', 'received', 'receipt:QWE123ABC', 'M-PESA']
    );
    assert.deepEqual(result.payment_import.parse_warnings, []);
    assert.equal(result.payment_import.counterparty_phone_masked, '••••5678');
    assert.equal(result.payment_import.raw_retention_policy, 'not_retained');
    assert.deepEqual(
        [result.payment_import.reviewer_user_id, result.payment_import.buyer_name, result.payment_import.batch_id, result.payment_import.created_transaction_id],
        [null, null, null, null]
    );

    const stored = await get(store.db, 'SELECT * FROM payment_imports');
    assert.equal(stored.source_message_id, 'android:de305d54-75b4-431b-adb2-eb6b9e546014');
    assert.equal(stored.device_id, 'android:device-01');
    assert.equal(stored.sim_slot, 'SIM 1');
    assert.equal(stored.parse_warnings, '[]');
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(incoming.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(stored), /0712345678/);
    assert.doesNotMatch(JSON.stringify(result), /0712345678/);
    assert.ok(store.calls.every(call => !/\b(?:transactions|ledger_)\b/i.test(call.sql)));
});

test('masks phone senders and deduplicates identical manual and webhook receipts into the original row', async (t) => {
    const store = await temporaryStore(t);
    const manual = await ingestPaymentImport({ source: 'manual', text: incoming, sender: '+254112345678' }, store.adapter);
    const webhook = await ingestPaymentImport({
        source: 'webhook', text: incoming, sender: '0712345678', source_message_id: 'forwarder-77', device_id: 'phone-a', sim: '0'
    }, store.adapter);

    assert.equal(manual.payment_import.sender_masked, '••••5678');
    assert.equal(webhook.created, false);
    assert.equal(webhook.duplicate, true);
    assert.equal(webhook.conflict, false);
    assert.deepEqual(webhook.conflict_fields, []);
    assert.deepEqual(
        [webhook.payment_import.has_conflict, webhook.payment_import.conflict_count, webhook.payment_import.conflict_fields],
        [0, 0, []]
    );
    assert.equal(webhook.payment_import.id, manual.payment_import.id);
    assert.equal(webhook.payment_import.source, 'manual');
    assert.equal((await get(store.db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 1);
});

test('signals a material receipt collision while preserving the canonical import', async (t) => {
    const store = await temporaryStore(t);
    const originalText = 'COL1234XYZ Confirmed. Ksh100.00 received from BUYER A 0712345678 on 6/9/26 at 10:30 AM.';
    const collisionText = 'COL1234XYZ Confirmed. Ksh900.00 received from BUYER B 0712349999 on 6/9/26 at 10:31 AM.';
    const original = await ingestPaymentImport({ source: 'manual', text: originalText, sender: 'MPESA' }, store.adapter);
    const collision = await ingestPaymentImport({ source: 'webhook', text: collisionText, sender: 'M-PESA' }, store.adapter);

    assert.equal(collision.created, false);
    assert.equal(collision.duplicate, true);
    assert.equal(collision.conflict, true);
    assert.deepEqual(collision.conflict_fields, ['amount_minor', 'transaction_at_ms', 'counterparty_name', 'counterparty_phone_masked']);
    assert.equal(collision.payment_import.id, original.payment_import.id);
    assert.deepEqual(
        [collision.payment_import.amount_minor, collision.payment_import.counterparty_name, collision.payment_import.transaction_at_ms, collision.payment_import.status, collision.payment_import.has_conflict, collision.payment_import.conflict_count, collision.payment_import.conflict_fields],
        [10000, 'BUYER A', Date.UTC(2026, 8, 6, 7, 30), 'needs_review', 1, 1, ['amount_minor', 'transaction_at_ms', 'counterparty_name', 'counterparty_phone_masked']]
    );
    assert.doesNotMatch(JSON.stringify(collision.conflict_fields), /BUYER|900|0712349999/);
    await run(store.db, "UPDATE payment_imports SET status = 'approved' WHERE id = ?", [original.payment_import.id]);
    const terminalCollision = await ingestPaymentImport({ source: 'webhook', text: 'COL1234XYZ Confirmed. Ksh800.00 received from BUYER C 0712348888.' }, store.adapter);
    assert.deepEqual(
        [terminalCollision.payment_import.status, terminalCollision.payment_import.has_conflict, terminalCollision.payment_import.conflict_count],
        ['approved', 1, 2]
    );
    assert.equal((await get(store.db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 1);
});

test('concurrent material conflicts atomically retain every conflict increment', async (t) => {
    const store = await temporaryStore(t);
    await ingestPaymentImport({ source: 'manual', text: 'CON1234XYZ Confirmed. Ksh100 received from BUYER A 0712345678.' }, store.adapter);
    const results = await Promise.all([200, 300, 400, 500].map(amount => ingestPaymentImport({
        source: 'webhook', text: `CON1234XYZ Confirmed. Ksh${amount} received from BUYER ${amount} 0712345678.`
    }, store.adapter)));
    assert.ok(results.every(result => result.conflict));
    const stored = await get(store.db, "SELECT status, has_conflict, conflict_count, conflict_fields FROM payment_imports WHERE dedupe_identity = 'receipt:CON1234XYZ'");
    assert.deepEqual([stored.status, stored.has_conflict, stored.conflict_count], ['needs_review', 1, 4]);
    assert.deepEqual(JSON.parse(stored.conflict_fields), ['amount_minor', 'counterparty_name']);
    assert.doesNotMatch(JSON.stringify(stored), /BUYER 500|0712345678/);
});

test('uses normalized fingerprints without a receipt and lets a reversal identity coexist with its normal receipt', async (t) => {
    const store = await temporaryStore(t);
    const noReceipt = 'Confirmed. Ksh50 received from TEST BUYER on 6/9/26 at 1:00 PM.';
    const first = await ingestPaymentImport({ source: 'manual', text: noReceipt, sender: 'MPESA' }, store.adapter);
    const retry = await ingestPaymentImport({ source: 'webhook', text: `  ${noReceipt.toLowerCase()}  `, sender: 'M-PESA' }, store.adapter);
    const normal = await ingestPaymentImport({ source: 'manual', text: 'REV1234XYZ Confirmed. Ksh100 received from ORIGINAL BUYER 0712345678.' }, store.adapter);
    const reversal = await ingestPaymentImport({ source: 'webhook', text: 'REV1234XYZ Confirmed. Ksh100 reversal of transaction.' }, store.adapter);

    assert.match(first.payment_import.dedupe_identity, /^fingerprint:[a-f0-9]{64}$/);
    assert.equal(retry.created, false);
    assert.equal(retry.payment_import.id, first.payment_import.id);
    assert.equal(normal.payment_import.dedupe_identity, 'receipt:REV1234XYZ');
    assert.equal(reversal.payment_import.dedupe_identity, 'reversal:REV1234XYZ');
    assert.equal(reversal.payment_import.status, 'reversed');
    assert.equal((await get(store.db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 3);
});

test('repeated concurrent retries create one row and return deterministic duplicate results', async (t) => {
    const store = await temporaryStore(t);
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => ingestPaymentImport({
        source: index % 2 ? 'webhook' : 'manual', text: incoming, sender: 'MPESA'
    }, store.adapter)));

    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(results.filter(result => result.duplicate).length, 4);
    assert.ok(results.every(result => result.conflict === false && result.conflict_fields.length === 0));
    assert.equal(new Set(results.map(result => result.payment_import.id)).size, 1);
    assert.equal((await get(store.db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 1);
});

test('rejects raw SMS and prose in opaque metadata while accepting ordinary Android IDs and SIM labels', async (t) => {
    const store = await temporaryStore(t);
    const rawMetadata = 'MET1234XYZ Confirmed. Ksh100 received from METADATA TEST 0712345678.';
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values) => logs.push(values.join(' '));
    console.error = (...values) => logs.push(values.join(' '));
    try {
        for (const field of ['source_message_id', 'device_id', 'sim']) {
            await assert.rejects(ingestPaymentImport({ source: 'manual', text: incoming, [field]: rawMetadata }, store.adapter), /opaque identifier|safe slot label/);
        }
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.equal(logs.join('\n'), '');
    assert.equal((await get(store.db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 0);

    const accepted = await ingestPaymentImport({
        source: 'webhook', text: 'SIM1234XYZ Confirmed. Ksh25 received from SLOT TEST 0712345678.',
        source_message_id: 'forwarder:123e4567-e89b-12d3-a456-426614174000', device_id: 'android:pixel-7', sim: 0
    }, store.adapter);
    assert.deepEqual(
        [accepted.payment_import.source_message_id, accepted.payment_import.device_id, accepted.payment_import.sim_slot],
        ['forwarder:123e4567-e89b-12d3-a456-426614174000', 'android:pixel-7', '0']
    );
    const stored = await get(store.db, 'SELECT * FROM payment_imports');
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(rawMetadata.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(accepted), new RegExp(rawMetadata.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('validation failures and unexpected database failures rethrow without inserting a row', async (t) => {
    const store = await temporaryStore(t);
    for (const input of [
        { source: 'daraja', text: incoming },
        { source: 'manual', text: '   ' },
        { source: 'manual', text: 'x'.repeat(MAX_SMS_LENGTH + 1) },
        { source: 'manual', text: incoming, sent_at_ms: -1 },
        { source: 'manual', text: incoming, received_at_ms: 1.5 }
    ]) {
        await assert.rejects(ingestPaymentImport(input, store.adapter));
    }
    await assert.rejects(
        ingestPaymentImport({ source: 'manual', text: incoming }, {
            runQuery: async () => { throw new Error('injected disk failure'); },
            getQuery: store.adapter.getQuery,
            allQuery: store.adapter.allQuery
        }),
        /injected disk failure/
    );
    assert.equal((await get(store.db, 'SELECT COUNT(*) AS count FROM payment_imports')).count, 0);
});

test('never returns, stores, or logs a full raw SMS body and preserves malformed evidence for review', async (t) => {
    const store = await temporaryStore(t);
    const raw = 'ZER1234XYZ Confirmed. You have received Ksh0.00 from PRIVATE CUSTOMER 0712345678. New M-PESA balance is Ksh9,999. Fuliza M-PESA limit is Ksh1,000.';
    const originalLog = console.log;
    const originalError = console.error;
    const logs = [];
    console.log = (...values) => logs.push(values.join(' '));
    console.error = (...values) => logs.push(values.join(' '));
    try {
        const zero = await ingestPaymentImport({ source: 'webhook', text: raw, sender: '0712345678' }, store.adapter);
        const malformed = await ingestPaymentImport({ source: 'manual', text: 'not a payment message', sender: 'not-safe-sender' }, store.adapter);
        assert.equal(zero.payment_import.source, 'webhook');
        assert.equal(zero.payment_import.status, 'needs_review');
        assert.ok(zero.payment_import.parse_warnings.includes('non_positive_amount'));
        assert.equal(malformed.payment_import.status, 'needs_review');
        assert.equal(malformed.payment_import.sender_masked, null);
        assert.doesNotMatch(JSON.stringify(zero), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(JSON.stringify(zero), /0712345678|9,999|FULIZA/i);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.equal(logs.join('\n'), '');
    const stored = await all(store.db, 'SELECT * FROM payment_imports');
    assert.ok(stored.every(row => !JSON.stringify(row).includes(raw)));
    assert.ok(stored.every(row => !/0712345678|9,999|FULIZA/i.test(JSON.stringify(row))));
    assert.ok(stored.every(row => !JSON.stringify(row).includes('not-safe-sender')));
});

test('lists only safe fields with bounded filtering, newest-first order, and malformed warning JSON fallback', async (t) => {
    const store = await temporaryStore(t);
    await run(store.db, `
        INSERT INTO payment_imports (
            id, source, status, parser_version, message_fingerprint, dedupe_identity,
            direction, event_kind, parse_warnings, redacted_evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ['older', 'manual', 'needs_review', 'v1', 'f-old', 'receipt:OLDER001', 'unknown', 'unknown', '[]', 'safe old evidence', '2026-01-01 00:00:00']);
    await run(store.db, `
        INSERT INTO payment_imports (
            id, source, status, parser_version, message_fingerprint, dedupe_identity,
            direction, event_kind, parse_warnings, redacted_evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ['newer', 'webhook', 'needs_review', 'v1', 'f-new', 'fingerprint:f-new', 'unknown', 'unknown', '{bad json', 'safe new evidence', '2026-01-02 00:00:00']);

    const listed = await listPaymentImports({ limit: 999, offset: -20, status: 'needs_review' }, store.adapter);
    assert.equal(listed.limit, 100);
    assert.equal(listed.offset, 0);
    assert.deepEqual(listed.items.map(item => item.id), ['newer', 'older']);
    assert.deepEqual(listed.items[0].parse_warnings, ['malformed_stored_parse_warnings']);
    assert.ok(listed.items.every(item => !Object.hasOwn(item, 'text') && !Object.hasOwn(item, 'raw_sms')));

    const filtered = await listPaymentImports({ source: 'manual', limit: 1 }, store.adapter);
    assert.deepEqual(filtered.items.map(item => item.id), ['older']);
    assert.equal((await getPaymentImport('newer', store.adapter)).id, 'newer');
    await assert.rejects(listPaymentImports({ status: 'invalid' }, store.adapter));
    await assert.rejects(listPaymentImports({ limit: 1.2 }, store.adapter));
});
