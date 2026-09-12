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
const { migrateCustomerCreditNotes } = require('../../migrations/customer-credit-notes');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const settlement = require('../../services/customer-settlement');
const {
    CustomerCreditNoteNotFoundError,
    CustomerCreditNoteConflictError,
    createCustomerCreditNoteService,
    postCreditNoteLedgerWithAdapter,
    idsFor
} = require('../../services/customer-credit-note');
const { registerCustomerCreditNoteApi } = require('../../services/customer-credit-note-http');

function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function callback(error) { return error ? reject(error) : resolve(this); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function all(db, sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-credit-note-'));
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
    await run(db, "INSERT INTO ledger_accounts (id, name, type, code) VALUES ('1200', 'Accounts Receivable', 'asset', '1200')");
    await migrateCustomerSettlement(db);
    await migrateLedgerMinorUnits(db);
    await migrateCustomerCreditNotes(db);
    await run(db, `INSERT INTO customers (id, display_name, normalized_name, is_active)
        VALUES ('customer:a', 'Customer A', 'CUSTOMER A', 1),
               ('customer:b', 'Customer B', 'CUSTOMER B', 1),
               ('customer:inactive', 'Inactive', 'INACTIVE', 0)`);
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    return { db, boundary: createDedicatedTransactionBoundary(file) };
}

function service(boundary, overrides = {}) {
    return createCustomerCreditNoteService({ withDedicatedTransaction: boundary.withDedicatedTransaction, ...overrides });
}

async function event(s, customer, kind, amount_minor, key, extra = {}) {
    return (await settlement.recordCustomerAccountEvent({
        customer_id: customer, kind, amount_minor, idempotency_key: key, ...extra
    }, s.boundary)).event;
}

function noteInput(invoice_event_id, overrides = {}) {
    return {
        customer_id: 'customer:a',
        invoice_event_id,
        amount: '10.12',
        reason_code: 'return',
        external_reference: null,
        idempotency_key: 'credit-note:one',
        created_by_user_id: 'admin-1',
        ...overrides
    };
}

async function state(db, key) {
    const operation = await get(db, 'SELECT * FROM customer_credit_note_operations WHERE idempotency_key = ?', [key]);
    const event = operation ? await get(db, 'SELECT * FROM customer_account_events WHERE id = ?', [operation.credit_note_event_id]) : undefined;
    const header = operation ? await get(db, 'SELECT * FROM ledger_transactions WHERE id = ?', [operation.ledger_transaction_id]) : undefined;
    const entries = header ? await all(db, 'SELECT * FROM ledger_entries WHERE transaction_id = ?', [header.id]) : [];
    const allocation = operation?.auto_allocation_id ? await get(db, 'SELECT * FROM customer_account_allocations WHERE id = ?', [operation.auto_allocation_id]) : undefined;
    return { operation, event, header, entries, allocation };
}

async function counts(db) {
    const count = async sql => (await get(db, sql)).n;
    return {
        transactions: await count('SELECT COUNT(*) AS n FROM transactions'),
        invoices: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'invoice'"),
        notes: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'credit_note'"),
        payments: await count("SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'payment'"),
        allocations: await count('SELECT COUNT(*) AS n FROM customer_account_allocations'),
        headers: await count('SELECT COUNT(*) AS n FROM ledger_transactions'),
        returns: await count("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id = '4050'"),
        revenue: await count("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id IN ('4000', '4010')")
    };
}

test('unpaid, part-paid, and settled invoices create exact credit-note evidence and only allocate the deficit', async t => {
    const s = await store(t);
    const unpaid = await event(s, 'customer:a', 'invoice', 1000, 'invoice-unpaid');
    const partlyPaid = await event(s, 'customer:a', 'invoice', 1000, 'invoice-part');
    const paid = await event(s, 'customer:a', 'invoice', 1000, 'invoice-paid');
    const paymentPart = await event(s, 'customer:a', 'payment', 700, 'payment-part', { method: 'cash', external_reference: 'cash-part' });
    const paymentPaid = await event(s, 'customer:a', 'payment', 1000, 'payment-paid', { method: 'bank', external_reference: 'bank-paid' });
    await settlement.allocateCustomerCredit({ credit_event_id: paymentPart.id, debit_event_id: partlyPaid.id, amount_minor: 700, idempotency_key: 'pay-part', created_by_user_id: 'admin-1' }, s.boundary);
    await settlement.allocateCustomerCredit({ credit_event_id: paymentPaid.id, debit_event_id: paid.id, amount_minor: 1000, idempotency_key: 'pay-paid', created_by_user_id: 'admin-1' }, s.boundary);
    const cases = [
        [unpaid, '5.00', 500, 500, 0, 'note-unpaid'],
        [partlyPaid, '5.00', 500, 300, 200, 'note-part'],
        [paid, '5.00', 500, 0, 500, 'note-paid']
    ];
    for (const [invoice, amount, minor, allocated, remaining, key] of cases) {
        const outcome = await service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, { amount, idempotency_key: key, reason_code: 'quality_issue' }));
        const saved = await state(s.db, key);
        assert.deepEqual([outcome.idempotent, outcome.amount_minor, outcome.automatically_allocated_minor, outcome.remaining_credit_minor], [false, minor, allocated, remaining]);
        assert.deepEqual([saved.event.kind, saved.event.side, saved.event.status, saved.event.original_event_id, saved.event.reason_code, saved.event.amount_minor], ['credit_note', 'credit', 'posted', invoice.id, 'quality_issue', minor]);
        assert.deepEqual(saved.entries.map(row => [row.id, row.account_id, row.entry_type, row.amount_minor, row.reconciliation_status]).sort(), [
            [`${saved.header.id}:cr`, '1200', 'credit', minor, 'exact'],
            [`${saved.header.id}:dr`, '4050', 'debit', minor, 'exact']
        ].sort());
        assert.equal(saved.allocation?.amount_minor ?? 0, allocated);
    }
    assert.deepEqual(await counts(s.db), {
        transactions: 0, invoices: 3, notes: 3, payments: 2, allocations: 4, headers: 3, returns: 3, revenue: 0
    });
});

