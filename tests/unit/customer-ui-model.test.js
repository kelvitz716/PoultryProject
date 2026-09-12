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
    }
    append(...children) {
        this.children.push(...children);
    }
}

const fakeDocument = { createElement: tagName => new FakeElement(tagName) };
const model = import('../../js/customer-ui-model.mjs');

test('customer and transaction request helpers expose non-OK and network errors to the UI', async () => {
    const { requestCustomerJson, requestTransactionJson } = await model;
    await assert.rejects(requestCustomerJson(async () => ({
        ok: false,
        json: async () => ({ error: 'Customer request conflicts' })
    }), '/api/customers'), /conflicts/);
    await assert.rejects(requestCustomerJson(async () => { throw new Error('offline'); }, '/api/customers'), /unavailable/);
    await assert.rejects(requestTransactionJson(async () => ({
        ok: false,
        json: async () => ({ error: 'Invalid transaction customer' })
    }), '/api/transactions/batch-1'), /Invalid transaction customer/);
    await assert.rejects(requestTransactionJson(async () => { throw new Error('offline'); }, '/api/transactions/batch-1'), /Transaction service is unavailable/);
});

test('customer registry DOM helpers keep duplicate names distinct and use text nodes for untrusted names', async () => {
    const { appendCustomerRegistryRow, appendSaleCustomerSelector, customerRowModel } = await model;
    const first = { id: 'customer:000001', display_name: '<img src=x onerror=alert(1)>', payment_terms_days: 7, contact_phone: '0712345678', is_active: 1 };
    const second = { id: 'customer:000002', display_name: '<img src=x onerror=alert(1)>', payment_terms_days: 7, contact_phone: '0712345678', is_active: 1 };
    assert.notEqual(customerRowModel(first).disambiguator, customerRowModel(second).disambiguator);

    const registry = new FakeElement('div');
    const row = appendCustomerRegistryRow(registry, first, fakeDocument);
    assert.equal(row.children[0].children[0].textContent, first.display_name);
    assert.equal(Object.hasOwn(row.children[0].children[0], 'innerHTML'), false);

    const selectorContainer = new FakeElement('div');
    const select = appendSaleCustomerSelector(selectorContainer, [first, second], fakeDocument);
    assert.equal(select.children[1].textContent.includes('<img src=x onerror=alert(1)>'), true);
    assert.equal(Object.hasOwn(select.children[1], 'innerHTML'), false);
});

test('customer UI roles, bootstrap issues, and transaction fields preserve stable customer identity', async () => {
    const {
        bootstrapIssueMessage,
        canSaveSaleForCustomer,
        canWriteCustomers,
        newIdempotencyKey,
        saleCustomerFields
    } = await model;
    assert.equal(canWriteCustomers('viewer'), false);
    assert.equal(canWriteCustomers('farmer'), true);
    assert.equal(bootstrapIssueMessage({ code: 'reserved_walk_in' }), 'Walk-in Customer is transaction-local; create a named customer instead.');
    assert.doesNotMatch(bootstrapIssueMessage({ code: 'invalid_phone' }), /0712345678|secret/i);

    const named = saleCustomerFields({ id: 'customer:stable-1', display_name: 'Same Name', payment_terms_days: 14 });
    assert.deepEqual(named, {
        customerId: 'customer:stable-1',
        buyerName: 'Same Name',
        buyerTerms: 'Net 14',
        paymentTermsDays: 14
    });
    const walkIn = saleCustomerFields(null);
    assert.deepEqual(walkIn, {
        customerId: null,
        buyerName: 'Walk-in Customer',
        buyerTerms: 'COD',
        paymentTermsDays: 0
    });
    assert.equal(canSaveSaleForCustomer(walkIn), true);
    assert.equal(canSaveSaleForCustomer({ customerId: null, paymentTermsDays: 7 }), false);
    assert.equal(newIdempotencyKey('customer-create', () => 'fixed-id'), 'customer-create:fixed-id');
});

test('settings and sales use stable customer helpers without mutating legacy buyer JSON', () => {
    const root = path.join(__dirname, '..', '..');
    const settings = fs.readFileSync(path.join(root, 'js', 'settings.js'), 'utf8');
    const sales = fs.readFileSync(path.join(root, 'js', 'sales.js'), 'utf8');
    assert.match(settings, /store\.bootstrapLegacyCustomers\(\)/);
    assert.match(settings, /appendCustomerRegistryRow/);
    assert.doesNotMatch(settings, /farmProfile\.buyers\.push|farmProfile\.buyers\.splice/);
    assert.match(sales, /store\.syncCustomers\(\)/);
    assert.match(sales, /customerId: customerFields\.customerId/);
    assert.match(sales, /canSaveSaleForCustomer/);
    assert.match(sales, /await api\.saveTransaction\(bid, newTx\)/);
    assert.match(sales, /Transaction was not saved/);
    assert.doesNotMatch(sales, /farmProfile\.buyers/);
    const saveFailure = sales.indexOf('Transaction was not saved');
    const earlyReturn = sales.indexOf('return;', saveFailure);
    const batchEffects = sales.indexOf('const batch =', saveFailure);
    assert.ok(saveFailure >= 0 && earlyReturn > saveFailure && batchEffects > earlyReturn);
});
