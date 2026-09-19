const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.textContent = '';
        this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
}

const fakeDocument = {
    createElement: tagName => new FakeElement(tagName),
    createTextNode: text => ({ tagName: '#text', textContent: text })
};
const model = import('../../js/payment-inbox-model.mjs');

function cleanIncoming(overrides = {}) {
    return {
        id: 'import:clean', status: 'received', source: 'manual', receipt_code: 'QWE123ABC',
        amount_minor: 125050, currency: 'KES', direction: 'received', event_kind: 'customer_receipt',
        parse_warnings: [], has_conflict: 0, redacted_evidence: 'QWE123ABC Confirmed. Ksh1,250.50 received.',
        ...overrides
    };
}

function descendants(element, tagName) {
    const matches = [];
    for (const child of element.children || []) {
        if (child.tagName === tagName) matches.push(child);
        matches.push(...descendants(child, tagName));
    }
    return matches;
}

test('Payment Inbox request helper propagates safe server, HTTP, and network failures', async () => {
    const { PaymentImportRequestError, requestPaymentImportJson } = await model;
    await assert.rejects(requestPaymentImportJson(async () => ({
        ok: false, status: 409, json: async () => ({ error: 'Payment import conflicts' })
    }), '/api/payment-imports/manual'), error => error instanceof PaymentImportRequestError && error.status === 409 && /conflicts/.test(error.message));
    await assert.rejects(requestPaymentImportJson(async () => ({
        ok: false, status: 500, json: async () => null
    }), '/api/payment-imports'), /Payment Inbox request failed/);
    await assert.rejects(requestPaymentImportJson(async () => { throw new Error('offline'); }, '/api/payment-imports'), /Payment Inbox is unavailable/);
});

test('Payment Inbox role policy and DOM helpers keep evidence redacted and XSS-safe', async () => {
    const { appendPaymentImportRow, canAccessPaymentInbox, renderPaymentImportDetail } = await model;
    assert.equal(canAccessPaymentInbox('viewer'), false);
    assert.equal(canAccessPaymentInbox('farmer'), true);
    assert.equal(canAccessPaymentInbox('admin'), true);
    const paymentImport = {
        id: 'import:one', status: 'needs_review', source: 'manual', receipt_code: '<img src=x onerror=alert(1)>',
        amount_minor: 125050, redacted_evidence: '<script>alert(1)</script> 07******78',
        sender_masked: 'M-PESA', parse_warnings: ['<b>missing_counterparty</b>']
    };
    const list = new FakeElement('div');
    const row = appendPaymentImportRow(list, paymentImport, () => {}, fakeDocument);
    assert.equal(row.children[0].children[0].textContent.includes('<img src=x onerror=alert(1)>'), true);
    assert.equal(row.children[0].children[1].textContent, paymentImport.redacted_evidence);
    assert.equal(Object.hasOwn(row, 'innerHTML'), false);
    const detail = new FakeElement('div');
    renderPaymentImportDetail(detail, paymentImport, fakeDocument);
    assert.equal(detail.children.some(child => child.textContent === paymentImport.redacted_evidence), false);
    assert.equal(detail.children.some(child => child.children?.some(grandchild => grandchild.textContent === paymentImport.redacted_evidence)), true);
    assert.equal(Object.hasOwn(detail, 'innerHTML'), false);
});

