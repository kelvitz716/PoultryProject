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
const { getCustomerSettlement } = require('../../services/customer-settlement-read');
const { registerCustomerSettlementApi } = require('../../services/customer-settlement-http');

function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function callback(error) { return error ? reject(error) : resolve(this); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-settlement-api-'));
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
async function event(s, customer, kind, amount_minor, key, extra = {}) {
    return (await settlement.recordCustomerAccountEvent({ customer_id: customer, kind, amount_minor, idempotency_key: key, ...extra }, s.boundary)).event;
}
async function customer(s, id, active = 1) {
    await run(s.db, `INSERT INTO customers (id, display_name, normalized_name, is_active)
        VALUES (?, ?, ?, ?)`, [id, id, id.toUpperCase(), active]);
}
function allocation(credit_event_id, debit_event_id, amount = '1.00', idempotency_key = 'allocation-key', actor = 'actor-1') {
    return { credit_event_id, debit_event_id, amount, idempotency_key, created_by_user_id: actor };
}
async function financialCounts(db) {
    const count = async table => (await get(db, `SELECT COUNT(*) AS n FROM ${table}`)).n;
    return {
        events: await count('customer_account_events'),
        allocations: await count('customer_account_allocations'),
        transactions: await count('transactions'),
        ledgerTransactions: await count('ledger_transactions'),
        ledgerEntries: await count('ledger_entries')
    };
}

test('allocates many tenders to one invoice and one payment across invoices with exact under/overpayment positions', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const invoice = await event(s, 'customer:a', 'invoice', 100000, 'invoice-1');
    const cash = await event(s, 'customer:a', 'payment', 20000, 'cash-1', { method: 'cash', external_reference: 'cash-1' });
    const bank = await event(s, 'customer:a', 'payment', 30000, 'bank-1', { method: 'bank', external_reference: 'bank-1' });
    const mpesa = await event(s, 'customer:a', 'payment', 50000, 'mpesa-1', { method: 'mpesa', external_reference: 'mpesa-1' });
    for (const [credit, key] of [[cash, 'a-cash'], [bank, 'a-bank'], [mpesa, 'a-mpesa']]) {
        await settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: invoice.id, amount_minor: credit.amount_minor, idempotency_key: key, created_by_user_id: 'actor-1' }, s.boundary);
    }
    const invoiceTwo = await event(s, 'customer:a', 'invoice', 5000, 'invoice-2');
    const invoiceThree = await event(s, 'customer:a', 'invoice', 5000, 'invoice-3');
    const overpayment = await event(s, 'customer:a', 'payment', 15000, 'payment-over', { method: 'cash', external_reference: 'cash-over' });
    await settlement.allocateCustomerCredit({ credit_event_id: overpayment.id, debit_event_id: invoiceTwo.id, amount_minor: 5000, idempotency_key: 'a-two' }, s.boundary);
    await settlement.allocateCustomerCredit({ credit_event_id: overpayment.id, debit_event_id: invoiceThree.id, amount_minor: 3000, idempotency_key: 'a-three', created_by_user_id: 'actor-2' }, s.boundary);
    const snapshot = await getCustomerSettlement('customer:a', s.boundary);
    assert.deepEqual([snapshot.status, snapshot.outstanding_debit_minor, snapshot.available_credit_minor, snapshot.net_minor], ['exact', 2000, 7000, 5000]);
    assert.equal(snapshot.events.find(row => row.id === invoice.id).status, 'settled');
    assert.equal(snapshot.events.find(row => row.id === invoiceThree.id).status, 'part-paid');
    assert.equal(snapshot.events.find(row => row.id === overpayment.id).remaining_minor, 7000);
    assert.deepEqual(await financialCounts(s.db), {
        events: 7, allocations: 5, transactions: 0, ledgerTransactions: 0, ledgerEntries: 0
    });
});

