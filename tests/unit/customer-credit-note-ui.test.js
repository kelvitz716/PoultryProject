const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.textContent = '';
        this.value = '';
    }

    append(...children) { this.children.push(...children); }

    replaceChildren(...children) {
        this.children = children;
        if (this.tagName === 'select') this.value = '';
    }
}

const fakeDocument = { createElement: tagName => new FakeElement(tagName) };
const model = import('../../js/customer-credit-note-ui-model.mjs');
const timelineModel = import('../../js/customer-settlement-timeline-model.mjs');

function customer(active = true) {
    return { id: 'customer:one', display_name: '<img src=x onerror=alert(1)> Same Name', is_active: active };
}

function snapshot(overrides = {}) {
    return {
        customer_id: 'customer:one',
        currency: 'KES',
        status: 'exact',
        events: [
            {
                id: 'invoice:one', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'invoice', status: 'part-paid',
                amount_minor: 1012, allocated_minor: 29, remaining_minor: 983, external_reference: '<b>INV-ONE</b>'
            },
            {
                id: 'invoice:settled', customer_id: 'customer:one', currency: 'KES', side: 'debit', kind: 'invoice', status: 'settled',
                amount_minor: 29, allocated_minor: 29, remaining_minor: 0, external_reference: 'INV-SETTLED'
            },
            {
                id: 'credit-note:earlier', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'credit_note', status: 'open',
                amount_minor: 29, allocated_minor: 0, remaining_minor: 29, original_event_id: 'invoice:one', external_reference: 'CN-EARLIER'
            },
            // A non-commercial draft must not hide otherwise coherent invoices.
            {
                id: 'payment:draft', customer_id: 'customer:one', currency: 'KES', side: 'credit', kind: 'payment', status: 'draft',
                amount_minor: 500, allocated_minor: 0, remaining_minor: 0, external_reference: 'DRAFT'
            }
        ],
        ...overrides
    };
}

const exactSuggestions = { status: 'exact', suggestions: [] };

function request(preview, overrides = {}) {
    return {
        customer_id: 'customer:one',
        invoice_event_id: 'invoice:one',
        amount: preview.amount,
        amount_minor: preview.amount_minor,
        reason_code: 'return',
        external_reference: 'CN-REF',
        automatically_allocated_minor: preview.automatically_allocated_minor,
        remaining_credit_minor: preview.remaining_credit_minor,
        ...overrides
    };
}

function response(requested, overrides = {}) {
    return {
        idempotent: false,
        credit_note_event_id: `credit-note:${'a'.repeat(40)}`,
        ledger_transaction_id: `ledger-credit-note:${'b'.repeat(36)}`,
        amount_minor: requested.amount_minor,
        automatically_allocated_minor: requested.automatically_allocated_minor,
        remaining_credit_minor: requested.remaining_credit_minor,
        reason_code: requested.reason_code,
        original_invoice_event_id: requested.invoice_event_id,
        recorded_at: '2026-09-09T10:11:12.123Z',
        recorded_by_user_id: 'admin-1',
        ...overrides
    };
}

