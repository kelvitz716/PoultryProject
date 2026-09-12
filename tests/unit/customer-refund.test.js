const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { migrateLedgerMinorUnits } = require('../../migrations/ledger-minor-units');
const { migrateManualCustomerReceipts } = require('../../migrations/manual-customer-receipts');
const { migrateCustomerCreditNotes } = require('../../migrations/customer-credit-notes');
const { migrateCustomerRefunds } = require('../../migrations/customer-refunds');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const settlement = require('../../services/customer-settlement');
const {
    CustomerRefundNotFoundError,
    CustomerRefundConflictError,
    createCustomerRefundService,
    postRefundLedgerWithAdapter
} = require('../../services/customer-refund');
const { registerCustomerRefundApi } = require('../../services/customer-refund-http');

function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function callback(error) { return error ? reject(error) : resolve(this); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function all(db, sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-refund-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'PRAGMA journal_mode=WAL');
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, code TEXT)');
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT)');
    await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, transaction_id TEXT REFERENCES ledger_transactions(id) ON DELETE CASCADE, account_id TEXT, entry_type TEXT, amount REAL NOT NULL)');
    await run(db, 'CREATE UNIQUE INDEX ledger_ref_type_id ON ledger_transactions(ref_type, ref_id)');
    await run(db, `INSERT INTO ledger_accounts (id, name, type, code) VALUES
        ('1000', 'Liquid Cash Box', 'asset', '1000'), ('1010', 'M-Pesa Till', 'asset', '1010'),
        ('1020', 'Bank Account', 'asset', '1020'), ('1200', 'Accounts Receivable', 'asset', '1200')`);
    await migrateCustomerSettlement(db);
    await migrateLedgerMinorUnits(db);
    await migrateManualCustomerReceipts(db);
    await migrateCustomerCreditNotes(db);
    await migrateCustomerRefunds(db);
    await run(db, `INSERT INTO customers (id, display_name, normalized_name, is_active)
        VALUES ('customer:a', 'Customer A', 'CUSTOMER A', 1),
               ('customer:b', 'Customer B', 'CUSTOMER B', 1),
               ('customer:inactive', 'Inactive', 'INACTIVE', 0)`);
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    return { db, boundary: createDedicatedTransactionBoundary(file) };
}

function service(boundary, overrides = {}) {
    return createCustomerRefundService({ withDedicatedTransaction: boundary.withDedicatedTransaction, ...overrides });
}

async function event(s, customer, kind, amount_minor, key, extra = {}) {
    return (await settlement.recordCustomerAccountEvent({
        customer_id: customer, kind, amount_minor, idempotency_key: key, ...extra
    }, s.boundary)).event;
}

function input(sources, overrides = {}) {
    return {
        customer_id: 'customer:a',
        method: 'cash',
        amount: '10.00',
        sources,
        reason_code: 'overpayment',
        external_reference: null,
        acknowledge_method_difference: false,
        idempotency_key: 'refund-one',
        created_by_user_id: 'admin-1',
        ...overrides
    };
}

async function state(db, key) {
    const operation = await get(db, 'SELECT * FROM customer_refund_operations WHERE idempotency_key = ?', [key]);
    const event = operation ? await get(db, 'SELECT * FROM customer_account_events WHERE id = ?', [operation.refund_event_id]) : undefined;
    const header = operation ? await get(db, 'SELECT * FROM ledger_transactions WHERE id = ?', [operation.ledger_transaction_id]) : undefined;
    const entries = header ? await all(db, 'SELECT * FROM ledger_entries WHERE transaction_id = ?', [header.id]) : [];
    const links = operation ? await all(db, 'SELECT * FROM customer_refund_source_allocations WHERE refund_idempotency_key = ? ORDER BY source_ordinal', [key]) : [];
    return { operation, event, header, entries, links };
}

