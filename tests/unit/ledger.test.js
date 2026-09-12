const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let failWhen = null;

require.cache[require.resolve('../../db')] = {
    exports: {
        runQuery: async (sql, params = []) => {
            calls.push({ sql, params });
            if (failWhen?.(sql, params)) {
                throw new Error('injected ledger write failure');
            }
        }
    }
};

const { syncTransactionToLedger } = require('../../services/ledger');

function reset({ failure } = {}) {
    calls.length = 0;
    failWhen = failure || null;
}

function ledgerEntries() {
    return calls.filter(call => call.sql.startsWith('INSERT INTO ledger_entries'));
}

function accountPostings() {
    return ledgerEntries().map(call => call.params.slice(2, 4));
}

function transactionHeader() {
    return calls.find(call => call.sql.startsWith('INSERT INTO ledger_transactions'));
}

test('cash COD sale posts Cash against Egg Sales', async () => {
    reset();
    await syncTransactionToLedger('batch-1', {
        id: 'cash-sale-1', type: 'sale', category: 'eggs', amount: 1500,
        buyerTerms: 'COD', payment_method: 'cash'
    });

    assert.deepEqual(accountPostings(), [['1000', 'debit'], ['4000', 'credit']]);
    assert.equal(transactionHeader().params[4], 'cash-sale-1');
    assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('credit sale posts Accounts Receivable against Egg Sales', async () => {
    reset();
    await syncTransactionToLedger('batch-1', {
        id: 'credit-sale-1', type: 'sale', category: 'eggs', amount: 1800,
        buyerTerms: 'Net 14', payment_method: 'cash'
    });

    assert.deepEqual(accountPostings(), [['1200', 'debit'], ['4000', 'credit']]);
});

test('cash purchase posts inventory or expense against Cash', async () => {
    reset();
    await syncTransactionToLedger('batch-1', {
        id: 'cash-purchase-1', type: 'purchase', category: 'feed', amount: 3200,
        payment_method: 'cash'
    });

    assert.deepEqual(accountPostings(), [['1310', 'debit'], ['1000', 'credit']]);
});

test('M-Pesa-tagged sale posts M-Pesa Till against Egg Sales and persists its reference', async () => {
    reset();
    await syncTransactionToLedger('batch-1', {
        id: 'mpesa-sale-1', type: 'sale', category: 'eggs', amount: 1500,
        buyerTerms: 'COD', payment_method: 'mpesa', mpesa_code: 'QWE123ABC'
    });

    assert.deepEqual(accountPostings(), [['1010', 'debit'], ['4000', 'credit']]);
    assert.equal(transactionHeader().params[4], 'QWE123ABC');
});

test('M-Pesa-tagged purchase posts inventory or expense against M-Pesa Till', async () => {
    reset();
    await syncTransactionToLedger('batch-1', {
        id: 'mpesa-purchase-1', type: 'purchase', category: 'feed', amount: 3200,
        payment_method: 'mpesa', mpesa_code: 'RTY456DEF'
    });

    assert.deepEqual(accountPostings(), [['1310', 'debit'], ['1010', 'credit']]);
    assert.equal(transactionHeader().params[4], 'RTY456DEF');
});

test('delete path removes the ledger transaction without creating replacement entries', async () => {
    reset();
    await syncTransactionToLedger('batch-1', { id: 'delete-1' }, true);

    assert.deepEqual(calls.map(call => call.sql), [
        'BEGIN TRANSACTION',
        'DELETE FROM ledger_transactions WHERE id = ?',
        'COMMIT'
    ]);
    assert.equal(ledgerEntries().length, 0);
});

test('ledger write failure rolls back and rethrows the original failure', async () => {
    reset({
        failure: sql => sql.startsWith('INSERT INTO ledger_entries')
    });

    await assert.rejects(
        syncTransactionToLedger('batch-1', {
            id: 'failure-1', type: 'sale', category: 'eggs', amount: 1500,
            buyerTerms: 'COD', payment_method: 'cash'
        }),
        /injected ledger write failure/
    );

    assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(!calls.some(call => call.sql === 'COMMIT'));
});
