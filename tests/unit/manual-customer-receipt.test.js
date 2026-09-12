const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { migratePaymentImports } = require('../../migrations/payment-imports');
const { migrateLedgerMinorUnits } = require('../../migrations/ledger-minor-units');
const { migrateManualCustomerReceipts } = require('../../migrations/manual-customer-receipts');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const {
    ManualCustomerReceiptNotFoundError,
    ManualCustomerReceiptConflictError,
    createManualCustomerReceiptService,
    postReceiptLedgerWithAdapter,
    idsFor
} = require('../../services/manual-customer-receipt');

function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db));
    });
}
function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function callback(error) {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-manual-receipt-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'PRAGMA busy_timeout=5000');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY, batch_id TEXT, data TEXT)');
    await run(db, `CREATE TABLE ledger_accounts (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, code TEXT
    )`);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT REFERENCES ledger_transactions(id) ON DELETE CASCADE,
        account_id TEXT, entry_type TEXT, amount REAL NOT NULL
    )`);
    await run(db, 'CREATE UNIQUE INDEX ledger_ref_type_id ON ledger_transactions(ref_type, ref_id)');
    await run(db, `INSERT INTO ledger_accounts (id, name, type, code) VALUES
        ('1000', 'Liquid Cash Box', 'asset', '1000'),
        ('1200', 'Accounts Receivable', 'asset', '1200')`);
    await migrateCustomerSettlement(db);
    await migratePaymentImports(db);
    await migrateLedgerMinorUnits(db);
    await migrateManualCustomerReceipts(db);
    await run(db, `INSERT INTO customers (id, display_name, normalized_name, payment_terms_days, is_active)
        VALUES ('customer:a', 'Customer A', 'CUSTOMER A', 14, 1),
               ('customer:b', 'Customer B', 'CUSTOMER B', 0, 1),
               ('customer:inactive', 'Inactive', 'INACTIVE', 0, 0)`);
    t.after(async () => {
        await close(db);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const adapter = {
        runQuery: (sql, params = []) => run(db, sql, params),
        getQuery: (sql, params = []) => get(db, sql, params),
        allQuery: (sql, params = []) => all(db, sql, params)
    };
    return { db, adapter, boundary: createDedicatedTransactionBoundary(file) };
}

function service(boundary, overrides = {}) {
    return createManualCustomerReceiptService({
        withDedicatedTransaction: boundary.withDedicatedTransaction,
        ...overrides
    });
}

function receiptInput(overrides = {}) {
    return {
        customer_id: 'customer:a',
        method: 'cash',
        amount: '1250.50',
        external_reference: null,
        idempotency_key: 'receipt:cash-1',
        created_by_user_id: 'farmer-1',
        reviewer_user_id: 'farmer-1',
        ...overrides
    };
}

async function receiptState(db, idempotencyKey) {
    const operation = await get(db, 'SELECT * FROM manual_customer_receipt_operations WHERE idempotency_key = ?', [idempotencyKey]);
    const event = operation ? await get(db, 'SELECT * FROM customer_account_events WHERE id = ?', [operation.customer_account_event_id]) : undefined;
    const header = operation ? await get(db, 'SELECT * FROM ledger_transactions WHERE id = ?', [operation.ledger_transaction_id]) : undefined;
    const entries = header ? await all(db, `SELECT account_id, entry_type, amount, amount_minor, reconciliation_status
        FROM ledger_entries WHERE transaction_id = ?`, [header.id]) : [];
    return { operation, event, header, entries };
}

async function counts(db) {
    const count = async sql => (await get(db, sql)).n;
    return {
        flatTransactions: await count('SELECT COUNT(*) AS n FROM transactions'),
        invoices: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'invoice'"),
        payments: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'payment'"),
        allocations: await count('SELECT COUNT(*) AS n FROM customer_account_allocations'),
        headers: await count('SELECT COUNT(*) AS n FROM ledger_transactions'),
        revenue: await count("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id IN ('4000', '4010')")
    };
}

test('cash and bank receipts post one unallocated payment with the required exact GL pair', async t => {
    const s = await store(t);
    const receipts = [
        receiptInput({ idempotency_key: 'receipt:cash-1', method: 'cash', amount: '1250.50' }),
        receiptInput({ idempotency_key: 'receipt:bank-1', method: 'bank', amount: '200.01', external_reference: 'bank-ref-001' })
    ];
    for (const input of receipts) {
        const outcome = await service(s.boundary).recordManualCustomerReceipt(input);
        const saved = await receiptState(s.db, input.idempotency_key);
        const debit = input.method === 'cash' ? '1000' : '1020';
        assert.equal(outcome.idempotent, false);
        assert.deepEqual(
            [saved.event.customer_id, saved.event.kind, saved.event.side, saved.event.status, saved.event.method,
                saved.event.amount_minor, saved.event.external_reference, saved.event.payment_import_id],
            ['customer:a', 'payment', 'credit', 'posted', input.method,
                input.method === 'cash' ? 125050 : 20001, input.external_reference && input.external_reference.toUpperCase(), null]
        );
        assert.deepEqual(
            saved.entries.map(row => [row.account_id, row.entry_type, row.amount, row.amount_minor, row.reconciliation_status]).sort(),
            [[debit, 'debit', input.method === 'cash' ? 1250.5 : 200.01, input.method === 'cash' ? 125050 : 20001, 'exact'],
                ['1200', 'credit', input.method === 'cash' ? 1250.5 : 200.01, input.method === 'cash' ? 125050 : 20001, 'exact']].sort()
        );
        assert.equal(saved.header.customer_account_event_id, saved.event.id);
    }
    assert.equal((await get(s.db, "SELECT name FROM ledger_accounts WHERE id = '1020'")).name, 'Bank Account');
    assert.deepEqual(await counts(s.db), {
        flatTransactions: 0, invoices: 0, payments: 2, allocations: 0, headers: 2, revenue: 0
    });
});

test('manual receipt validation rejects unsafe payment evidence before financial writes', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    for (const input of [
        receiptInput({ method: 'mpesa' }),
        receiptInput({ method: 'card' }),
        receiptInput({ method: 'bank', external_reference: null }),
        receiptInput({ amount: '1.234' }),
        receiptInput({ amount: '1e2' }),
        receiptInput({ amount: 0 }),
        receiptInput({ external_reference: 'unsafe reference prose' }),
        receiptInput({ idempotency_key: 'x'.repeat(129) }),
        receiptInput({ reviewer_user_id: 'different-actor' })
    ]) {
        await assert.rejects(persistence.recordManualCustomerReceipt(input), error => error instanceof TypeError || error instanceof RangeError);
    }
    await assert.rejects(
        persistence.recordManualCustomerReceipt(receiptInput({ customer_id: 'customer:missing' })),
        ManualCustomerReceiptNotFoundError
    );
    await assert.rejects(
        persistence.recordManualCustomerReceipt(receiptInput({ customer_id: 'customer:inactive' })),
        ManualCustomerReceiptConflictError
    );
    assert.deepEqual(await counts(s.db), {
        flatTransactions: 0, invoices: 0, payments: 0, allocations: 0, headers: 0, revenue: 0
    });
});

test('exact retries are immutable, material retries conflict, and concurrent retries create one receipt', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    const original = receiptInput({ idempotency_key: 'receipt:retry', method: 'bank', amount: '15.00', external_reference: 'BANK-15' });
    const first = await persistence.recordManualCustomerReceipt(original);
    const retry = await persistence.recordManualCustomerReceipt({ ...original, created_by_user_id: 'admin-2', reviewer_user_id: 'admin-2' });
    const saved = await receiptState(s.db, original.idempotency_key);
    assert.deepEqual([first.idempotent, retry.idempotent], [false, true]);
    assert.equal(retry.recorded_at, first.recorded_at);
    assert.equal(saved.operation.created_by_user_id, 'farmer-1');
    assert.equal(saved.event.created_by_user_id, 'farmer-1');
    await assert.rejects(persistence.recordManualCustomerReceipt({ ...original, amount: '16.00' }), ManualCustomerReceiptConflictError);
    await assert.rejects(persistence.recordManualCustomerReceipt({ ...original, customer_id: 'customer:b' }), ManualCustomerReceiptConflictError);
    await assert.rejects(persistence.recordManualCustomerReceipt({ ...original, external_reference: 'BANK-OTHER' }), ManualCustomerReceiptConflictError);

    const concurrent = receiptInput({ idempotency_key: 'receipt:concurrent', amount: '5.00' });
    const results = await Promise.all([
        persistence.recordManualCustomerReceipt(concurrent),
        persistence.recordManualCustomerReceipt({ ...concurrent, created_by_user_id: 'admin-2', reviewer_user_id: 'admin-2' })
    ]);
    assert.deepEqual(results.map(value => value.idempotent).sort(), [false, true]);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE idempotency_key = ?", [idsFor(concurrent.idempotency_key).event_key])).n, 1);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM ledger_transactions WHERE ref_id = ?", [concurrent.idempotency_key])).n, 1);
});

test('a manual receipt dedicated transaction preserves an unrelated shared-connection write', async t => {
    const s = await store(t);
    const input = receiptInput({ idempotency_key: 'receipt:independent', amount: '7.00' });
    await Promise.all([
        service(s.boundary).recordManualCustomerReceipt(input),
        s.adapter.runQuery(`INSERT INTO customers
            (id, display_name, normalized_name, payment_terms_days, is_active)
            VALUES ('customer:unrelated', 'Unrelated', 'UNRELATED', 0, 1)`)
    ]);
    assert.ok(await get(s.db, "SELECT id FROM customers WHERE id = 'customer:unrelated'"));
    assert.equal((await receiptState(s.db, input.idempotency_key)).event.kind, 'payment');
});

test('method-scoped reference collisions fail closed and exact retry detects corrupt provenance order-independently', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    const first = receiptInput({ idempotency_key: 'receipt:ref-1', method: 'bank', amount: '8.00', external_reference: 'bank-same' });
    await persistence.recordManualCustomerReceipt(first);
    await assert.rejects(
        persistence.recordManualCustomerReceipt(receiptInput({ idempotency_key: 'receipt:ref-2', method: 'bank', amount: '8.00', external_reference: 'BANK-SAME' })),
        ManualCustomerReceiptConflictError
    );
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM ledger_transactions WHERE ref_id = 'receipt:ref-2'")).n, 0);

    const saved = await receiptState(s.db, first.idempotency_key);
    await run(s.db, 'DELETE FROM ledger_entries WHERE transaction_id = ?', [saved.header.id]);
    await run(s.db, `INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1200', 'credit', 8, 800, 'exact')`, [`${saved.header.id}:cr`, saved.header.id]);
    await run(s.db, `INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1020', 'debit', 8, 800, 'exact')`, [`${saved.header.id}:dr`, saved.header.id]);
    assert.equal((await persistence.recordManualCustomerReceipt(first)).idempotent, true);

    await run(s.db, 'DELETE FROM ledger_entries WHERE id = ?', [`${saved.header.id}:cr`]);
    await run(s.db, `INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1020', 'debit', 8, 800, 'exact')`, [`${saved.header.id}:duplicate-debit`, saved.header.id]);
    await assert.rejects(persistence.recordManualCustomerReceipt(first), ManualCustomerReceiptConflictError);
});

