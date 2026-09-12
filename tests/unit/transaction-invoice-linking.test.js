const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { resolveTransactionCustomer } = require('../../services/transaction-customer-validation');
const { syncTransactionToLedgerWithAdapter } = require('../../services/ledger');
const { recordCustomerAccountEventWithAdapter } = require('../../services/customer-settlement');
const {
    TransactionPersistenceConflictError,
    createTransactionPersistenceService
} = require('../../services/transaction-persistence');

function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db));
    });
}
function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
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

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-invoice-link-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, `CREATE TABLE customers (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
        payment_terms_days INTEGER NOT NULL, is_active INTEGER NOT NULL
    )`);
    await run(db, `CREATE TABLE transactions (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, data TEXT NOT NULL, updated_at DATETIME
    )`);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
        account_id TEXT, entry_type TEXT, amount REAL NOT NULL, amount_minor INTEGER, reconciliation_status TEXT
    )`);
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, `CREATE TABLE customer_account_events (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, currency TEXT NOT NULL, side TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT,
        external_reference TEXT, payment_import_id TEXT, source_transaction_id TEXT, original_event_id TEXT,
        reason_code TEXT,
        idempotency_key TEXT NOT NULL UNIQUE, created_by_user_id TEXT, reviewer_user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_at DATETIME, reversed_at DATETIME
    )`);
    await run(db, `CREATE UNIQUE INDEX invoice_source_transaction
        ON customer_account_events(source_transaction_id)
        WHERE kind = 'invoice' AND source_transaction_id IS NOT NULL`);
    await run(db, `CREATE TABLE customer_account_allocations (
        id TEXT PRIMARY KEY, credit_event_id TEXT, debit_event_id TEXT, amount_minor INTEGER,
        status TEXT DEFAULT 'active', idempotency_key TEXT UNIQUE, created_by_user_id TEXT
    )`);
    await run(db, `INSERT INTO customers (id, display_name, payment_terms_days, is_active) VALUES
        ('customer:cod', 'COD Named Buyer', 0, 1),
        ('customer:net', 'Net Named Buyer', 14, 1),
        ('customer:other', 'Other Buyer', 30, 1)`);
    t.after(async () => {
        await close(db);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, boundary: createDedicatedTransactionBoundary(file) };
}

function service(boundary, overrides = {}) {
    return createTransactionPersistenceService({
        withDedicatedTransaction: boundary.withDedicatedTransaction,
        resolveTransactionCustomer,
        syncTransactionToLedgerWithAdapter,
        recordCustomerAccountEventWithAdapter,
        ...overrides
    });
}

function namedSale(id, customerId, amount = '1250.50') {
    return {
        id, type: 'sale', category: 'eggs', qty: 10, raw_unit: 'pcs', amount, customerId,
        buyerName: 'forged buyer', buyerTerms: 'Net 30', paymentTermsDays: 30,
        status: 'paid', payment_method: 'mpesa', mpesa_code: 'FORGED123',
        created_by_user_id: 'forged:body-actor'
    };
}
function walkInSale(id, amount = 500) {
    return {
        id, type: 'sale', category: 'eggs', amount, customerId: null,
        buyerName: 'forged walk-in', buyerTerms: 'COD', paymentTermsDays: 0,
        status: 'paid', payment_method: 'mpesa'
    };
}
function purchase(id, amount = 500) {
    return { id, type: 'purchase', category: 'feed', amount, payment_method: 'cash' };
}
async function state(db, id) {
    return {
        transaction: await get(db, 'SELECT batch_id, data FROM transactions WHERE id = ?', [id]),
        header: await get(db, 'SELECT * FROM ledger_transactions WHERE id = ?', [id]),
        entries: await all(db, 'SELECT account_id, entry_type, amount, amount_minor FROM ledger_entries WHERE transaction_id = ? ORDER BY id', [id]),
        invoice: await get(db, "SELECT * FROM customer_account_events WHERE kind = 'invoice' AND source_transaction_id = ?", [id])
    };
}
async function financialCounts(db) {
    return {
        payments: (await get(db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'payment'")).n,
        allocations: (await get(db, 'SELECT COUNT(*) AS n FROM customer_account_allocations')).n,
        imports: (await get(db, 'SELECT COUNT(*) AS n FROM payment_imports')).n
    };
}

test('named COD and Net sales each create one unpaid invoice and receivable ledger pair without payment effects', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await persistence.createOrUpdateTransaction('batch-1', namedSale('named-cod', 'customer:cod'), 'actor:one');
    await persistence.createOrUpdateTransaction('batch-1', namedSale('named-net', 'customer:net', '2000.00'), 'actor:two');

    for (const [id, customer, actor, minor] of [
        ['named-cod', 'customer:cod', 'actor:one', 125050],
        ['named-net', 'customer:net', 'actor:two', 200000]
    ]) {
        const saved = await state(s.db, id);
        const json = JSON.parse(saved.transaction.data);
        assert.equal(json.status, 'unpaid');
        assert.equal(json.customerId, customer);
        assert.equal(json.payment_method, undefined);
        assert.equal(json.mpesa_code, undefined);
        assert.equal(json.created_by_user_id, undefined);
        assert.deepEqual(saved.entries.map(row => [row.account_id, row.entry_type, row.amount_minor]), [
            ['4000', 'credit', minor], ['1200', 'debit', minor]
        ]);
        assert.deepEqual(
            [saved.invoice.customer_id, saved.invoice.kind, saved.invoice.status, saved.invoice.amount_minor,
                saved.invoice.source_transaction_id, saved.invoice.created_by_user_id],
            [customer, 'invoice', 'posted', minor, id, actor]
        );
    }
    assert.deepEqual(await financialCounts(s.db), { payments: 0, allocations: 0, imports: 0 });
});

test('walk-in COD sale remains direct tender and creates no customer event', async t => {
    const s = await store(t);
    await service(s.boundary).createOrUpdateTransaction('batch-1', walkInSale('walkin-1'), 'actor:one');
    const saved = await state(s.db, 'walkin-1');
    assert.equal(JSON.parse(saved.transaction.data).status, 'paid');
    assert.deepEqual(saved.entries.map(row => [row.account_id, row.entry_type]), [
        ['4000', 'credit'], ['1010', 'debit']
    ]);
    assert.equal(saved.invoice, undefined);
    assert.deepEqual(await financialCounts(s.db), { payments: 0, allocations: 0, imports: 0 });
});

test('exact named-sale retries, including concurrent different actors, retain the original invoice and GL evidence', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    const request = namedSale('retry-invoice', 'customer:cod', '100.00');
    await persistence.createOrUpdateTransaction('batch-1', request, 'actor:original');
    const before = await state(s.db, 'retry-invoice');
    await Promise.all([
        persistence.createOrUpdateTransaction('batch-1', request, 'actor:later-a'),
        persistence.createOrUpdateTransaction('batch-1', request, 'actor:later-b')
    ]);
    const after = await state(s.db, 'retry-invoice');
    assert.deepEqual(after, before);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'invoice'")).n, 1);
});

test('linked invoice rejects material, walk-in, and non-sale rewrites without changing any surface', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await persistence.createOrUpdateTransaction('batch-1', namedSale('immutable-invoice', 'customer:cod', 100), 'actor:one');
    const before = await state(s.db, 'immutable-invoice');
    for (const replacement of [
        namedSale('immutable-invoice', 'customer:other', 100),
        namedSale('immutable-invoice', 'customer:cod', 200),
        walkInSale('immutable-invoice', 100),
        purchase('immutable-invoice', 100)
    ]) {
        await assert.rejects(
            persistence.createOrUpdateTransaction('batch-1', replacement, 'actor:two'),
            TransactionPersistenceConflictError
        );
        assert.deepEqual(await state(s.db, 'immutable-invoice'), before);
    }
    await assert.rejects(
        persistence.createOrUpdateTransaction('other-batch', namedSale('immutable-invoice', 'customer:cod', 100), 'actor:one'),
        TransactionPersistenceConflictError
    );
    assert.deepEqual(await state(s.db, 'immutable-invoice'), before);
});

test('invoice and ledger write failures each roll back every linked surface', async t => {
    const s = await store(t);
    const invoiceFailing = service(s.boundary, {
        recordCustomerAccountEventWithAdapter: async () => { throw new Error('injected invoice failure'); }
    });
    await assert.rejects(
        invoiceFailing.createOrUpdateTransaction('batch-1', namedSale('invoice-fail', 'customer:cod'), 'actor:one'),
        /injected invoice failure/
    );
    assert.deepEqual(await state(s.db, 'invoice-fail'), { transaction: undefined, header: undefined, entries: [], invoice: undefined });

    const ledgerFailing = service(s.boundary, {
        syncTransactionToLedgerWithAdapter: async () => { throw new Error('injected ledger failure'); }
    });
    await assert.rejects(
        ledgerFailing.createOrUpdateTransaction('batch-1', namedSale('ledger-fail', 'customer:cod'), 'actor:one'),
        /injected ledger failure/
    );
    assert.deepEqual(await state(s.db, 'ledger-fail'), { transaction: undefined, header: undefined, entries: [], invoice: undefined });
    assert.deepEqual(await financialCounts(s.db), { payments: 0, allocations: 0, imports: 0 });
});

test('linked invoice blocks single and mixed bulk deletion while unlinked deletion still works', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await persistence.createOrUpdateTransaction('batch-1', namedSale('delete-invoice', 'customer:cod'), 'actor:one');
    await persistence.createOrUpdateTransaction('batch-1', purchase('delete-unlinked'));
    const linkedBefore = await state(s.db, 'delete-invoice');
    const plainBefore = await state(s.db, 'delete-unlinked');
    await assert.rejects(persistence.deleteTransaction('batch-1', 'delete-invoice'), TransactionPersistenceConflictError);
    assert.deepEqual(await state(s.db, 'delete-invoice'), linkedBefore);
    await assert.rejects(persistence.deleteTransactionsForBatch('batch-1'), TransactionPersistenceConflictError);
    assert.deepEqual(await state(s.db, 'delete-invoice'), linkedBefore);
    assert.deepEqual(await state(s.db, 'delete-unlinked'), plainBefore);
    await persistence.deleteTransaction('batch-1', 'delete-unlinked');
    assert.deepEqual(await state(s.db, 'delete-unlinked'), { transaction: undefined, header: undefined, entries: [], invoice: undefined });
});

test('new named-sale transaction IDs are bounded opaque source identifiers', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await assert.rejects(
        persistence.createOrUpdateTransaction('batch-1', namedSale('x'.repeat(129), 'customer:cod'), 'actor:one'),
        /transaction id is invalid/
    );
    assert.deepEqual(await state(s.db, 'x'.repeat(129)), { transaction: undefined, header: undefined, entries: [], invoice: undefined });
});