test('Payment Inbox controller ignores stale success and failure responses and prevents double manual submission', async () => {
    const { PaymentImportRequestError, createPaymentInboxController, paymentInboxPageLabel } = await model;
    let releaseFirst;
    const firstList = new Promise(resolve => { releaseFirst = resolve; });
    const filters = [];
    let submitResolve;
    const apiClient = {
        listPaymentImports: input => {
            filters.push(input);
            return filters.length === 1 ? firstList : Promise.resolve({ items: [{ id: 'newer' }] });
        },
        ingestManualPaymentImport: () => new Promise(resolve => { submitResolve = resolve; })
    };
    const controller = createPaymentInboxController(apiClient);
    const staleRequest = controller.load({ status: 'received', source: undefined, limit: 25, offset: 0 });
    const current = await controller.load({ status: 'needs_review', source: 'manual', limit: 25, offset: 25 });
    releaseFirst({ items: [{ id: 'older' }] });
    const stale = await staleRequest;
    assert.deepEqual(filters, [
        { status: 'received', source: undefined, limit: 25, offset: 0 },
        { status: 'needs_review', source: 'manual', limit: 25, offset: 25 }
    ]);
    assert.deepEqual([current.stale, current.result.items[0].id, stale.stale], [false, 'newer', true]);

    let rejectFirst;
    const firstFailure = new Promise((_, reject) => { rejectFirst = reject; });
    let failureCalls = 0;
    const failureController = createPaymentInboxController({
        listPaymentImports: () => {
            failureCalls += 1;
            return failureCalls === 1 ? firstFailure : Promise.resolve({ items: [{ id: 'current' }] });
        },
        ingestManualPaymentImport: async () => ({})
    });
    const obsoleteFailure = failureController.load({ status: 'received', limit: 25, offset: 0 });
    const newerSuccess = await failureController.load({ status: 'needs_review', limit: 25, offset: 25 });
    rejectFirst(new PaymentImportRequestError('obsolete failure', 500));
    const staleFailure = await obsoleteFailure;
    assert.deepEqual([newerSuccess.stale, newerSuccess.result.items[0].id, staleFailure.stale, staleFailure.error.message], [false, 'current', true, 'obsolete failure']);
    assert.equal(paymentInboxPageLabel(0, 0), 'No results');
    assert.equal(paymentInboxPageLabel(25, 0), 'No results');
    assert.equal(paymentInboxPageLabel(25, 2), 'Showing 26–27');

    const firstSubmit = controller.submitManual({ text: 'TRANSIENT SMS BODY', sender: 'M-PESA' });
    const blocked = await controller.submitManual({ text: 'SECOND BODY', sender: 'M-PESA' });
    assert.deepEqual(blocked, { ignored: true, clearText: false });
    submitResolve({ created: false, duplicate: true, conflict: false, payment_import: { id: 'safe' } });
    assert.deepEqual((await firstSubmit).clearText, true);

    const conflictController = createPaymentInboxController({
        listPaymentImports: async () => ({ items: [] }),
        ingestManualPaymentImport: async () => { throw new PaymentImportRequestError('Payment import conflicts', 409); }
    });
    const conflict = await conflictController.submitManual({ text: 'TRANSIENT CONFLICT BODY' });
    assert.equal(conflict.clearText, true);
    assert.equal(conflict.error.status, 409);
});

