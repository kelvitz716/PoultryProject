'use strict';

const crypto = require('crypto');
const { getBatchHouseBalances } = require('./batch-house-balance');

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
function defaultDependencies() {
    const db = require('../db');
    return {
        withDedicatedTransaction: db.withDedicatedTransaction,
        withDedicatedReadTransaction: db.withDedicatedReadTransaction
    };
}

function historyLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new BatchTransferValidationError('invalid transfer history limit');
    return value;
}

function createBatchTransferService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined ? defaultDependencies() : {};
    const dependencies = {
        ...defaults,
        ...overrides,
        withDedicatedReadTransaction: overrides.withDedicatedReadTransaction || defaults.withDedicatedReadTransaction || overrides.withDedicatedTransaction
    };
    if (typeof dependencies.withDedicatedTransaction !== 'function') throw new TypeError('batch transfer requires a transaction boundary');
    if (typeof dependencies.withDedicatedReadTransaction !== 'function') throw new TypeError('batch transfer requires a read transaction boundary');

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
            // Project the entire immutable timeline, including this request.  A
            // location may only send birds that are physically alive there on
            // the stated date; aggregate batch totals cannot bypass this.
            const allocation = await getBatchHouseBalances(db, {
                batch_id: row.id,
                as_of_date: request.transfer_date,
                additional_transfers: [{
                    id, source_location_id: request.source_location_id,
                    destination_location_id: request.destination_location_id,
                    transfer_date: request.transfer_date, quantity: request.quantity,
                    created_at: '9999-12-31T23:59:59.999Z'
                }]
            });
            if (allocation.conflict) {
                if (allocation.conflict.reason === 'transfer_exceeds_source') {
                    throw new BatchTransferConflictError('transfer quantity exceeds live birds at the source location');
                }
                throw new BatchTransferConflictError('recorded house mortality exceeds live birds');
            }
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

    async function listTransfers({ batch_id, limit = 50 } = {}) {
        const requestedBatchId = batchId(batch_id);
        const boundedLimit = historyLimit(limit);
        return dependencies.withDedicatedReadTransaction(async db => {
            const batch = await db.getQuery('SELECT id FROM batches WHERE id IN (?, ?) ORDER BY id = ? DESC LIMIT 1', [requestedBatchId, `${requestedBatchId}.0`, requestedBatchId]);
            if (!batch) throw new BatchTransferNotFoundError('batch was not found');
            const rows = await db.allQuery(`SELECT id, batch_id, cohort_id, source_location_id, destination_location_id,
                transfer_date, quantity, reason, created_by_user_id, created_at
                FROM batch_transfers WHERE batch_id = ?
                ORDER BY transfer_date DESC, created_at DESC, id DESC LIMIT ?`, [batch.id, boundedLimit]);
            return { transfers: rows.map(safe) };
        });
    }

    async function getHouseBalances({ batch_id, as_of_date } = {}) {
        const requestedBatchId = batchId(batch_id);
        return dependencies.withDedicatedReadTransaction(async db => {
            const result = await getBatchHouseBalances(db, { batch_id: requestedBatchId, as_of_date });
            if (!result) throw new BatchTransferNotFoundError('batch was not found');
            if (result.conflict) throw new BatchTransferConflictError('house allocation records are inconsistent');
            return { batch_id: result.batch_id, as_of_date: result.as_of_date, balances: result.balances };
        });
    }

    return { recordTransfer, listTransfers, getHouseBalances };
}

function safe(row) {
    return row && {
        id: row.id, batch_id: row.batch_id, cohort_id: row.cohort_id, source_location_id: row.source_location_id,
        destination_location_id: row.destination_location_id, transfer_date: row.transfer_date, quantity: row.quantity,
        reason: row.reason, created_by_user_id: row.created_by_user_id, created_at: row.created_at
    };
}

module.exports = { BatchTransferValidationError, BatchTransferConflictError, BatchTransferNotFoundError, createBatchTransferService };
