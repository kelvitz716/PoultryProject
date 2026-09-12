const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const sqlite3 = require('sqlite3').verbose();
const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { SettlementConflictError, SettlementNotFoundError, createCustomer, recordCustomerAccountEvent, recordCustomerAccountEventWithAdapter, recordCustomerRefund, allocateCustomerCredit, reverseCustomerAllocation, eventPosition, customerPosition } = require('../../services/customer-settlement');
const { createCustomerRecord, updateCustomerRecord, deactivateCustomer, getCustomer, listCustomers } = require('../../services/customer-registry');
function open(file) { return new Promise((r, j) => { const db = new sqlite3.Database(file, e => e ? j(e) : r(db)); }); }
function run(db, sql, p = []) { return new Promise((r, j) => db.run(sql, p, function (e) { e ? j(e) : r(this); })); }
function get(db, sql, p = []) { return new Promise((r, j) => db.get(sql, p, (e, x) => e ? j(e) : r(x))); }
function all(db, sql, p = []) { return new Promise((r, j) => db.all(sql, p, (e, x) => e ? j(e) : r(x))); }
function close(db) { return new Promise((r, j) => db.close(e => e ? j(e) : r())); }
async function store(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-settlement-')); const file = path.join(dir, 'db.sqlite'); const db = await open(file); await run(db, 'PRAGMA foreign_keys=ON'); await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)'); await migrateCustomerSettlement(db); await migrateCustomerSettlement(db); t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); }); return { db, boundary: createDedicatedTransactionBoundary(file), adapter: { runQuery: (s,p=[])=>run(db,s,p), getQuery:(s,p=[])=>get(db,s,p), allQuery:(s,p=[])=>all(db,s,p) } }; }
const ev = (customer_id, kind, amount_minor, key, extra={}) => ({ customer_id, kind, amount_minor, idempotency_key:key, ...extra });
test('migration is rerunnable, has no raw text, and dedicated boundary rolls back independently', async t => { const s=await store(t); const columns=await all(s.db,'PRAGMA table_info(customer_account_events)'); assert.ok(columns.some(x=>x.name==='payment_import_id')); assert.ok(!columns.some(x=>/raw|sms/i.test(x.name))); await assert.rejects(s.boundary.withDedicatedTransaction(async db=>{await db.runQuery("INSERT INTO customers (id, display_name, normalized_name) VALUES ('x','X','X')"); throw new Error('fail');}),/fail/); assert.equal((await get(s.db,'SELECT COUNT(*) n FROM customers')).n,0); });
test('event wrapper and injected-adapter operation share validation and idempotency behavior', async t => {
    const s = await store(t);
    await createCustomer({ id: 'adapter-customer', display_name: 'Adapter Customer' }, s.boundary);
    const input = ev('adapter-customer', 'invoice', 250, 'adapter-invoice');
    const first = await recordCustomerAccountEvent(input, s.boundary);
    const retry = await s.boundary.withDedicatedTransaction(adapter => recordCustomerAccountEventWithAdapter(input, adapter));
    assert.deepEqual([first.created, retry.created, retry.event.id], [true, false, first.event.id]);
});
test('settles one invoice with four tenders and supports multiple payments or one payment across invoices', async t => { const s=await store(t); await createCustomer({id:'c1',display_name:'Customer One'},s.boundary); const invoice=(await recordCustomerAccountEvent(ev('c1','invoice',1000000,'i1'),s.boundary)).event; const cash=(await recordCustomerAccountEvent(ev('c1','payment',200000,'p1',{method:'cash',external_reference:'cash-1'}),s.boundary)).event; const mpesa=(await recordCustomerAccountEvent(ev('c1','payment',300000,'p2',{method:'mpesa',external_reference:'mp-1'}),s.boundary)).event; const bank=(await recordCustomerAccountEvent(ev('c1','payment',400000,'p3',{method:'bank',external_reference:'bank-1'}),s.boundary)).event; const note=(await recordCustomerAccountEvent(ev('c1','credit_note',100000,'n1',{original_event_id:invoice.id,reason_code:'return'}),s.boundary)).event; for(const [x,n] of [[cash,'a1'],[mpesa,'a2'],[bank,'a3'],[note,'a4']]) await allocateCustomerCredit({credit_event_id:x.id,debit_event_id:invoice.id,amount_minor:x.amount_minor,idempotency_key:n},s.boundary); assert.deepEqual(await eventPosition(invoice.id,s.adapter),{event_id:invoice.id,side:'debit',amount_minor:1000000,allocated_minor:1000000,remaining_minor:0,status:'settled'}); const oneInvoice=(await recordCustomerAccountEvent(ev('c1','invoice',60000,'i-multi'),s.boundary)).event; const mp1=(await recordCustomerAccountEvent(ev('c1','payment',30000,'p-multi-1',{method:'mpesa',external_reference:'mp-multi-1'}),s.boundary)).event; const mp2=(await recordCustomerAccountEvent(ev('c1','payment',30000,'p-multi-2',{method:'mpesa',external_reference:'mp-multi-2'}),s.boundary)).event; await allocateCustomerCredit({credit_event_id:mp1.id,debit_event_id:oneInvoice.id,amount_minor:30000,idempotency_key:'a-multi-1'},s.boundary); await allocateCustomerCredit({credit_event_id:mp2.id,debit_event_id:oneInvoice.id,amount_minor:30000,idempotency_key:'a-multi-2'},s.boundary); assert.equal((await eventPosition(oneInvoice.id,s.adapter)).status,'settled'); const i2=(await recordCustomerAccountEvent(ev('c1','invoice',50000,'i2'),s.boundary)).event; const i3=(await recordCustomerAccountEvent(ev('c1','invoice',50000,'i3'),s.boundary)).event; const p=(await recordCustomerAccountEvent(ev('c1','payment',100000,'p4',{method:'mpesa',external_reference:'mp-2'}),s.boundary)).event; await allocateCustomerCredit({credit_event_id:p.id,debit_event_id:i2.id,amount_minor:50000,idempotency_key:'a5'},s.boundary); await allocateCustomerCredit({credit_event_id:p.id,debit_event_id:i3.id,amount_minor:50000,idempotency_key:'a6'},s.boundary); assert.equal((await eventPosition(p.id,s.adapter)).status,'settled'); });
test('underpayment, overpayment, refund and reversed allocation compute exact positions', async t => { const s=await store(t); await createCustomer({id:'c1',display_name:'Customer'},s.boundary); const invoice=(await recordCustomerAccountEvent(ev('c1','invoice',10000,'i'),s.boundary)).event; const payment=(await recordCustomerAccountEvent(ev('c1','payment',15000,'p',{method:'mpesa',external_reference:'receipt'}),s.boundary)).event; const a=(await allocateCustomerCredit({credit_event_id:payment.id,debit_event_id:invoice.id,amount_minor:6000,idempotency_key:'a'},s.boundary)).allocation; assert.equal((await eventPosition(invoice.id,s.adapter)).remaining_minor,4000); await allocateCustomerCredit({credit_event_id:payment.id,debit_event_id:invoice.id,amount_minor:4000,idempotency_key:'b'},s.boundary); assert.equal((await customerPosition('c1',s.adapter)).available_credit_minor,5000); const note=(await recordCustomerAccountEvent(ev('c1','credit_note',2000,'n',{original_event_id:invoice.id,reason_code:'return'}),s.boundary)).event; const refund=(await recordCustomerRefund({customer_id:'c1',amount_minor:7000,idempotency_key:'r',method:'cash',sources:[{credit_event_id:payment.id,amount_minor:5000},{credit_event_id:note.id,amount_minor:2000}]},s.boundary)).event; await assert.rejects(allocateCustomerCredit({credit_event_id:payment.id,debit_event_id:refund.id,amount_minor:1,idempotency_key:'e'},s.boundary),SettlementConflictError); await reverseCustomerAllocation({id:a.id,reversed_by_user_id:'reviewer'},s.boundary); assert.deepEqual([(await eventPosition(invoice.id,s.adapter)).remaining_minor,(await eventPosition(payment.id,s.adapter)).remaining_minor],[6000,6000]); });
test('enforces side/customer/reference/import/idempotency constraints and concurrent allocation capacity', async t => { const s=await store(t); await createCustomer({id:'c1',display_name:'A'},s.boundary); await createCustomer({id:'c2',display_name:'B'},s.boundary); await run(s.db,"INSERT INTO payment_imports (id) VALUES ('import-1')"); const d=(await recordCustomerAccountEvent(ev('c1','invoice',100,'i'),s.boundary)).event; const c=(await recordCustomerAccountEvent(ev('c1','payment',100,'p',{method:'mpesa',external_reference:'same',payment_import_id:'import-1'}),s.boundary)).event; const other=(await recordCustomerAccountEvent(ev('c2','invoice',100,'i2'),s.boundary)).event; await assert.rejects(recordCustomerAccountEvent(ev('c1','payment',1,'pdup',{method:'mpesa',external_reference:'same'}),s.boundary),/UNIQUE|constraint/); await assert.rejects(recordCustomerAccountEvent(ev('c1','payment',1,'pimport',{method:'mpesa',external_reference:'other',payment_import_id:'import-1'}),s.boundary),/UNIQUE|constraint/); await assert.rejects(recordCustomerAccountEvent(ev('c1','invoice',1,'usd',{currency:'USD'}),s.boundary),/KES/); await assert.rejects(allocateCustomerCredit({credit_event_id:c.id,debit_event_id:other.id,amount_minor:1,idempotency_key:'x'},s.boundary),SettlementConflictError); await assert.rejects(allocateCustomerCredit({credit_event_id:d.id,debit_event_id:other.id,amount_minor:1,idempotency_key:'side'},s.boundary),SettlementConflictError); const results=await Promise.allSettled([60,60].map((n,i)=>allocateCustomerCredit({credit_event_id:c.id,debit_event_id:d.id,amount_minor:n,idempotency_key:`con${i}`},s.boundary))); assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal((await eventPosition(d.id,s.adapter)).allocated_minor,60); const winner=await get(s.db,"SELECT idempotency_key FROM customer_account_allocations WHERE status='active'"); const again=await allocateCustomerCredit({credit_event_id:c.id,debit_event_id:d.id,amount_minor:60,idempotency_key:winner.idempotency_key},s.boundary); assert.equal(again.created,false); });

