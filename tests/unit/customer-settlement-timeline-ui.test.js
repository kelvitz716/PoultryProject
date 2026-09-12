const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.style = {};
        this.textContent = '';
        this.value = '';
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}

const fakeDocument = { createElement: tagName => new FakeElement(tagName) };
const model = import('../../js/customer-settlement-timeline-model.mjs');

function exactSnapshot(overrides = {}) {
    return {
        customer_id: 'customer:one', currency: 'KES', status: 'exact',
        outstanding_debit_minor: 7000, available_credit_minor: 2500, net_minor: -4500,
        evidence_count: 4, allocation_count: 2, issue_count: 0,
        events: [
            { id: 'invoice:late', kind: 'invoice', side: 'debit', status: 'part-paid', amount_minor: 10000, remaining_minor: 7000, external_reference: 'INV-2', created_at: '2026-09-02 09:00:00', posted_at: '2026-09-02 09:00:00' },
            { id: 'payment:early', kind: 'payment', side: 'credit', status: 'settled', amount_minor: 3000, remaining_minor: 0, external_reference: 'PAY-1', created_at: '2026-09-01 09:00:00', posted_at: '2026-09-01 09:00:00' },
            { id: 'credit-note:middle', kind: 'credit_note', side: 'credit', status: 'open', amount_minor: 2500, remaining_minor: 2500, external_reference: 'CN-1', created_at: '2026-09-01 12:00:00', posted_at: '2026-09-01 12:00:00' },
            { id: 'refund:middle', kind: 'refund', side: 'debit', status: 'open', amount_minor: 1000, remaining_minor: 1000, external_reference: 'RF-1', created_at: '2026-09-01 13:00:00', posted_at: '2026-09-01 13:00:00' }
        ],
        allocations: [
            { id: 'allocation:active', credit_event_id: 'payment:early', debit_event_id: 'invoice:late', amount_minor: 3000, status: 'active', created_at: '2026-09-01 10:00:00', reversed_at: null },
            { id: 'allocation:reversed', credit_event_id: 'credit-note:middle', debit_event_id: 'invoice:late', amount_minor: 500, status: 'reversed', created_at: '2026-09-01 14:00:00', reversed_at: '2026-09-01 15:00:00' }
        ],
        ...overrides
    };
}

function exactSuggestions(overrides = {}) {
    return {
        status: 'exact',
        suggestions: [
            { credit_event_id: 'payment:z', debit_event_id: 'invoice:z', amount_minor: 1000, reason_code: 'partial_capacity_match' },
            { credit_event_id: 'payment:b', debit_event_id: 'invoice:b', amount_minor: 500, reason_code: 'exact_remaining_match' },
            { credit_event_id: 'payment:a', debit_event_id: 'invoice:c', amount_minor: 500, reason_code: 'exact_remaining_match' }
        ],
        ...overrides
    };
}

function descendants(element, tagName) {
    const output = [];
    for (const child of element.children || []) {
        if (child.tagName === tagName) output.push(child);
        output.push(...descendants(child, tagName));
    }
    return output;
}

test('Customer Settlement Timeline roles and top summary preserve exact values or explicit unavailability', async () => {
    const { canAccessCustomerSettlement, formatKesMinor, settlementSummaryModel } = await model;
    assert.equal(canAccessCustomerSettlement('viewer'), false);
    assert.equal(canAccessCustomerSettlement('farmer'), true);
    assert.equal(formatKesMinor(29), 'KES 0.29');
    const exact = settlementSummaryModel(exactSnapshot(), exactSuggestions());
    assert.deepEqual([exact.status, exact.outstanding, exact.credit, exact.net, exact.evidenceCount, exact.allocationCount], [
        'exact', 'KES 70.00', 'KES 25.00', '−KES 45.00', '4', '2'
    ]);
    const unavailable = settlementSummaryModel(exactSnapshot({ status: 'reconciliation_required' }), exactSuggestions());
    assert.equal(unavailable.status, 'reconciliation_required');
    assert.equal(unavailable.outstanding, 'Unavailable / reconciliation required');
    assert.equal(unavailable.credit, 'Unavailable / reconciliation required');
    assert.equal(unavailable.net, 'Unavailable / reconciliation required');
    assert.notEqual(unavailable.outstanding, 'KES 0.00');
});

