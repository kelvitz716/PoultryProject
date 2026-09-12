/** HTTP boundary for manual cash and bank customer receipts. */

const {
    ManualCustomerReceiptNotFoundError,
    ManualCustomerReceiptConflictError
} = require('./manual-customer-receipt');

const ALLOWED_FIELDS = new Set([
    'customer_id',
    'method',
    'amount',
    'external_reference',
    'idempotency_key'
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeError(res, status, error) {
    return res.status(status).json({ error });
}

function hasDangerousKeys(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return true;
    return Object.keys(value).some(key => DANGEROUS_KEYS.has(key));
}

function validPayload(payload) {
    return !hasDangerousKeys(payload)
        && Object.keys(payload).every(key => ALLOWED_FIELDS.has(key))
        && ['customer_id', 'method', 'amount', 'idempotency_key'].every(key => Object.hasOwn(payload, key));
}

function receiptFailure(res, error) {
    if (error instanceof ManualCustomerReceiptNotFoundError) {
        return safeError(res, 404, 'Customer not found');
    }
    if (error instanceof ManualCustomerReceiptConflictError) {
        return safeError(res, 409, 'Manual customer receipt conflicts');
    }
    if (error instanceof TypeError || error instanceof RangeError) {
        return safeError(res, 400, 'Invalid manual customer receipt');
    }
    return safeError(res, 500, 'Manual customer receipt service unavailable');
}

function registerManualCustomerReceiptApi(app, { receiptService, requireRole } = {}) {
    if (!receiptService || typeof receiptService.recordManualCustomerReceipt !== 'function'
        || typeof requireRole !== 'function') {
        throw new TypeError('manual customer receipt service and roles are required');
    }
    app.post('/api/customer-receipts/manual', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
        if (!validPayload(req.body)) return safeError(res, 400, 'Invalid manual customer receipt');
        try {
            const result = await receiptService.recordManualCustomerReceipt({
                customer_id: req.body.customer_id,
                method: req.body.method,
                amount: req.body.amount,
                external_reference: req.body.external_reference,
                idempotency_key: req.body.idempotency_key,
                created_by_user_id: req.session.userId,
                reviewer_user_id: req.session.userId
            });
            return res.status(result.idempotent ? 200 : 201).json(result);
        } catch (error) {
            return receiptFailure(res, error);
        }
    });
}

module.exports = {
    registerManualCustomerReceiptApi,
    validPayload,
    receiptFailure
};
