/** HTTP boundary for posted commercial credit notes. */

const {
    CustomerCreditNoteNotFoundError,
    CustomerCreditNoteConflictError
} = require('./customer-credit-note');

const FIELDS = new Set([
    'customer_id',
    'invoice_event_id',
    'amount',
    'reason_code',
    'external_reference',
    'idempotency_key'
]);
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const REASONS = new Set(['return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other']);

function exactPayload(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).every(key => FIELDS.has(key) && !DANGEROUS.has(key))
        && ['customer_id', 'invoice_event_id', 'amount', 'reason_code', 'idempotency_key']
            .every(key => Object.hasOwn(value, key))
        && REASONS.has(value.reason_code);
}

function safeError(res, status, error) {
    return res.status(status).json({ error });
}

function failure(res, error) {
    if (error instanceof CustomerCreditNoteNotFoundError) {
        return safeError(res, 404, 'Customer or invoice not found');
    }
    if (error instanceof CustomerCreditNoteConflictError) {
        return safeError(res, 409, 'Customer credit note conflicts');
    }
    if (error instanceof TypeError || error instanceof RangeError) {
        return safeError(res, 400, 'Invalid customer credit note');
    }
    return safeError(res, 500, 'Customer credit note service unavailable');
}

function registerCustomerCreditNoteApi(app, { creditNoteService, requireRole } = {}) {
    if (!creditNoteService || typeof creditNoteService.issueCustomerCreditNote !== 'function'
        || typeof requireRole !== 'function') {
        throw new TypeError('customer credit note service and roles are required');
    }
    app.post('/api/customer-credit-notes', requireRole('super_admin', 'admin'), async (req, res) => {
        if (!exactPayload(req.body)) return safeError(res, 400, 'Invalid customer credit note');
        try {
            const outcome = await creditNoteService.issueCustomerCreditNote({
                customer_id: req.body.customer_id,
                invoice_event_id: req.body.invoice_event_id,
                amount: req.body.amount,
                reason_code: req.body.reason_code,
                external_reference: req.body.external_reference,
                idempotency_key: req.body.idempotency_key,
                created_by_user_id: req.session.userId
            });
            return res.status(outcome.idempotent ? 200 : 201).json(outcome);
        } catch (error) {
            return failure(res, error);
        }
    });
}

module.exports = { registerCustomerCreditNoteApi, exactPayload, failure };