test('stable IDs allow same names; idempotency and method-scoped references retain material evidence', async t => {
    const s = await store(t);
    await createCustomer({ id: 'same-1', display_name: 'Same Name' }, s.boundary);
    await createCustomer({ id: 'same-2', display_name: 'Same Name' }, s.boundary);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customers WHERE normalized_name = ?', ['SAME NAME'])).n, 2);

    const first = await recordCustomerAccountEvent(ev('same-1', 'payment', 100, 'idempotent-payment', {
        method: 'mpesa', external_reference: 'abc123def'
    }), s.boundary);
    const retry = await recordCustomerAccountEvent(ev('same-1', 'payment', 100, 'idempotent-payment', {
        method: 'mpesa', external_reference: 'ABC123DEF'
    }), s.boundary);
    assert.equal(retry.created, false);
    await assert.rejects(recordCustomerAccountEvent(ev('same-1', 'payment', 200, 'idempotent-payment', {
        method: 'mpesa', external_reference: 'ABC123DEF'
    }), s.boundary), SettlementConflictError);
    await recordCustomerAccountEvent(ev('same-1', 'payment', 100, 'cash-ref', {
        method: 'cash', external_reference: 'shared-label'
    }), s.boundary);
    await recordCustomerAccountEvent(ev('same-1', 'payment', 100, 'bank-ref', {
        method: 'bank', external_reference: 'shared-label'
    }), s.boundary);
    assert.equal(first.event.external_reference, 'ABC123DEF');
});