test('allocation retries are deterministic across actors, material retries conflict, and reversal preserves first provenance', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 1000, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 1000, 'payment', { method: 'cash', external_reference: 'cash' });
    const input = { credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 1000, idempotency_key: 'retry-key', created_by_user_id: 'actor-1' };
    const first = await settlement.allocateCustomerCredit(input, s.boundary);
    const retry = await settlement.allocateCustomerCredit({ ...input, created_by_user_id: 'actor-2' }, s.boundary);
    assert.deepEqual([first.created, retry.created, first.allocation.id, retry.allocation.created_by_user_id], [true, false, settlement.allocationIdFor('retry-key'), 'actor-1']);
    await assert.rejects(settlement.allocateCustomerCredit({ ...input, amount_minor: 999 }, s.boundary), settlement.SettlementConflictError);
    const reversed = await settlement.reverseCustomerAllocation({ id: first.allocation.id, reversed_by_user_id: 'actor-1' }, s.boundary);
    const reversedRetry = await settlement.reverseCustomerAllocation({ id: first.allocation.id, reversed_by_user_id: 'actor-2' }, s.boundary);
    assert.deepEqual([reversed.idempotent, reversedRetry.idempotent, reversedRetry.allocation.reversed_by_user_id], [false, true, 'actor-1']);
    const snapshot = await getCustomerSettlement('customer:a', s.boundary);
    assert.deepEqual([snapshot.outstanding_debit_minor, snapshot.available_credit_minor], [1000, 1000]);
});

test('migrated settlement HTTP read exposes safe allocation provenance for reversal, including a null original creator', async t => {
    const s = await store(t);
    await customer(s, 'customer-history');
    const debit = await event(s, 'customer-history', 'invoice', 1012, 'history-invoice');
    const credit = await event(s, 'customer-history', 'payment', 1012, 'history-payment', { method: 'cash', external_reference: 'HISTORY-CASH' });
    const created = await settlement.allocateCustomerCredit({
        credit_event_id: credit.id,
        debit_event_id: debit.id,
        amount_minor: 1012,
        idempotency_key: 'history-allocation',
        created_by_user_id: null
    }, s.boundary);
    const snapshot = await getCustomerSettlement('customer-history', s.boundary);
    const row = snapshot.allocations.find(allocation => allocation.id === created.allocation.id);
    assert.deepEqual({
        id: row.id,
        credit_event_id: row.credit_event_id,
        debit_event_id: row.debit_event_id,
        amount_minor: row.amount_minor,
        idempotency_key: row.idempotency_key,
        created_by_user_id: row.created_by_user_id,
        status: row.status
    }, {
        id: created.allocation.id,
        credit_event_id: credit.id,
        debit_event_id: debit.id,
        amount_minor: 1012,
        idempotency_key: 'history-allocation',
        created_by_user_id: null,
        status: 'active'
    });
    const reversalModel = await import('../../js/customer-allocation-reversal-ui-model.mjs');
    const customerRow = { id: 'customer-history', is_active: false };
    const suggestions = { status: 'exact', suggestions: [] };
    const candidates = reversalModel.allocationReversalCandidates(customerRow, snapshot, suggestions);
    assert.deepEqual(candidates.allocations.map(allocation => allocation.id), [created.allocation.id]);
    const requested = reversalModel.allocationReversalDraft({
        customer: customerRow, settlement: snapshot, suggestions, allocationId: created.allocation.id, confirmed: true
    });

    const app = express();
    app.use((req, res, next) => {
        req.session = req.headers['x-role'] ? { userId: 'session-reverser', userRole: req.headers['x-role'] } : {};
        next();
    });
    app.use(express.json());
    const requireRole = (...roles) => (req, res, next) => !req.session.userId
        ? res.status(401).json({ error: 'Unauthorized' })
        : !roles.includes(req.session.userRole)
            ? res.status(403).json({ error: 'Forbidden' })
            : next();
    registerCustomerSettlementApi(app, {
        requireRole,
        settlementService: {
            allocateCustomerCredit: input => settlement.allocateCustomerCredit(input, s.boundary),
            reverseCustomerAllocation: input => settlement.reverseCustomerAllocation(input, s.boundary)
        },
        settlementReadService: { getCustomerSettlement: id => getCustomerSettlement(id, s.boundary) }
    });
    const server = await new Promise(resolve => { const listening = app.listen(0, () => resolve(listening)); });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const overHttp = await request(server, 'GET', '/api/customers/customer-history/settlement', 'farmer');
    assert.equal(overHttp.status, 200);
    assert.equal(overHttp.body.allocations[0].idempotency_key, 'history-allocation');
    assert.equal(overHttp.body.allocations[0].created_by_user_id, null);
    const reversal = await request(server, 'POST', `/api/customer-settlement/allocations/${encodeURIComponent(created.allocation.id)}/reverse`, 'farmer', {});
    assert.equal(reversal.status, 200);
    assert.equal(reversalModel.validAllocationReversalResponse(reversal.body, requested), true);
    assert.equal(reversal.body.allocation.created_by_user_id, null);
    assert.equal(reversal.body.allocation.reversed_by_user_id, 'session-reverser');
});