test('credit-note cap, KES boundaries, and concurrent issuance never exceed the original invoice', async t => {
    const s = await store(t);
    const invoice = await event(s, 'customer:a', 'invoice', 1048, 'invoice-boundary');
    for (const [amount, key, reason] of [['0.07', 'note-007', 'return'], ['0.29', 'note-029', 'pricing_adjustment'], ['10.12', 'note-1012', 'cancellation']]) {
        const result = await service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, { amount, idempotency_key: key, reason_code: reason }));
        assert.equal(result.amount_minor, Math.round(Number(amount) * 100));
    }
    await assert.rejects(service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, { amount: '0.01', idempotency_key: 'over-cap' })), CustomerCreditNoteConflictError);

    const concurrentInvoice = await event(s, 'customer:a', 'invoice', 1000, 'invoice-concurrent');
    const race = await Promise.allSettled([
        service(s.boundary).issueCustomerCreditNote(noteInput(concurrentInvoice.id, { amount: '7.00', idempotency_key: 'race-a' })),
        service(s.boundary).issueCustomerCreditNote(noteInput(concurrentInvoice.id, { amount: '7.00', idempotency_key: 'race-b' }))
    ]);
    assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal((await get(s.db, "SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM customer_account_events WHERE original_event_id = ? AND kind = 'credit_note'", [concurrentInvoice.id])).amount, 700);
});