test('draft events are explicitly non-allocatable and malformed/raw storage is absent', async t => {
    const s = await store(t);
    const logs = []; const originalLog = console.log; const originalError = console.error;
    console.log = (...values) => logs.push(values.join(' ')); console.error = (...values) => logs.push(values.join(' '));
    try { await createCustomer({ id: 'draft-customer', display_name: 'Draft Customer' }, s.boundary); } finally { console.log = originalLog; console.error = originalError; }
    const draft = (await recordCustomerAccountEvent(ev('draft-customer', 'invoice', 100, 'draft', { status: 'draft' }), s.boundary)).event;
    assert.deepEqual(await eventPosition(draft.id, s.adapter), {
        event_id: draft.id, side: 'debit', amount_minor: 100, allocated_minor: 0, remaining_minor: 0, status: 'draft'
    });
    const schema = JSON.stringify(await all(s.db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'customer_%'"));
    assert.doesNotMatch(schema, /raw.*sms|raw.*text/i);
    assert.equal(logs.join('\n'), '');
});

test('migration upgrades a prior event table with missing provenance columns', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-settlement-upgrade-'));
    const db = await open(path.join(dir, 'upgrade.sqlite'));
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL, created_by_user_id TEXT, created_at DATETIME, updated_at DATETIME)');
    await run(db, 'CREATE TABLE customer_account_events (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, currency TEXT NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT, external_reference TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_by_user_id TEXT, created_at DATETIME, posted_at DATETIME, reversed_at DATETIME)');
    await migrateCustomerSettlement(db);
    const names = (await all(db, 'PRAGMA table_info(customer_account_events)')).map(column => column.name);
    assert.deepEqual(['payment_import_id', 'source_transaction_id', 'original_event_id', 'reviewer_user_id'].every(name => names.includes(name)), true);
    await assert.rejects(run(db, "INSERT INTO customer_account_events (id, customer_id, currency, side, kind, status, amount_minor, method, payment_import_id, idempotency_key) VALUES ('bad-provenance', 'c', 'KES', 'credit', 'payment', 'posted', 1, 'cash', 'import-1', 'bad')"), /invalid customer event provenance/);
});