test('allocation and operation use one persisted timestamp even when finalization is delayed', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 100, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 100, 'payment', { method: 'cash', external_reference: 'cash' });
    const delayed = {
        withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(adapter => work({
            ...adapter,
            runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO customer_allocation_operations')) {
                    await new Promise(resolve => setTimeout(resolve, 1100));
                }
                return adapter.runQuery(sql, params);
            }
        }))
    };
    const input = { credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 100, idempotency_key: 'delayed-timestamp', created_by_user_id: 'creator' };
    const created = await settlement.allocateCustomerCredit(input, delayed);
    const operation = await get(s.db, 'SELECT created_at FROM customer_allocation_operations WHERE idempotency_key = ?', [input.idempotency_key]);
    assert.equal(created.allocation.created_at, operation.created_at);
    const retry = await settlement.allocateCustomerCredit({ ...input, created_by_user_id: 'later' }, s.boundary);
    assert.equal(retry.created, false);
});

test('allocation retry verifies operation binding, actor, key, and active/reversed provenance', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 1000, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 1000, 'payment', { method: 'cash', external_reference: 'cash' });
    const input = { credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 1000, idempotency_key: 'evidence-key', created_by_user_id: 'creator' };
    const first = await settlement.allocateCustomerCredit(input, s.boundary);
    await run(s.db, 'UPDATE customer_account_allocations SET created_by_user_id = ? WHERE id = ?', ['tampered', first.allocation.id]);
    await assert.rejects(settlement.allocateCustomerCredit({ ...input, created_by_user_id: 'later' }, s.boundary), settlement.SettlementConflictError);

    const actorRepair = await run(s.db, 'UPDATE customer_account_allocations SET created_by_user_id = ? WHERE id = ?', ['creator', first.allocation.id]);
    assert.equal(actorRepair.changes, 1);
    await run(s.db, 'DROP TRIGGER customer_allocations_immutable_links');
    await run(s.db, 'UPDATE customer_account_allocations SET idempotency_key = ? WHERE id = ?', ['tampered-key', first.allocation.id]);
    await assert.rejects(settlement.allocateCustomerCredit(input, s.boundary), settlement.SettlementConflictError);
    await run(s.db, 'DROP TRIGGER customer_allocations_reversal_shape_update');
    await run(s.db, 'UPDATE customer_account_allocations SET idempotency_key = ?, reversed_at = ? WHERE id = ?', ['evidence-key', '2026-01-01T00:00:00Z', first.allocation.id]);
    await assert.rejects(settlement.allocateCustomerCredit(input, s.boundary), settlement.SettlementConflictError);
});

test('allocation capacity rejects unsafe persisted event and active-allocation evidence', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 200, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 200, 'payment', { method: 'cash', external_reference: 'cash' });
    await run(s.db, 'DROP TRIGGER customer_events_immutable_posted');
    await run(s.db, 'UPDATE customer_account_events SET amount_minor = ? WHERE id = ?', [Number.MAX_SAFE_INTEGER + 1, credit.id]);
    await assert.rejects(settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 1, idempotency_key: 'unsafe-event' }, s.boundary), settlement.SettlementConflictError);

    await run(s.db, 'UPDATE customer_account_events SET amount_minor = ? WHERE id = ?', [200, credit.id]);
    const first = await settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 100, idempotency_key: 'safe-first' }, s.boundary);
    await run(s.db, 'DROP TRIGGER customer_allocations_immutable_links');
    await run(s.db, 'UPDATE customer_account_allocations SET amount_minor = ? WHERE id = ?', [Number.MAX_SAFE_INTEGER + 1, first.allocation.id]);
    await assert.rejects(settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 1, idempotency_key: 'unsafe-active-allocation' }, s.boundary), settlement.SettlementConflictError);
});