test('retry verification rejects header evidence or mismatched actor provenance, and integrity constraints are not normal collisions', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    const actorMismatch = receiptInput({
        idempotency_key: 'receipt:actor-mismatch',
        reviewer_user_id: 'different-actor'
    });
    await assert.rejects(persistence.recordManualCustomerReceipt(actorMismatch), TypeError);
    assert.deepEqual(await receiptState(s.db, actorMismatch.idempotency_key), {
        operation: undefined, event: undefined, header: undefined, entries: []
    });

    const headerInput = receiptInput({ idempotency_key: 'receipt:header-corrupt' });
    await persistence.recordManualCustomerReceipt(headerInput);
    const headerState = await receiptState(s.db, headerInput.idempotency_key);
    await run(s.db, 'UPDATE ledger_transactions SET description = ? WHERE id = ?', ['tampered', headerState.header.id]);
    await assert.rejects(persistence.recordManualCustomerReceipt(headerInput), ManualCustomerReceiptConflictError);

    const provenanceInput = receiptInput({ idempotency_key: 'receipt:actor-corrupt' });
    await persistence.recordManualCustomerReceipt(provenanceInput);
    const provenanceState = await receiptState(s.db, provenanceInput.idempotency_key);
    await run(s.db, 'UPDATE customer_account_events SET reviewer_user_id = ? WHERE id = ?', ['tampered-actor', provenanceState.event.id]);
    await assert.rejects(persistence.recordManualCustomerReceipt(provenanceInput), ManualCustomerReceiptConflictError);

    const integrityError = Object.assign(new Error('CHECK constraint failed: amount_minor'), {
        code: 'SQLITE_CONSTRAINT'
    });
    const constraintInput = receiptInput({ idempotency_key: 'receipt:integrity-error' });
    await assert.rejects(
        service(s.boundary, {
            recordCustomerAccountEventWithAdapter: async () => { throw integrityError; }
        }).recordManualCustomerReceipt(constraintInput),
        error => error === integrityError
    );
    assert.deepEqual(await receiptState(s.db, constraintInput.idempotency_key), {
        operation: undefined, event: undefined, header: undefined, entries: []
    });
});