test('compound refunds are atomic, idempotent, and reject unsafe standalone refund or payment reversal', async t => {
    const s = await store(t);
    await createCustomer({ id: 'refund-customer', display_name: 'Refund Customer' }, s.boundary);
    const payment = (await recordCustomerAccountEvent(ev('refund-customer', 'payment', 500, 'refund-payment', { method: 'cash', external_reference: 'cash-1' }), s.boundary)).event;
    await assert.rejects(recordCustomerAccountEvent(ev('refund-customer', 'refund', 1, 'unsafe-refund', { method: 'cash' }), s.boundary), /recordCustomerRefund/);
    await assert.rejects(recordCustomerAccountEvent(ev('refund-customer', 'payment_reversal', 1, 'unsafe-reversal', { original_event_id: payment.id }), s.boundary), /deferred/);
    const refund = await recordCustomerRefund({ customer_id: 'refund-customer', amount_minor: 300, method: 'cash', idempotency_key: 'refund-1', sources: [{ credit_event_id: payment.id, amount_minor: 300 }] }, s.boundary);
    const retry = await recordCustomerRefund({ customer_id: 'refund-customer', amount_minor: 300, method: 'cash', idempotency_key: 'refund-1', sources: [{ credit_event_id: payment.id, amount_minor: 300 }] }, s.boundary);
    assert.deepEqual([refund.created, retry.created, (await eventPosition(payment.id, s.adapter)).remaining_minor], [true, false, 200]);
    await assert.rejects(recordCustomerRefund({ customer_id: 'refund-customer', amount_minor: 300, method: 'cash', idempotency_key: 'refund-too-much', sources: [{ credit_event_id: payment.id, amount_minor: 300 }] }, s.boundary), SettlementConflictError);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = "refund"')).n, 1);
});

