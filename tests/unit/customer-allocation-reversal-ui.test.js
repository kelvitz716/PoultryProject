const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.textContent = ''; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) {
        this.children = children;
        if (this.tagName === 'select') this.value = '';
    }
}

const fakeDocument = { createElement: tagName => new FakeElement(tagName) };
const model = import('../../js/customer-allocation-reversal-ui-model.mjs');
const timelineModel = import('../../js/customer-settlement-timeline-model.mjs');

function customer(active = true) {
    return { id: 'customer:one', display_name: '<img src=x onerror=alert(1)>', is_active: active };
}

function snapshot(overrides = {}) {
    return {
        customer_id: 'customer:one', currency: 'KES', status: 'exact',
        events: [
            { id: 'payment:one', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', external_reference: '<b>PAY-1</b>' },
            { id: 'invoice:one', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'invoice', external_reference: '<img src=x>' },
            { id: 'refund:one', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'refund', external_reference: 'REFUND-1' }
        ],
        allocations: [
            {
                id: 'allocation:one', credit_event_id: 'payment:one', debit_event_id: 'invoice:one', amount_minor: 1012,
                idempotency_key: 'allocation-key', created_by_user_id: 'actor-one', created_at: '2026-09-09T10:11:12.123Z',
                status: 'active', reversed_by_user_id: null, reversed_at: null
            },
            {
                id: 'allocation:reversed', credit_event_id: 'payment:one', debit_event_id: 'invoice:one', amount_minor: 7,
                idempotency_key: 'allocation-old', created_by_user_id: 'actor-one', created_at: '2026-09-09T09:11:12.123Z',
                status: 'reversed', reversed_by_user_id: 'actor-two', reversed_at: '2026-09-09 10:11:12'
            },
            {
                id: 'allocation:refund', credit_event_id: 'payment:one', debit_event_id: 'refund:one', amount_minor: 1,
                idempotency_key: 'refund-link', created_by_user_id: 'actor-one', created_at: '2026-09-09T08:11:12.123Z',
                status: 'active', reversed_by_user_id: null, reversed_at: null
            }
        ],
        ...overrides
    };
}

const exactSuggestions = { status: 'exact', suggestions: [] };

test('reversal choices expose only coherent active credit-to-invoice links, including inactive historical customers', async () => {
    const { allocationReversalCandidates, appendAllocationReversalOptions } = await model;
    const candidates = allocationReversalCandidates(customer(), snapshot(), exactSuggestions);
    assert.equal(candidates.available, true);
    assert.deepEqual(candidates.allocations.map(item => item.id), ['allocation:one']);
    assert.match(candidates.allocations[0].label, /payment.*<b>PAY-1<\/b>.*invoice.*<img src=x>.*KES 10\.12/);
    assert.equal(allocationReversalCandidates(customer(false), snapshot(), exactSuggestions).available, true);
    assert.equal(allocationReversalCandidates(customer(), snapshot({ status: 'reconciliation_required' }), exactSuggestions).available, false);
    assert.equal(allocationReversalCandidates(customer(), snapshot(), { status: 'reconciliation_required' }).available, false);
    assert.equal(allocationReversalCandidates(customer(), snapshot({ events: snapshot().events.map(event => event.id === 'invoice:one' ? { ...event, customer_id: 'customer:two' } : event) }), exactSuggestions).available, false);

    const select = new FakeElement('select');
    appendAllocationReversalOptions(select, candidates.allocations, 'Select active allocation', fakeDocument);
    select.value = 'allocation:one';
    appendAllocationReversalOptions(select, candidates.allocations, 'Select active allocation', fakeDocument);
    assert.deepEqual(select.children.map(option => option.value), ['', 'allocation:one']);
    assert.equal(select.value, 'allocation:one');
    assert.equal(Object.hasOwn(select, 'innerHTML'), false);
});

test('reversal draft requires deliberate confirmation and pending state freezes every financial form and identity control', async () => {
    const { allocationReversalDraft, createAllocationReversalIdentityLock } = await model;
    const { customerFinancialFormAvailability } = await timelineModel;
    const draft = allocationReversalDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        allocationId: 'allocation:one', confirmed: true
    });
    assert.equal(draft.id, 'allocation:one');
    assert.throws(() => allocationReversalDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        allocationId: 'allocation:one', confirmed: false
    }), TypeError);
    const lock = createAllocationReversalIdentityLock();
    lock.begin();
    assert.equal(lock.canChange(), false);
    assert.deepEqual(customerFinancialFormAvailability({
        customer: customer(), allocationAvailable: true, settlementLoading: false,
        receiptPending: false, allocationPending: false, reversalPending: true
    }), { receiptEnabled: false, allocationEnabled: false, reversalEnabled: false, creditNoteEnabled: false, refundEnabled: false, identityEnabled: false });
    assert.deepEqual(customerFinancialFormAvailability({
        customer: customer(false), allocationAvailable: true, settlementLoading: false,
        receiptPending: false, allocationPending: false, reversalPending: false, creditNotePending: false
    }), { receiptEnabled: false, allocationEnabled: false, reversalEnabled: true, creditNoteEnabled: true, refundEnabled: true, identityEnabled: true });
    lock.finish();
    assert.equal(lock.canChange(), true);
});