test('credit-note validation rejects unsafe commercial evidence without financial writes', async t => {
    const s = await store(t);
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'invoice-validation');
    const draft = await event(s, 'customer:a', 'invoice', 1000, 'invoice-draft', { status: 'draft' });
    const payment = await event(s, 'customer:a', 'payment', 1000, 'payment', { method: 'cash', external_reference: 'cash' });
    for (const input of [
        noteInput(invoice.id, { reason_code: 'prose reason' }),
        noteInput(invoice.id, { amount: '1.234' }),
        noteInput(invoice.id, { amount: '1e2' }),
        noteInput(invoice.id, { amount: '0.00' }),
        noteInput(invoice.id, { external_reference: 'caller prose 0712345678' }),
        noteInput(invoice.id, { method: 'cash' }),
        noteInput(draft.id, { idempotency_key: 'draft-note' }),
        noteInput(payment.id, { idempotency_key: 'payment-note' }),
        noteInput(invoice.id, { customer_id: 'customer:b', idempotency_key: 'wrong-customer' })
    ]) {
        await assert.rejects(service(s.boundary).issueCustomerCreditNote(input), error => error instanceof TypeError || error instanceof RangeError || error instanceof CustomerCreditNoteConflictError);
    }
    await assert.rejects(service(s.boundary).issueCustomerCreditNote(noteInput('missing-invoice', { idempotency_key: 'missing-invoice' })), CustomerCreditNoteNotFoundError);
    await assert.rejects(service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, { customer_id: 'missing-customer', idempotency_key: 'missing-customer' })), CustomerCreditNoteNotFoundError);
    const inactive = await event(s, 'customer:inactive', 'invoice', 1000, 'inactive-invoice');
    assert.equal((await service(s.boundary).issueCustomerCreditNote(noteInput(inactive.id, { customer_id: 'customer:inactive', amount: '5.00', idempotency_key: 'inactive-correction' }))).idempotent, false);
    assert.deepEqual(await counts(s.db), {
        transactions: 0, invoices: 3, notes: 1, payments: 1, allocations: 1, headers: 1, returns: 1, revenue: 0
    });
});