test('credit note needs a posted original and invoice source transactions are unique', async t => {
    const s = await store(t);
    await createCustomer({ id: 'invoice-customer', display_name: 'Invoice Customer' }, s.boundary);
    const draft = (await recordCustomerAccountEvent(ev('invoice-customer', 'invoice', 100, 'draft-invoice', { status: 'draft', source_transaction_id: 'sale-1' }), s.boundary)).event;
    await assert.rejects(recordCustomerAccountEvent(ev('invoice-customer', 'credit_note', 1, 'draft-note', { original_event_id: draft.id, reason_code: 'return' }), s.boundary), SettlementConflictError);
    await assert.rejects(recordCustomerAccountEvent(ev('invoice-customer', 'invoice', 100, 'duplicate-source', { source_transaction_id: 'sale-1' }), s.boundary), /UNIQUE|constraint/);
});

test('refund sources are unique payment or credit-note credits and retries preserve all evidence', async t => {
    const s = await store(t);
    await createCustomer({ id: 'refund-source-customer', display_name: 'Refund Sources' }, s.boundary);
    const payment = (await recordCustomerAccountEvent(ev('refund-source-customer', 'payment', 500, 'payment-source', { method: 'mpesa', external_reference: 'ref-1' }), s.boundary)).event;
    const invoice = (await recordCustomerAccountEvent(ev('refund-source-customer', 'invoice', 100, 'source-invoice'), s.boundary)).event;
    const note = (await recordCustomerAccountEvent(ev('refund-source-customer', 'credit_note', 100, 'source-note', { original_event_id: invoice.id, reason_code: 'return' }), s.boundary)).event;
    const writeOff = (await recordCustomerAccountEvent(ev('refund-source-customer', 'write_off', 50, 'source-writeoff'), s.boundary)).event;
    await assert.rejects(recordCustomerRefund({ customer_id: 'refund-source-customer', amount_minor: 200, method: 'cash', idempotency_key: 'duplicate-source', sources: [{ credit_event_id: payment.id, amount_minor: 100 }, { credit_event_id: payment.id, amount_minor: 100 }] }, s.boundary), /must not repeat/);
    await assert.rejects(recordCustomerRefund({ customer_id: 'refund-source-customer', amount_minor: 50, method: 'cash', idempotency_key: 'writeoff-source', sources: [{ credit_event_id: writeOff.id, amount_minor: 50 }] }, s.boundary), SettlementConflictError);
    await recordCustomerRefund({ customer_id: 'refund-source-customer', amount_minor: 200, method: 'cash', external_reference: 'cash-ref', created_by_user_id: 'creator', reviewer_user_id: 'reviewer', idempotency_key: 'evidence-refund', sources: [{ credit_event_id: payment.id, amount_minor: 100 }, { credit_event_id: note.id, amount_minor: 100 }] }, s.boundary);
    await assert.rejects(recordCustomerRefund({ customer_id: 'refund-source-customer', amount_minor: 200, method: 'cash', external_reference: 'changed', created_by_user_id: 'creator', reviewer_user_id: 'reviewer', idempotency_key: 'evidence-refund', sources: [{ credit_event_id: payment.id, amount_minor: 100 }, { credit_event_id: note.id, amount_minor: 100 }] }, s.boundary), SettlementConflictError);
});

