const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const settlement = require('../../services/customer-settlement');
const suggestions = require('../../services/customer-reconciliation-suggestions');
const { registerCustomerReconciliationSuggestionsApi } = require('../../services/customer-reconciliation-suggestions-http');

function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function callback(error) { return error ? reject(error) : resolve(this); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-suggestions-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'PRAGMA journal_mode=WAL');
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY)');
    await migrateCustomerSettlement(db);
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    return { db, boundary: createDedicatedTransactionBoundary(file) };
}

async function customer(s, id) {
    await run(s.db, `INSERT INTO customers (id, display_name, normalized_name, is_active)
        VALUES (?, ?, ?, 1)`, [id, id, id.toUpperCase()]);
}

async function event(s, customerId, kind, amountMinor, key, extra = {}) {
    return (await settlement.recordCustomerAccountEvent({
        customer_id: customerId,
        kind,
        amount_minor: amountMinor,
        idempotency_key: key,
        ...extra
    }, s.boundary)).event;
}

async function allocate(s, credit, debit, amountMinor, key, actor = 'reviewer-1') {
    return settlement.allocateCustomerCredit({
        credit_event_id: credit.id,
        debit_event_id: debit.id,
        amount_minor: amountMinor,
        idempotency_key: key,
        created_by_user_id: actor
    }, s.boundary);
}

async function counts(db) {
    const count = async table => (await get(db, `SELECT COUNT(*) AS n FROM ${table}`)).n;
    return {
        events: await count('customer_account_events'),
        allocations: await count('customer_account_allocations'),
        transactions: await count('transactions'),
        ledgerTransactions: await count('ledger_transactions'),
        ledgerEntries: await count('ledger_entries'),
        imports: await count('payment_imports')
    };
}

test('reconciliation suggestions rank exact matches first and cover one-to-many and many-to-one capacity', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const invoiceExact = await event(s, 'customer:a', 'invoice', 1000, 'invoice-exact');
    const invoicePartial = await event(s, 'customer:a', 'invoice', 600, 'invoice-partial');
    const invoiceThird = await event(s, 'customer:a', 'invoice', 300, 'invoice-third');
    const paymentExact = await event(s, 'customer:a', 'payment', 1000, 'payment-exact', { method: 'cash', external_reference: 'cash-exact' });
    const paymentSmall = await event(s, 'customer:a', 'payment', 200, 'payment-small', { method: 'bank', external_reference: 'bank-small' });
    const original = await event(s, 'customer:a', 'invoice', 400, 'invoice-original');
    const note = await event(s, 'customer:a', 'credit_note', 400, 'credit-note', { original_event_id: original.id, reason_code: 'return' });

    const output = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:a', limit: 20 }, s.boundary);
    assert.equal(output.status, 'exact');
    assert.equal(output.suggestions[0].reason_code, 'exact_remaining_match');
    assert.deepEqual(output.suggestions.find(row => row.credit_event_id === paymentExact.id && row.debit_event_id === invoiceExact.id), {
        credit_event_id: paymentExact.id,
        debit_event_id: invoiceExact.id,
        amount_minor: 1000,
        credit_remaining_minor: 1000,
        invoice_deficit_minor: 1000,
        reason_code: 'exact_remaining_match'
    });
    assert.ok(output.suggestions.some(row => row.credit_event_id === paymentExact.id && row.debit_event_id === invoicePartial.id));
    assert.ok(output.suggestions.some(row => row.credit_event_id === paymentSmall.id && row.debit_event_id === invoiceExact.id));
    assert.ok(output.suggestions.some(row => row.credit_event_id === note.id && row.debit_event_id === invoiceThird.id));
    const reasonOrder = output.suggestions.map(row => row.reason_code);
    assert.deepEqual(reasonOrder, [
        'exact_remaining_match', 'exact_remaining_match',
        'partial_capacity_match', 'partial_capacity_match', 'partial_capacity_match',
        'partial_capacity_match', 'partial_capacity_match', 'partial_capacity_match',
        'partial_capacity_match', 'partial_capacity_match', 'partial_capacity_match',
        'partial_capacity_match'
    ]);
});

