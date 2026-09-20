'use strict';

const { ProductionInventoryConflictError } = require('./production-inventory');

class BatchDeletionValidationError extends Error {}
class BatchDeletionConflictError extends Error {}

function batchIdCandidates(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new BatchDeletionValidationError('batch id is invalid');
    }
    const supplied = value.trim();
    const canonical = supplied.endsWith('.0') ? supplied.slice(0, -2) : supplied;
    return [canonical, `${canonical}.0`];
}

function defaultDependencies() {
    return { withDedicatedTransaction: require('../db').withDedicatedTransaction };
}

function defaultProductionInventory() {
    return require('./production-inventory').createProductionInventoryService();
}

async function first(adapter, sql, params = []) {
    return adapter.getQuery(`${sql} LIMIT 1`, params);
}

async function protectedEvidenceForTransactions(adapter, transactionWhere, params) {
    if (await first(adapter, `
        SELECT t.id
          FROM transactions t
          JOIN customer_account_events e ON e.source_transaction_id = t.id
         WHERE ${transactionWhere}
    `, params)) return 'customer_account_event';

    if (await first(adapter, `
        SELECT t.id
          FROM transactions t
          JOIN ledger_transactions l ON l.id = t.id OR l.ref_id = t.id
         WHERE ${transactionWhere}
    `, params)) return 'ledger_transaction';

    if (await first(adapter, `
        SELECT t.id
          FROM transactions t
          JOIN payment_imports p ON p.created_transaction_id = t.id
         WHERE ${transactionWhere}
    `, params)) return 'payment_import_transaction';

    return null;
}

function createBatchDeletionService(overrides = {}) {
    const defaults = {};
    if (overrides.withDedicatedTransaction === undefined) Object.assign(defaults, defaultDependencies());
    if (overrides.productionInventory === undefined) defaults.productionInventory = defaultProductionInventory();
    const dependencies = { ...defaults, ...overrides };
    if (typeof dependencies.withDedicatedTransaction !== 'function'
        || typeof dependencies.productionInventory?.assertBatchTransactionsDeletableWithAdapter !== 'function') {
        throw new TypeError('batch deletion requires transaction and production inventory boundaries');
    }

    async function retainedBatchHistory(adapter, where, params) {
        const batches = await adapter.allQuery(`SELECT id, data FROM batches WHERE ${where}`, params);
        for (const row of batches) {
            let batch;
            try { batch = JSON.parse(row.data); } catch (_) { return true; }
            if (batch?.status === 'completed' || batch?.closure_review) return true;
        }
        return false;
    }

    async function assertInventoryRetained(adapter, batchIds) {
        if (batchIds.length === 0) return;
        try {
            await dependencies.productionInventory.assertBatchTransactionsDeletableWithAdapter(adapter, batchIds);
        } catch (error) {
            if (error instanceof ProductionInventoryConflictError) {
                throw new BatchDeletionConflictError('batch has retained evidence');
            }
            throw error;
        }
    }

    async function deleteBatch(batchIdValue) {
        const candidates = batchIdCandidates(batchIdValue);
        return dependencies.withDedicatedTransaction(async adapter => {
            const closure = await retainedBatchHistory(adapter, 'id IN (?, ?)', candidates);
            const evidence = await protectedEvidenceForTransactions(
                adapter,
                't.batch_id IN (?, ?)',
                candidates
            );
            const paymentImport = await first(
                adapter,
                'SELECT id FROM payment_imports WHERE batch_id IN (?, ?)',
                candidates
            );
            const staging = await first(
                adapter,
                'SELECT id FROM staging WHERE batch_id IN (?, ?)',
                candidates
            );
            const transfer = await first(
                adapter,
                'SELECT id FROM batch_transfers WHERE batch_id IN (?, ?)',
                candidates
            );
            if (closure || evidence || paymentImport || staging || transfer) {
                throw new BatchDeletionConflictError('batch has retained evidence');
            }
            await assertInventoryRetained(adapter, candidates);

            await adapter.runQuery('DELETE FROM logs WHERE batch_id IN (?, ?)', candidates);
            await adapter.runQuery('DELETE FROM health_logs WHERE batch_id IN (?, ?)', candidates);
            await adapter.runQuery('DELETE FROM transactions WHERE batch_id IN (?, ?)', candidates);
            const deletion = await adapter.runQuery('DELETE FROM batches WHERE id IN (?, ?)', candidates);
            return { deleted: deletion.changes > 0 };
        });
    }

    async function deleteAllBatches() {
        return dependencies.withDedicatedTransaction(async adapter => {
            const batches = await adapter.allQuery('SELECT id, data FROM batches');
            const closure = await retainedBatchHistory(adapter, '1 = 1', []);
            const evidence = await protectedEvidenceForTransactions(adapter, '1 = 1', []);
            const paymentImport = await first(adapter, 'SELECT id FROM payment_imports WHERE batch_id IS NOT NULL');
            const staging = await first(adapter, 'SELECT id FROM staging');
            const transfer = await first(adapter, 'SELECT id FROM batch_transfers');
            if (closure || evidence || paymentImport || staging || transfer) {
                throw new BatchDeletionConflictError('one or more batches have retained evidence');
            }
            await assertInventoryRetained(adapter, batches.map(row => row.id));

            await adapter.runQuery('DELETE FROM logs');
            await adapter.runQuery('DELETE FROM health_logs');
            await adapter.runQuery('DELETE FROM transactions');
            const deletion = await adapter.runQuery('DELETE FROM batches');
            return { deleted: deletion.changes };
        });
    }

    return { deleteBatch, deleteAllBatches };
}

function defaultService() {
    return createBatchDeletionService();
}

module.exports = {
    BatchDeletionValidationError,
    BatchDeletionConflictError,
    batchIdCandidates,
    createBatchDeletionService,
    deleteBatch: (...args) => defaultService().deleteBatch(...args),
    deleteAllBatches: (...args) => defaultService().deleteAllBatches(...args)
};
