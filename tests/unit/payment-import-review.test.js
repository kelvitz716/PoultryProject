const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { migratePaymentImports } = require('../../migrations/payment-imports');
const { ingestPaymentImport } = require('../../services/payment-imports');
const {
    MAX_REVIEW_NOTE_LENGTH,
    PaymentImportNotFoundError,
    PaymentImportStateConflictError,
    rejectPaymentImport
} = require('../../services/payment-import-review');

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function temporaryStore(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-payment-import-review-'));
    const db = await openDatabase(path.join(tempDir, 'payment-imports.sqlite'));
    const calls = [];
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, "INSERT INTO users (id) VALUES ('reviewer-1'), ('reviewer-2')");
    await migratePaymentImports(db);
    t.after(async () => {
        await close(db);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const adapter = {
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
    };
    return { db, calls, adapter };
}

async function createImport(store, text = 'REJ1234XYZ Confirmed. Ksh100 received from REVIEW BUYER 0712345678.') {
    return ingestPaymentImport({ source: 'manual', text, sender: 'MPESA' }, store.adapter);
}

test('rejects received evidence atomically without changing parsed evidence or ledger state', async (t) => {
    const store = await temporaryStore(t);
    const created = await createImport(store);
    const before = await get(store.db, 'SELECT receipt_code, amount_minor, direction, event_kind, redacted_evidence FROM payment_imports WHERE id = ?', [created.payment_import.id]);
    store.calls.length = 0;

    const result = await rejectPaymentImport({
        id: created.payment_import.id, reviewer_user_id: 'reviewer-1', review_notes: 'No matching farm order for 0712345678.'
    }, store.adapter);

    assert.equal(result.idempotent, false);
    assert.deepEqual(
        [result.payment_import.status, result.payment_import.reviewer_user_id, result.payment_import.review_notes],
        ['rejected', 'reviewer-1', 'No matching farm order for ••••5678.']
    );
    assert.ok(result.payment_import.reviewed_at);
    assert.ok(result.payment_import.rejected_at);
    const after = await get(store.db, 'SELECT receipt_code, amount_minor, direction, event_kind, redacted_evidence FROM payment_imports WHERE id = ?', [created.payment_import.id]);
    assert.deepEqual(after, before);
    assert.ok(store.calls.some(call => call.kind === 'get' && call.sql.trim().startsWith('UPDATE payment_imports')));
    assert.ok(store.calls.every(call => !/^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim())));
    assert.ok(store.calls.every(call => !/\b(?:transactions|ledger_)\b/i.test(call.sql)));
});

test('supports received and needs_review rejection, keeps rejected retries immutable, and rejects terminal states', async (t) => {
    const store = await temporaryStore(t);
    const received = await createImport(store, 'RID1234XYZ Confirmed. Ksh100 received from RETRY BUYER 0712345678.');
    const first = await rejectPaymentImport({ id: received.payment_import.id, reviewer_user_id: 'reviewer-1', review_notes: 'First reviewer note.' }, store.adapter);
    const retry = await rejectPaymentImport({ id: received.payment_import.id, reviewer_user_id: 'reviewer-2', review_notes: 'Second reviewer note.' }, store.adapter);
    assert.equal(retry.idempotent, true);
    assert.deepEqual(
        [retry.payment_import.reviewer_user_id, retry.payment_import.review_notes, retry.payment_import.reviewed_at, retry.payment_import.rejected_at],
        [first.payment_import.reviewer_user_id, first.payment_import.review_notes, first.payment_import.reviewed_at, first.payment_import.rejected_at]
    );

    const reviewNeeded = await createImport(store, 'NEE1234XYZ Confirmed. Ksh0.00 received from ZERO BUYER 0712345678.');
    assert.equal(reviewNeeded.payment_import.status, 'needs_review');
    assert.equal((await rejectPaymentImport({ id: reviewNeeded.payment_import.id, reviewer_user_id: 'reviewer-1' }, store.adapter)).payment_import.status, 'rejected');

    const terminal = await createImport(store, 'TER1234XYZ Confirmed. Ksh100 received from TERMINAL BUYER 0712345678.');
    for (const status of ['approved', 'reversed']) {
        await run(store.db, 'UPDATE payment_imports SET status = ? WHERE id = ?', [status, terminal.payment_import.id]);
        await assert.rejects(
            rejectPaymentImport({ id: terminal.payment_import.id, reviewer_user_id: 'reviewer-1' }, store.adapter),
            PaymentImportStateConflictError
        );
    }
    await assert.rejects(rejectPaymentImport({ id: 'missing-import', reviewer_user_id: 'reviewer-1' }, store.adapter), PaymentImportNotFoundError);
});