test('allocation insert and operation finalization failures roll back with no financial side effects', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 100, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 100, 'payment', { method: 'cash', external_reference: 'cash' });
    const input = { credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 100, idempotency_key: 'rollback', created_by_user_id: 'actor' };
    const insertionFailure = {
        withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(adapter => work({
            ...adapter,
            runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO customer_account_allocations')) throw new Error('allocation insert failure');
                return adapter.runQuery(sql, params);
            }
        }))
    };
    await assert.rejects(settlement.allocateCustomerCredit(input, insertionFailure), /allocation insert failure/);
    assert.deepEqual(await financialCounts(s.db), {
        events: 2, allocations: 0, transactions: 0, ledgerTransactions: 0, ledgerEntries: 0
    });
    const markerFailure = {
        withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(adapter => work({
            ...adapter,
            runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO customer_allocation_operations')) throw new Error('operation failure');
                return adapter.runQuery(sql, params);
            }
        }))
    };
    await assert.rejects(settlement.allocateCustomerCredit(input, markerFailure), /operation failure/);
    assert.deepEqual(await financialCounts(s.db), {
        events: 2, allocations: 0, transactions: 0, ledgerTransactions: 0, ledgerEntries: 0
    });
});

test('missing or corrupt allocation operation evidence fails closed on retry', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 100, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 100, 'payment', { method: 'cash', external_reference: 'cash' });
    const input = { credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 100, idempotency_key: 'missing-evidence', created_by_user_id: 'actor' };
    const created = await settlement.allocateCustomerCredit(input, s.boundary);
    await run(s.db, 'PRAGMA foreign_keys=OFF');
    await run(s.db, 'DELETE FROM customer_account_allocations WHERE id = ?', [created.allocation.id]);
    await run(s.db, 'PRAGMA foreign_keys=ON');
    await assert.rejects(settlement.allocateCustomerCredit({ ...input, idempotency_key: 'missing-evidence', created_by_user_id: 'later' }, s.boundary), settlement.SettlementConflictError);
});

test('concurrent allocations cap a single payment shared across two invoices', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const credit = await event(s, 'customer:a', 'payment', 1000, 'credit', { method: 'bank', external_reference: 'bank' });
    const first = await event(s, 'customer:a', 'invoice', 1000, 'first');
    const second = await event(s, 'customer:a', 'invoice', 1000, 'second');
    const concurrent = await Promise.allSettled([first, second].map((debit, index) => settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 600, idempotency_key: `payment-side-${index}`, created_by_user_id: `actor-${index}` }, s.boundary)));
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_allocations WHERE status = 'active'")).n, 1);
});

test('concurrent allocations cap a single invoice shared across two payments', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 1000, 'debit');
    const first = await event(s, 'customer:a', 'payment', 1000, 'credit-one', { method: 'cash', external_reference: 'cash-one' });
    const second = await event(s, 'customer:a', 'payment', 1000, 'credit-two', { method: 'bank', external_reference: 'bank-two' });
    const concurrent = await Promise.allSettled([first, second].map((credit, index) => settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 600, idempotency_key: `debit-side-${index}`, created_by_user_id: `actor-${index}` }, s.boundary)));
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_allocations WHERE status = 'active'")).n, 1);
});

test('allocation rejects cross-customer and draft evidence without mutation', async t => {
    const s = await store(t);
    await customer(s, 'customer:a'); await customer(s, 'customer:b');
    const debit = await event(s, 'customer:a', 'invoice', 1000, 'debit');
    const credit = await event(s, 'customer:a', 'payment', 1000, 'credit', { method: 'bank', external_reference: 'bank' });
    const other = await event(s, 'customer:b', 'invoice', 1000, 'other');
    await assert.rejects(settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: other.id, amount_minor: 1, idempotency_key: 'cross' }, s.boundary), settlement.SettlementConflictError);
    const draft = await event(s, 'customer:a', 'invoice', 1, 'draft', { status: 'draft' });
    await assert.rejects(settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: draft.id, amount_minor: 1, idempotency_key: 'draft' }, s.boundary), settlement.SettlementConflictError);
    assert.deepEqual(await financialCounts(s.db), {
        events: 4, allocations: 0, transactions: 0, ledgerTransactions: 0, ledgerEntries: 0
    });
});

