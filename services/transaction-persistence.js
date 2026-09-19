/**
 * Atomic persistence for flat transaction JSON, its ledger mirror, and the
 * one immutable customer invoice created by a new named-customer sale.
 */

const crypto = require('crypto');
const {
    TransactionCustomerValidationError,
    resolveTransactionCustomer
} = require('./transaction-customer-validation');
const { syncTransactionToLedgerWithAdapter } = require('./ledger');
const { KesMoneyValidationError, normalizeNewTransactionAmount } = require('./kes-money');
const {
    SettlementConflictError,
    SettlementNotFoundError,
    recordCustomerAccountEventWithAdapter
} = require('./customer-settlement');
const {
    ProductionInventoryValidationError,
    ProductionInventoryConflictError,
    createProductionInventoryService
} = require('./production-inventory');

class TransactionPersistenceValidationError extends Error {}
class TransactionPersistenceConflictError extends Error {}

function opaquePathValue(value, field) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new TransactionPersistenceValidationError(`${field} is invalid`);
    }
    return value.trim();
}

function transactionPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TransactionPersistenceValidationError('transaction is invalid');
    }
    return value;
}

function transactionId(value, batchId) {
    if (value === undefined || value === null || value === '') {
        return `tx:${crypto.randomUUID()}`;
    }
    const id = opaquePathValue(value, 'transaction id');
    if (id.length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(id)) {
        throw new TransactionPersistenceValidationError('transaction id is invalid');
    }
    return id;
}

function batchIdCandidates(batchId) {
    const supplied = opaquePathValue(batchId, 'batch id');
    const canonical = supplied.endsWith('.0') ? supplied.slice(0, -2) : supplied;
    return [canonical, `${canonical}.0`];
}

function defaultDependencies() {
    const db = require('../db');
    return {
        withDedicatedTransaction: db.withDedicatedTransaction,
        resolveTransactionCustomer,
        syncTransactionToLedgerWithAdapter,
        recordCustomerAccountEventWithAdapter
    };
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function invoiceToken(transactionIdValue) {
    return crypto.createHash('sha256').update(`customer-invoice:${transactionIdValue}`).digest('hex');
}

function namedSaleForStorage(transaction) {
    const stored = { ...transaction, status: 'unpaid' };
    // A named sale records an invoice, not a tender. Do not preserve a client
    // payment snapshot that could later be mistaken for settlement evidence.
    delete stored.payment_method;
    delete stored.mpesa_code;
    delete stored.created_by_user_id;
    return stored;
}

function actorId(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(value.trim())) {
        throw new TransactionPersistenceValidationError('transaction actor is invalid');
    }
    return value.trim();
}

function translateInventoryError(error) {
    if (error instanceof ProductionInventoryValidationError) {
        throw new TransactionPersistenceValidationError(error.message);
    }
    if (error instanceof ProductionInventoryConflictError) {
        throw new TransactionPersistenceConflictError(error.message);
    }
    throw error;
}

function isNamedSale(transaction) {
    return transaction.type === 'sale' && typeof transaction.customerId === 'string' && transaction.customerId.length > 0;
}