test('timeline keeps commercial, money, active/reversed allocation tracks chronological and linked', async () => {
    const { eventLane, timelineModel } = await model;
    const timeline = timelineModel(exactSnapshot());
    assert.equal(eventLane({ kind: 'invoice' }), 'commercial');
    assert.equal(eventLane({ kind: 'credit_note' }), 'commercial');
    assert.equal(eventLane({ kind: 'payment' }), 'money');
    assert.deepEqual(timeline.commercial.map(row => row.kind), ['credit_note', 'invoice']);
    assert.deepEqual(timeline.money.map(row => row.kind), ['payment', 'refund']);
    assert.deepEqual(timeline.allocations.map(row => row.status), ['active', 'reversed']);
    assert.match(timeline.allocations[0].from, /payment/);
    assert.match(timeline.allocations[0].to, /invoice/);
});

test('customer selector and timeline DOM use text nodes, keep duplicate names distinct, and show safe advisory ordering', async () => {
    const {
        appendCustomerSettlementOptions,
        renderCustomerSettlementSuggestions,
        renderCustomerSettlementTimeline,
        suggestionModel
    } = await model;
    const select = new FakeElement('select');
    appendCustomerSettlementOptions(select, [
        { id: 'customer:first', display_name: '<img src=x onerror=alert(1)>', is_active: true },
        { id: 'customer:second', display_name: '<img src=x onerror=alert(1)>', is_active: true }
    ], fakeDocument);
    assert.deepEqual(select.children.map(option => option.value), ['', 'customer:first', 'customer:second']);
    assert.notEqual(select.children[1].textContent, select.children[2].textContent);
    assert.match(select.children[1].textContent, /ID customer:first/);
    assert.equal(Object.hasOwn(select, 'innerHTML'), false);

    const suggestions = suggestionModel(exactSuggestions());
    assert.deepEqual(suggestions.map(row => [row.reason, row.credit, row.debit]), [
        ['Exact remaining match', 'payment:a', 'invoice:c'],
        ['Exact remaining match', 'payment:b', 'invoice:b'],
        ['Partial capacity match', 'payment:z', 'invoice:z']
    ]);
    const suggestionContainer = new FakeElement('div');
    renderCustomerSettlementSuggestions(suggestionContainer, exactSuggestions(), fakeDocument);
    assert.equal(descendants(suggestionContainer, 'article').length, 3);
    const timelineContainer = new FakeElement('div');
    renderCustomerSettlementTimeline(timelineContainer, exactSnapshot(), fakeDocument);
    assert.equal(descendants(timelineContainer, 'section').length, 3);
    assert.equal(Object.hasOwn(timelineContainer, 'innerHTML'), false);
});

test('timeline controller drops stale customer and settlement reads without retaining their data', async () => {
    const { createCustomerSettlementTimelineController } = await model;
    let releaseFirstCustomer;
    let releaseFirstSettlement;
    let listCalls = 0;
    let settlementCalls = 0;
    const controller = createCustomerSettlementTimelineController({
        listCustomers: () => {
            listCalls += 1;
            return listCalls === 1
                ? new Promise(resolve => { releaseFirstCustomer = resolve; })
                : Promise.resolve([{ id: 'customer:new' }]);
        },
        getCustomerSettlement: id => {
            settlementCalls += 1;
            return settlementCalls === 1
                ? new Promise(resolve => { releaseFirstSettlement = resolve; })
                : Promise.resolve(exactSnapshot({ customer_id: id }));
        },
        getCustomerReconciliationSuggestions: id => Promise.resolve(exactSuggestions({ customer_id: id }))
    });
    const staleCustomers = controller.loadCustomers(false);
    const currentCustomers = await controller.loadCustomers(true);
    releaseFirstCustomer([{ id: 'customer:old' }]);
    assert.deepEqual([currentCustomers.stale, currentCustomers.customers[0].id, (await staleCustomers).stale], [false, 'customer:new', true]);

    const staleSettlement = controller.load('customer:old');
    const currentSettlement = await controller.load('customer:new');
    releaseFirstSettlement(exactSnapshot({ customer_id: 'customer:old' }));
    assert.deepEqual([currentSettlement.stale, currentSettlement.settlement.customer_id, (await staleSettlement).stale], [false, 'customer:new', true]);
});

