const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const {
    TransactionCustomerValidationError,
    resolveTransactionCustomer
} = require('../../services/transaction-customer-validation');

function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db));
    });
}
function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        return error ? reject(error) : resolve(this);
    }));
}
function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}
function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-tx-customer-'));
    const db = await open(path.join(dir, 'db.sqlite'));
    await run(db, `CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        payment_terms_days INTEGER NOT NULL,
        is_active INTEGER NOT NULL
    )`);
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY)');
    await run(db, `INSERT INTO customers (id, display_name, payment_terms_days, is_active)
        VALUES ('customer:cod', 'COD Customer', 0, 1),
               ('customer:credit', 'Credit Customer', 14, 1),
               ('customer:inactive', 'Inactive Customer', 7, 0)`);
    t.after(async () => {
        await close(db);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, adapter: { getQuery: (sql, params = []) => get(db, sql, params) } };
}

test('active named customers overwrite forged sale snapshots for COD and credit', async t => {
    const s = await store(t);
    const cod = await resolveTransactionCustomer({
        type: 'sale', customerId: 'customer:cod', buyerName: 'Forged Buyer',
        buyerTerms: 'Net 30', paymentTermsDays: 30, status: 'unpaid'
    }, s.adapter);
    assert.deepEqual(cod, {
        type: 'sale', customerId: 'customer:cod', buyerName: 'COD Customer',
        buyerTerms: 'COD', paymentTermsDays: 0, status: 'unpaid'
    });

    const credit = await resolveTransactionCustomer({
        type: 'sale', customerId: 'customer:credit', buyerName: 'Forged Buyer',
        buyerTerms: 'COD', paymentTermsDays: 0, status: 'paid'
    }, s.adapter);
    assert.deepEqual(credit, {
        type: 'sale', customerId: 'customer:credit', buyerName: 'Credit Customer',
        buyerTerms: 'Net 14', paymentTermsDays: 14, status: 'unpaid'
    });
});

test('walk-in sales are derived as transaction-local COD and paid', async t => {
    const s = await store(t);
    const walkIn = await resolveTransactionCustomer({
        type: 'sale', customerId: null, buyerName: 'Forged Walk-in',
        buyerTerms: 'COD', paymentTermsDays: 0, status: 'paid'
    }, s.adapter);
    assert.deepEqual(walkIn, {
        type: 'sale', customerId: null, buyerName: 'Walk-in Customer',
        buyerTerms: 'COD', paymentTermsDays: 0, status: 'paid'
    });
    await assert.rejects(resolveTransactionCustomer({
        type: 'sale', customerId: null, buyerTerms: 'Net 7', paymentTermsDays: 7, status: 'unpaid'
    }, s.adapter), TransactionCustomerValidationError);
});

test('missing, inactive, malformed, and non-sale customer fields are rejected without side effects', async t => {
    const s = await store(t);
    const invalid = [
        { type: 'sale' },
        { type: 'sale', customerId: 'customer:missing' },
        { type: 'sale', customerId: 'customer:inactive' },
        { type: 'sale', customerId: 7 },
        { type: 'sale', customerId: null, paymentTermsDays: '7' },
        { type: 'sale', customerId: null, buyerTerms: 'Terms 7' },
        { type: 'sale', customerId: null, status: 'pending' },
        { type: 'purchase', customerId: null },
        { type: 7, customerId: 'customer:cod' }
    ];
    for (const transaction of invalid) {
        await assert.rejects(resolveTransactionCustomer(transaction, s.adapter), TransactionCustomerValidationError);
    }
    for (const table of ['transactions', 'payment_imports', 'customer_account_events', 'ledger_transactions', 'ledger_entries']) {
        assert.equal((await get(s.db, `SELECT COUNT(*) AS n FROM ${table}`)).n, 0);
    }
});
