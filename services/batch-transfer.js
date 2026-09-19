'use strict';

const crypto = require('crypto');

class BatchTransferValidationError extends Error {}
class BatchTransferConflictError extends Error {}
class BatchTransferNotFoundError extends Error {}

const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function opaque(value, field) {
    if (typeof value !== 'string' || !OPAQUE_ID.test(value.trim())) throw new BatchTransferValidationError(`${field} must be an opaque identifier`);
    return value.trim();
}
function batchId(value) { return opaque(value, 'batch id').replace(/\.0$/, ''); }
function text(value, field, max = 500) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001F\u007F]/.test(value)) throw new BatchTransferValidationError(`invalid ${field}`);
    return value.trim();
}
function quantity(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new BatchTransferValidationError('invalid transfer quantity');
    return value;
}
function transferDate(value) {
    const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new BatchTransferValidationError('invalid transfer date');
    return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function defaultDependencies() { return { withDedicatedTransaction: require('../db').withDedicatedTransaction }; }

function createBatchTransferService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined ? defaultDependencies() : {};
    const dependencies = { ...defaults, ...overrides };
    if (typeof dependencies.withDedicatedTransaction !== 'function') throw new TypeError('batch transfer requires a transaction boundary');

    async function recordTransfer(input = {}) {
        const request = {
            batch_id: batchId(input.batch_id),
            source_location_id: opaque(input.source_location_id, 'source location'),
            destination_location_id: opaque(input.destination_location_id, 'destination location'),
            transfer_date: transferDate(input.transfer_date),
            quantity: quantity(input.quantity),
            reason: text(input.reason, 'transfer reason'),
            idempotency_key: opaque(input.idempotency_key, 'idempotency key'),
            actor_user_id: opaque(input.actor_user_id, 'actor id')
        };
        if (request.source_location_id === request.destination_location_id) throw new BatchTransferValidationError('transfer locations must differ');
        const fingerprint = digest({ ...request, actor_user_id: undefined });
        const id = `transfer:${digest(request.idempotency_key).slice(0, 32)}`;
        return dependencies.withDedicatedTransaction(async db => {
            const prior = await db.getQuery('SELECT * FROM batch_transfers WHERE idempotency_key = ?', [request.idempotency_key]);
            if (prior) {
                if (prior.request_fingerprint !== fingerprint) throw new BatchTransferConflictError('transfer idempotency key conflicts');
                return { idempotent: true, transfer: safe(prior) };
            }
            const row = await db.getQuery('SELECT id, data FROM batches WHERE id IN (?, ?) ORDER BY id = ? DESC LIMIT 1', [request.batch_id, `${request.batch_id}.0`, request.batch_id]);
            if (!row) throw new BatchTransferNotFoundError('batch was not found');
            let batch;
            try { batch = JSON.parse(row.data); } catch (_) { throw new BatchTransferConflictError('batch record is unreadable'); }
            if (batch.status === 'completed' || batch.closure_review) throw new BatchTransferConflictError('closed batches cannot be transferred');
            const cohortId = opaque(batch.cohort_id, 'batch cohort');
            const openingLocation = opaque(batch.location_id, 'batch location');
            const knownSource = request.source_location_id === openingLocation || await db.getQuery(
                'SELECT id FROM batch_transfers WHERE batch_id = ? AND destination_location_id = ? LIMIT 1', [row.id, request.source_location_id]
            );
            if (!knownSource) throw new BatchTransferConflictError('transfer source has no recorded cohort location');
            const birdsAlive = Number.isSafeInteger(batch.stats?.birdsAlive) ? batch.stats.birdsAlive : batch.size;
            if (!Number.isSafeInteger(birdsAlive) || birdsAlive < request.quantity) throw new BatchTransferConflictError('transfer quantity exceeds recorded live birds');
            await db.runQuery(`INSERT INTO batch_transfers (
                id, batch_id, cohort_id, source_location_id, destination_location_id, transfer_date, quantity,
                reason, created_by_user_id, idempotency_key, request_fingerprint
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                id, row.id, cohortId, request.source_location_id, request.destination_location_id, request.transfer_date,
                request.quantity, request.reason, request.actor_user_id, request.idempotency_key, fingerprint
            ]);
            return { idempotent: false, transfer: safe(await db.getQuery('SELECT * FROM batch_transfers WHERE id = ?', [id])) };
        });
    }

    return { recordTransfer };
}

function safe(row) {
    return row && {
        id: row.id, batch_id: row.batch_id, cohort_id: row.cohort_id, source_location_id: row.source_location_id,
        destination_location_id: row.destination_location_id, transfer_date: row.transfer_date, quantity: row.quantity,
        reason: row.reason, created_by_user_id: row.created_by_user_id, created_at: row.created_at
    };
}

module.exports = { BatchTransferValidationError, BatchTransferConflictError, BatchTransferNotFoundError, createBatchTransferService };
