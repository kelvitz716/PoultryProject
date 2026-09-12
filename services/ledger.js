/**
 * @file services/ledger.js
 * @description Double-entry ledger synchronization for PoultryDSS farm transactions.
 */

const { parseKesAmount } = require('./kes-money');

function requireWriter(adapter) {
    if (!adapter || typeof adapter.runQuery !== 'function') {
        throw new TypeError('ledger synchronization requires a database writer');
    }
    return adapter;
}

/**
 * Synchronizes a flat farm transaction to the double-entry general ledger.
 * M-Pesa remains a manual payment method and posts to the M-Pesa Till account.
 */
async function syncTransactionToLedgerWithAdapter(adapter, batchId, tx, isDelete = false, options = {}) {
    if (!tx || !tx.id) return;

    const writer = requireWriter(adapter);
    await writer.runQuery('DELETE FROM ledger_transactions WHERE id = ?', [tx.id]);
    if (isDelete) return;

    const money = options.amountMinor === undefined
        ? parseKesAmount(tx.amount)
        : { amount: Number(options.amountMinor) / 100, amountMinor: options.amountMinor };
    if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor <= 0) {
        throw new RangeError('ledger amount_minor must be a positive safe integer');
    }

    const desc = tx.notes || `${tx.type} ${tx.category || ''}`;
    const date = tx.date || new Date().toISOString();
    const refType = tx.type || 'unknown';
    const refId = tx.mpesa_code || tx.id;
    await writer.runQuery(
        'INSERT INTO ledger_transactions (id, date, description, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)',
        [tx.id, date, desc, refType, refId]
    );

    const amount = money.amount;

    let drAccount = '1000';
    let crAccount = '4000';
    const type = tx.type;
    const cat = tx.category || '';
    const terms = tx.buyerTerms || 'COD';
    const payment = tx.payment_method || 'cash';

    if (type === 'sale') {
        // A stable named customer sale is always an invoice/receivable. Tender
        // collection is a later, separate customer-account/payment operation.
        if (tx.customerId) {
            drAccount = '1200';
        } else if (terms !== 'COD' && terms !== 'cash') {
            drAccount = '1200';
        } else if (payment === 'mpesa') {
            drAccount = '1010';
        }
        if (cat === 'spent' || cat === 'roosters' || cat === 'rooster') {
            crAccount = '4010';
        }
    } else if (type === 'purchase') {
        if (cat === 'feed') drAccount = '1310';
        else if (cat === 'labor') drAccount = '5010';
        else if (cat === 'electricity' || cat === 'water' || cat === 'utility') drAccount = '5020';
        else if (cat === 'vaccines' || cat === 'meds' || cat === 'health') drAccount = '5030';
        else if (cat === 'chicks') drAccount = '5040';
        else drAccount = '5000';
        crAccount = payment === 'mpesa' ? '1010' : '1000';
    } else if (type === 'return') {
        drAccount = '4000';
        crAccount = payment === 'mpesa' ? '1010' : '1000';
    } else if (type === 'write_off') {
        drAccount = '5000';
        crAccount = cat === 'feed' ? '1310' : '1300';
    }

    await writer.runQuery(
        `INSERT INTO ledger_entries
            (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
         VALUES (?, ?, ?, ?, ?, ?, 'exact')`,
        [`${tx.id}_dr`, tx.id, drAccount, 'debit', amount, money.amountMinor]
    );
    await writer.runQuery(
        `INSERT INTO ledger_entries
            (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
         VALUES (?, ?, ?, ?, ?, ?, 'exact')`,
        [`${tx.id}_cr`, tx.id, crAccount, 'credit', amount, money.amountMinor]
    );
}

/**
 * Backwards-compatible shared-connection wrapper. New persistence code must
 * call syncTransactionToLedgerWithAdapter inside its dedicated transaction.
 */
async function syncTransactionToLedger(batchId, tx, isDelete = false, adapter, options) {
    if (adapter) return syncTransactionToLedgerWithAdapter(adapter, batchId, tx, isDelete, options);

    const { runQuery } = require('../db');

    await runQuery('BEGIN TRANSACTION');
    try {
        await syncTransactionToLedgerWithAdapter({ runQuery }, batchId, tx, isDelete, options);
        await runQuery('COMMIT');
    } catch (err) {
        await runQuery('ROLLBACK').catch(() => {});
        throw err;
    }
}

module.exports = { syncTransactionToLedger, syncTransactionToLedgerWithAdapter };