test('reversal success must bind the selected immutable allocation and return a complete reversed shape', async () => {
    const { allocationReversalDraft, validAllocationReversalResponse, allocationReversalResponseIsCurrent } = await model;
    const requested = allocationReversalDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions,
        allocationId: 'allocation:one', confirmed: true
    });
    const good = {
        idempotent: false,
        allocation: {
            ...requested, status: 'reversed', reversed_by_user_id: 'actor-two', reversed_at: '2026-09-09 11:12:13'
        }
    };
    assert.equal(validAllocationReversalResponse(good, requested), true);
    for (const malformed of [
        {}, { ...good, idempotent: 'false' },
        { ...good, allocation: { ...good.allocation, id: 'allocation:other' } },
        { ...good, allocation: { ...good.allocation, amount_minor: 1013 } },
        { ...good, allocation: { ...good.allocation, status: 'active', reversed_by_user_id: null, reversed_at: null } },
        { ...good, allocation: { ...good.allocation, reversed_by_user_id: '<unsafe>' } },
        { ...good, allocation: { ...good.allocation, reversed_at: 'not-a-time' } }
    ]) assert.equal(validAllocationReversalResponse(malformed, requested), false);
    const submitted = { customerId: 'customer:one', selectionVersion: 3, snapshotVersion: 4, requestVersion: 5 };
    assert.equal(allocationReversalResponseIsCurrent(submitted, submitted), true);
    assert.equal(allocationReversalResponseIsCurrent(submitted, { ...submitted, customerId: 'customer:two' }), false);
    assert.equal(allocationReversalResponseIsCurrent(submitted, { ...submitted, snapshotVersion: 5 }), false);
});

test('reversal API encodes the selected ID, sends exactly an empty JSON body, and UI remains read-safe', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
        const { api } = await import('../../js/api.js');
        await api.reverseCustomerAllocation('allocation:one');
        assert.deepEqual(calls, [{
            url: '/api/customer-settlement/allocations/allocation%3Aone/reverse',
            options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        }]);
    } finally { global.fetch = originalFetch; }
    const root = path.join(__dirname, '..', '..');
    const view = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline.js'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'js', 'customer-allocation-reversal-ui-model.mjs'), 'utf8');
    assert.match(view, /reverseCustomerAllocation\(requested\.id\)/);
    assert.match(view, /validAllocationReversalResponse/);
    assert.match(view, /reversalIdentityLock/);
    assert.match(view, /fields\.disabled = !availability\.reversalEnabled/);
    assert.match(view, /if \(state\.reversalPending \|\| state\.receiptPending \|\| state\.allocationPending \|\| state\.creditNotePending \|\| state\.refundPending\) return/);
    assert.match(view, /if \(state\.allocationPending \|\| state\.receiptPending \|\| state\.reversalPending \|\| state\.creditNotePending \|\| state\.refundPending\) return/);
    assert.match(view, /if \(state\.receiptPending \|\| state\.allocationPending \|\| state\.reversalPending \|\| state\.creditNotePending \|\| state\.refundPending\) return/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|innerHTML|delete|saveTransaction|issueCustomerCreditNote|recordCustomerRefund|paymentReversal/i);
});