test('Payment Inbox decision gates, duplicate customer identities, acknowledgement, and safe note handling are explicit', async () => {
    const {
        approvalRequestIsReady,
        canApprovePaymentImport,
        canRejectPaymentImport,
        renderPaymentImportDetail,
        reviewNoteIsSafeForInbox
    } = await model;
    const clean = cleanIncoming();
    assert.equal(canApprovePaymentImport('farmer', clean), true);
    assert.equal(canApprovePaymentImport('viewer', clean), false);
    assert.equal(canRejectPaymentImport('farmer', clean), false);
    assert.equal(canRejectPaymentImport('admin', clean), true);
    assert.equal(canApprovePaymentImport('admin', cleanIncoming({ parse_warnings: ['missing_counterparty'] })), false);
    assert.equal(canApprovePaymentImport('admin', cleanIncoming({ has_conflict: 1 })), false);
    assert.equal(canApprovePaymentImport('admin', cleanIncoming({ event_kind: 'reversal', status: 'reversed' })), false);
    assert.equal(canRejectPaymentImport('admin', cleanIncoming({ status: 'approved' })), false);
    assert.equal(approvalRequestIsReady('customer:a', true), true);
    assert.equal(approvalRequestIsReady('', true), false);
    assert.equal(approvalRequestIsReady('customer:a', false), false);
    assert.equal(reviewNoteIsSafeForInbox('No matching farm order.'), true);
    assert.equal(reviewNoteIsSafeForInbox('QWE123ABC Confirmed. Ksh1,250.50 received from JANE DOE 0712345678.'), false);

    let approvedCustomer = null;
    const detail = new FakeElement('div');
    renderPaymentImportDetail(detail, clean, {
        role: 'farmer',
        customers: [
            { id: 'customer:second', display_name: 'JANE DOE', payment_terms_days: 7, is_active: true },
            { id: 'customer:first', display_name: 'JANE DOE', payment_terms_days: 0, contact_phone: '07******78', is_active: true }
        ],
        onApprove: customerId => { approvedCustomer = customerId; }
    }, fakeDocument);
    const forms = descendants(detail, 'form');
    assert.equal(forms.length, 1);
    const select = descendants(forms[0], 'select')[0];
    const options = descendants(select, 'option');
    assert.deepEqual(options.map(option => option.value), ['', 'customer:first', 'customer:second']);
    assert.match(options[1].textContent, /ID …:first/);
    assert.match(options[2].textContent, /ID …second/);
    const acknowledgement = descendants(forms[0], 'input')[0];
    const approveButton = descendants(forms[0], 'button')[0];
    assert.equal(approveButton.disabled, true);
    select.value = 'customer:first';
    acknowledgement.checked = true;
    select.listeners.change();
    assert.equal(approveButton.disabled, false);
    forms[0].listeners.submit({ preventDefault() {} });
    await Promise.resolve();
    assert.equal(approvedCustomer, 'customer:first');

    const terminal = new FakeElement('div');
    renderPaymentImportDetail(terminal, cleanIncoming({ status: 'approved' }), { role: 'admin' }, fakeDocument);
    assert.equal(descendants(terminal, 'form').length, 0);
    assert.equal(descendants(terminal, 'p').some(node => /read-only/.test(node.textContent)), true);

    let rejectedNote = null;
    const rejectionDetail = new FakeElement('div');
    renderPaymentImportDetail(rejectionDetail, cleanIncoming({ status: 'needs_review', parse_warnings: ['missing_counterparty'] }), {
        role: 'admin',
        onReject: reviewNotes => { rejectedNote = reviewNotes; },
        onRejectNoteRejected: () => { rejectedRawNoteMessage = true; }
    }, fakeDocument);
    let rejectedRawNoteMessage = false;
    const rejectionForm = descendants(rejectionDetail, 'form')[0];
    const note = descendants(rejectionForm, 'textarea')[0];
    const confirmation = descendants(rejectionForm, 'input')[0];
    const rejectionButton = descendants(rejectionForm, 'button')[0];
    assert.equal(rejectionButton.disabled, true);
    note.value = 'QWE123ABC Confirmed. Ksh1,250.50 received from JANE DOE 0712345678.';
    confirmation.checked = true;
    confirmation.listeners.change();
    assert.equal(rejectionButton.disabled, false);
    rejectionForm.listeners.submit({ preventDefault() {} });
    assert.equal(note.value, '');
    assert.equal(rejectedRawNoteMessage, true);
    assert.equal(rejectedNote, null);

    note.value = 'No matching farm order.';
    rejectionForm.listeners.submit({ preventDefault() {} });
    await Promise.resolve();
    assert.equal(note.value, '');
    assert.equal(rejectedNote, 'No matching farm order.');
});