async function counts(db) {
    const count = async sql => (await get(db, sql)).n;
    return {
        transactions: await count('SELECT COUNT(*) AS n FROM transactions'),
        refunds: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'refund'"),
        payments: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'payment'"),
        allocations: await count('SELECT COUNT(*) AS n FROM customer_account_allocations'),
        headers: await count('SELECT COUNT(*) AS n FROM ledger_transactions'),
        revenue: await count("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id IN ('4000', '4010', '4050')")
    };
}

test('refund creates one outgoing debit, exact GL pair, and allocations from mixed credit sources', async t => {
    const s = await store(t);
    const cash = await event(s, 'customer:a', 'payment', 200, 'cash-credit', { method: 'cash', external_reference: 'cash-1' });
    const mpesa = await event(s, 'customer:a', 'payment', 300, 'mpesa-credit', { method: 'mpesa', external_reference: 'MPESA001' });
    const bank = await event(s, 'customer:a', 'payment', 200, 'bank-credit', { method: 'bank', external_reference: 'BANK001' });
    const invoice = await event(s, 'customer:a', 'invoice', 300, 'note-invoice');
    const note = await event(s, 'customer:a', 'credit_note', 300, 'credit-note', { original_event_id: invoice.id, reason_code: 'return' });
    const outcome = await service(s.boundary).issueCustomerRefund(input([
        { credit_event_id: note.id, amount: '3.00' }, { credit_event_id: bank.id, amount: '2.00' },
        { credit_event_id: mpesa.id, amount: '3.00' }, { credit_event_id: cash.id, amount: '2.00' }
    ], { acknowledge_method_difference: true }));
    const saved = await state(s.db, 'refund-one');
    assert.deepEqual([outcome.idempotent, outcome.amount_minor, outcome.method_difference, outcome.acknowledge_method_difference], [false, 1000, true, true]);
    assert.deepEqual([saved.event.side, saved.event.kind, saved.event.status, saved.event.method, saved.event.reason_code], ['debit', 'refund', 'posted', 'cash', null]);
    assert.equal(saved.operation.reason_code, 'overpayment');
    assert.deepEqual(saved.entries.map(row => [row.id, row.account_id, row.entry_type, row.amount_minor]).sort(), [
        [`${saved.header.id}:dr`, '1200', 'debit', 1000], [`${saved.header.id}:cr`, '1000', 'credit', 1000]
    ].sort());
    assert.equal(saved.links.length, 4);
    assert.deepEqual(await counts(s.db), { transactions: 0, refunds: 1, payments: 3, allocations: 4, headers: 1, revenue: 0 });
});

test('refund validates source eligibility, exact money, references, acknowledgement, and inactive-customer history', async t => {
    const s = await store(t);
    const cash = await event(s, 'customer:a', 'payment', 1000, 'valid-credit', { method: 'cash', external_reference: 'cash-valid' });
    const mpesa = await event(s, 'customer:a', 'payment', 1000, 'mpesa-valid', { method: 'mpesa', external_reference: 'MPESA-VALID' });
    const draft = await event(s, 'customer:a', 'payment', 1000, 'draft-credit', { method: 'cash', external_reference: 'draft-credit', status: 'draft' });
    for (const candidate of [
        input([{ credit_event_id: mpesa.id, amount: '10.00' }]),
        input([{ credit_event_id: cash.id, amount: '10.01' }]),
        input([{ credit_event_id: cash.id, amount: '1e2' }]),
        input([{ credit_event_id: draft.id, amount: '10.00' }]),
        input([{ credit_event_id: cash.id, amount: '10.00' }], { method: 'bank', external_reference: null }),
        input([{ credit_event_id: cash.id, amount: '10.00' }], { sources: [{ credit_event_id: cash.id, amount: '5.00' }, { credit_event_id: cash.id, amount: '5.00' }] }),
        input([{ credit_event_id: cash.id, amount: '10.00' }], { reason_code: 'caller prose 0712345678' })
    ]) await assert.rejects(service(s.boundary).issueCustomerRefund(candidate), error => error instanceof TypeError || error instanceof RangeError || error instanceof CustomerRefundConflictError);
    await assert.rejects(service(s.boundary).issueCustomerRefund(input([{ credit_event_id: 'missing', amount: '10.00' }], { idempotency_key: 'missing-source' })), CustomerRefundNotFoundError);
    const inactive = await event(s, 'customer:inactive', 'payment', 700, 'inactive-credit', { method: 'bank', external_reference: 'INACTIVE-BANK' });
    const outcome = await service(s.boundary).issueCustomerRefund(input([{ credit_event_id: inactive.id, amount: '7.00' }], {
        customer_id: 'customer:inactive', method: 'bank', amount: '7.00', external_reference: 'INACTIVE-REFUND', idempotency_key: 'inactive-refund'
    }));
    assert.equal(outcome.idempotent, false);
});