test('admin-only credit-note candidates preserve settled invoices with allowance and use safe labels', async () => {
    const { canIssueCustomerCreditNotes, creditNoteCandidates, appendCreditNoteInvoiceOptions } = await model;
    assert.equal(canIssueCustomerCreditNotes('super_admin'), true);
    assert.equal(canIssueCustomerCreditNotes('admin'), true);
    assert.equal(canIssueCustomerCreditNotes('farmer'), false);
    assert.equal(canIssueCustomerCreditNotes('viewer'), false);

    const candidates = creditNoteCandidates(customer(), snapshot(), exactSuggestions);
    assert.equal(candidates.available, true);
    assert.deepEqual(candidates.invoices.map(row => [row.id, row.current_deficit_minor, row.prior_notes_minor, row.remaining_allowance_minor]), [
        ['invoice:one', 983, 29, 983],
        ['invoice:settled', 0, 0, 29]
    ]);
    assert.match(candidates.invoices[0].label, /<b>INV-ONE<\/b>.*ID invoice:one.*original KES 10\.12.*allocated KES 0\.29.*prior notes KES 0\.29.*allowance KES 9\.83/);
    assert.equal(creditNoteCandidates(customer(false), snapshot(), exactSuggestions).available, true);
    assert.equal(creditNoteCandidates(customer(), snapshot({ status: 'reconciliation_required' }), exactSuggestions).available, false);
    assert.equal(creditNoteCandidates(customer(), snapshot(), { status: 'reconciliation_required' }).available, false);
    assert.equal(creditNoteCandidates(customer(), snapshot({ events: snapshot().events.map(event => event.id === 'credit-note:earlier' ? { ...event, amount_minor: 1013, remaining_minor: 1013 } : event) }), exactSuggestions).available, false);
    assert.equal(creditNoteCandidates(customer(), snapshot({ events: snapshot().events.map(event => event.id === 'credit-note:earlier' ? { ...event, amount_minor: Number.MAX_SAFE_INTEGER, remaining_minor: Number.MAX_SAFE_INTEGER } : event) }), exactSuggestions).available, false);

    const select = new FakeElement('select');
    appendCreditNoteInvoiceOptions(select, candidates.invoices, 'Select invoice', fakeDocument);
    select.value = 'invoice:one';
    appendCreditNoteInvoiceOptions(select, candidates.invoices, 'Select invoice', fakeDocument);
    assert.deepEqual(select.children.map(option => option.value), ['', 'invoice:one', 'invoice:settled']);
    assert.equal(select.value, 'invoice:one');
    assert.equal(Object.hasOwn(select, 'innerHTML'), false);
});

test('credit-note draft uses exact KES, current allowance, commercial reasons, and linked-invoice preview only', async () => {
    const { creditNotePreview, creditNoteDraft, normalizeCreditNoteReference } = await model;
    for (const [amount, minor, applied, remaining] of [
        ['0.07', 7, 7, 0],
        ['0.29', 29, 29, 0]
    ]) {
        const preview = creditNotePreview({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, invoiceEventId: 'invoice:one', amount });
        assert.deepEqual([preview.amount_minor, preview.automatically_allocated_minor, preview.remaining_credit_minor], [minor, applied, remaining]);
    }
    const noPriorNotes = snapshot({ events: snapshot().events.filter(event => event.id !== 'credit-note:earlier') });
    const full = creditNotePreview({ customer: customer(), settlement: noPriorNotes, suggestions: exactSuggestions, invoiceEventId: 'invoice:one', amount: '10.12' });
    assert.deepEqual([full.amount_minor, full.automatically_allocated_minor, full.remaining_credit_minor], [1012, 983, 29]);
    const settled = creditNotePreview({ customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, invoiceEventId: 'invoice:settled', amount: '0.29' });
    assert.deepEqual([settled.automatically_allocated_minor, settled.remaining_credit_minor], [0, 29]);
    const draft = creditNoteDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, invoiceEventId: 'invoice:one',
        amount: '0.29', reasonCode: 'quality_issue', externalReference: ' cn-1 ', confirmed: true
    });
    assert.deepEqual(draft, {
        customer_id: 'customer:one', invoice_event_id: 'invoice:one', amount: '0.29', amount_minor: 29,
        reason_code: 'quality_issue', external_reference: 'CN-1', automatically_allocated_minor: 29, remaining_credit_minor: 0
    });
    assert.equal(normalizeCreditNoteReference(''), null);
    for (const input of [
        { amount: '9.84' }, { amount: '1.234' }, { amount: '1e2' }, { amount: '1,000.00' }, { amount: '0.00' },
        { reasonCode: 'caller prose 0712345678' }, { externalReference: 'raw sms body has spaces' }, { confirmed: false }
    ]) assert.throws(() => creditNoteDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, invoiceEventId: 'invoice:one',
        amount: '0.29', reasonCode: 'return', externalReference: null, confirmed: true, ...input
    }), error => error instanceof TypeError || error instanceof RangeError);
});

