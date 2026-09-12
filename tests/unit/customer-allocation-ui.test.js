const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.textContent = ''; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) {
        this.children = children;
        // Match a browser select losing its current selected option while its
        // options are rebuilt, so restoration is exercised rather than implied.
        if (this.tagName === 'select') this.value = '';
    }
}

const fakeDocument = { createElement: tagName => new FakeElement(tagName) };
const model = import('../../js/customer-allocation-ui-model.mjs');
const timelineModel = import('../../js/customer-settlement-timeline-model.mjs');

function customer(active = true) {
    return { id: 'customer:one', display_name: '<img src=x onerror=alert(1)>', is_active: active };
}

function snapshot(overrides = {}) {
    return {
        customer_id: 'customer:one', currency: 'KES', status: 'exact',
        events: [
            { id: 'payment:cash', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', status: 'open', method: 'cash', external_reference: 'CASH-1', remaining_minor: 1012 },
            { id: 'credit-note:one', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'credit_note', status: 'part-paid', method: null, external_reference: 'CN-1', remaining_minor: 29 },
            { id: 'invoice:one', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'invoice', status: 'part-paid', external_reference: 'INV-1', remaining_minor: 1012 },
            { id: 'invoice:two', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'invoice', status: 'open', external_reference: 'INV-2', remaining_minor: 7 },
            { id: 'payment:settled', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', status: 'settled', remaining_minor: 0 },
            { id: 'refund:one', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'refund', status: 'open', remaining_minor: 100 }
        ],
        ...overrides
    };
}

const exactSuggestions = { status: 'exact', suggestions: [{ credit_event_id: 'payment:cash', debit_event_id: 'invoice:one', amount_minor: 1012, reason_code: 'exact_remaining_match' }] };

test('allocation choices use only current exact stable-customer payment/credit-note capacity and invoice deficits', async () => {
    const { allocationCandidates, appendAllocationOptions } = await model;
    const candidates = allocationCandidates(customer(), snapshot(), exactSuggestions);
    assert.equal(candidates.available, true);
    assert.deepEqual(candidates.credits.map(row => [row.id, row.remaining_minor]), [['payment:cash', 1012], ['credit-note:one', 29]]);
    assert.deepEqual(candidates.debits.map(row => [row.id, row.remaining_minor]), [['invoice:one', 1012], ['invoice:two', 7]]);
    assert.match(candidates.credits[0].label, /payment.*cash.*ID payment:cash.*KES 10\.12/);
    assert.equal(allocationCandidates(customer(false), snapshot(), exactSuggestions).available, false);
    assert.equal(allocationCandidates(customer(), snapshot({ status: 'reconciliation_required' }), exactSuggestions).available, false);
    assert.equal(allocationCandidates(customer(), snapshot(), { status: 'reconciliation_required' }).available, false);
    assert.equal(allocationCandidates(customer(), snapshot({ customer_id: 'customer:two' }), exactSuggestions).available, false);

    const select = new FakeElement('select');
    appendAllocationOptions(select, candidates.credits, 'Select credit', fakeDocument);
    assert.deepEqual(select.children.map(option => option.value), ['', 'payment:cash', 'credit-note:one']);
    assert.match(select.children[1].textContent, /payment/);
    assert.equal(Object.hasOwn(select, 'innerHTML'), false);
});

test('availability rerenders preserve an eligible uncertain allocation draft and freeze both financial forms', async () => {
    const { appendAllocationOptions, allocationDraft, createAllocationRetryTracker } = await model;
    const { customerFinancialFormAvailability } = await timelineModel;
    const candidates = (await model).allocationCandidates(customer(), snapshot(), exactSuggestions);
    const credit = new FakeElement('select');
    const invoice = new FakeElement('select');
    appendAllocationOptions(credit, candidates.credits, 'Select credit', fakeDocument);
    appendAllocationOptions(invoice, candidates.debits, 'Select invoice', fakeDocument);
    credit.value = 'payment:cash';
    invoice.value = 'invoice:one';
    const draftFields = { amount: '10.12', confirmed: true };

    // This is the same helper called by renderAllocationChoices before and
    // after an uncertain request. It must not erase the selected pair or the
    // untouched amount/confirmation controls in the form.
    appendAllocationOptions(credit, candidates.credits, 'Select credit', fakeDocument);
    appendAllocationOptions(invoice, candidates.debits, 'Select invoice', fakeDocument);
    assert.equal(credit.value, 'payment:cash');
    assert.equal(invoice.value, 'invoice:one');
    assert.deepEqual(draftFields, { amount: '10.12', confirmed: true });
    const draft = allocationDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        creditEventId: credit.value, debitEventId: invoice.value, ...draftFields
    });
    let keyCount = 0;
    const retries = createAllocationRetryTracker(() => `customer-allocation:retry-${++keyCount}`);
    const originalKey = retries.keyFor(draft);
    retries.retainUncertain(draft, originalKey);
    const retryDraft = allocationDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        creditEventId: credit.value, debitEventId: invoice.value, ...draftFields
    });
    assert.equal(retries.keyFor(retryDraft), originalKey);

    const allocationPending = customerFinancialFormAvailability({
        customer: customer(), allocationAvailable: true, settlementLoading: false,
        receiptPending: false, allocationPending: true
    });
    assert.deepEqual(allocationPending, { receiptEnabled: false, allocationEnabled: false, reversalEnabled: false, creditNoteEnabled: false, refundEnabled: false, identityEnabled: false });
    const receiptPending = customerFinancialFormAvailability({
        customer: customer(), allocationAvailable: true, settlementLoading: false,
        receiptPending: true, allocationPending: false
    });
    assert.deepEqual(receiptPending, { receiptEnabled: false, allocationEnabled: false, reversalEnabled: false, creditNoteEnabled: false, refundEnabled: false, identityEnabled: false });
    assert.deepEqual(customerFinancialFormAvailability({
        customer: customer(), allocationAvailable: true, settlementLoading: false,
        receiptPending: false, allocationPending: false
    }), { receiptEnabled: true, allocationEnabled: true, reversalEnabled: true, creditNoteEnabled: true, refundEnabled: true, identityEnabled: true });
});