test('exact KES boundaries, partial credit, bank/M-Pesa reference rules, and method-scoped collisions are deterministic', async t => {
    const s = await store(t);
    const values = [['0.07', 7], ['0.29', 29], ['10.12', 1012]];
    for (const [amount, minor] of values) {
        const source = await event(s, 'customer:a', 'payment', minor, `credit-${minor}`, { method: 'bank', external_reference: `BANK-${minor}` });
        const result = await service(s.boundary).issueCustomerRefund(input([{ credit_event_id: source.id, amount }], {
            method: 'bank', amount, external_reference: `refund-${minor}`, idempotency_key: `refund-${minor}`
        }));
        assert.equal(result.amount_minor, minor);
    }
    const partial = await event(s, 'customer:a', 'payment', 1000, 'partial-credit', { method: 'cash', external_reference: 'partial' });
    await service(s.boundary).issueCustomerRefund(input([{ credit_event_id: partial.id, amount: '4.00' }], { amount: '4.00', idempotency_key: 'partial-refund' }));
    await assert.rejects(service(s.boundary).issueCustomerRefund(input([{ credit_event_id: partial.id, amount: '7.00' }], { amount: '7.00', idempotency_key: 'partial-over' })), CustomerRefundConflictError);
    const a = await event(s, 'customer:a', 'payment', 100, 'collision-a', { method: 'cash', external_reference: 'collision-a' });
    const b = await event(s, 'customer:a', 'payment', 100, 'collision-b', { method: 'bank', external_reference: 'collision-b' });
    await service(s.boundary).issueCustomerRefund(input([{ credit_event_id: a.id, amount: '1.00' }], { amount: '1.00', method: 'cash', external_reference: 'same-ref', idempotency_key: 'cash-ref' }));
    await service(s.boundary).issueCustomerRefund(input([{ credit_event_id: b.id, amount: '1.00' }], { amount: '1.00', method: 'bank', external_reference: 'same-ref', idempotency_key: 'bank-ref' }));
});

test('refund retry normalizes source order, preserves original actor, and rejects every material difference', async t => {
    const s = await store(t);
    const one = await event(s, 'customer:a', 'payment', 500, 'retry-one', { method: 'cash', external_reference: 'retry-one' });
    const two = await event(s, 'customer:a', 'payment', 500, 'retry-two', { method: 'cash', external_reference: 'retry-two' });
    const original = input([{ credit_event_id: two.id, amount: '5.00' }, { credit_event_id: one.id, amount: '5.00' }], { idempotency_key: 'retry-refund' });
    const first = await service(s.boundary).issueCustomerRefund(original);
    const retry = await service(s.boundary).issueCustomerRefund({ ...original, sources: [...original.sources].reverse(), created_by_user_id: 'admin-2' });
    assert.deepEqual([first.idempotent, retry.idempotent, retry.recorded_by_user_id], [false, true, 'admin-1']);
    for (const changed of [
        { method: 'bank', external_reference: 'RETRY-BANK', acknowledge_method_difference: true },
        { amount: '9.99', sources: [{ credit_event_id: one.id, amount: '5.00' }, { credit_event_id: two.id, amount: '4.99' }] },
        { reason_code: 'other' }, { acknowledge_method_difference: true }
    ]) await assert.rejects(service(s.boundary).issueCustomerRefund({ ...original, ...changed }), CustomerRefundConflictError);
});