test('Payment Inbox decision API bodies are exact, actor-free, and double submissions are ignored', async () => {
    const { createPaymentInboxDecisionController, createPaymentInboxDecisionGate } = await model;
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ idempotent: false }) };
    };
    try {
        const { api } = await import('../../js/api.js');
        await api.approvePaymentImport('import:one', 'customer:one');
        await api.rejectPaymentImport('import:one', 'No matching farm order.');
        assert.deepEqual(calls.map(call => [call.url, JSON.parse(call.options.body)]), [
            ['/api/payment-imports/import%3Aone/approve', { customer_id: 'customer:one' }],
            ['/api/payment-imports/import%3Aone/reject', { review_notes: 'No matching farm order.' }]
        ]);
        assert.doesNotMatch(calls.map(call => call.options.body).join(' '), /reviewer|actor|created_by/i);
    } finally {
        global.fetch = originalFetch;
    }

    let release;
    const controller = createPaymentInboxDecisionController({
        approvePaymentImport: () => new Promise(resolve => { release = resolve; }),
        rejectPaymentImport: async () => ({ idempotent: true })
    });
    const first = controller.approve('import:one', 'customer:one');
    const blocked = await controller.approve('import:one', 'customer:one');
    assert.deepEqual(blocked, { ignored: true });
    release({ idempotent: false });
    assert.deepEqual(await first, { ignored: false, result: { idempotent: false } });

    let approveCalls = 0;
    let rejectCalls = 0;
    let releaseApprove;
    const gate = createPaymentInboxDecisionGate();
    const crossFormController = createPaymentInboxDecisionController({
        approvePaymentImport: () => {
            approveCalls += 1;
            return new Promise(resolve => { releaseApprove = resolve; });
        },
        rejectPaymentImport: async () => { rejectCalls += 1; return { idempotent: false }; }
    });
    const approvalToken = gate.start();
    const pendingApproval = crossFormController.approve('import:one', 'customer:one');
    const rejectedToken = gate.start();
    if (rejectedToken !== null) await crossFormController.reject('import:one', 'No matching order.');
    assert.equal(rejectCalls, 0);
    releaseApprove({ idempotent: false });
    const acceptedApproval = await pendingApproval;
    let refreshes = 0;
    if (gate.isCurrent(approvalToken) && !acceptedApproval.ignored) refreshes += 1;
    gate.finish(approvalToken);
    assert.deepEqual([approveCalls, rejectCalls, acceptedApproval.ignored, refreshes, gate.busy], [1, 0, false, 1, false]);
});

test('Payment Inbox source retains no raw body or note and includes only intentional decision calls', () => {
    const root = path.join(__dirname, '..', '..');
    const api = fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8');
    const inbox = fs.readFileSync(path.join(root, 'js', 'payment-inbox.js'), 'utf8');
    const modelSource = fs.readFileSync(path.join(root, 'js', 'payment-inbox-model.mjs'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
    assert.match(api, /listPaymentImports/);
    assert.match(api, /getPaymentImport/);
    assert.match(api, /ingestManualPaymentImport/);
    assert.match(api, /payment-imports\/\$\{encodeURIComponent\(id\)\}\/approve/);
    assert.match(api, /payment-imports\/\$\{encodeURIComponent\(id\)\}\/reject/);
    assert.doesNotMatch(inbox, /localStorage|sessionStorage|indexedDB|console\.|innerHTML/);
    assert.doesNotMatch(modelSource, /localStorage|sessionStorage|indexedDB|console\.|innerHTML/);
    assert.match(inbox, /decisionController\.approve/);
    assert.match(inbox, /decisionController\.reject/);
    assert.doesNotMatch(inbox, /allocateCustomerCredit|customer-settlement|ledger|saveTransaction/i);
    assert.doesNotMatch(modelSource, /allocateCustomerCredit|customer-settlement|ledger|saveTransaction/i);
    assert.match(inbox, /detailVersion === state\.detailVersion/);
    assert.match(inbox, /decisionGate\.start\(\)/);
    assert.match(inbox, /setDecisionControlsBusy\(true\)/);
    assert.match(app, /nav-payment-inbox[\s\S]{0,180}style\.display = 'none'/);
});