function createTransactionPersistenceService(overrides = {}) {
    const required = ['withDedicatedTransaction', 'resolveTransactionCustomer', 'syncTransactionToLedgerWithAdapter', 'recordCustomerAccountEventWithAdapter'];
    const defaults = required.some(name => overrides[name] === undefined) ? defaultDependencies() : {};
    const dependencies = {
        ...defaults,
        productionInventory: createProductionInventoryService(),
        ...overrides
    };
    for (const name of required) {
        if (typeof dependencies[name] !== 'function') {
            throw new TypeError(`transaction persistence requires ${name}`);
        }
    }
    if (!dependencies.productionInventory
        || typeof dependencies.productionInventory.recordTransactionWithAdapter !== 'function'
        || typeof dependencies.productionInventory.assertTransactionMutableWithAdapter !== 'function'
        || typeof dependencies.productionInventory.hasTransactionMovementWithAdapter !== 'function'
        || typeof dependencies.productionInventory.assertTransactionDeletableWithAdapter !== 'function'
        || typeof dependencies.productionInventory.assertBatchTransactionsDeletableWithAdapter !== 'function') {
        throw new TypeError('transaction persistence requires production inventory service');
    }

    async function createOrUpdateTransaction(batchIdValue, requestedTransaction, authenticatedActorId) {
        const batchId = opaquePathValue(batchIdValue, 'batch id');
        const candidates = batchIdCandidates(batchId);
        const input = transactionPayload(requestedTransaction);
        let requested;
        let amountMinor;
        try {
            ({ transaction: requested, amountMinor } = normalizeNewTransactionAmount(input));
        } catch (error) {
            if (error instanceof KesMoneyValidationError) {
                throw new TransactionPersistenceValidationError(error.message);
            }
            throw error;
        }
        return dependencies.withDedicatedTransaction(async adapter => {
            let resolved;
            try {
                // Customer active-state validation intentionally reads through this
                // same dedicated adapter before the JSON and ledger writes.
                resolved = await dependencies.resolveTransactionCustomer(requested, adapter);
            } catch (error) {
                if (error instanceof TransactionCustomerValidationError) {
                    throw new TransactionPersistenceValidationError(error.message);
                }
                throw error;
            }
            let tx = { ...resolved, id: transactionId(resolved.id, batchId) };
            const namedSale = isNamedSale(tx);
            if (namedSale) tx = namedSaleForStorage(tx);

            const existing = await adapter.getQuery('SELECT batch_id, data FROM transactions WHERE id = ?', [tx.id]);
            if (existing && !candidates.includes(existing.batch_id)) {
                throw new TransactionPersistenceConflictError('transaction belongs to another batch');
            }
            if (existing) {
                const invoice = await adapter.getQuery(`SELECT id FROM customer_account_events
                    WHERE kind = 'invoice' AND status = 'posted' AND source_transaction_id = ?`, [tx.id]);
                if (invoice) {
                    let previous;
                    try { previous = JSON.parse(existing.data); } catch { throw new TransactionPersistenceConflictError('stored transaction is invalid'); }
                    // An invoice freezes its source sale. A retry must remain a
                    // normalized named sale and must be byte-for-byte equivalent
                    // after canonical key ordering; it must not reattribute the
                    // posted invoice to the caller making the retry.
                    if (!namedSale || stableJson(previous) !== stableJson(tx)) {
                        throw new TransactionPersistenceConflictError('posted invoice sale is immutable');
                    }
                    return previous;
                }
            }
            // Once a feed receipt or egg dispatch has reached the prospective
            // inventory sub-ledger, changing the source JSON would desync the
            // physical and financial audit trails. Exact named-sale retries
            // returned above remain idempotent.
            let exactExisting = false;
            if (existing) {
                let previous;
                try { previous = JSON.parse(existing.data); } catch { throw new TransactionPersistenceConflictError('stored transaction is invalid'); }
                exactExisting = stableJson(previous) === stableJson(tx);
            }
            try {
                await dependencies.productionInventory.assertTransactionMutableWithAdapter(adapter, tx, { allowExisting: exactExisting });
            } catch (error) {
                translateInventoryError(error);
            }
            const actor = namedSale ? actorId(authenticatedActorId) : null;
            // A legacy `.0` alias identifies the same batch. Preserve the exact
            // stored batch ID so an update never silently moves historical JSON.
            const storedBatchId = existing ? existing.batch_id : batchId;
            await adapter.runQuery(
                `INSERT INTO transactions (id, batch_id, data, updated_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
                [tx.id, storedBatchId, JSON.stringify(tx)]
            );
            await dependencies.syncTransactionToLedgerWithAdapter(adapter, batchId, tx, false, { amountMinor });
            if (namedSale) {
                const token = invoiceToken(tx.id);
                try {
                    await dependencies.recordCustomerAccountEventWithAdapter({
                        id: `invoice:${token.slice(0, 32)}`,
                        customer_id: tx.customerId,
                        kind: 'invoice',
                        status: 'posted',
                        amount_minor: amountMinor,
                        source_transaction_id: tx.id,
                        idempotency_key: `invoice:${token.slice(0, 48)}`,
                        created_by_user_id: actor
                    }, adapter);
                } catch (error) {
                    if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError) {
                        throw new TransactionPersistenceConflictError('customer invoice conflicts');
                    }
                    throw error;
                }
            }
            // A source that existed before this feature is a historical record,
            // even if an operator later corrects its JSON.  Only a new source,
            // or a retry of an already-tracked source, can affect the
            // prospective zero-opening sub-ledger.
            const alreadyTracked = existing
                ? await dependencies.productionInventory.hasTransactionMovementWithAdapter(adapter, tx.id)
                : false;
            if (!existing || alreadyTracked) {
                try {
                    await dependencies.productionInventory.recordTransactionWithAdapter(
                        adapter, storedBatchId, tx, amountMinor, authenticatedActorId || 'system'
                    );
                } catch (error) {
                    translateInventoryError(error);
                }
            }
            return tx;
        });
    }

    async function deleteTransaction(batchIdValue, transactionIdValue) {
        const transactionIdValueNormalized = opaquePathValue(transactionIdValue, 'transaction id');
        const candidates = batchIdCandidates(batchIdValue);
        return dependencies.withDedicatedTransaction(async adapter => {
            const existing = await adapter.getQuery(
                'SELECT batch_id FROM transactions WHERE id = ?',
                [transactionIdValueNormalized]
            );
            if (!existing || !candidates.includes(existing.batch_id)) {
                return { id: transactionIdValueNormalized, deleted: false };
            }
            const invoice = await adapter.getQuery(`SELECT id FROM customer_account_events
                WHERE kind = 'invoice' AND status = 'posted' AND source_transaction_id = ?`, [transactionIdValueNormalized]);
            if (invoice) throw new TransactionPersistenceConflictError('posted invoice sale cannot be deleted');
            try {
                await dependencies.productionInventory.assertTransactionDeletableWithAdapter(adapter, transactionIdValueNormalized);
            } catch (error) {
                translateInventoryError(error);
            }
            await dependencies.syncTransactionToLedgerWithAdapter(
                adapter,
                candidates[0],
                { id: transactionIdValueNormalized },
                true
            );
            await adapter.runQuery(
                'DELETE FROM transactions WHERE id = ? AND batch_id = ?',
                [transactionIdValueNormalized, existing.batch_id]
            );
            return { id: transactionIdValueNormalized, deleted: true };
        });
    }

    async function deleteTransactionsForBatch(batchIdValue) {
        const candidates = batchIdCandidates(batchIdValue);
        return dependencies.withDedicatedTransaction(async adapter => {
            const rows = await adapter.allQuery(
                'SELECT id FROM transactions WHERE batch_id IN (?, ?) ORDER BY id',
                candidates
            );
            for (const row of rows) {
                const invoice = await adapter.getQuery(`SELECT id FROM customer_account_events
                    WHERE kind = 'invoice' AND status = 'posted' AND source_transaction_id = ?`, [row.id]);
                if (invoice) throw new TransactionPersistenceConflictError('posted invoice sale cannot be deleted');
            }
            try {
                await dependencies.productionInventory.assertBatchTransactionsDeletableWithAdapter(adapter, candidates);
            } catch (error) {
                translateInventoryError(error);
            }
            for (const row of rows) {
                await dependencies.syncTransactionToLedgerWithAdapter(adapter, candidates[0], { id: row.id }, true);
            }
            await adapter.runQuery('DELETE FROM transactions WHERE batch_id IN (?, ?)', candidates);
            return { deleted: rows.map(row => row.id) };
        });
    }

    return {
        createOrUpdateTransaction,
        deleteTransaction,
        deleteTransactionsForBatch
    };
}

function defaultService() {
    return createTransactionPersistenceService();
}

module.exports = {
    TransactionPersistenceValidationError,
    TransactionPersistenceConflictError,
    batchIdCandidates,
    createTransactionPersistenceService,
    createOrUpdateTransaction: (...args) => defaultService().createOrUpdateTransaction(...args),
    deleteTransaction: (...args) => defaultService().deleteTransaction(...args),
    deleteTransactionsForBatch: (...args) => defaultService().deleteTransactionsForBatch(...args)
};