test('settlement read holds one coherent snapshot while a writer reverses an allocation', async t => {
    const s = await store(t);
    await customer(s, 'customer:a');
    const debit = await event(s, 'customer:a', 'invoice', 100, 'invoice');
    const credit = await event(s, 'customer:a', 'payment', 100, 'payment', { method: 'cash', external_reference: 'cash' });
    const created = await settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 50, idempotency_key: 'snapshot-allocation' }, s.boundary);
    let pauseRows;
    let releaseRows;
    const rowsPaused = new Promise(resolve => { pauseRows = resolve; });
    const rowsReleased = new Promise(resolve => { releaseRows = resolve; });
    let paused = false;
    const interleavedBoundary = {
        withDedicatedReadTransaction: work => s.boundary.withDedicatedReadTransaction(adapter => work({
            ...adapter,
            allQuery: async (sql, params = []) => {
                if (!paused) {
                    paused = true;
                    pauseRows();
                    await rowsReleased;
                }
                return adapter.allQuery(sql, params);
            }
        }))
    };
    const pending = getCustomerSettlement('customer:a', interleavedBoundary);
    await rowsPaused;
    await run(s.db, "UPDATE customer_account_allocations SET status = 'reversed', reversed_by_user_id = 'writer', reversed_at = CURRENT_TIMESTAMP WHERE id = ?", [created.allocation.id]);
    releaseRows();
    const snapshot = await pending;
    assert.deepEqual([snapshot.status, snapshot.outstanding_debit_minor, snapshot.available_credit_minor], ['exact', 50, 50]);
    const after = await getCustomerSettlement('customer:a', s.boundary);
    assert.deepEqual([after.outstanding_debit_minor, after.available_credit_minor], [100, 100]);
});

test('settlement read is one safe snapshot and marks corrupt, overflowing, or cross-customer evidence unavailable', async t => {
    const s = await store(t);
    await customer(s, 'customer:a', 0); await customer(s, 'customer:b');
    const debit = await event(s, 'customer:a', 'invoice', 100, 'debit');
    const credit = await event(s, 'customer:a', 'payment', 100, 'credit', { method: 'cash', external_reference: 'cash' });
    const foreignDebit = await event(s, 'customer:b', 'invoice', 100, 'foreign-debit');
    const allocation = await settlement.allocateCustomerCredit({ credit_event_id: credit.id, debit_event_id: debit.id, amount_minor: 50, idempotency_key: 'safe' }, s.boundary);
    const snapshot = await getCustomerSettlement('customer:a', s.boundary);
    assert.deepEqual([snapshot.status, snapshot.outstanding_debit_minor, snapshot.available_credit_minor], ['exact', 50, 50]);
    await run(s.db, 'DROP TRIGGER customer_allocations_immutable_links');
    await run(s.db, 'UPDATE customer_account_allocations SET debit_event_id = ? WHERE id = ?', [foreignDebit.id, allocation.allocation.id]);
    const corrupt = await getCustomerSettlement('customer:a', s.boundary);
    assert.deepEqual([corrupt.status, corrupt.outstanding_debit_minor, corrupt.available_credit_minor], ['reconciliation_required', null, null]);
    assert.deepEqual([corrupt.evidence_count, corrupt.allocation_count, corrupt.issue_count], [2, 1, 1]);
    assert.doesNotMatch(JSON.stringify(corrupt), /raw_sms|fingerprint|secret/i);

    const overflow = await store(t);
    await customer(overflow, 'customer:overflow');
    const tooLarge = await event(overflow, 'customer:overflow', 'invoice', 1, 'small');
    await run(overflow.db, 'DROP TRIGGER customer_events_immutable_posted');
    await run(overflow.db, 'UPDATE customer_account_events SET amount_minor = ? WHERE id = ?', [Number.MAX_SAFE_INTEGER + 1, tooLarge.id]);
    const unsafe = await getCustomerSettlement('customer:overflow', overflow.boundary);
    assert.deepEqual([unsafe.status, unsafe.outstanding_debit_minor], ['reconciliation_required', null]);
});