test('customer changes synchronously clear financial evidence and stale or failed reads cannot restore it', async () => {
    const { createCustomerSettlementTimelineController } = await model;
    for (const firstOutcome of ['success', 'failure']) {
        let finishFirst;
        const controller = createCustomerSettlementTimelineController({
            listCustomers: async () => [],
            getCustomerSettlement: id => id === 'customer:a'
                ? new Promise((resolve, reject) => { finishFirst = firstOutcome === 'success' ? resolve : reject; })
                : Promise.resolve(exactSnapshot({ customer_id: id })),
            getCustomerReconciliationSuggestions: id => Promise.resolve(exactSuggestions({ customer_id: id }))
        });
        let displayed = { customer_id: 'customer:a', outstanding: 'KES 70.00' };
        const start = customerId => { displayed = { customer_id: customerId, outstanding: 'Unavailable / reconciliation required' }; };
        const first = controller.load('customer:a', start);
        const second = controller.load('customer:b', start);
        assert.deepEqual(displayed, { customer_id: 'customer:b', outstanding: 'Unavailable / reconciliation required' });
        const current = await second;
        if (!current.stale && !current.error) displayed = { customer_id: current.settlement.customer_id, outstanding: 'KES 70.00' };
        finishFirst(firstOutcome === 'success' ? exactSnapshot({ customer_id: 'customer:a' }) : new Error('offline'));
        const stale = await first;
        if (!stale.stale && !stale.error) displayed = { customer_id: stale.settlement.customer_id, outstanding: 'KES 70.00' };
        assert.deepEqual([stale.stale, displayed.customer_id, displayed.outstanding], [true, 'customer:b', 'KES 70.00']);
    }

    const failedController = createCustomerSettlementTimelineController({
        listCustomers: async () => [],
        getCustomerSettlement: async () => { throw new Error('offline'); },
        getCustomerReconciliationSuggestions: async () => { throw new Error('offline'); }
    });
    let displayed = { customer_id: 'customer:a', outstanding: 'KES 70.00' };
    const failed = await failedController.load('customer:b', customerId => {
        displayed = { customer_id: customerId, outstanding: 'Unavailable / reconciliation required' };
    });
    assert.equal(Boolean(failed.error), true);
    assert.deepEqual(displayed, { customer_id: 'customer:b', outstanding: 'Unavailable / reconciliation required' });
});

test('Customer Settlement Timeline API reads use only the existing bounded GET endpoints', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ status: 'exact' }) };
    };
    try {
        const { api } = await import('../../js/api.js');
        await api.getCustomerSettlement('customer:one');
        await api.getCustomerReconciliationSuggestions('customer:one', { limit: 25 });
        assert.deepEqual(calls.map(call => [call.url, call.options]), [
            ['/api/customers/customer%3Aone/settlement', {}],
            ['/api/customers/customer%3Aone/reconciliation-suggestions?limit=25', {}]
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Customer Settlement Timeline renderer stays safe and leaves financial actions to a separate bounded form', async () => {
    const root = path.join(__dirname, '..', '..');
    const apiSource = fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8');
    const viewSource = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline.js'), 'utf8');
    const modelSource = fs.readFileSync(path.join(root, 'js', 'customer-settlement-timeline-model.mjs'), 'utf8');
    const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
    assert.match(apiSource, /getCustomerSettlement/);
    assert.match(apiSource, /getCustomerReconciliationSuggestions/);
    assert.match(viewSource, /createCustomerSettlementTimelineController\(api\)/);
    assert.doesNotMatch(modelSource, /allocateCustomerCredit|reverseCustomerAllocation|issueCustomerCreditNote|recordCustomerRefund|saveTransaction|method:\s*'POST'|method:\s*'PATCH'|method:\s*'DELETE'/i);
    assert.doesNotMatch(modelSource, /localStorage|sessionStorage|indexedDB|console\.|innerHTML/);
    assert.match(appSource, /nav-customer-accounts[\s\S]{0,180}style\.display = 'none'/);
});