test('concurrent refunds and a refund-versus-allocation race never consume customer credit twice', async t => {
    const s = await store(t);
    const source = await event(s, 'customer:a', 'payment', 1000, 'race-source', { method: 'cash', external_reference: 'race-source' });
    const race = await Promise.allSettled([
        service(s.boundary).issueCustomerRefund(input([{ credit_event_id: source.id, amount: '7.00' }], { amount: '7.00', idempotency_key: 'race-refund-a' })),
        service(s.boundary).issueCustomerRefund(input([{ credit_event_id: source.id, amount: '7.00' }], { amount: '7.00', idempotency_key: 'race-refund-b' }))
    ]);
    assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
    const sourceTwo = await event(s, 'customer:a', 'payment', 1000, 'race-source-two', { method: 'cash', external_reference: 'race-source-two' });
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'race-invoice');
    const mixed = await Promise.allSettled([
        service(s.boundary).issueCustomerRefund(input([{ credit_event_id: sourceTwo.id, amount: '7.00' }], { amount: '7.00', idempotency_key: 'race-refund-mixed' })),
        settlement.allocateCustomerCredit({ credit_event_id: sourceTwo.id, debit_event_id: invoice.id, amount_minor: 700, idempotency_key: 'race-explicit-allocation', created_by_user_id: 'admin-2' }, s.boundary)
    ]);
    assert.equal(mixed.filter(row => row.status === 'fulfilled').length, 1);
});

test('every refund event, ledger, allocation, and operation failure rolls back all refund surfaces', async t => {
    const s = await store(t);
    const cases = [
        ['event', { insertRefundEventWithAdapter: async () => { throw new Error('event failure'); } }],
        ['header', { postRefundLedgerWithAdapter: async (adapter, details) => postRefundLedgerWithAdapter({ ...adapter, runQuery: async (sql, params = []) => {
            if (sql.includes('INSERT INTO ledger_transactions')) throw new Error('header failure');
            return adapter.runQuery(sql, params);
        } }, details) }],
        ['debit', (() => {
            let entries = 0;
            return { postRefundLedgerWithAdapter: async (adapter, details) => postRefundLedgerWithAdapter({ ...adapter, runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO ledger_entries') && ++entries === 1) throw new Error('debit failure');
                return adapter.runQuery(sql, params);
            } }, details) };
        })()],
        ['credit', (() => {
            let entries = 0;
            return { postRefundLedgerWithAdapter: async (adapter, details) => postRefundLedgerWithAdapter({ ...adapter, runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO ledger_entries') && ++entries === 2) throw new Error('credit failure');
                return adapter.runQuery(sql, params);
            } }, details) };
        })()],
        ['allocation', { allocateCustomerCreditWithAdapter: async () => { throw new Error('allocation failure'); } }],
        ['operation', { insertRefundOperationWithAdapter: async () => { throw new Error('operation failure'); } }]
    ];
    for (const [label, overrides] of cases) {
        const source = await event(s, 'customer:a', 'payment', 100, `failure-source-${label}`, { method: 'cash', external_reference: `failure-${label}` });
        await assert.rejects(service(s.boundary, overrides).issueCustomerRefund(input([{ credit_event_id: source.id, amount: '1.00' }], { amount: '1.00', idempotency_key: `failure-${label}` })), /failure/, label);
        assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customer_refund_operations WHERE idempotency_key = ?', [`failure-${label}`])).n, 0);
    }
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'refund'")).n, 0);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM ledger_transactions')).n, 0);
});

