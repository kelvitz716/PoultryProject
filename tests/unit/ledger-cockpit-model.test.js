const test = require('node:test');
const assert = require('node:assert/strict');

async function model() {
    return import('../../js/ledger-cockpit-model.mjs');
}

function account(code, balanceMinor = 0, entryCount = 0, status = 'exact') {
    return { code, balance_minor: balanceMinor, entry_count: entryCount, status };
}

test('cockpit ledger model preserves initial capital only for an exact empty ledger', async () => {
    const { deriveCockpitLedgerDisplay } = await model();
    const result = deriveCockpitLedgerDisplay({
        accounts: [account('1000'), account('1010'), account('1200')], initialCash: 2500
    });
    assert.deepEqual(result, {
        liquid_cash: 2500, outstanding_credit: 0,
        cash_text: 'KES 2,500', credit_text: 'KES 0'
    });
});

test('cockpit ledger model marks unresolved cash, M-Pesa, or receivables without null-to-zero fallback', async () => {
    const { deriveCockpitLedgerDisplay, RECONCILIATION_REQUIRED_TEXT } = await model();
    const exact = [account('1000', 10000, 1), account('1010', 5000, 1), account('1200', 4000, 1)];
    assert.equal(deriveCockpitLedgerDisplay({ accounts: [account('1000', 10000, 1, 'reconciliation_required'), ...exact.slice(1)], initialCash: 999 }).cash_text, RECONCILIATION_REQUIRED_TEXT);
    assert.equal(deriveCockpitLedgerDisplay({ accounts: [exact[0], account('1010', 5000, 1, 'reconciliation_required'), exact[2]] }).cash_text, RECONCILIATION_REQUIRED_TEXT);
    const receivable = deriveCockpitLedgerDisplay({ accounts: [exact[0], exact[1], account('1200', 4000, 1, 'reconciliation_required')] });
    assert.deepEqual([receivable.cash_text, receivable.credit_text, receivable.outstanding_credit], ['KES 150', RECONCILIATION_REQUIRED_TEXT, null]);
    const unknown = deriveCockpitLedgerDisplay({ accounts: [], initialCash: 999 });
    assert.deepEqual([unknown.cash_text, unknown.liquid_cash], [RECONCILIATION_REQUIRED_TEXT, null]);
});

test('farmer cash privacy remains masked even when ledger evidence is unresolved', async () => {
    const { deriveCockpitLedgerDisplay } = await model();
    const result = deriveCockpitLedgerDisplay({
        accounts: [account('1000', null, 1, 'reconciliation_required'), account('1010'), account('1200')],
        isFarmer: true
    });
    assert.deepEqual([result.cash_text, result.credit_text], ['KES —', 'KES 0']);
});