test('candidate generation has exact stable ordering and stops before materializing a large Cartesian product', () => {
    const event = (id, side, kind, remaining) => ({ id, side, kind, status: 'open', remaining_minor: remaining });
    const ordered = suggestions.candidates({ events: [
        event('credit:c', 'credit', 'payment', 300),
        event('credit:a', 'credit', 'payment', 100),
        event('credit:b', 'credit', 'credit_note', 100),
        event('invoice:b', 'debit', 'invoice', 100),
        event('invoice:a', 'debit', 'invoice', 100),
        event('invoice:c', 'debit', 'invoice', 250)
    ] }, 7);
    assert.deepEqual(ordered.map(row => [row.reason_code, row.credit_event_id, row.debit_event_id, row.amount_minor]), [
        ['exact_remaining_match', 'credit:a', 'invoice:a', 100],
        ['exact_remaining_match', 'credit:a', 'invoice:b', 100],
        ['exact_remaining_match', 'credit:b', 'invoice:a', 100],
        ['exact_remaining_match', 'credit:b', 'invoice:b', 100],
        ['partial_capacity_match', 'credit:a', 'invoice:c', 100],
        ['partial_capacity_match', 'credit:b', 'invoice:c', 100],
        ['partial_capacity_match', 'credit:c', 'invoice:a', 100]
    ]);

    let remainingReads = 0;
    const highCardinality = [];
    for (let index = 0; index < 250; index += 1) {
        highCardinality.push({
            id: `credit:${String(index).padStart(3, '0')}`,
            side: 'credit', kind: 'payment', status: 'open',
            get remaining_minor() { remainingReads += 1; return 500; }
        });
        highCardinality.push({
            id: `invoice:${String(index).padStart(3, '0')}`,
            side: 'debit', kind: 'invoice', status: 'open',
            get remaining_minor() { remainingReads += 1; return 1000; }
        });
    }
    const bounded = suggestions.candidates({ events: highCardinality }, 3);
    assert.deepEqual(bounded.map(row => [row.credit_event_id, row.debit_event_id, row.amount_minor]), [
        ['credit:000', 'invoice:000', 500],
        ['credit:000', 'invoice:001', 500],
        ['credit:000', 'invoice:002', 500]
    ]);
    assert.ok(remainingReads < 5000, `bounded generator unexpectedly read ${remainingReads} candidate amounts`);
});

test('partial allocations, unused credit, cross-customer evidence, empty capacity, and bounded ordering are handled safely', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    await customer(s, 'customer:b');
    const invoice = await event(s, 'customer:a', 'invoice', 1000, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 1500, 'credit', { method: 'mpesa', external_reference: 'MPESA-A' });
    const otherInvoice = await event(s, 'customer:b', 'invoice', 1500, 'other-invoice');
    await allocate(s, credit, invoice, 400, 'partial-allocation');
    const before = await counts(s.db);
    const output = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:a', limit: 1 }, s.boundary);
    assert.deepEqual(output.suggestions, [{
        credit_event_id: credit.id,
        debit_event_id: invoice.id,
        amount_minor: 600,
        credit_remaining_minor: 1100,
        invoice_deficit_minor: 600,
        reason_code: 'partial_capacity_match'
    }]);
    assert.deepEqual(await counts(s.db), before);
    const foreign = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:b' }, s.boundary);
    assert.equal(foreign.suggestions.length, 0);
    assert.equal(otherInvoice.customer_id, 'customer:b');
    await allocate(s, credit, invoice, 600, 'settle-invoice');
    const noDebit = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:a' }, s.boundary);
    assert.deepEqual(noDebit.suggestions, []);
});

test('corrupt or unsafe event and active-allocation provenance is unavailable rather than suggested', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const invoice = await event(s, 'customer:a', 'invoice', 100, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 100, 'credit', { method: 'cash', external_reference: 'cash' });
    const created = await allocate(s, credit, invoice, 10, 'allocation');
    await run(s.db, 'DELETE FROM customer_allocation_operations WHERE allocation_id = ?', [created.allocation.id]);
    const missingProvenance = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:a' }, s.boundary);
    assert.deepEqual([missingProvenance.status, missingProvenance.available_credit_minor, missingProvenance.suggestions.length, missingProvenance.evidence_count], ['reconciliation_required', null, 0, 2]);

    const nonNullActor = await store(t);
    await customer(nonNullActor, 'customer:actor');
    const actorInvoice = await event(nonNullActor, 'customer:actor', 'invoice', 100, 'actor-invoice');
    const actorCredit = await event(nonNullActor, 'customer:actor', 'payment', 100, 'actor-credit', { method: 'cash', external_reference: 'actor-cash' });
    const actorAllocation = await allocate(nonNullActor, actorCredit, actorInvoice, 10, 'actor-allocation', 'reviewer-1');
    await run(nonNullActor.db, 'UPDATE customer_allocation_operations SET created_by_user_id = ? WHERE allocation_id = ?', ['tampered-actor', actorAllocation.allocation.id]);
    const nonNullMismatch = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:actor' }, nonNullActor.boundary);
    assert.deepEqual([nonNullMismatch.status, nonNullMismatch.suggestions.length], ['reconciliation_required', 0]);

    const nullActor = await store(t);
    await customer(nullActor, 'customer:null-actor');
    const nullInvoice = await event(nullActor, 'customer:null-actor', 'invoice', 100, 'null-invoice');
    const nullCredit = await event(nullActor, 'customer:null-actor', 'payment', 100, 'null-credit', { method: 'bank', external_reference: 'null-bank' });
    const nullAllocation = await allocate(nullActor, nullCredit, nullInvoice, 10, 'null-allocation', null);
    const persistedNullActors = await get(nullActor.db, `SELECT a.created_by_user_id AS allocation_actor,
        o.created_by_user_id AS operation_actor
        FROM customer_account_allocations a
        JOIN customer_allocation_operations o ON o.allocation_id = a.id
        WHERE a.id = ?`, [nullAllocation.allocation.id]);
    assert.deepEqual(persistedNullActors, { allocation_actor: null, operation_actor: null });
    await run(nullActor.db, 'UPDATE customer_allocation_operations SET created_by_user_id = ? WHERE allocation_id = ?', ['tampered-actor', nullAllocation.allocation.id]);
    const nullMismatch = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:null-actor' }, nullActor.boundary);
    assert.deepEqual([nullMismatch.status, nullMismatch.suggestions.length], ['reconciliation_required', 0]);

    const unsafe = await store(t);
    await customer(unsafe, 'customer:unsafe');
    const unsafeInvoice = await event(unsafe, 'customer:unsafe', 'invoice', 100, 'unsafe-invoice');
    await run(unsafe.db, 'DROP TRIGGER customer_events_immutable_posted');
    await run(unsafe.db, 'UPDATE customer_account_events SET amount_minor = ? WHERE id = ?', [Number.MAX_SAFE_INTEGER + 1, unsafeInvoice.id]);
    const unsafeOutput = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:unsafe' }, unsafe.boundary);
    assert.deepEqual([unsafeOutput.status, unsafeOutput.outstanding_debit_minor, unsafeOutput.suggestions.length, unsafeOutput.evidence_count], ['reconciliation_required', null, 0, 1]);
});

