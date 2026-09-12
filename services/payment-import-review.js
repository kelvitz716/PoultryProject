/**
 * Rejection-only review operation for payment imports. No approval or accounting work lives here.
 */

const { redactEvidence } = require('./payment-import-parser');
const { PAYMENT_IMPORT_SAFE_SELECT, toSafePaymentImport } = require('./payment-imports');

const MAX_REVIEW_NOTE_LENGTH = 500;
const OPAQUE_ID = /^[A-Za-z0-9._:@-]+$/;

class PaymentImportNotFoundError extends Error {}
class PaymentImportStateConflictError extends Error {}

function validateOpaqueId(value, field) {
    if (typeof value !== 'string') throw new TypeError(`${field} must be an opaque identifier`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 128 || !OPAQUE_ID.test(normalized)) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return normalized;
}

function looksLikeRawPaymentMessage(value) {
    return /\b[A-Z0-9]{8,14}\s+CONFIRMED\b/i.test(value)
        || /\b(?:KSH|KES)\.?\s*[\d,]+(?:\.\d{1,2})?\b[\s\S]*\b(?:RECEIVED\s+FROM|SENT\s+TO|PAID\s+TO|BUY\s+GOODS|REVERSAL)\b/i.test(value);
}

function normalizeReviewNote(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new TypeError('review_notes must be text');
    const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > MAX_REVIEW_NOTE_LENGTH || /[\u0000-\u001F\u007F]/.test(normalized)) {
        throw new RangeError('review_notes must be bounded safe text');
    }
    // Review notes are not an alternate raw-SMS retention channel.
    if (looksLikeRawPaymentMessage(normalized)) {
        throw new TypeError('review_notes must not contain a raw payment message');
    }
    return redactEvidence(normalized);
}

function resolveAdapter(adapter) {
    const resolved = adapter || require('../db');
    for (const name of ['runQuery', 'getQuery', 'allQuery']) {
        if (typeof resolved[name] !== 'function') throw new TypeError(`payment-import database adapter requires ${name}`);
    }
    return resolved;
}

async function readImport(id, adapter) {
    return toSafePaymentImport(await adapter.getQuery(
        `SELECT ${PAYMENT_IMPORT_SAFE_SELECT} FROM payment_imports WHERE id = ?`,
        [id]
    ));
}

async function rejectPaymentImport({ id, reviewer_user_id, review_notes }, dbAdapter) {
    const paymentImportId = validateOpaqueId(id, 'id');
    const reviewerId = validateOpaqueId(reviewer_user_id, 'reviewer_user_id');
    const note = normalizeReviewNote(review_notes);
    const adapter = resolveAdapter(dbAdapter);

    const rejected = toSafePaymentImport(await adapter.getQuery(`
        UPDATE payment_imports
        SET status = 'rejected',
            reviewer_user_id = ?,
            reviewed_at = CURRENT_TIMESTAMP,
            rejected_at = CURRENT_TIMESTAMP,
            review_notes = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('received', 'needs_review')
        RETURNING ${PAYMENT_IMPORT_SAFE_SELECT}
    `, [reviewerId, note, paymentImportId]));
    if (rejected) return { idempotent: false, payment_import: rejected };

    const existing = await readImport(paymentImportId, adapter);
    if (!existing) throw new PaymentImportNotFoundError('payment import was not found');
    if (existing.status === 'rejected') return { idempotent: true, payment_import: existing };
    throw new PaymentImportStateConflictError('payment import cannot be rejected from its current state');
}

module.exports = {
    MAX_REVIEW_NOTE_LENGTH,
    PaymentImportNotFoundError,
    PaymentImportStateConflictError,
    looksLikeRawPaymentMessage,
    normalizeReviewNote,
    rejectPaymentImport
};