test('reason provenance is exclusive to enumerated credit notes in both service and schema', async t => {
    const s = await store(t);
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'reason-invoice');
    await assert.rejects(settlement.recordCustomerAccountEvent({
        customer_id: 'customer:a', kind: 'invoice', amount_minor: 1,
        idempotency_key: 'invoice-reason', reason_code: 'return'
    }, s.boundary), TypeError);
    await assert.rejects(settlement.recordCustomerAccountEvent({
        customer_id: 'customer:a', kind: 'credit_note', amount_minor: 1,
        original_event_id: invoice.id, idempotency_key: 'missing-note-reason'
    }, s.boundary), TypeError);
    await assert.rejects(run(s.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, reason_code, idempotency_key)
        VALUES ('sql-invoice-reason', 'customer:a', 'KES', 'debit', 'invoice', 'posted', 1, 'return', 'sql-invoice-reason-key')`), /invalid customer event (reason )?provenance/);
});

test('exact, different-actor, material, concurrent, and reference retries preserve immutable note evidence', async t => {
    const s = await store(t);
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'invoice-retry');
    const original = noteInput(invoice.id, { amount: '4.00', external_reference: 'CN-001', idempotency_key: 'note-retry' });
    const first = await service(s.boundary).issueCustomerCreditNote(original);
    const retry = await service(s.boundary).issueCustomerCreditNote({ ...original, created_by_user_id: 'admin-2' });
    assert.deepEqual([first.idempotent, retry.idempotent, retry.recorded_by_user_id, retry.recorded_at], [false, true, 'admin-1', first.recorded_at]);
    await assert.rejects(service(s.boundary).issueCustomerCreditNote({ ...original, amount: '4.01' }), CustomerCreditNoteConflictError);
    await assert.rejects(service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, { idempotency_key: 'note-reference-collision', external_reference: 'cn-001' })), CustomerCreditNoteConflictError);

    const concurrentInvoice = await event(s, 'customer:a', 'invoice', 1000, 'invoice-retry-concurrent');
    const raceInput = noteInput(concurrentInvoice.id, { idempotency_key: 'note-retry-concurrent', amount: '2.00' });
    const race = await Promise.all([
        service(s.boundary).issueCustomerCreditNote(raceInput),
        service(s.boundary).issueCustomerCreditNote({ ...raceInput, created_by_user_id: 'admin-2' })
    ]);
    assert.deepEqual(race.map(row => row.idempotent).sort(), [false, true]);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customer_credit_note_operations WHERE idempotency_key = ?', [raceInput.idempotency_key])).n, 1);
});

test('credit-note retry fails closed on event, ledger, allocation, or operation corruption', async t => {
    const corrupt = async (mutate, key) => {
        const s = await store(t);
        const invoice = await event(s, 'customer:a', 'invoice', 1000, `invoice-${key}`);
        const input = noteInput(invoice.id, { idempotency_key: `corrupt-${key}`, amount: '5.00' });
        await service(s.boundary).issueCustomerCreditNote(input);
        await mutate(s, input);
        await assert.rejects(service(s.boundary).issueCustomerCreditNote({ ...input, created_by_user_id: 'admin-2' }), CustomerCreditNoteConflictError);
    };
    await corrupt(async (s, input) => {
        const saved = await state(s.db, input.idempotency_key);
        await run(s.db, 'DROP TRIGGER customer_events_immutable_posted');
        await run(s.db, 'DROP TRIGGER customer_credit_note_immutable_posted');
        await run(s.db, "UPDATE customer_account_events SET reason_code = 'other' WHERE id = ?", [saved.event.id]);
    }, 'event');
    await corrupt(async (s, input) => {
        const saved = await state(s.db, input.idempotency_key);
        await run(s.db, 'DELETE FROM ledger_entries WHERE id = ?', [`${saved.header.id}:cr`]);
        await run(s.db, `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
            VALUES (?, ?, '4050', 'debit', 5, 500, 'exact')`, ['duplicate-side', saved.header.id]);
    }, 'ledger');
    await corrupt(async (s, input) => {
        const saved = await state(s.db, input.idempotency_key);
        await run(s.db, "UPDATE ledger_transactions SET description = 'tampered' WHERE id = ?", [saved.header.id]);
    }, 'header');
    await corrupt(async (s, input) => {
        const saved = await state(s.db, input.idempotency_key);
        await run(s.db, 'DROP TRIGGER customer_allocations_immutable_links');
        await run(s.db, "UPDATE customer_account_allocations SET status = 'reversed', reversed_by_user_id = 'tamper', reversed_at = CURRENT_TIMESTAMP WHERE id = ?", [saved.allocation.id]);
    }, 'allocation');
    await corrupt(async (s, input) => {
        await run(s.db, "UPDATE customer_credit_note_operations SET reason_code = 'other' WHERE idempotency_key = ?", [input.idempotency_key]);
    }, 'operation');
});

test('credit-note retry rechecks aggregate caps and absent auto-allocation operation evidence', async t => {
    const aggregate = await store(t);
    const invoice = await event(aggregate, 'customer:a', 'invoice', 1000, 'aggregate-invoice');
    const input = noteInput(invoice.id, { amount: '5.00', idempotency_key: 'aggregate-note' });
    await service(aggregate.boundary).issueCustomerCreditNote(input);
    await run(aggregate.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, original_event_id, reason_code, idempotency_key)
        VALUES ('corrupt-excess-note', 'customer:a', 'KES', 'credit', 'credit_note', 'posted', 600, ?, 'other', 'corrupt-excess-key')`, [invoice.id]);
    await assert.rejects(service(aggregate.boundary).issueCustomerCreditNote({ ...input, created_by_user_id: 'admin-2' }), CustomerCreditNoteConflictError);

    const noAuto = await store(t);
    const settledInvoice = await event(noAuto, 'customer:a', 'invoice', 500, 'settled-invoice');
    const payment = await event(noAuto, 'customer:a', 'payment', 500, 'settled-payment', { method: 'cash', external_reference: 'settled-cash' });
    await settlement.allocateCustomerCredit({ credit_event_id: payment.id, debit_event_id: settledInvoice.id, amount_minor: 500, idempotency_key: 'settle-invoice', created_by_user_id: 'admin-1' }, noAuto.boundary);
    const noAutoInput = noteInput(settledInvoice.id, { amount: '5.00', idempotency_key: 'no-auto-note' });
    await service(noAuto.boundary).issueCustomerCreditNote(noAutoInput);
    const note = await state(noAuto.db, noAutoInput.idempotency_key);
    const auto = idsFor(noAutoInput.idempotency_key).auto_allocation_key;
    const autoId = settlement.allocationIdFor(auto);
    await run(noAuto.db, 'PRAGMA foreign_keys=OFF');
    await run(noAuto.db, `INSERT INTO customer_allocation_operations
        (idempotency_key, allocation_id, credit_event_id, debit_event_id, amount_minor, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, 1, 'admin-1', CURRENT_TIMESTAMP)`, [auto, autoId, note.event.id, settledInvoice.id]);
    await run(noAuto.db, 'PRAGMA foreign_keys=ON');
    await assert.rejects(service(noAuto.boundary).issueCustomerCreditNote({ ...noAutoInput, created_by_user_id: 'admin-2' }), CustomerCreditNoteConflictError);
});

