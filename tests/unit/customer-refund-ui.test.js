const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.textContent = ''; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}

const model = import('../../js/customer-refund-ui-model.mjs');
const timelineModel = import('../../js/customer-settlement-timeline-model.mjs');

function customer(active = true) { return { id: 'customer:one', display_name: '<img src=x onerror=alert(1)>', is_active: active }; }
function snapshot(overrides = {}) {
    return {
        customer_id: 'customer:one', currency: 'KES', status: 'exact',
        events: [
            { id: 'payment:cash', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', status: 'open', method: 'cash', external_reference: '<b>CASH</b>', amount_minor: 1012, allocated_minor: 0, remaining_minor: 1012 },
            { id: 'payment:mpesa', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', status: 'part-paid', method: 'mpesa', external_reference: 'MPESA-1', amount_minor: 29, allocated_minor: 0, remaining_minor: 29 },
            { id: 'credit-note:one', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'credit_note', status: 'open', method: null, external_reference: 'CN-1', amount_minor: 7, allocated_minor: 0, remaining_minor: 7 },
            { id: 'invoice:one', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'invoice', status: 'open', amount_minor: 100, allocated_minor: 0, remaining_minor: 100 },
            { id: 'refund:old', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'refund', status: 'open', method: 'cash', amount_minor: 50, allocated_minor: 0, remaining_minor: 50 },
            { id: 'payment:draft', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', status: 'draft', method: 'cash', amount_minor: 50, allocated_minor: 0, remaining_minor: 0 }
        ],
        ...overrides
    };
}
const exactSuggestions = { status: 'exact', suggestions: [] };

function sources(rows) { return rows.map(([credit_event_id, amount]) => ({ credit_event_id, amount })); }

function response(draft, overrides = {}) {
    return {
        idempotent: false,
        refund_event_id: `customer-refund:${'a'.repeat(40)}`,
        ledger_transaction_id: `ledger-customer-refund:${'b'.repeat(36)}`,
        amount_minor: draft.amount_minor,
        method: draft.method,
        external_reference: draft.external_reference,
        reason_code: draft.reason_code,
        method_difference: draft.method_difference,
        acknowledge_method_difference: draft.acknowledge_method_difference,
        source_allocations: draft.sources.map((source, index) => ({ credit_event_id: source.credit_event_id, allocation_id: `allocation:${String(index).padStart(40, 'a')}`, amount_minor: source.amount_minor })),
        recorded_at: '2026-09-09T10:11:12.123Z',
        recorded_by_user_id: 'admin-1',
        ...overrides
    };
}

test('admin-only refund choices expose only exact available payment or credit-note evidence, including inactive history', async () => {
    const { canIssueCustomerRefunds, refundCandidates } = await model;
    assert.equal(canIssueCustomerRefunds('super_admin'), true);
    assert.equal(canIssueCustomerRefunds('admin'), true);
    assert.equal(canIssueCustomerRefunds('farmer'), false);
    assert.equal(canIssueCustomerRefunds('viewer'), false);
    const candidates = refundCandidates(customer(), snapshot(), exactSuggestions);
    assert.deepEqual(candidates.sources.map(row => [row.id, row.kind, row.method, row.remaining_minor]), [
        ['payment:cash', 'payment', 'cash', 1012], ['payment:mpesa', 'payment', 'mpesa', 29], ['credit-note:one', 'credit_note', null, 7]
    ]);
    assert.match(candidates.sources[0].label, /<b>CASH<\/b>.*original KES 10\.12.*allocated KES 0\.00.*available KES 10\.12/);
    assert.equal(refundCandidates(customer(false), snapshot(), exactSuggestions).available, true);
    assert.equal(refundCandidates(customer(), snapshot({ status: 'reconciliation_required' }), exactSuggestions).available, false);
    assert.equal(refundCandidates(customer(), snapshot(), { status: 'reconciliation_required' }).available, false);
    assert.equal(refundCandidates(customer(), snapshot({ events: snapshot().events.map(event => event.id === 'payment:cash' ? { ...event, remaining_minor: 1011 } : event) }), exactSuggestions).available, false);
});

test('refund draft enforces exact source caps/totals, method reference/reason rules, and mismatch acknowledgement', async () => {
    const { refundPreview, refundDraft, refundAcknowledgementState, refundPreviewText } = await model;
    for (const [amount, rows] of [
        ['0.07', sources([['credit-note:one', '0.07']])],
        ['0.29', sources([['payment:mpesa', '0.29']])],
        ['10.12', sources([['payment:cash', '10.12']])]
    ]) {
        const preview = refundPreview({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, method: 'cash', amount, sources: rows, reasonCode: 'other', externalReference: null });
        assert.equal(preview.amount_minor, Math.round(Number(amount) * 100));
    }
    const multi = refundPreview({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, method: 'cash', amount: '0.36', sources: sources([['payment:mpesa', '0.29'], ['credit-note:one', '0.07']]), reasonCode: 'duplicate_payment', externalReference: null });
    assert.equal(multi.method_difference, true);
    assert.deepEqual(multi.sources.map(row => row.resulting_remaining_minor), [0, 0]);
    assert.deepEqual([multi.method_label, multi.external_reference, multi.reason_label], ['Cash', null, 'Duplicate payment']);
    assert.match(refundPreviewText(multi), /Outgoing KES 0\.36 by Cash\. Reference: No external reference \(cash\)\. Reason: Duplicate payment\./);
    assert.deepEqual(refundAcknowledgementState({ methodDifference: true, pending: false, checked: true }), { visible: true, checked: true });
    assert.deepEqual(refundAcknowledgementState({ methodDifference: false, pending: false, checked: true }), { visible: false, checked: false });
    assert.deepEqual(refundAcknowledgementState({ methodDifference: false, pending: true, checked: true }), { visible: false, checked: true });
    assert.throws(() => refundDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, method: 'cash', amount: '0.29', sources: sources([['payment:mpesa', '0.29']]), reasonCode: 'overpayment', externalReference: null, acknowledgeMethodDifference: false, confirmed: true }), TypeError);
    const draft = refundDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, method: 'bank', amount: '0.36', sources: sources([['payment:mpesa', '0.29'], ['credit-note:one', '0.07']]), reasonCode: 'duplicate_payment', externalReference: ' bank-1 ', acknowledgeMethodDifference: true, confirmed: true });
    assert.deepEqual([draft.amount, draft.amount_minor, draft.external_reference, draft.method_difference], ['0.36', 36, 'BANK-1', true]);
    for (const change of [
        { amount: '0.37' }, { sources: sources([['payment:cash', '10.13']]) }, { sources: sources([['payment:mpesa', '0.14'], ['payment:mpesa', '0.15']]), amount: '0.29' },
        { method: 'mpesa', externalReference: null }, { reasonCode: 'caller prose 0712345678' }, { confirmed: false }
    ]) assert.throws(() => refundDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, method: 'cash', amount: '0.07', sources: sources([['credit-note:one', '0.07']]), reasonCode: 'other', externalReference: null, acknowledgeMethodDifference: false, confirmed: true, ...change }), error => error instanceof TypeError || error instanceof RangeError);
});

