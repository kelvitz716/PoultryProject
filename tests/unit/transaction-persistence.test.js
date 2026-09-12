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
    TransactionPersistenceValidationError,
    createTransactionPersistenceService
} = require('../../services/transaction-persistence');

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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-transaction-persistence-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, `CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        payment_terms_days INTEGER NOT NULL,
        is_active INTEGER NOT NULL
    )`);
    await run(db, `CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at DATETIME
    )`);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        description TEXT,
        ref_type TEXT,
        ref_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
        account_id TEXT,
        entry_type TEXT,
        amount REAL NOT NULL,
        amount_minor INTEGER,
        reconciliation_status TEXT
    )`);
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, `CREATE TABLE customer_account_events (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        side TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        method TEXT,
        external_reference TEXT,
        payment_import_id TEXT,
        source_transaction_id TEXT,
        original_event_id TEXT,
        reason_code TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT,
        reviewer_user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        posted_at DATETIME,
        reversed_at DATETIME
    )`);
    await run(db, `CREATE UNIQUE INDEX customer_invoice_source
        ON customer_account_events(source_transaction_id)
        WHERE kind = 'invoice' AND source_transaction_id IS NOT NULL`);
    await run(db, `CREATE TABLE customer_account_allocations (
        id TEXT PRIMARY KEY,
        credit_event_id TEXT,
        debit_event_id TEXT,
        amount_minor INTEGER,
        status TEXT DEFAULT 'active',
        idempotency_key TEXT UNIQUE,
        created_by_user_id TEXT
    )`);
    await run(db, `INSERT INTO customers (id, display_name, payment_terms_days, is_active) VALUES
        ('customer:cash', 'Cash Customer', 0, 1),
        ('customer:credit', 'Credit Customer', 14, 1),
        ('customer:inactive', 'Inactive Customer', 7, 0)`);
    t.after(async () => {
        await close(db);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, boundary: createDedicatedTransactionBoundary(file), file };
}

function service(boundary, overrides = {}) {
    const persistence = createTransactionPersistenceService({
        withDedicatedTransaction: boundary.withDedicatedTransaction,
        resolveTransactionCustomer,
        syncTransactionToLedgerWithAdapter,
        recordCustomerAccountEventWithAdapter,
        ...overrides
    });
    return {
        ...persistence,
        createOrUpdateTransaction: (batchId, transaction, actor = 'test:actor') =>
            persistence.createOrUpdateTransaction(batchId, transaction, actor)
    };
}

function sale(id, customerId = 'customer:cash', amount = 1500) {
    return {
        id,
        type: 'sale',
        category: 'eggs',
        amount,
        customerId,
        buyerName: 'Forged client value',
        buyerTerms: 'Net 30',
        paymentTermsDays: 30,
        status: 'unpaid',
        payment_method: 'cash'
    };
}

function purchase(id, amount = 500) {
    return { id, type: 'purchase', category: 'feed', amount, payment_method: 'cash' };
}

async function financialRows(db, id) {
    return {
        transaction: await get(db, 'SELECT batch_id, data FROM transactions WHERE id = ?', [id]),
        header: await get(db, 'SELECT id, ref_type, ref_id FROM ledger_transactions WHERE id = ?', [id]),
        entries: await all(db, `SELECT account_id, entry_type, amount, amount_minor, reconciliation_status
            FROM ledger_entries WHERE transaction_id = ? ORDER BY id`, [id])
    };
}

test('create/update share one adapter, derive customer snapshots, and keep legacy empty non-sale snapshots compatible', async t => {
    const s = await store(t);
    const adapterCalls = [];
    const observedService = service(s.boundary, {
        resolveTransactionCustomer: async (input, adapter) => {
            adapterCalls.push(adapter);
            return resolveTransactionCustomer(input, adapter);
        },
        syncTransactionToLedgerWithAdapter: async (adapter, ...args) => {
            adapterCalls.push(adapter);
            return syncTransactionToLedgerWithAdapter(adapter, ...args);
        }
    });

    const created = await observedService.createOrUpdateTransaction('batch-1', sale('tx-1', 'customer:credit', 1500));
    assert.deepEqual(
        [created.buyerName, created.buyerTerms, created.paymentTermsDays, created.status],
        ['Credit Customer', 'Net 14', 14, 'unpaid']
    );
    assert.equal(adapterCalls.length, 2);
    assert.equal(adapterCalls[0], adapterCalls[1]);

    const state = await financialRows(s.db, 'tx-1');
    assert.equal(JSON.parse(state.transaction.data).amount, 1500);
    assert.deepEqual(state.entries.sort((left, right) => left.entry_type.localeCompare(right.entry_type)), [
        { account_id: '4000', entry_type: 'credit', amount: 1500, amount_minor: 150000, reconciliation_status: 'exact' },
        { account_id: '1200', entry_type: 'debit', amount: 1500, amount_minor: 150000, reconciliation_status: 'exact' }
    ]);

    const legacy = await observedService.createOrUpdateTransaction('batch-1', {
        id: 'legacy-purchase', type: 'purchase', category: 'feed', amount: 500,
        customerId: null, buyerName: '', buyerTerms: '', paymentTermsDays: ''
    });
    assert.equal(Object.hasOwn(legacy, 'customerId'), false);
    await assert.rejects(
        observedService.createOrUpdateTransaction('batch-1', { ...legacy, id: 'bad-legacy', customerId: null }),
        TransactionPersistenceValidationError
    );

    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM payment_imports')).n, 0);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customer_account_events')).n, 1);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customer_account_allocations')).n, 0);
});

test('new sales, purchases, and M-Pesa entries retain compatibility amounts with exact identical minor units', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    const mpesaSale = await persistence.createOrUpdateTransaction('batch-1', {
        ...sale('minor-sale', 'customer:cash', '1250.50'),
        payment_method: 'mpesa',
        mpesa_code: 'MIN123ABC'
    });
    const purchase = await persistence.createOrUpdateTransaction('batch-1', {
        id: 'minor-purchase', type: 'purchase', category: 'feed', amount: '0.01', payment_method: 'mpesa'
    });
    const saleState = await financialRows(s.db, 'minor-sale');
    const purchaseState = await financialRows(s.db, 'minor-purchase');
    assert.deepEqual([mpesaSale.amount, Object.hasOwn(mpesaSale, 'amountMinor')], [1250.5, false]);
    assert.deepEqual(saleState.entries.map(row => [row.account_id, row.amount, row.amount_minor, row.reconciliation_status]), [
        ['4000', 1250.5, 125050, 'exact'], ['1200', 1250.5, 125050, 'exact']
    ]);
    assert.deepEqual(purchaseState.entries.map(row => [row.account_id, row.amount, row.amount_minor, row.reconciliation_status]), [
        ['1010', 0.01, 1, 'exact'], ['1310', 0.01, 1, 'exact']
    ]);
    assert.equal(JSON.parse(saleState.transaction.data).amountMinor, undefined);
    assert.equal(JSON.parse(purchaseState.transaction.data).amount, 0.01);
});

test('invalid exact-money creates and updates fail before mutation and preserve prior financial state', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await persistence.createOrUpdateTransaction('batch-1', sale('money-update', 'customer:cash', '20.00'));
    const prior = await financialRows(s.db, 'money-update');
    for (const invalid of ['1.234', '1e3', '1,000', 0, -1]) {
        await assert.rejects(
            persistence.createOrUpdateTransaction('batch-1', sale('money-update', 'customer:cash', invalid)),
            TransactionPersistenceValidationError
        );
        assert.deepEqual(await financialRows(s.db, 'money-update'), prior);
    }
    await assert.rejects(
        persistence.createOrUpdateTransaction('batch-1', { ...sale('money-new'), amountMinor: 100 }),
        TransactionPersistenceValidationError
    );
    assert.deepEqual(await financialRows(s.db, 'money-new'), { transaction: undefined, header: undefined, entries: [] });
});

test('ledger failures roll back a new JSON transaction and all ledger rows', async t => {
    const s = await store(t);
    const failing = service(s.boundary, {
        syncTransactionToLedgerWithAdapter: async (adapter, ...args) => {
            await syncTransactionToLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.startsWith('INSERT INTO ledger_entries')) throw new Error('injected ledger failure');
                    return adapter.runQuery(sql, params);
                }
            }, ...args);
        }
    });
    await assert.rejects(failing.createOrUpdateTransaction('batch-1', sale('new-failure')), /injected ledger failure/);
    assert.deepEqual(await financialRows(s.db, 'new-failure'), { transaction: undefined, header: undefined, entries: [] });
});

test('ledger failures during update preserve the prior JSON transaction and ledger state', async t => {
    const s = await store(t);
    const healthy = service(s.boundary);
    await healthy.createOrUpdateTransaction('batch-1', purchase('update-failure', 1000));
    const prior = await financialRows(s.db, 'update-failure');
    const failing = service(s.boundary, {
        syncTransactionToLedgerWithAdapter: async (adapter, ...args) => {
            await syncTransactionToLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.startsWith('INSERT INTO ledger_entries')) throw new Error('injected update ledger failure');
                    return adapter.runQuery(sql, params);
                }
            }, ...args);
        }
    });
    await assert.rejects(failing.createOrUpdateTransaction('batch-1', purchase('update-failure', 3000)), /injected update ledger failure/);
    assert.deepEqual(await financialRows(s.db, 'update-failure'), prior);
});

test('single and bulk deletion roll back both transaction and ledger surfaces on failure', async t => {
    const s = await store(t);
    const healthy = service(s.boundary);
    await healthy.createOrUpdateTransaction('legacy-batch', purchase('delete-one'));
    await healthy.createOrUpdateTransaction('legacy-batch', purchase('delete-two'));
    await healthy.createOrUpdateTransaction('legacy-batch.0', purchase('delete-three'));
    const failureAfterFirstLedgerDelete = () => {
        let deletes = 0;
        return service(s.boundary, {
            syncTransactionToLedgerWithAdapter: async (adapter, ...args) => {
                await syncTransactionToLedgerWithAdapter({
                    ...adapter,
                    runQuery: async (sql, params = []) => {
                        if (sql.startsWith('DELETE FROM ledger_transactions') && ++deletes >= 1) {
                            throw new Error('injected delete failure');
                        }
                        return adapter.runQuery(sql, params);
                    }
                }, ...args);
            }
        });
    };
    await assert.rejects(failureAfterFirstLedgerDelete().deleteTransaction('legacy-batch', 'delete-one'), /injected delete failure/);
    assert.ok((await financialRows(s.db, 'delete-one')).transaction);

    let deletes = 0;
    const bulkFailing = service(s.boundary, {
        syncTransactionToLedgerWithAdapter: async (adapter, ...args) => {
            await syncTransactionToLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.startsWith('DELETE FROM ledger_transactions') && ++deletes === 2) {
                        throw new Error('injected bulk delete failure');
                    }
                    return adapter.runQuery(sql, params);
                }
            }, ...args);
        }
    });
    await assert.rejects(bulkFailing.deleteTransactionsForBatch('legacy-batch'), /injected bulk delete failure/);
    for (const id of ['delete-one', 'delete-two', 'delete-three']) {
        assert.ok((await financialRows(s.db, id)).transaction, `${id} transaction remains`);
        assert.ok((await financialRows(s.db, id)).header, `${id} ledger header remains`);
    }

    const result = await healthy.deleteTransactionsForBatch('legacy-batch');
    assert.deepEqual(result.deleted, ['delete-one', 'delete-three', 'delete-two']);
    for (const id of result.deleted) assert.deepEqual(await financialRows(s.db, id), { transaction: undefined, header: undefined, entries: [] });
});

test('mismatched deletes and cross-batch IDs cannot split or move transaction and ledger state', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await persistence.createOrUpdateTransaction('owned-batch', purchase('owned-tx', 700));
    const prior = await financialRows(s.db, 'owned-tx');

    const mismatch = await persistence.deleteTransaction('other-batch', 'owned-tx');
    assert.deepEqual(mismatch, { id: 'owned-tx', deleted: false });
    assert.deepEqual(await financialRows(s.db, 'owned-tx'), prior);

    await assert.rejects(
        persistence.createOrUpdateTransaction('other-batch', purchase('owned-tx', 900)),
        TransactionPersistenceConflictError
    );
    assert.deepEqual(await financialRows(s.db, 'owned-tx'), prior);

    await persistence.createOrUpdateTransaction('owned-batch.0', purchase('owned-tx', 800));
    const aliasUpdate = await financialRows(s.db, 'owned-tx');
    assert.equal(aliasUpdate.transaction.batch_id, 'owned-batch');
    assert.equal(JSON.parse(aliasUpdate.transaction.data).amount, 800);
    assert.equal(aliasUpdate.entries.length, 2);
});

test('dedicated transaction validates active customer before a concurrent deactivation can commit', async t => {
    const s = await store(t);
    let validationRead;
    const readReached = new Promise(resolve => { validationRead = resolve; });
    let releaseValidation;
    const waitForRelease = new Promise(resolve => { releaseValidation = resolve; });
    const pausingService = service(s.boundary, {
        resolveTransactionCustomer: async (input, adapter) => {
            const resolved = await resolveTransactionCustomer(input, adapter);
            validationRead();
            await waitForRelease;
            return resolved;
        }
    });
    const save = pausingService.createOrUpdateTransaction('batch-1', sale('concurrent-customer', 'customer:cash'));
    await readReached;
    let deactivated = false;
    const deactivate = s.boundary.withDedicatedTransaction(async adapter => {
        await adapter.runQuery('UPDATE customers SET is_active = 0 WHERE id = ?', ['customer:cash']);
        deactivated = true;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(deactivated, false, 'BEGIN IMMEDIATE keeps validation and writes together');
    releaseValidation();
    await Promise.all([save, deactivate]);
    assert.ok((await financialRows(s.db, 'concurrent-customer')).header);
    assert.equal((await get(s.db, 'SELECT is_active FROM customers WHERE id = ?', ['customer:cash'])).is_active, 0);
});

test('concurrent same-ID updates serialize to one coherent JSON and balanced ledger pair', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    await Promise.all([
        persistence.createOrUpdateTransaction('batch-1', purchase('same-id', 1000)),
        persistence.createOrUpdateTransaction('batch-1', purchase('same-id', 2000))
    ]);
    const state = await financialRows(s.db, 'same-id');
    const amount = JSON.parse(state.transaction.data).amount;
    assert.ok([1000, 2000].includes(amount));
    assert.equal(state.header.id, 'same-id');
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries.reduce((sum, entry) => sum + entry.amount, 0), amount * 2);
    assert.deepEqual(state.entries.map(entry => entry.amount), [amount, amount]);
});