test('delayed ledger and operation finalization reuse the persisted event timestamp', async t => {
    const s = await store(t);
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'timestamp-invoice');
    const input = noteInput(invoice.id, { amount: '5.00', idempotency_key: 'timestamp-note' });
    const delayed = service(s.boundary, {
        postCreditNoteLedgerWithAdapter: async (adapter, details) => {
            await new Promise(resolve => setTimeout(resolve, 1100));
            return postCreditNoteLedgerWithAdapter(adapter, details);
        }
    });
    await delayed.issueCustomerCreditNote(input);
    const saved = await state(s.db, input.idempotency_key);
    assert.deepEqual([saved.event.posted_at, saved.header.date, saved.operation.created_at], [saved.event.posted_at, saved.event.posted_at, saved.event.posted_at]);
    assert.equal((await service(s.boundary).issueCustomerCreditNote({ ...input, created_by_user_id: 'admin-2' })).idempotent, true);
});

test('every event, ledger, allocation, and finalization failure rolls back all credit-note surfaces', async t => {
    const s = await store(t);
    const cases = [
        ['event', { recordCustomerAccountEventWithAdapter: async () => { throw new Error('event failure'); } }],
        ['header', { postCreditNoteLedgerWithAdapter: async (adapter, details) => postCreditNoteLedgerWithAdapter({ ...adapter, runQuery: async (sql, params = []) => {
            if (sql.includes('INSERT INTO ledger_transactions')) throw new Error('header failure');
            return adapter.runQuery(sql, params);
        } }, details) }],
        ['debit', { postCreditNoteLedgerWithAdapter: async (adapter, details) => postCreditNoteLedgerWithAdapter({ ...adapter, runQuery: async (sql, params = []) => {
            if (sql.includes("'4050'")) throw new Error('debit failure');
            return adapter.runQuery(sql, params);
        } }, details) }],
        ['credit', { postCreditNoteLedgerWithAdapter: async (adapter, details) => postCreditNoteLedgerWithAdapter({ ...adapter, runQuery: async (sql, params = []) => {
            if (sql.includes("'1200'")) throw new Error('credit failure');
            return adapter.runQuery(sql, params);
        } }, details) }],
        ['allocation', { allocateCustomerCreditWithAdapter: async () => { throw new Error('allocation failure'); } }],
        ['operation', { withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(adapter => work({ ...adapter, runQuery: async (sql, params = []) => {
            if (sql.includes('INSERT INTO customer_credit_note_operations')) throw new Error('operation failure');
            return adapter.runQuery(sql, params);
        } })) }]
    ];
    for (const [label, overrides] of cases) {
        const invoice = await event(s, 'customer:a', 'invoice', 500, `invoice-${label}`);
        await assert.rejects(service(s.boundary, overrides).issueCustomerCreditNote(noteInput(invoice.id, { amount: '5.00', idempotency_key: `failure-${label}` })), /failure/);
        assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customer_credit_note_operations WHERE idempotency_key = ?', [`failure-${label}`])).n, 0);
    }
    assert.deepEqual(await counts(s.db), {
        transactions: 0, invoices: 6, notes: 0, payments: 0, allocations: 0, headers: 0, returns: 0, revenue: 0
    });
});