test('concurrent rejections retain the first reviewer and one durable rejection', async (t) => {
    const store = await temporaryStore(t);
    const created = await createImport(store, 'CONREJ123 Confirmed. Ksh100 received from CONCURRENT BUYER 0712345678.');
    const results = await Promise.all([
        rejectPaymentImport({ id: created.payment_import.id, reviewer_user_id: 'reviewer-1', review_notes: 'First decision.' }, store.adapter),
        rejectPaymentImport({ id: created.payment_import.id, reviewer_user_id: 'reviewer-2', review_notes: 'Second decision.' }, store.adapter)
    ]);
    const winners = results.filter(result => result.idempotent === false);
    const retries = results.filter(result => result.idempotent === true);
    assert.equal(winners.length, 1);
    assert.equal(retries.length, 1);
    const winner = winners[0].payment_import;
    const stored = await get(store.db, 'SELECT status, reviewer_user_id, review_notes FROM payment_imports WHERE id = ?', [created.payment_import.id]);
    assert.deepEqual(stored, { status: 'rejected', reviewer_user_id: winner.reviewer_user_id, review_notes: winner.review_notes });
    assert.deepEqual(
        [retries[0].payment_import.reviewer_user_id, retries[0].payment_import.review_notes],
        [winner.reviewer_user_id, winner.review_notes]
    );
    const laterRetry = await rejectPaymentImport({
        id: created.payment_import.id,
        reviewer_user_id: 'reviewer-1',
        review_notes: 'Later attempted overwrite.'
    }, store.adapter);
    assert.equal(laterRetry.idempotent, true);
    assert.deepEqual(
        [laterRetry.payment_import.reviewer_user_id, laterRetry.payment_import.review_notes],
        [winner.reviewer_user_id, winner.review_notes]
    );
});

test('atomic rejection does not capture an interleaved ingestion on the shared adapter', async (t) => {
    const store = await temporaryStore(t);
    const target = await createImport(store, 'INT1234XYZ Confirmed. Ksh100 received from INTERLEAVE TARGET 0712345678.');
    let interleaved;
    const interleavingAdapter = {
        ...store.adapter,
        getQuery: async (sql, params = []) => {
            if (sql.trim().startsWith('UPDATE payment_imports') && !interleaved) {
                interleaved = await ingestPaymentImport({
                    source: 'webhook', text: 'INT5678XYZ Confirmed. Ksh200 received from INTERLEAVE WRITE 0712345678.'
                }, store.adapter);
            }
            return store.adapter.getQuery(sql, params);
        }
    };
    const rejected = await rejectPaymentImport({ id: target.payment_import.id, reviewer_user_id: 'reviewer-1' }, interleavingAdapter);
    assert.equal(rejected.payment_import.status, 'rejected');
    assert.equal(interleaved.created, true);
    const rows = await all(store.db, 'SELECT status FROM payment_imports ORDER BY receipt_code');
    assert.deepEqual(rows.map(row => row.status).sort(), ['received', 'rejected']);
});

test('an injected atomic-statement failure leaves the import unchanged and does not roll back another write', async (t) => {
    const store = await temporaryStore(t);
    const writeFailure = await createImport(store, 'WRT1234XYZ Confirmed. Ksh100 received from WRITE BUYER 0712345678.');
    let interleaved;
    const failingAtomicAdapter = {
        ...store.adapter,
        getQuery: async (sql, params = []) => {
            if (sql.trim().startsWith('UPDATE payment_imports')) {
                interleaved = await ingestPaymentImport({
                    source: 'webhook', text: 'FAI1234XYZ Confirmed. Ksh200 received from FAILURE WRITE 0712345678.'
                }, store.adapter);
                throw new Error('injected atomic failure');
            }
            return store.adapter.getQuery(sql, params);
        }
    };
    await assert.rejects(rejectPaymentImport({ id: writeFailure.payment_import.id, reviewer_user_id: 'reviewer-1' }, failingAtomicAdapter), /injected atomic failure/);
    assert.equal((await get(store.db, 'SELECT status FROM payment_imports WHERE id = ?', [writeFailure.payment_import.id])).status, 'received');
    assert.equal(interleaved.created, true);
    assert.equal((await get(store.db, "SELECT status FROM payment_imports WHERE receipt_code = 'FAI1234XYZ'")).status, 'received');
});

test('validates bounded safe rejection input', async (t) => {
    const store = await temporaryStore(t);
    const created = await createImport(store, 'RED1234XYZ Confirmed. Ksh100 received from READ BUYER 0712345678.');
    for (const request of [
        { id: '', reviewer_user_id: 'reviewer-1' },
        { id: created.payment_import.id, reviewer_user_id: 'bad reviewer' },
        { id: created.payment_import.id, reviewer_user_id: 'reviewer-1', review_notes: 'x'.repeat(MAX_REVIEW_NOTE_LENGTH + 1) },
        { id: created.payment_import.id, reviewer_user_id: 'reviewer-1', review_notes: 'Copied SMS: RAW1234XYZ Confirmed. Ksh100 received from SOMEONE 0712345678.' },
        { id: created.payment_import.id, reviewer_user_id: 'reviewer-1', review_notes: 'Ksh100 received from SOMEONE 0712345678.' }
    ]) {
        await assert.rejects(rejectPaymentImport(request, store.adapter), /opaque identifier|bounded safe text|raw payment message/);
    }
});
