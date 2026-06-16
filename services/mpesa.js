const { runQuery, getQuery, allQuery } = require('../db');

let BATCH_STATUS = { ACTIVE: 'active', POST_BATCH: 'post_batch', COMPLETED: 'completed' };

import('../js/engine.js').then(engine => {
    if (engine.BATCH_STATUS) BATCH_STATUS = engine.BATCH_STATUS;
}).catch(err => {
    console.error('Failed to dynamically import engine.js inside mpesa service:', err.message);
});

/**
 * Helper to sync a flat transaction to the double-entry general ledger.
 */
async function syncTransactionToLedger(batchId, tx, isDelete = false) {
    if (!tx || !tx.id) return;
    
    await runQuery('BEGIN TRANSACTION');
    try {
        // Delete existing entries first
        await runQuery('DELETE FROM ledger_transactions WHERE id = ?', [tx.id]);
        if (isDelete) {
            await runQuery('COMMIT');
            return;
        }

        // Insert transaction header
        const desc = tx.notes || `${tx.type} ${tx.category || ''}`;
        const date = tx.date || new Date().toISOString();
        const refType = tx.type || 'unknown';
        const refId = tx.mpesa_code || tx.id;
        
        await runQuery(
            'INSERT INTO ledger_transactions (id, date, description, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)',
            [tx.id, date, desc, refType, refId]
        );

        const amount = parseFloat(tx.amount || 0) || 0;
        if (amount <= 0) {
            await runQuery('COMMIT');
            return; // No entries for zero amount
        }

        let drAccount = '1000'; // Default Cash
        let crAccount = '4000'; // Default Revenue

        const type = tx.type;
        const cat = tx.category || '';
        const terms = tx.buyerTerms || 'COD';
        const payment = tx.payment_method || 'cash';

        if (type === 'sale') {
            if (terms !== 'COD' && terms !== 'cash') {
                drAccount = '1200'; // Accounts Receivable
            } else if (payment === 'mpesa') {
                drAccount = '1010'; // M-Pesa Till
            } else {
                drAccount = '1000'; // Cash
            }
            if (cat === 'spent' || cat === 'roosters' || cat === 'rooster') {
                crAccount = '4010'; // Flock Sales Revenue
            } else {
                crAccount = '4000'; // Egg Sales
            }
        } else if (type === 'purchase') {
            if (cat === 'feed') {
                drAccount = '1310'; // Feed Inventory
            } else if (cat === 'labor') {
                drAccount = '5010'; // Labor
            } else if (cat === 'electricity' || cat === 'water' || cat === 'utility') {
                drAccount = '5020'; // Utilities
            } else if (cat === 'vaccines' || cat === 'meds' || cat === 'health') {
                drAccount = '5030'; // Meds
            } else if (cat === 'chicks') {
                drAccount = '5040'; // Chicks
            } else {
                drAccount = '5000'; // Feed Expense
            }
            
            if (payment === 'mpesa') {
                crAccount = '1010'; // M-Pesa Till
            } else {
                crAccount = '1000'; // Cash
            }
        } else if (type === 'return') {
            drAccount = '4000';
            if (payment === 'mpesa') {
                crAccount = '1010';
            } else {
                crAccount = '1000';
            }
        } else if (type === 'write_off') {
            drAccount = '5000';
            if (cat === 'feed') {
                crAccount = '1310';
            } else {
                crAccount = '1300'; // Eggs
            }
        }

        await runQuery(
            'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
            [`${tx.id}_dr`, tx.id, drAccount, 'debit', amount]
        );

        await runQuery(
            'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
            [`${tx.id}_cr`, tx.id, crAccount, 'credit', amount]
        );

        await runQuery('COMMIT');
    } catch (err) {
        await runQuery('ROLLBACK').catch(() => {});
        throw err;
    }
}

/**
 * Handles Safaricom Daraja API confirmed callbacks.
 */