test('refund retries fail closed on corrupted provenance, linked evidence is immutable, and no unrelated financial row changes', async t => {
    const s = await store(t);
    const source = await event(s, 'customer:a', 'payment', 1000, 'corrupt-source', { method: 'cash', external_reference: 'corrupt-source' });
    const request = input([{ credit_event_id: source.id, amount: '10.00' }], { idempotency_key: 'corrupt-refund' });
    await service(s.boundary).issueCustomerRefund(request);
    const saved = await state(s.db, request.idempotency_key);
    await assert.rejects(run(s.db, 'DELETE FROM customer_account_events WHERE id = ?', [saved.event.id]), /linked to a refund/);
    await assert.rejects(run(s.db, 'DELETE FROM customer_account_allocations WHERE id = ?', [saved.links[0].allocation_id]), /linked to a refund/);
    await assert.rejects(run(s.db, "UPDATE customer_allocation_operations SET created_by_user_id = 'tamper' WHERE allocation_id = ?", [saved.links[0].allocation_id]), /linked to a refund/);
    await assert.rejects(run(s.db, 'DELETE FROM customer_allocation_operations WHERE allocation_id = ?', [saved.links[0].allocation_id]), /linked to a refund/);
    await assert.rejects(run(s.db, "UPDATE customer_account_events SET status = 'draft' WHERE id = ?", [saved.event.id]), /invalid customer refund evidence|posted customer refunds are immutable/);
    await run(s.db, 'DROP TRIGGER customer_refund_operation_immutable');
    await run(s.db, "UPDATE customer_refund_operations SET reason_code = 'other' WHERE idempotency_key = ?", [request.idempotency_key]);
    await assert.rejects(service(s.boundary).issueCustomerRefund({ ...request, created_by_user_id: 'admin-2' }), CustomerRefundConflictError);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM transactions')).n, 0);
});

test('refund retry independently rejects a missing required reference or unacknowledged method difference', async t => {
    const reference = await store(t);
    const bank = await event(reference, 'customer:a', 'payment', 100, 'verify-bank-source', { method: 'bank', external_reference: 'VERIFY-BANK' });
    const bankRequest = input([{ credit_event_id: bank.id, amount: '1.00' }], {
        method: 'bank', amount: '1.00', external_reference: 'VERIFY-REF', idempotency_key: 'verify-bank-refund'
    });
    await service(reference.boundary).issueCustomerRefund(bankRequest);
    await run(reference.db, 'DROP TRIGGER customer_refund_operation_immutable');
    await run(reference.db, 'DROP TRIGGER customer_refund_operation_shape_update');
    await run(reference.db, "UPDATE customer_refund_operations SET external_reference = '' WHERE idempotency_key = ?", [bankRequest.idempotency_key]);
    await assert.rejects(service(reference.boundary).issueCustomerRefund({ ...bankRequest, created_by_user_id: 'admin-2' }), CustomerRefundConflictError);

    const acknowledgement = await store(t);
    const mpesa = await event(acknowledgement, 'customer:a', 'payment', 100, 'verify-mpesa-source', { method: 'mpesa', external_reference: 'VERIFY-MPESA' });
    const mismatchRequest = input([{ credit_event_id: mpesa.id, amount: '1.00' }], {
        amount: '1.00', acknowledge_method_difference: true, idempotency_key: 'verify-mismatch-refund'
    });
    await service(acknowledgement.boundary).issueCustomerRefund(mismatchRequest);
    await run(acknowledgement.db, 'DROP TRIGGER customer_refund_operation_immutable');
    await run(acknowledgement.db, 'DROP TRIGGER customer_refund_operation_shape_update');
    await run(acknowledgement.db, 'UPDATE customer_refund_operations SET method_difference = 0, acknowledge_method_difference = 0 WHERE idempotency_key = ?', [mismatchRequest.idempotency_key]);
    await assert.rejects(service(acknowledgement.boundary).issueCustomerRefund({ ...mismatchRequest, created_by_user_id: 'admin-2' }), CustomerRefundConflictError);
});

