'use strict';

const { getBatchHouseBalances } = require('./batch-house-balance');

class BatchClosureValidationError extends Error {}
class BatchClosureConflictError extends Error {}

const EXCEPTION_CODES = new Set([
    'inventory_variance', 'ledger_ambiguity', 'documentation_gap', 'external_system_delay', 'other'
]);

function canonicalBatchId(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new BatchClosureValidationError('invalid batch id');
    }
    return value.trim().replace(/\.0$/, '');
}

function boundedText(value, field, { min = 1, max = 500 } = {}) {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new BatchClosureValidationError(`invalid ${field}`);
    }
    return value.trim();
}

function normalizeException(value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BatchClosureValidationError('invalid reconciliation exception');
    if (!EXCEPTION_CODES.has(value.code)) throw new BatchClosureValidationError('invalid reconciliation exception code');
    return {
        code: value.code,
        note: boundedText(value.note, 'reconciliation exception note')
    };
}

function defaultDependencies() {
    return { withDedicatedTransaction: require('../db').withDedicatedTransaction };
}

function createBatchClosureService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined ? defaultDependencies() : {};
    const dependencies = { ...defaults, ...overrides };
    if (typeof dependencies.withDedicatedTransaction !== 'function') throw new TypeError('batch closure requires a transaction boundary');

    async function closeBatch({ batch_id, reconciliation_exception, actor_user_id, closed_at = new Date().toISOString() } = {}) {
        const batchId = canonicalBatchId(batch_id);
        const actor = boundedText(actor_user_id, 'actor id', { max: 256 });
        const exception = normalizeException(reconciliation_exception);
        const closedAt = new Date(closed_at);
        if (Number.isNaN(closedAt.getTime())) throw new BatchClosureValidationError('invalid closure time');

        return dependencies.withDedicatedTransaction(async adapter => {
            const row = await adapter.getQuery('SELECT id, data FROM batches WHERE id IN (?, ?) ORDER BY id = ? DESC LIMIT 1', [batchId, `${batchId}.0`, batchId]);
            if (!row) throw new BatchClosureConflictError('batch does not exist');
            let batch;
            try { batch = JSON.parse(row.data); } catch (_) { throw new BatchClosureConflictError('batch record is unreadable'); }
            if (batch.status === 'completed' || batch.closure_review) throw new BatchClosureConflictError('batch is already closed');
            if (typeof batch.cohort_id !== 'string' || !batch.cohort_id.trim() || typeof batch.location_id !== 'string' || !batch.location_id.trim()) {
                throw new BatchClosureConflictError('batch requires explicit cohort and location identity before closure');
            }

            const allocation = await getBatchHouseBalances(adapter, {
                batch_id: row.id,
                as_of_date: closedAt.toISOString().slice(0, 10)
            });
            if (allocation.conflict) throw new BatchClosureConflictError('house allocation records are inconsistent and require review');
            const finalLocations = allocation.balances.filter(item => item.live_birds > 0);

            // Ledger transactions are keyed by the farm transaction ID.  Their
            // ref_id is an external receipt code when one exists, so it cannot
            // be matched directly to the batch ID.
            const unresolved = await adapter.allQuery(`
                SELECT l.id AS ledger_transaction_id
                  FROM transactions t
                  JOIN ledger_transactions l ON l.id = t.id
                  LEFT JOIN ledger_entries e ON e.transaction_id = l.id
                 WHERE t.batch_id = ?
                 GROUP BY l.id
                HAVING COUNT(e.id) = 0
                    OR SUM(CASE WHEN e.reconciliation_status = 'exact' THEN 0 ELSE 1 END) > 0
                 ORDER BY l.id ASC`, [row.id]);
            if (unresolved.length > 0 && !exception) {
                throw new BatchClosureConflictError('unresolved reconciliation requires a reviewed exception');
            }

            batch.status = 'completed';
            batch.closeDate = closedAt.toISOString();
            batch.closure_review = {
                policy_version: 1,
                cohort_id: batch.cohort_id,
                // Kept for compatibility when the cohort ended in one house;
                // final_locations is the authoritative split-cohort record.
                final_location_id: finalLocations.length === 1 ? finalLocations[0].location_id : null,
                final_locations: finalLocations,
                status: unresolved.length > 0 ? 'exception_accepted' : 'exact',
                unresolved_ledger_transaction_ids: unresolved.map(item => item.ledger_transaction_id),
                reconciliation_exception: exception,
                reviewed_by_user_id: actor,
                reviewed_at: closedAt.toISOString()
            };
            await adapter.runQuery('UPDATE batches SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(batch), row.id]);
            return { batch, unresolved_count: unresolved.length };
        });
    }

    return { closeBatch };
}

module.exports = { BatchClosureValidationError, BatchClosureConflictError, EXCEPTION_CODES, createBatchClosureService };