async function handleMpesaCallback(body) {
    console.log('M-Pesa Callback Payload:', JSON.stringify(body));
    
    let mpesaCode = '';
    let amount = 0;
    let phone = '';
    let billRef = '';
    
    if (body.Body && body.Body.stkCallback) {
        const stk = body.Body.stkCallback;
        if (stk.ResultCode !== 0) {
            console.log(`STK Push failed: ${stk.ResultDesc}`);
            return { body: { ResultCode: 0, ResultDesc: "Accepted" } };
        }
        const items = stk.CallbackMetadata?.Item || [];
        mpesaCode = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || '';
        amount = parseFloat(items.find(i => i.Name === 'Amount')?.Value || 0);
        phone = String(items.find(i => i.Name === 'PhoneNumber')?.Value || '');
    } else if (body.TransID) {
        mpesaCode = body.TransID;
        amount = parseFloat(body.TransAmount || 0);
        phone = String(body.MSISDN || '');
        billRef = String(body.BillRefNumber || '').trim();
    } else {
        return { status: 400, body: { error: 'Unsupported callback payload format' } };
    }

    if (!mpesaCode || amount <= 0) {
        return { body: { ResultCode: 0, ResultDesc: "Accepted" } };
    }

    const existingTx = await getQuery('SELECT id FROM ledger_transactions WHERE ref_id = ?', [mpesaCode]);
    if (existingTx) {
        console.log(`M-Pesa callback: Transaction ${mpesaCode} already processed.`);
        return { body: { ResultCode: 0, ResultDesc: "Accepted" } };
    }

    const activeBatchRow = await getQuery("SELECT id FROM batches WHERE json_extract(data, '$.status') = ? LIMIT 1", [BATCH_STATUS.ACTIVE]);
    const batchId = activeBatchRow ? activeBatchRow.id : '1779692918051';

    let matchedBuyer = null;
    if (phone) {
        const cleanPhone = phone.replace('+', '').replace(/^254/, '0');
        const profileEntity = await getQuery("SELECT value FROM entities WHERE key = 'poultryFarmProfile'");
        if (profileEntity) {
            const profile = JSON.parse(profileEntity.value) || {};
            const buyers = profile.buyers || [];
            matchedBuyer = buyers.find(b => {
                const bPhone = String(b.phone || '').replace('+', '').replace(/^254/, '0');
                return bPhone && bPhone === cleanPhone;
            });
        }
    }

    const txId = `mpesa_${Date.now()}_${mpesaCode}`;
    const desc = `M-Pesa payment from ${phone}${matchedBuyer ? ` (${matchedBuyer.name})` : ''} - Ref: ${mpesaCode}`;
    
    await runQuery('BEGIN TRANSACTION');
    try {
        await runQuery(
            'INSERT INTO ledger_transactions (id, date, description, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)',
            [txId, new Date().toISOString(), desc, 'mpesa', mpesaCode]
        );

        let drAccount = '1010';
        let crAccount = '9999';

        if (matchedBuyer) {
            crAccount = '1200';
        }

        await runQuery(
            'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
            [`${txId}_dr`, txId, drAccount, 'debit', amount]
        );

        await runQuery(
            'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
            [`${txId}_cr`, txId, crAccount, 'credit', amount]
        );

        await runQuery(
            'INSERT INTO transactions (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
            [
                txId,
                batchId,
                JSON.stringify({
                    id: txId,
                    date: new Date().toISOString(),
                    type: 'sale',
                    category: 'eggs',
                    amount: amount,
                    qty: 0,
                    buyerName: matchedBuyer ? matchedBuyer.name : 'M-Pesa Unmatched',
                    buyerTerms: 'COD',
                    payment_method: 'mpesa',
                    notes: `M-Pesa Ref: ${mpesaCode}. Phone: ${phone}`
                })
            ]
        );

        await runQuery('COMMIT');
    } catch (dbErr) {
        await runQuery('ROLLBACK').catch(() => {});
        throw dbErr;
    }

    console.log(`M-Pesa transaction ${mpesaCode} processed successfully. Match: ${matchedBuyer ? matchedBuyer.name : 'None (Suspense)'}`);
    return { body: { ResultCode: 0, ResultDesc: "Accepted" } };
}

module.exports = {
    syncTransactionToLedger,
    handleMpesaCallback
};
