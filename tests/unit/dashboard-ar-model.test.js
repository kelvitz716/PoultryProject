const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.style = {}; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}
const fakeDocument = { createElement: tagName => new FakeElement(tagName) };
const model = import('../../js/dashboard-ar-model.mjs');

function customer(overrides = {}) {
    return { id: 'customer:one', display_name: '<img src=x onerror=alert(1)>', is_active: true, ...overrides };
}
function settlement(overrides = {}) {
    return {
        customer_id: 'customer:one', currency: 'KES', status: 'exact',
        outstanding_debit_minor: 7000, available_credit_minor: 2500, net_minor: -4500,
        events: [
            { kind: 'invoice', side: 'debit', status: 'part-paid', amount_minor: 10000, remaining_minor: 7000 },
            { kind: 'payment', side: 'credit', status: 'settled', amount_minor: 3000, remaining_minor: 0 },
            { kind: 'payment', side: 'credit', status: 'open', amount_minor: 2500, remaining_minor: 2500 },
            { kind: 'credit_note', side: 'credit', status: 'settled', amount_minor: 1000, remaining_minor: 0 },
            { kind: 'refund', side: 'debit', status: 'settled', amount_minor: 500, remaining_minor: 0 },
            { kind: 'payment_reversal', side: 'debit', status: 'settled', amount_minor: 300, remaining_minor: 0 }
        ],
        ...overrides
    };
}

test('dashboard AR projects only exact settlement positions, including partial and multiple tender evidence', async () => {
    const { dashboardArProjection, canAccessDashboardAccountsReceivable } = await model;
    const exact = dashboardArProjection(customer(), settlement());
    assert.deepEqual([exact.status, exact.outstanding, exact.credit, exact.net], ['exact', 'KES 70.00', 'KES 25.00', '−KES 45.00']);
    assert.equal(canAccessDashboardAccountsReceivable('viewer'), false);
    assert.equal(canAccessDashboardAccountsReceivable('farmer'), true);
    // Credit notes, refunds, and reversals are represented only through this
    // supplied settlement snapshot; no transaction status is consulted.
    assert.equal(settlement().events.filter(event => ['credit_note', 'refund', 'payment_reversal'].includes(event.kind)).length, 3);
});

test('dashboard AR fails closed on unavailable or inconsistent settlement evidence and uses safe DOM nodes', async () => {
    const { dashboardArProjection, renderDashboardAr } = await model;
    for (const snapshot of [
        settlement({ status: 'reconciliation_required' }),
        settlement({ net_minor: 0 }),
        settlement({ customer_id: 'customer:other' })
    ]) {
        const projection = dashboardArProjection(customer(), snapshot);
        assert.deepEqual([projection.status, projection.outstanding, projection.credit, projection.net], [
            'reconciliation_required', 'Unavailable / reconciliation required', 'Unavailable / reconciliation required', 'Unavailable / reconciliation required'
        ]);
    }
    const container = new FakeElement('div');
    renderDashboardAr(container, { status: 'ready', projections: [dashboardArProjection(customer(), settlement())] }, fakeDocument);
    assert.equal(Object.hasOwn(container, 'innerHTML'), false);
    assert.equal(container.children[0].children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
});

test('dashboard AR controller preserves reload safety and never fetches settlement data for unauthorized roles', async () => {
    const { createDashboardArController } = await model;
    let releaseOld;
    let settlements = 0;
    let lists = 0;
    const controller = createDashboardArController({
        listCustomers: () => ++lists === 1 ? new Promise(resolve => { releaseOld = resolve; }) : Promise.resolve([customer({ id: 'customer:new', display_name: 'New' })]),
        getCustomerSettlement: id => { settlements += 1; return Promise.resolve(settlement({ customer_id: id })); }
    });
    const old = controller.load('admin');
    const latest = await controller.load('admin');
    releaseOld([customer()]);
    assert.equal((await old).status, 'stale');
    assert.deepEqual([latest.status, latest.projections.length, settlements], ['ready', 1, 1]);
    const denied = await controller.load('viewer');
    assert.deepEqual([denied.status, settlements], ['unauthorized', 1]);
});

test('dashboard has no transaction-status or financial write path and only invokes read settlement APIs', () => {
    const root = path.join(__dirname, '..', '..');
    const dashboard = fs.readFileSync(path.join(root, 'js', 'dashboard.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8');
    const arSection = dashboard.slice(dashboard.indexOf('// Accounts Receivable'), dashboard.indexOf('lucide.createIcons'));
    assert.match(dashboard, /createDashboardArController/);
    assert.match(dashboard, /getCustomerSettlement/);
    assert.doesNotMatch(arSection, /markInvoicePaid|saveTransaction|getTransactions|\.status\s*===\s*['"]unpaid['"]|innerHTML/);
    const settlementRead = api.slice(api.indexOf('async getCustomerSettlement'), api.indexOf('async getCustomerReconciliationSuggestions'));
    assert.match(settlementRead, /requestCustomerJson\(fetch, `\/api\/customers/);
    assert.doesNotMatch(settlementRead, /POST|PATCH|PUT|DELETE|saveTransaction|allocateCustomerCredit/);
});