test('allocation draft enforces exact KES, displayed dual-side capacity, and explicit confirmation without auto-applying a suggestion', async () => {
    const { allocationDraft } = await model;
    for (const [amount, minor, credit, debit] of [
        ['0.07', 7, 'payment:cash', 'invoice:two'],
        ['0.29', 29, 'credit-note:one', 'invoice:one'],
        ['10.12', 1012, 'payment:cash', 'invoice:one']
    ]) {
        const draft = allocationDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
            creditEventId: credit, debitEventId: debit, amount, confirmed: true });
        assert.deepEqual([draft.credit_event_id, draft.debit_event_id, draft.amount_minor], [credit, debit, minor]);
    }
    for (const input of [
        { amount: '10.13' }, { amount: '1.234' }, { amount: '1e2' }, { amount: '1,000.00' },
        { amount: '0.00' }, { creditEventId: 'payment:settled' }, { debitEventId: 'refund:one' }, { confirmed: false }
    ]) assert.throws(() => allocationDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        creditEventId: 'payment:cash', debitEventId: 'invoice:one', amount: '10.12', confirmed: true, ...input
    }), error => error instanceof TypeError || error instanceof RangeError);
});

test('allocation retry keys and identity lock preserve an uncertain exact draft through a customer/snapshot race', async () => {
    const { createAllocationRetryTracker, createAllocationIdentityLock, allocationDraft, allocationResponseIsCurrent } = await model;
    const draft = allocationDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        creditEventId: 'payment:cash', debitEventId: 'invoice:one', amount: '10.12', confirmed: true });
    let sequence = 0;
    const tracker = createAllocationRetryTracker(() => `customer-allocation:key-${++sequence}`);
    const first = tracker.keyFor(draft);
    const lock = createAllocationIdentityLock();
    lock.begin();
    let selected = 'customer:one';
    for (const attempted of ['customer:two', 'customer:one']) if (lock.canChange()) selected = attempted;
    assert.equal(selected, 'customer:one');
    tracker.retainUncertain(draft, first);
    assert.equal(tracker.keyFor(draft), first);
    lock.finish();
    assert.equal(tracker.keyFor({ ...draft, amount: '10.11' }), 'customer-allocation:key-2');
    const submitted = { customerId: 'customer:one', selectionVersion: 2, snapshotVersion: 3, requestVersion: 4 };
    assert.equal(allocationResponseIsCurrent(submitted, submitted), true);
    assert.equal(allocationResponseIsCurrent(submitted, { ...submitted, snapshotVersion: 4 }), false);
    assert.equal(allocationResponseIsCurrent(submitted, { ...submitted, customerId: 'customer:two' }), false);
});

