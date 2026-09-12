const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const receiptModel = import('../../js/manual-customer-receipt-ui-model.mjs');
const timelineModel = import('../../js/customer-settlement-timeline-model.mjs');

test('manual receipt draft accepts exact KES cash and bank evidence only for an active stable customer', async () => {
    const { manualReceiptDraft, parseManualReceiptKes } = await receiptModel;
    for (const [amount, amountMinor] of [['0.07', 7], ['0.29', 29], ['10.12', 1012]]) {
        const draft = manualReceiptDraft({
            customerId: 'customer:one', customerIsActive: true, method: 'cash', amount,
            externalReference: '', confirmed: true
        });
        assert.deepEqual([draft.amount, draft.external_reference, parseManualReceiptKes(amount).amountMinor], [amount, null, amountMinor]);
    }
    assert.deepEqual(manualReceiptDraft({
        customerId: 'customer:one', customerIsActive: true, method: 'bank', amount: '10.12',
        externalReference: ' bank-ref:01 ', confirmed: true
    }), {
        customer_id: 'customer:one', method: 'bank', amount: '10.12', external_reference: 'BANK-REF:01'
    });
    for (const input of [
        { customerIsActive: false },
        { customerId: 'Walk-in Customer' },
        { method: 'mpesa' },
        { amount: '1.234' },
        { amount: '1e2' },
        { amount: '1,000.00' },
        { amount: '0.00' },
        { method: 'bank', externalReference: '' },
        { externalReference: 'reference prose is unsafe' },
        { confirmed: false }
    ]) {
        assert.throws(() => manualReceiptDraft({
            customerId: 'customer:one', customerIsActive: true, method: 'cash', amount: '1.00',
            externalReference: '', confirmed: true, ...input
        }), error => error instanceof TypeError || error instanceof RangeError);
    }
});

test('a pending receipt freezes A identity through an A-to-B-to-A attempt and preserves its uncertain retry key', async () => {
    const {
        createManualReceiptRetryTracker,
        createManualReceiptIdentityLock,
        manualReceiptDraft,
        receiptResponseIsCurrent
    } = await receiptModel;
    let sequence = 0;
    const tracker = createManualReceiptRetryTracker(() => `manual-receipt:key-${++sequence}`);
    const draft = manualReceiptDraft({
        customerId: 'customer:one', customerIsActive: true, method: 'cash', amount: '10.12',
        externalReference: '', confirmed: true
    });
    const first = tracker.keyFor(draft);
    let selectedCustomerId = 'customer:one';
    const identityLock = createManualReceiptIdentityLock();
    identityLock.begin();
    for (const attemptedCustomerId of ['customer:two', 'customer:one']) {
        if (identityLock.canChange()) selectedCustomerId = attemptedCustomerId;
    }
    assert.equal(selectedCustomerId, 'customer:one');
    assert.equal(identityLock.canChange(), false);
    tracker.retainUncertain(draft, first);
    assert.equal(tracker.keyFor(draft), first);
    identityLock.finish();
    assert.equal(identityLock.canChange(), true);
    const changed = { ...draft, amount: '10.13' };
    assert.equal(tracker.keyFor(changed), 'manual-receipt:key-2');
    assert.equal(tracker.keyFor(changed), 'manual-receipt:key-3');
    tracker.retainUncertain(changed, 'manual-receipt:key-3');
    tracker.invalidate();
    assert.equal(tracker.keyFor(changed), 'manual-receipt:key-4');

    const pendingForA = { customerId: 'customer:a', selectionVersion: 2, requestVersion: 7 };
    assert.equal(receiptResponseIsCurrent(pendingForA, pendingForA), true);
    assert.equal(receiptResponseIsCurrent(pendingForA, { ...pendingForA, customerId: 'customer:b' }), false);
    assert.equal(receiptResponseIsCurrent(pendingForA, { ...pendingForA, selectionVersion: 3 }), false);
});

