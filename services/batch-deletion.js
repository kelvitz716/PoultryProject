'use strict';

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
    const defaults = overrides.withDedicatedTransaction === undefined ? defaultDependencies() : {};
    const dependencies = { ...defaults, ...overrides };
    if (typeof dependencies.withDedicatedTransaction !== 'function') {
        throw new TypeError('batch deletion requires withDedicatedTransaction');
    }

    async function deleteBatch(batchIdValue) {
        const candidates = batchIdCandidates(batchIdValue);
        return dependencies.withDedicatedTransaction(async adapter => {
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
            if (evidence || paymentImport || staging) {
                throw new BatchDeletionConflictError('batch has retained evidence');
            }

            await adapter.runQuery('DELETE FROM logs WHERE batch_id IN (?, ?)', candidates);
            await adapter.runQuery('DELETE FROM health_logs WHERE batch_id IN (?, ?)', candidates);
            await adapter.runQuery('DELETE FROM transactions WHERE batch_id IN (?, ?)', candidates);
            const deletion = await adapter.runQuery('DELETE FROM batches WHERE id IN (?, ?)', candidates);
            return { deleted: deletion.changes > 0 };
        });
    }

    async function deleteAllBatches() {
        return dependencies.withDedicatedTransaction(async adapter => {
            const evidence = await protectedEvidenceForTransactions(adapter, '1 = 1', []);
            const paymentImport = await first(adapter, 'SELECT id FROM payment_imports WHERE batch_id IS NOT NULL');
            const staging = await first(adapter, 'SELECT id FROM staging');
            if (evidence || paymentImport || staging) {
                throw new BatchDeletionConflictError('one or more batches have retained evidence');
            }

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