test('suggestions use one read snapshot while an allocation writer interleaves', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const invoice = await event(s, 'customer:a', 'invoice', 100, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 100, 'credit', { method: 'bank', external_reference: 'bank' });
    let pause;
    let release;
    const paused = new Promise(resolve => { pause = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    let held = false;
    const interleaved = {
        withDedicatedReadTransaction: work => s.boundary.withDedicatedReadTransaction(adapter => work({
            ...adapter,
            getQuery: async (sql, params = []) => {
                const row = await adapter.getQuery(sql, params);
                if (!held && sql.includes('SELECT id FROM customers')) {
                    held = true;
                    pause();
                    await released;
                }
                return row;
            }
        }))
    };
    const pending = suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:a' }, interleaved);
    await paused;
    await allocate(s, credit, invoice, 100, 'writer-allocation');
    release();
    const during = await pending;
    assert.deepEqual([during.status, during.outstanding_debit_minor, during.available_credit_minor, during.suggestions.length], ['exact', 100, 100, 1]);
    const after = await suggestions.getCustomerReconciliationSuggestions({ customer_id: 'customer:a' }, s.boundary);
    assert.deepEqual([after.outstanding_debit_minor, after.available_credit_minor, after.suggestions.length], [0, 0, 0]);
});

function request(server, pathname, role) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const req = http.request({
            host: '127.0.0.1', port: address.port, method: 'GET', path: pathname,
            headers: role ? { 'x-role': role } : {}
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

test('suggestion HTTP route enforces financial-read roles, bounded input, and sanitized errors', async t => {
    const calls = [];
    const app = express();
    app.use((req, res, next) => { req.session = req.headers['x-role'] ? { userId: 'session-user', userRole: req.headers['x-role'] } : {}; next(); });
    const requireRole = (...roles) => (req, res, next) => !req.session.userId
        ? res.status(401).json({ error: 'Unauthorized' })
        : !roles.includes(req.session.userRole) ? res.status(403).json({ error: 'Forbidden' }) : next();
    registerCustomerReconciliationSuggestionsApi(app, {
        requireRole,
        suggestionService: {
            getCustomerReconciliationSuggestions: async input => {
                if (input.customer_id === 'missing') throw new settlement.SettlementNotFoundError('caller prose 0712345678');
                if (input.customer_id === 'invalid') throw new TypeError('caller prose 0712345678');
                if (input.customer_id === 'failure') throw new Error('caller prose 0712345678');
                calls.push(input);
                return { customer_id: input.customer_id, status: 'exact', suggestions: [] };
            }
        }
    });
    const server = await new Promise(resolve => { const value = app.listen(0, () => resolve(value)); });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

    assert.equal((await request(server, '/api/customers/customer-a/reconciliation-suggestions', undefined)).status, 401);
    assert.equal((await request(server, '/api/customers/customer-a/reconciliation-suggestions', 'viewer')).status, 403);
    for (const role of ['super_admin', 'admin', 'farmer']) {
        assert.equal((await request(server, '/api/customers/customer-a/reconciliation-suggestions?limit=2', role)).status, 200);
    }
    assert.deepEqual(calls[0], { customer_id: 'customer-a', limit: 2 });
    for (const pathname of [
        '/api/customers/bad%20id/reconciliation-suggestions',
        '/api/customers/customer-a/reconciliation-suggestions?limit=0',
        '/api/customers/customer-a/reconciliation-suggestions?limit=101',
        '/api/customers/customer-a/reconciliation-suggestions?limit=1e2',
        '/api/customers/customer-a/reconciliation-suggestions?other=1'
    ]) assert.equal((await request(server, pathname, 'farmer')).status, 400);
    for (const [id, status] of [['missing', 404], ['invalid', 400], ['failure', 500]]) {
        const response = await request(server, `/api/customers/${id}/reconciliation-suggestions`, 'farmer');
        assert.equal(response.status, status);
        assert.doesNotMatch(JSON.stringify(response.body), /caller prose|0712345678/i);
    }
});