test('settlement read rejects impossible active and reversed allocation provenance shapes', async t => {
    const active = await store(t);
    await customer(active, 'customer:a');
    const activeDebit = await event(active, 'customer:a', 'invoice', 100, 'active-invoice');
    const activeCredit = await event(active, 'customer:a', 'payment', 100, 'active-payment', { method: 'cash', external_reference: 'active-cash' });
    const activeAllocation = await settlement.allocateCustomerCredit({ credit_event_id: activeCredit.id, debit_event_id: activeDebit.id, amount_minor: 50, idempotency_key: 'active-shape' }, active.boundary);
    await assert.rejects(run(active.db, "UPDATE customer_account_allocations SET reversed_at = CURRENT_TIMESTAMP WHERE id = ?", [activeAllocation.allocation.id]), /invalid customer allocation reversal provenance/);
    await run(active.db, 'DROP TRIGGER customer_allocations_reversal_shape_update');
    await run(active.db, "UPDATE customer_account_allocations SET reversed_at = CURRENT_TIMESTAMP WHERE id = ?", [activeAllocation.allocation.id]);
    const activeCorrupt = await getCustomerSettlement('customer:a', active.boundary);
    assert.deepEqual([activeCorrupt.status, activeCorrupt.outstanding_debit_minor, activeCorrupt.evidence_count, activeCorrupt.allocation_count], ['reconciliation_required', null, 2, 1]);

    const reversed = await store(t);
    await customer(reversed, 'customer:a');
    const reversedDebit = await event(reversed, 'customer:a', 'invoice', 100, 'reversed-invoice');
    const reversedCredit = await event(reversed, 'customer:a', 'payment', 100, 'reversed-payment', { method: 'bank', external_reference: 'reversed-bank' });
    const reversedAllocation = await settlement.allocateCustomerCredit({ credit_event_id: reversedCredit.id, debit_event_id: reversedDebit.id, amount_minor: 50, idempotency_key: 'reversed-shape' }, reversed.boundary);
    await assert.rejects(run(reversed.db, "UPDATE customer_account_allocations SET status = 'reversed' WHERE id = ?", [reversedAllocation.allocation.id]), /invalid customer allocation reversal provenance/);
    await run(reversed.db, 'DROP TRIGGER customer_allocations_reversal_shape_update');
    await run(reversed.db, "UPDATE customer_account_allocations SET status = 'reversed' WHERE id = ?", [reversedAllocation.allocation.id]);
    const reversedCorrupt = await getCustomerSettlement('customer:a', reversed.boundary);
    assert.deepEqual([reversedCorrupt.status, reversedCorrupt.available_credit_minor, reversedCorrupt.evidence_count, reversedCorrupt.allocation_count], ['reconciliation_required', null, 2, 1]);
});