test('refund migration reruns, repairs weak same-name guards, and enforces direct operation shapes', async t => {
    const s = await store(t);
    for (const name of [
        'customer_refund_event_shape_insert', 'customer_refund_event_shape_update',
        'customer_refund_operation_shape_insert', 'customer_refund_operation_shape_update',
        'customer_refund_source_allocation_shape_insert', 'customer_refund_source_allocation_shape_update'
    ]) await run(s.db, `DROP TRIGGER ${name}`);
    await run(s.db, `CREATE TRIGGER customer_refund_event_shape_insert
        BEFORE INSERT ON customer_account_events WHEN NEW.kind = 'refund' AND NEW.method IS NULL
        BEGIN SELECT RAISE(ABORT, 'weak refund trigger'); END`);
    await run(s.db, `CREATE TRIGGER customer_refund_event_shape_update
        BEFORE UPDATE OF method ON customer_account_events WHEN NEW.kind = 'refund' AND NEW.method IS NULL
        BEGIN SELECT RAISE(ABORT, 'weak refund trigger'); END`);
    await run(s.db, `CREATE TRIGGER customer_refund_operation_shape_insert
        BEFORE INSERT ON customer_refund_operations WHEN NEW.method IS NULL
        BEGIN SELECT RAISE(ABORT, 'weak refund trigger'); END`);
    await run(s.db, `CREATE TRIGGER customer_refund_operation_shape_update
        BEFORE UPDATE OF method ON customer_refund_operations WHEN NEW.method IS NULL
        BEGIN SELECT RAISE(ABORT, 'weak refund trigger'); END`);
    await run(s.db, `CREATE TRIGGER customer_refund_source_allocation_shape_insert
        BEFORE INSERT ON customer_refund_source_allocations WHEN NEW.source_ordinal < 0
        BEGIN SELECT RAISE(ABORT, 'weak refund trigger'); END`);
    await run(s.db, `CREATE TRIGGER customer_refund_source_allocation_shape_update
        BEFORE UPDATE OF source_ordinal ON customer_refund_source_allocations WHEN NEW.source_ordinal < 0
        BEGIN SELECT RAISE(ABORT, 'weak refund trigger'); END`);
    await migrateCustomerRefunds(s.db);
    assert.ok((await get(s.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'customer_refund_operations'")));
    assert.ok((await get(s.db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_customer_events_refund_reference'")));
    const source = await event(s, 'customer:a', 'payment', 100, 'guard-source', { method: 'cash', external_reference: 'guard-source' });
    await assert.rejects(run(s.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, method, idempotency_key)
        VALUES ('bad-refund-evidence', 'customer:a', 'KES', 'debit', 'refund', 'posted', 1, 'bank', 'bad-refund-evidence')`), /invalid customer refund evidence/);
    await assert.rejects(run(s.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, reason_code, idempotency_key)
        VALUES ('bad-non-note-reason', 'customer:a', 'KES', 'debit', 'invoice', 'posted', 1, 'overpayment', 'bad-non-note-reason')`), /invalid customer event.*provenance/);
    const result = await service(s.boundary).issueCustomerRefund(input([{ credit_event_id: source.id, amount: '1.00' }], { amount: '1.00', idempotency_key: 'guard-refund' }));
    const saved = await state(s.db, 'guard-refund');
    assert.deepEqual([result.ledger_transaction_id === saved.header.id, saved.header.customer_account_event_id, saved.operation.created_at === saved.event.posted_at], [true, saved.event.id, true]);
    await assert.rejects(run(s.db, "UPDATE customer_account_allocations SET status = 'reversed', reversed_by_user_id = 'x', reversed_at = CURRENT_TIMESTAMP WHERE id = ?", [saved.links[0].allocation_id]), /linked to a refund/);
    await run(s.db, 'DROP TRIGGER customer_refund_operation_immutable');
    await assert.rejects(run(s.db, 'UPDATE customer_refund_operations SET method_difference = 1, acknowledge_method_difference = 0 WHERE idempotency_key = ?', ['guard-refund']), /invalid customer refund operation/);
    await assert.rejects(run(s.db, `INSERT INTO customer_refund_source_allocations
        (refund_idempotency_key, source_ordinal, credit_event_id, allocation_id, amount_minor)
        VALUES ('guard-refund', 50, ?, ?, 1)`, [source.id, saved.links[0].allocation_id]), /invalid customer refund source evidence/);
    const eventGuard = await get(s.db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_refund_event_shape_insert'");
    assert.match(eventGuard.sql, /external_reference IS NULL/i);
});

function request(server, method, pathname, role, body) {
    return new Promise((resolve, reject) => {
        const wire = body === undefined ? undefined : JSON.stringify(body);
        const headers = role ? { 'x-role': role, 'content-type': 'application/json', ...(wire ? { 'content-length': Buffer.byteLength(wire) } : {}) } : {};
        const address = server.address();
        const req = http.request({ host: '127.0.0.1', port: address.port, method, path: pathname, headers }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject); if (wire) req.write(wire); req.end();
    });
}

test('refund HTTP route enforces roles, exact shape, session actor, and sanitized failures', async t => {
    const calls = [];
    const app = express();
    app.use((req, res, next) => { req.session = req.headers['x-role'] ? { userId: 'session-admin', userRole: req.headers['x-role'] } : {}; next(); });
    app.use(express.json());
    const requireRole = (...roles) => (req, res, next) => !req.session.userId ? res.status(401).json({ error: 'Unauthorized' }) : !roles.includes(req.session.userRole) ? res.status(403).json({ error: 'Forbidden' }) : next();
    registerCustomerRefundApi(app, { requireRole, refundService: { issueCustomerRefund: async candidate => {
        if (candidate.idempotency_key === 'missing') throw new CustomerRefundNotFoundError('caller prose 0712345678');
        if (candidate.idempotency_key === 'conflict') throw new CustomerRefundConflictError('caller prose 0712345678');
        if (candidate.idempotency_key === 'failure') throw new Error('caller prose 0712345678');
        calls.push(candidate); return { idempotent: false, refund_event_id: 'refund-1' };
    } } });
    const server = await new Promise(resolve => { const listening = app.listen(0, () => resolve(listening)); });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const body = { customer_id: 'customer:a', method: 'cash', amount: '1.00', sources: [{ credit_event_id: 'credit:a', amount: '1.00' }], reason_code: 'overpayment', acknowledge_method_difference: false, idempotency_key: 'http-refund' };
    assert.equal((await request(server, 'POST', '/api/customer-refunds', undefined, body)).status, 401);
    for (const role of ['viewer', 'farmer']) assert.equal((await request(server, 'POST', '/api/customer-refunds', role, body)).status, 403);
    for (const role of ['super_admin', 'admin']) assert.equal((await request(server, 'POST', '/api/customer-refunds', role, { ...body, idempotency_key: `http-${role}` })).status, 201);
    assert.equal(calls[0].created_by_user_id, 'session-admin');
    assert.equal((await request(server, 'POST', '/api/customer-refunds', 'admin', { ...body, created_by_user_id: 'forged' })).status, 400);
    assert.equal((await request(server, 'POST', '/api/customer-refunds', 'admin', { ...body, sources: 'caller prose 0712345678' })).status, 400);
    for (const [key, status] of [['missing', 404], ['conflict', 409], ['failure', 500]]) {
        const response = await request(server, 'POST', '/api/customer-refunds', 'admin', { ...body, idempotency_key: key });
        assert.equal(response.status, status);
        assert.doesNotMatch(JSON.stringify(response.body), /caller prose|0712345678/i);
    }
});

test('real refund service result satisfies the browser response contract', async t => {
    const s = await store(t);
    const source = await event(s, 'customer:a', 'payment', 29, 'ui-refund-source', { method: 'cash', external_reference: 'UI-CASH' });
    const outcome = await service(s.boundary).issueCustomerRefund(input([
        { credit_event_id: source.id, amount: '0.29' }
    ], { amount: '0.29', idempotency_key: 'ui-refund-contract', reason_code: 'other' }));
    const { validRefundResponse } = await import('../../js/customer-refund-ui-model.mjs');
    assert.equal(validRefundResponse(outcome, {
        customer_id: 'customer:a', method: 'cash', amount: '0.29', amount_minor: 29,
        sources: [{ credit_event_id: source.id, amount: '0.29', amount_minor: 29 }], reason_code: 'other',
        external_reference: null, acknowledge_method_difference: false, method_difference: false
    }), true);
});
