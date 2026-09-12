/** HTTP boundary for explicit, source-funded customer refunds. */

const { CustomerRefundNotFoundError, CustomerRefundConflictError } = require('./customer-refund');

const FIELDS = new Set([
    'customer_id', 'method', 'amount', 'sources', 'reason_code', 'external_reference',
    'acknowledge_method_difference', 'idempotency_key'
]);
const REQUIRED = ['customer_id', 'method', 'amount', 'sources', 'reason_code', 'acknowledge_method_difference', 'idempotency_key'];
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);

function exactPayload(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).every(key => FIELDS.has(key) && !DANGEROUS.has(key))
        && REQUIRED.every(key => Object.hasOwn(value, key))
        && typeof value.acknowledge_method_difference === 'boolean'
        && Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 50
        && value.sources.every(source => source && typeof source === 'object' && !Array.isArray(source)
            && Object.getPrototypeOf(source) === Object.prototype
            && Object.keys(source).length === 2
            && Object.hasOwn(source, 'credit_event_id') && Object.hasOwn(source, 'amount'));
}

function safeError(res, status, error) {
    return res.status(status).json({ error });
}

function failure(res, error) {
    if (error instanceof CustomerRefundNotFoundError) return safeError(res, 404, 'Customer or refund source not found');
    if (error instanceof CustomerRefundConflictError) return safeError(res, 409, 'Customer refund conflicts');
    if (error instanceof TypeError || error instanceof RangeError) return safeError(res, 400, 'Invalid customer refund');
    return safeError(res, 500, 'Customer refund service unavailable');
}

function registerCustomerRefundApi(app, { refundService, requireRole } = {}) {
    if (!refundService || typeof refundService.issueCustomerRefund !== 'function' || typeof requireRole !== 'function') {
        throw new TypeError('customer refund service and roles are required');
    }
    app.post('/api/customer-refunds', requireRole('super_admin', 'admin'), async (req, res) => {
        if (!exactPayload(req.body)) return safeError(res, 400, 'Invalid customer refund');
        try {
            const outcome = await refundService.issueCustomerRefund({
                customer_id: req.body.customer_id,
                method: req.body.method,
                amount: req.body.amount,
                sources: req.body.sources,
                reason_code: req.body.reason_code,
                external_reference: req.body.external_reference,
                acknowledge_method_difference: req.body.acknowledge_method_difference,
                idempotency_key: req.body.idempotency_key,
                created_by_user_id: req.session.userId
            });
            return res.status(outcome.idempotent ? 200 : 201).json(outcome);
        } catch (error) {
            return failure(res, error);
        }
    });
}

module.exports = { registerCustomerRefundApi, exactPayload, failure };