function request(server, method, pathname, role, body) {
    return new Promise((resolve, reject) => {
        const wire = body === undefined ? undefined : JSON.stringify(body);
        const headers = role ? { 'x-role': role, 'content-type': 'application/json', ...(wire === undefined ? {} : { 'content-length': Buffer.byteLength(wire) }) } : {};
        const address = server.address();
        const req = http.request({ host: '127.0.0.1', port: address.port, method, path: pathname, headers }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
            });
        }); req.on('error', reject); if (wire) req.write(wire); req.end();
    });
}
test('settlement HTTP routes enforce roles, exact shapes, path safety, actor provenance, and sanitized failures', async t => {
    const calls = [];
    const app = express(); app.use((req, res, next) => { req.session = req.headers['x-role'] ? { userId: 'session-actor', userRole: req.headers['x-role'] } : {}; next(); }); app.use(express.json());
    const requireRole = (...roles) => (req, res, next) => !req.session.userId ? res.status(401).json({ error: 'Unauthorized' }) : !roles.includes(req.session.userRole) ? res.status(403).json({ error: 'Forbidden' }) : next();
    registerCustomerSettlementApi(app, { requireRole, settlementService: {
        allocateCustomerCredit: async input => {
            if (input.idempotency_key === 'notfound') throw new settlement.SettlementNotFoundError('caller prose 0712345678');
            if (input.idempotency_key === 'conflict') throw new settlement.SettlementConflictError('caller prose 0712345678');
            if (input.idempotency_key === 'invalid') throw new TypeError('caller prose 0712345678');
            if (input.idempotency_key === 'failure') throw new Error('caller prose 0712345678');
            calls.push(input); return { created: true, allocation: { id: 'allocation:one' } };
        },
        reverseCustomerAllocation: async input => {
            if (input.id === 'missing') throw new settlement.SettlementNotFoundError('caller prose');
            if (input.id === 'conflict') throw new settlement.SettlementConflictError('caller prose');
            if (input.id === 'failure') throw new Error('caller prose');
            return { idempotent: false, allocation: input };
        }
    }, settlementReadService: {
        getCustomerSettlement: async id => {
            if (id === 'missing') throw new settlement.SettlementNotFoundError('caller prose');
            if (id === 'conflict') throw new settlement.SettlementConflictError('caller prose');
            if (id === 'failure') throw new Error('caller prose');
            return { customer_id: id, status: 'exact' };
        }
    } });
    const server = await new Promise(resolve => { const listening = app.listen(0, () => resolve(listening)); });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const body = { credit_event_id: 'credit', debit_event_id: 'debit', amount: '1.25', idempotency_key: 'allocation' };
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations', undefined, body)).status, 401);
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations', 'viewer', body)).status, 403);
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations', 'farmer', { ...body, created_by_user_id: 'forged' })).status, 400);
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations', 'farmer', { ...body, amount: '1e2' })).status, 400);
    for (const role of ['super_admin', 'admin', 'farmer']) {
        assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations', role, { ...body, idempotency_key: `allocation-${role}` })).status, 201);
    }
    assert.deepEqual([calls[0].amount_minor, calls[0].created_by_user_id], [125, 'session-actor']);
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations', 'farmer', { ...body, credit_event_id: 'bad id' })).status, 400);
    for (const [key, expected] of [['notfound', 404], ['conflict', 409], ['invalid', 400], ['failure', 500]]) {
        const response = await request(server, 'POST', '/api/customer-settlement/allocations', 'farmer', { ...body, idempotency_key: key });
        assert.equal(response.status, expected);
        assert.doesNotMatch(JSON.stringify(response.body), /caller prose|0712345678/i);
    }
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations/allocation:one/reverse', 'farmer', { x: 1 })).status, 400);
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations/bad%20id/reverse', 'farmer', {})).status, 400);
    for (const role of ['super_admin', 'admin', 'farmer']) {
        assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations/allocation:one/reverse', role, {})).status, 200);
    }
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations/allocation:one/reverse', undefined, {})).status, 401);
    assert.equal((await request(server, 'POST', '/api/customer-settlement/allocations/allocation:one/reverse', 'viewer', {})).status, 403);
    for (const [id, expected] of [['missing', 404], ['conflict', 409], ['failure', 500]]) {
        const response = await request(server, 'POST', `/api/customer-settlement/allocations/${id}/reverse`, 'farmer', {});
        assert.equal(response.status, expected);
        assert.doesNotMatch(JSON.stringify(response.body), /caller prose/i);
    }
    assert.equal((await request(server, 'GET', '/api/customers/customer-a/settlement', 'viewer')).status, 403);
    assert.equal((await request(server, 'GET', '/api/customers/customer-a/settlement', undefined)).status, 401);
    assert.equal((await request(server, 'GET', '/api/customers/customer-a/settlement?x=1', 'farmer')).status, 400);
    assert.equal((await request(server, 'GET', '/api/customers/bad%20id/settlement', 'farmer')).status, 400);
    for (const role of ['super_admin', 'admin', 'farmer']) {
        assert.equal((await request(server, 'GET', '/api/customers/customer-a/settlement', role)).status, 200);
    }
    for (const [id, expected] of [['missing', 404], ['conflict', 409], ['failure', 500]]) {
        const response = await request(server, 'GET', `/api/customers/${id}/settlement`, 'farmer');
        assert.equal(response.status, expected);
        assert.doesNotMatch(JSON.stringify(response.body), /caller prose/i);
    }
});