test('credit-note migration repairs actual weak same-name credit-note triggers and keeps no raw-message columns', async t => {
    const s = await store(t);
    await run(s.db, 'DROP TRIGGER customer_events_immutable_posted');
    await run(s.db, `CREATE TRIGGER customer_events_immutable_posted
        BEFORE UPDATE OF customer_id, reason_code ON customer_account_events
        WHEN OLD.status IN ('posted', 'reversed')
        BEGIN SELECT RAISE(ABORT, 'draft weak trigger'); END`);

    // Simulate the earlier local 14C draft: its own same-name triggers used
    // IF NOT EXISTS, accepted a NULL reason, and omitted status immutability.
    for (const name of [
        'customer_credit_note_immutable_posted',
        'customer_event_reason_provenance_insert',
        'customer_event_reason_provenance_update',
        'customer_credit_note_shape_insert',
        'customer_credit_note_shape_update',
        'customer_events_provenance_shape_insert',
        'customer_events_provenance_shape_update'
    ]) await run(s.db, `DROP TRIGGER IF EXISTS ${name}`);
    await run(s.db, `CREATE TRIGGER customer_credit_note_immutable_posted
        BEFORE UPDATE OF customer_id, currency, side, kind, amount_minor, method, external_reference,
                         payment_import_id, source_transaction_id, original_event_id, reason_code, idempotency_key
        ON customer_account_events WHEN OLD.kind = 'credit_note' AND OLD.status = 'posted'
        BEGIN SELECT RAISE(ABORT, 'weak note trigger'); END`);
    await run(s.db, `CREATE TRIGGER customer_credit_note_shape_insert
        BEFORE INSERT ON customer_account_events
        WHEN NEW.kind = 'credit_note' AND (
            NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')
            OR NOT EXISTS (SELECT 1 FROM customer_account_events original WHERE original.id = NEW.original_event_id)
        )
        BEGIN SELECT RAISE(ABORT, 'weak note shape'); END`);
    await run(s.db, `CREATE TRIGGER customer_credit_note_shape_update
        BEFORE UPDATE OF kind, customer_id, currency, side, original_event_id, reason_code
        ON customer_account_events
        WHEN NEW.kind = 'credit_note' AND (
            NEW.reason_code NOT IN ('return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other')
            OR NOT EXISTS (SELECT 1 FROM customer_account_events original WHERE original.id = NEW.original_event_id)
        )
        BEGIN SELECT RAISE(ABORT, 'weak note shape'); END`);

    await migrateCustomerCreditNotes(s.db);
    assert.deepEqual(await get(s.db, "SELECT name, type FROM ledger_accounts WHERE id = '4050'"), { name: 'Sales Returns and Allowances', type: 'revenue' });
    const operationColumns = await all(s.db, 'PRAGMA table_info(customer_credit_note_operations)');
    assert.ok(operationColumns.some(row => row.name === 'auto_allocation_id'));
    assert.equal(operationColumns.some(row => /raw|sms|secret/i.test(row.name)), false);
    const baseTrigger = await get(s.db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_events_immutable_posted'");
    assert.doesNotMatch(baseTrigger.sql, /reason_code/i);
    const shapeTrigger = await get(s.db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_credit_note_shape_insert'");
    const immutableNoteTrigger = await get(s.db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'customer_credit_note_immutable_posted'");
    assert.match(shapeTrigger.sql, /reason_code\s+IS\s+NULL/i);
    assert.match(immutableNoteTrigger.sql, /UPDATE OF[^]*\bstatus\b/i);
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'migration-invoice');
    await assert.rejects(run(s.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, original_event_id, idempotency_key)
        VALUES ('null-reason', 'customer:a', 'KES', 'credit', 'credit_note', 'posted', 1, ?, 'null-reason-key')`, [invoice.id]), /invalid customer credit note evidence/);
    await assert.rejects(run(s.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, original_event_id, reason_code, idempotency_key)
        VALUES ('bad-reason', 'customer:a', 'KES', 'credit', 'credit_note', 'posted', 1, ?, 'invalid', 'bad-reason-key')`, [invoice.id]), /invalid customer credit note evidence/);
    const note = await service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, { amount: '1.00', idempotency_key: 'immutable-note' }));
    await assert.rejects(run(s.db, "UPDATE customer_account_events SET status = 'draft' WHERE id = ?", [note.credit_note_event_id]), /posted customer credit notes are immutable/);
    const saved = await state(s.db, 'immutable-note');
    assert.deepEqual([saved.event.status, saved.header.customer_account_event_id, saved.entries.length], ['posted', saved.event.id, 2]);
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

test('credit-note HTTP route is admin-only, exact-shaped, session-attributed, and sanitized', async t => {
    const calls = [];
    const app = express();
    app.use((req, res, next) => { req.session = req.headers['x-role'] ? { userId: 'session-admin', userRole: req.headers['x-role'] } : {}; next(); });
    app.use(express.json());
    const requireRole = (...roles) => (req, res, next) => !req.session.userId ? res.status(401).json({ error: 'Unauthorized' }) : !roles.includes(req.session.userRole) ? res.status(403).json({ error: 'Forbidden' }) : next();
    registerCustomerCreditNoteApi(app, {
        requireRole,
        creditNoteService: { issueCustomerCreditNote: async input => {
            if (input.idempotency_key === 'notfound') throw new CustomerCreditNoteNotFoundError('caller prose 0712345678');
            if (input.idempotency_key === 'conflict') throw new CustomerCreditNoteConflictError('caller prose 0712345678');
            if (input.idempotency_key === 'failure') throw new Error('caller prose 0712345678');
            calls.push(input); return { idempotent: false, credit_note_event_id: 'note-1' };
        } }
    });
    const server = await new Promise(resolve => { const listening = app.listen(0, () => resolve(listening)); });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const body = { customer_id: 'customer:a', invoice_event_id: 'invoice:a', amount: '5.00', reason_code: 'return', idempotency_key: 'http-note' };
    assert.equal((await request(server, 'POST', '/api/customer-credit-notes', undefined, body)).status, 401);
    for (const role of ['viewer', 'farmer']) assert.equal((await request(server, 'POST', '/api/customer-credit-notes', role, body)).status, 403);
    for (const role of ['super_admin', 'admin']) assert.equal((await request(server, 'POST', '/api/customer-credit-notes', role, { ...body, idempotency_key: `http-${role}` })).status, 201);
    assert.equal(calls[0].created_by_user_id, 'session-admin');
    assert.equal((await request(server, 'POST', '/api/customer-credit-notes', 'admin', { ...body, created_by_user_id: 'forged' })).status, 400);
    assert.equal((await request(server, 'POST', '/api/customer-credit-notes', 'admin', { ...body, reason_code: 'caller prose 0712345678' })).status, 400);
    for (const [key, status] of [['notfound', 404], ['conflict', 409], ['failure', 500]]) {
        const response = await request(server, 'POST', '/api/customer-credit-notes', 'admin', { ...body, idempotency_key: key });
        assert.equal(response.status, status);
        assert.doesNotMatch(JSON.stringify(response.body), /caller prose|0712345678/i);
    }
});

test('real credit-note service result satisfies the browser response contract', async t => {
    const s = await store(t);
    const invoice = await event(s, 'customer:a', 'invoice', 1012, 'ui-contract-invoice');
    const result = await service(s.boundary).issueCustomerCreditNote(noteInput(invoice.id, {
        amount: '10.12', idempotency_key: 'ui-contract-note', created_by_user_id: 'admin-ui'
    }));
    const { validCreditNoteResponse } = await import('../../js/customer-credit-note-ui-model.mjs');
    assert.equal(validCreditNoteResponse(result, {
        customer_id: 'customer:a', invoice_event_id: invoice.id, amount: '10.12', amount_minor: 1012,
        reason_code: 'return', external_reference: null,
        automatically_allocated_minor: 1012, remaining_credit_minor: 0
    }), true);
});