test('allocation response must prove complete immutable active allocation evidence before success', async () => {
    const { validAllocationResponse } = await model;
    const draft = { credit_event_id: 'payment:cash', debit_event_id: 'invoice:one', amount: '10.12', amount_minor: 1012, idempotency_key: 'customer-allocation:key' };
    const good = {
        created: true,
        allocation: {
            id: `allocation:${'a'.repeat(40)}`, credit_event_id: draft.credit_event_id, debit_event_id: draft.debit_event_id,
            amount_minor: 1012, idempotency_key: draft.idempotency_key, status: 'active', created_by_user_id: 'session-actor',
            created_at: '2026-09-09T10:11:12.123Z', reversed_by_user_id: null, reversed_at: null
        }
    };
    assert.equal(validAllocationResponse(good, draft), true);
    for (const malformed of [
        {}, { ...good, created: 'true' }, { ...good, allocation: { ...good.allocation, amount_minor: 1013 } },
        { ...good, allocation: { ...good.allocation, status: 'reversed' } },
        { ...good, allocation: { ...good.allocation, idempotency_key: 'other' } },
        { ...good, allocation: { ...good.allocation, created_by_user_id: '<unsafe>' } },
        { ...good, allocation: { ...good.allocation, created_at: 'not-a-time' } }
    ]) assert.equal(validAllocationResponse(malformed, draft), false);
});

test('allocation API is exact-shaped and Customer Accounts remains roles-safe with no other financial action calls', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 201, json: async () => ({ created: true, allocation: {} }) };
    };
    try {
        const { api } = await import('../../js/api.js');
        await api.allocateCustomerCredit({ credit_event_id: 'payment:cash', debit_event_id: 'invoice:one', amount: '10.12', idempotency_key: 'allocation:key' });
        assert.deepEqual(calls, [{
            url: '/api/customer-settlement/allocations',
            options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credit_event_id: 'payment:cash', debit_event_id: 'invoice:one', amount: '10.12', idempotency_key: 'allocation:key' }) }
        }]);
    } finally { global.fetch = originalFetch; }
    const { canAccessCustomerSettlement } = await timelineModel;
    assert.equal(canAccessCustomerSettlement('viewer'), false);
    for (const role of ['super_admin', 'admin', 'farmer']) assert.equal(canAccessCustomerSettlement(role), true);
    const root = path.join(__dirname, '..', '..');
    const view = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline.js'), 'utf8');
    const allocationSource = fs.readFileSync(path.join(root, 'js', 'customer-allocation-ui-model.mjs'), 'utf8');
    const handler = view.slice(view.indexOf('async function submitCustomerAllocation(event)'), view.indexOf('function receiptErrorMessage'));
    assert.match(handler, /allocateCustomerCredit/);
    assert.match(handler, /validAllocationResponse/);
    assert.match(handler, /allocationIdentityLock/);
    assert.doesNotMatch(handler, /reverseCustomerAllocation|issueCustomerCreditNote|recordCustomerRefund|saveTransaction|recordManualCustomerReceipt/i);
    assert.doesNotMatch(allocationSource, /localStorage|sessionStorage|indexedDB|console\.|innerHTML/);
});