test('event, ledger header, each ledger entry, and operation finalization failures roll back all receipt surfaces', async t => {
    const s = await store(t);
    const failureCases = [
        ['event', {
            recordCustomerAccountEventWithAdapter: async () => { throw new Error('event failure'); }
        }],
        ['header', {
            postReceiptLedgerWithAdapter: async (adapter, details) => postReceiptLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.includes('INSERT INTO ledger_transactions')) throw new Error('header failure');
                    return adapter.runQuery(sql, params);
                }
            }, details)
        }],
        ['debit-entry', {
            postReceiptLedgerWithAdapter: async (adapter, details) => postReceiptLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.includes("'debit'")) throw new Error('debit entry failure');
                    return adapter.runQuery(sql, params);
                }
            }, details)
        }],
        ['credit-entry', {
            postReceiptLedgerWithAdapter: async (adapter, details) => postReceiptLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.includes("'1200', 'credit'")) throw new Error('credit entry failure');
                    return adapter.runQuery(sql, params);
                }
            }, details)
        }],
        ['finalization', {
            withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(adapter => work({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.includes('INSERT INTO manual_customer_receipt_operations')) throw new Error('finalization failure');
                    return adapter.runQuery(sql, params);
                }
            }))
        }]
    ];
    for (const [label, overrides] of failureCases) {
        const input = receiptInput({ idempotency_key: `receipt:failure-${label}` });
        await assert.rejects(service(s.boundary, overrides).recordManualCustomerReceipt(input), /failure/);
        assert.deepEqual(await receiptState(s.db, input.idempotency_key), {
            operation: undefined, event: undefined, header: undefined, entries: []
        });
    }
    assert.deepEqual(await counts(s.db), {
        flatTransactions: 0, invoices: 0, payments: 0, allocations: 0, headers: 0, revenue: 0
    });
});

test('actual production migration order is rerunnable, provides 1020, and receipt errors/logs retain no caller-supplied prose', async t => {
    const s = await store(t);
    await migrateManualCustomerReceipts(s.db);
    assert.equal((await get(s.db, "SELECT code FROM ledger_accounts WHERE id = '1020'")).code, '1020');
    const sensitive = 'PRIVATE-SMS-0712345678';
    const seen = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args) => seen.push(args.join(' '));
    console.log = (...args) => seen.push(args.join(' '));
    try {
        await assert.rejects(
            service(s.boundary).recordManualCustomerReceipt(receiptInput({ external_reference: `${sensitive} prose` })),
            TypeError
        );
    } finally {
        console.error = originalError;
        console.log = originalLog;
    }
    assert.doesNotMatch(seen.join('\n'), /PRIVATE-SMS|0712345678/);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM manual_customer_receipt_operations")).n, 0);
});