test('customer position uses one read snapshot and preserves not-found behavior', async t => {
    const s = await store(t);
    await createCustomer({ id: 'snapshot-customer', display_name: 'Snapshot Customer' }, s.boundary);
    await recordCustomerAccountEvent(ev('snapshot-customer', 'invoice', 250, 'snapshot-invoice'), s.boundary);
    const calls = [];
    const inspected = {
        getQuery: async (sql, params) => { calls.push({ sql, params }); return s.adapter.getQuery(sql, params); },
        allQuery: async () => { throw new Error('customerPosition must not issue an allQuery'); },
        runQuery: s.adapter.runQuery
    };
    assert.deepEqual(await customerPosition('snapshot-customer', inspected), {
        customer_id: 'snapshot-customer', currency: 'KES', outstanding_debit_minor: 250, available_credit_minor: 0, net_minor: -250
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /requested_customer/);
    await assert.rejects(customerPosition('missing-customer', inspected), SettlementNotFoundError);
});

test('allocation idempotency preserves original creator provenance across a different-actor retry', async t => {
    const s = await store(t);
    await createCustomer({ id: 'creator-customer', display_name: 'Creator Customer' }, s.boundary);
    const invoice = (await recordCustomerAccountEvent(ev('creator-customer', 'invoice', 100, 'creator-invoice'), s.boundary)).event;
    const payment = (await recordCustomerAccountEvent(ev('creator-customer', 'payment', 100, 'creator-payment', { method: 'cash', external_reference: 'creator-cash' }), s.boundary)).event;
    const input = { credit_event_id: payment.id, debit_event_id: invoice.id, amount_minor: 100, idempotency_key: 'creator-allocation', created_by_user_id: 'creator-a' };
    assert.equal((await allocateCustomerCredit(input, s.boundary)).created, true);
    assert.equal((await allocateCustomerCredit(input, s.boundary)).created, false);
    const retry = await allocateCustomerCredit({ ...input, created_by_user_id: 'creator-b' }, s.boundary);
    assert.deepEqual([retry.created, retry.allocation.created_by_user_id], [false, 'creator-a']);
});

test('customer registry preserves same names, retries safely, and deactivates without deleting', async t => {
    const s = await store(t);
    const input = { display_name: 'Named Customer', payment_terms_days: 14, contact_phone: '0712 345 678', created_by_user_id: 'farmer-1', idempotency_key: 'customer-create' };
    const first = await createCustomerRecord(input, s.boundary);
    const retry = await createCustomerRecord(input, s.boundary);
    assert.deepEqual([first.idempotent, retry.idempotent, first.customer.contact_phone], [false, true, '+254712345678']);
    await assert.rejects(createCustomerRecord({ ...input, display_name: 'Changed Name' }, s.boundary), SettlementConflictError);
    const sameName = await createCustomerRecord({ ...input, idempotency_key: 'customer-create-2' }, s.boundary);
    assert.notEqual(first.customer.id, sameName.customer.id);
    await deactivateCustomer({ id: first.customer.id, updated_by_user_id: 'farmer-1', idempotency_key: 'customer-deactivate' }, s.boundary);
    assert.equal((await getCustomer(first.customer.id, s.adapter)).is_active, 0);
    assert.equal((await listCustomers({}, s.adapter)).some(customer => customer.id === first.customer.id), false);
    assert.equal((await listCustomers({ include_inactive: true }, s.adapter)).some(customer => customer.id === first.customer.id), true);
    await assert.rejects(updateCustomerRecord({ id: sameName.customer.id, updated_by_user_id: 'farmer-1', payment_terms_days: 366, idempotency_key: 'bad-terms' }, s.boundary), /between/);
});

test('registry create is concurrent-idempotent and validates active and reserved names', async t => {
    const s = await store(t);
    const input={display_name:'Concurrent Customer',created_by_user_id:'farmer-1',idempotency_key:'concurrent-customer'};
    const results=await Promise.all([createCustomerRecord(input,s.boundary),createCustomerRecord(input,s.boundary)]);
    assert.deepEqual(results.map(x=>x.idempotent).sort(),[false,true]);
    await assert.rejects(updateCustomerRecord({id:results[0].customer.id,updated_by_user_id:'farmer-1',idempotency_key:'bad-active',is_active:'false'},s.boundary),/boolean/);
    await assert.rejects(createCustomerRecord({display_name:'  walk-in   customer ',created_by_user_id:'farmer-1',idempotency_key:'walkin'},s.boundary),/reserved/);
});

test('registry operation-record failure rolls back the customer mutation', async t => {
    const s = await store(t);
    const failingBoundary = {
        withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(async db => work({
            ...db,
            runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO customer_registry_operations')) {
                    throw new Error('injected operation record failure');
                }
                return db.runQuery(sql, params);
            }
        }))
    };

    await assert.rejects(createCustomerRecord({
        display_name: 'Rollback Customer',
        created_by_user_id: 'farmer-1',
        idempotency_key: 'rollback-customer'
    }, failingBoundary), /injected operation record failure/);

    assert.equal((await get(s.db,
        'SELECT COUNT(*) AS n FROM customers WHERE display_name = ?',
        ['Rollback Customer'])).n, 0);
    assert.equal((await get(s.db,
        'SELECT COUNT(*) AS n FROM customer_registry_operations WHERE idempotency_key = ?',
        ['rollback-customer'])).n, 0);
});