test('refund retry and response binding preserve immutable evidence while freezing every financial action', async () => {
    const { refundDraft, createRefundRetryTracker, createRefundIdentityLock, validRefundResponse, refundResponseIsCurrent } = await model;
    const draft = refundDraft({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, method: 'cash', amount: '0.07', sources: sources([['credit-note:one', '0.07']]), reasonCode: 'other', externalReference: null, acknowledgeMethodDifference: false, confirmed: true });
    let keys = 0;
    const retries = createRefundRetryTracker(() => `customer-refund:key-${++keys}`);
    const first = retries.keyFor(draft);
    retries.retainUncertain(draft, first);
    assert.equal(retries.keyFor({ ...draft, sources: [...draft.sources] }), first);
    assert.equal(retries.keyFor({ ...draft, reason_code: 'overpayment' }), 'customer-refund:key-2');
    const lock = createRefundIdentityLock(); lock.begin(); assert.equal(lock.canChange(), false); lock.finish();
    assert.equal(validRefundResponse(response(draft), draft), true);
    for (const bad of [{ ...response(draft), source_allocations: [] }, { ...response(draft), method: 'bank' }, { ...response(draft), amount_minor: 8 }, { ...response(draft), source_allocations: [{ ...response(draft).source_allocations[0], amount_minor: 6 }] }, { ...response(draft), refund_event_id: 'bad' }]) assert.equal(validRefundResponse(bad, draft), false);
    assert.equal(refundResponseIsCurrent({ customerId: 'customer:one', selectionVersion: 1, snapshotVersion: 2, requestVersion: 3 }, { customerId: 'customer:one', selectionVersion: 1, snapshotVersion: 2, requestVersion: 3 }), true);
    const { customerFinancialFormAvailability } = await timelineModel;
    assert.deepEqual(customerFinancialFormAvailability({ customer: customer(), allocationAvailable: true, settlementLoading: false, receiptPending: false, allocationPending: false, reversalPending: false, creditNotePending: false, refundPending: true }), { receiptEnabled: false, allocationEnabled: false, reversalEnabled: false, creditNoteEnabled: false, refundEnabled: false, identityEnabled: false });
});

test('refund API body is exact and the view has no unrelated financial write path or unsafe rendering', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 201, json: async () => ({}) }; };
    try {
        const { api } = await import('../../js/api.js');
        await api.issueCustomerRefund({ customer_id: 'customer:one', method: 'cash', amount: '0.07', sources: sources([['credit-note:one', '0.07']]), reason_code: 'other', external_reference: null, acknowledge_method_difference: false, idempotency_key: 'refund:key' });
    } finally { global.fetch = originalFetch; }
    assert.deepEqual(calls, [{ url: '/api/customer-refunds', options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: 'customer:one', method: 'cash', amount: '0.07', sources: sources([['credit-note:one', '0.07']]), reason_code: 'other', external_reference: null, acknowledge_method_difference: false, idempotency_key: 'refund:key' }) } }]);
    const root = path.join(__dirname, '..', '..');
    const view = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline.js'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'js', 'customer-refund-ui-model.mjs'), 'utf8');
    const submit = view.slice(view.indexOf('async function submitCustomerRefund'), view.indexOf('async function submitCustomerAllocationReversal'));
    assert.match(view, /customer-refund-card.*canIssueCustomerRefunds/s);
    assert.match(submit, /issueCustomerRefund\(/);
    assert.match(submit, /validRefundResponse/);
    assert.match(view, /refundAcknowledgementState/);
    assert.match(view, /refundPreviewText/);
    assert.doesNotMatch(submit, /recordManualCustomerReceipt|allocateCustomerCredit|reverseCustomerAllocation|issueCustomerCreditNote|saveTransaction|ledger/i);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|innerHTML|saveTransaction|issueCustomerCreditNote|paymentReversal/i);
});