test('credit-note retry key, pending lock, and success response bind only immutable submitted evidence', async () => {
    const {
        createCreditNoteRetryTracker, createCreditNoteIdentityLock, creditNoteDraft,
        validCreditNoteResponse, creditNoteResponseIsCurrent
    } = await model;
    const preview = creditNoteDraft({
        customer: customer(), settlement: snapshot(), suggestions: exactSuggestions, invoiceEventId: 'invoice:one',
        amount: '0.29', reasonCode: 'return', externalReference: 'CN-REF', confirmed: true
    });
    let keys = 0;
    const retries = createCreditNoteRetryTracker(() => `customer-credit-note:key-${++keys}`);
    const first = retries.keyFor(preview);
    retries.retainUncertain(preview, first);
    assert.equal(retries.keyFor({ ...preview }), first);
    assert.equal(retries.keyFor({ ...preview, amount: '0.07', amount_minor: 7 }), 'customer-credit-note:key-2');
    const lock = createCreditNoteIdentityLock();
    lock.begin();
    assert.equal(lock.canChange(), false);
    lock.finish();
    assert.equal(lock.canChange(), true);

    const requested = request(preview);
    const good = response(requested);
    assert.equal(validCreditNoteResponse(good, requested), true);
    // The linked invoice may be settled after this browser snapshot but before
    // the server records the note. Its authoritative, coherent split is still
    // a successful immutable result, not an unverified response.
    assert.equal(validCreditNoteResponse(response(requested, {
        automatically_allocated_minor: 0,
        remaining_credit_minor: requested.amount_minor
    }), requested), true);
    for (const malformed of [
        {}, { ...good, idempotent: 'false' }, { ...good, amount_minor: 7 },
        { ...good, original_invoice_event_id: 'invoice:other' }, { ...good, reason_code: 'other' },
        { ...good, automatically_allocated_minor: 0, remaining_credit_minor: 28 },
        { ...good, credit_note_event_id: 'credit-note:bad' }, { ...good, ledger_transaction_id: 'ledger-credit-note:bad' },
        { ...good, recorded_at: 'not-a-time' }, { ...good, recorded_by_user_id: '<unsafe>' }
    ]) assert.equal(validCreditNoteResponse(malformed, requested), false);
    const submitted = { customerId: 'customer:one', selectionVersion: 3, snapshotVersion: 4, requestVersion: 5 };
    assert.equal(creditNoteResponseIsCurrent(submitted, submitted), true);
    assert.equal(creditNoteResponseIsCurrent(submitted, { ...submitted, customerId: 'customer:two' }), false);
    assert.equal(creditNoteResponseIsCurrent(submitted, { ...submitted, snapshotVersion: 5 }), false);

    const { customerFinancialFormAvailability } = await timelineModel;
    assert.deepEqual(customerFinancialFormAvailability({
        customer: customer(), allocationAvailable: true, settlementLoading: false,
        receiptPending: false, allocationPending: false, reversalPending: false, creditNotePending: true
    }), { receiptEnabled: false, allocationEnabled: false, reversalEnabled: false, creditNoteEnabled: false, refundEnabled: false, identityEnabled: false });
});

test('credit-note API uses the exact approved request body and UI source has no unrelated financial write path', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 201, json: async () => ({}) };
    };
    try {
        const { api } = await import('../../js/api.js');
        await api.issueCustomerCreditNote({
            customer_id: 'customer:one', invoice_event_id: 'invoice:one', amount: '10.12',
            reason_code: 'return', external_reference: null, idempotency_key: 'credit-note:key'
        });
    } finally {
        global.fetch = originalFetch;
    }
    assert.deepEqual(calls, [{
        url: '/api/customer-credit-notes',
        options: {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customer_id: 'customer:one', invoice_event_id: 'invoice:one', amount: '10.12',
                reason_code: 'return', external_reference: null, idempotency_key: 'credit-note:key'
            })
        }
    }]);
    const root = path.join(__dirname, '..', '..');
    const view = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline.js'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'js', 'customer-credit-note-ui-model.mjs'), 'utf8');
    const submit = view.slice(view.indexOf('async function submitCustomerCreditNote'), view.indexOf('async function submitCustomerAllocationReversal'));
    assert.match(submit, /issueCustomerCreditNote\(/);
    assert.match(submit, /validCreditNoteResponse/);
    assert.doesNotMatch(submit, /recordManualCustomerReceipt|allocateCustomerCredit|reverseCustomerAllocation|recordCustomerRefund|saveTransaction|ledger/i);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|innerHTML|refund|paymentReversal|saveTransaction/i);
    assert.match(view, /customer-credit-note-card/);
});