test('registry original partial-patch retry returns its immutable operation snapshot', async t => {
    const s = await store(t);
    const created = await createCustomerRecord({
        display_name: 'Snapshot Customer',
        created_by_user_id: 'farmer-1',
        idempotency_key: 'snapshot-create'
    }, s.boundary);
    const originalPatch = {
        id: created.customer.id,
        updated_by_user_id: 'farmer-1',
        payment_terms_days: 14,
        idempotency_key: 'snapshot-original-patch'
    };
    const original = await updateCustomerRecord(originalPatch, s.boundary);
    await updateCustomerRecord({
        id: created.customer.id,
        updated_by_user_id: 'farmer-1',
        contact_phone: '0712 345 678',
        idempotency_key: 'snapshot-later-patch'
    }, s.boundary);

    const retried = await updateCustomerRecord(originalPatch, s.boundary);
    const current = await getCustomer(created.customer.id, s.adapter);

    assert.equal(retried.idempotent, true);
    assert.deepEqual(retried.customer, original.customer);
    assert.equal(retried.customer.contact_phone, null);
    assert.equal(current.contact_phone, '+254712345678');
});

test('registry migration upgrade preserves operation rows and supplies JSON snapshots', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-registry-upgrade-'));
    const db = await open(path.join(dir, 'upgrade.sqlite'));
    t.after(async () => { await close(db); fs.rmSync(dir, { recursive: true, force: true }); });
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, `CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        created_by_user_id TEXT,
        created_at DATETIME,
        updated_at DATETIME
    )`);
    await run(db, `CREATE TABLE customer_registry_operations (
        idempotency_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `INSERT INTO customers (id, display_name, normalized_name)
        VALUES ('legacy-customer', 'Legacy Customer', 'LEGACY CUSTOMER')`);
    await run(db, `INSERT INTO customer_registry_operations
        (idempotency_key, operation, customer_id, fingerprint)
        VALUES ('legacy-operation', 'create', 'legacy-customer', 'legacy-fingerprint')`);

    await migrateCustomerSettlement(db);

    const upgraded = await get(db, `SELECT idempotency_key, customer_id, result_snapshot
        FROM customer_registry_operations WHERE idempotency_key = ?`, ['legacy-operation']);
    assert.deepEqual([upgraded.idempotency_key, upgraded.customer_id], ['legacy-operation', 'legacy-customer']);
    assert.doesNotThrow(() => JSON.parse(upgraded.result_snapshot));

    const boundary = createDedicatedTransactionBoundary(path.join(dir, 'upgrade.sqlite'));
    const created = await createCustomerRecord({
        display_name: 'New Customer',
        created_by_user_id: 'admin-1',
        idempotency_key: 'new-operation'
    }, boundary);
    const stored = await get(db, 'SELECT result_snapshot FROM customer_registry_operations WHERE idempotency_key = ?', ['new-operation']);
    assert.deepEqual(JSON.parse(stored.result_snapshot), created.customer);
});