test('manual receipt success requires complete matching server evidence and malformed 2xx outcomes stay retryable', async () => {
    const { createManualReceiptRetryTracker, manualReceiptDraft, validManualReceiptResponse } = await receiptModel;
    const draft = manualReceiptDraft({
        customerId: 'customer:one', customerIsActive: true, method: 'bank', amount: '10.12',
        externalReference: 'bank-1', confirmed: true
    });
    const good = {
        idempotent: false,
        customer_account_event_id: `manual-payment:${'a'.repeat(40)}`,
        ledger_transaction_id: `ledger-manual:${'b'.repeat(36)}`,
        recorded_at: '2026-09-08 10:11:12',
        receipt: { customer_id: 'customer:one', method: 'bank', amount_minor: 1012, external_reference: 'BANK-1' }
    };
    assert.equal(validManualReceiptResponse(good, draft), true);
    for (const malformed of [
        {},
        { ...good, idempotent: 'false' },
        { ...good, customer_account_event_id: 'manual-payment:wrong' },
        { ...good, recorded_at: 'not-a-timestamp' },
        { ...good, receipt: { ...good.receipt, customer_id: 'customer:two' } },
        { ...good, receipt: { ...good.receipt, amount_minor: 1013 } },
        { ...good, receipt: { ...good.receipt, external_reference: 'BANK-2' } }
    ]) assert.equal(validManualReceiptResponse(malformed, draft), false);

    let sequence = 0;
    const tracker = createManualReceiptRetryTracker(() => `manual-receipt:key-${++sequence}`);
    const first = tracker.keyFor(draft);
    if (!validManualReceiptResponse({}, draft)) tracker.retainUncertain(draft, first);
    assert.equal(tracker.keyFor(draft), first);
});

test('manual receipt client uses only the existing endpoint and exact request shape', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 201, json: async () => ({ customer_account_event_id: 'payment:one' }) };
    };
    try {
        const { api } = await import('../../js/api.js');
        await api.recordManualCustomerReceipt({
            customer_id: 'customer:one', method: 'bank', amount: '10.12',
            external_reference: 'BANK-1', idempotency_key: 'manual-receipt:key'
        });
        assert.deepEqual(calls, [{
            url: '/api/customer-receipts/manual',
            options: {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer_id: 'customer:one', method: 'bank', amount: '10.12',
                    external_reference: 'BANK-1', idempotency_key: 'manual-receipt:key'
                })
            }
        }]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('manual receipt UI remains financial-role-only, XSS-safe, and bounded to receipt recording', async () => {
    const { canAccessCustomerSettlement } = await timelineModel;
    assert.equal(canAccessCustomerSettlement('viewer'), false);
    for (const role of ['farmer', 'admin', 'super_admin']) assert.equal(canAccessCustomerSettlement(role), true);
    const root = path.join(__dirname, '..', '..');
    const view = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline.js'), 'utf8');
    const form = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const modelSource = fs.readFileSync(path.join(root, 'js', 'manual-customer-receipt-ui-model.mjs'), 'utf8');
    assert.match(form, /Record money received as unallocated customer credit\. It does not apply a payment to an invoice\./);
    assert.match(view, /recordManualCustomerReceipt/);
    assert.match(view, /validManualReceiptResponse/);
    assert.match(view, /updateIdentityControls/);
    assert.match(view, /receiptIdentityLock\.canChange\(\)/);
    assert.match(view, /textContent/);
    const receiptHandler = view.slice(view.indexOf('async function submitManualReceipt'), view.indexOf('async function loadSettlement'));
    assert.doesNotMatch(receiptHandler, /allocateCustomerCredit|reverseCustomerAllocation|issueCustomerCreditNote|recordCustomerRefund|saveTransaction|approvePaymentImport|rejectPaymentImport/i);
    assert.doesNotMatch(modelSource, /localStorage|sessionStorage|indexedDB|console\.|innerHTML/);
});
