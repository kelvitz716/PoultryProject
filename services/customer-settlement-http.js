/** HTTP boundary for explicit customer-credit allocations and safe settlement reads. */

const { parseKesAmount } = require('./kes-money');
const { SettlementConflictError, SettlementNotFoundError } = require('./customer-settlement');

const ALLOCATION_FIELDS = new Set(['credit_event_id', 'debit_event_id', 'amount', 'idempotency_key']);
const EMPTY = new Set();
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function safeError(res, status, error) { return res.status(status).json({ error }); }
function exactBody(body, allowed, required = []) {
    return body && typeof body === 'object' && !Array.isArray(body)
        && Object.getPrototypeOf(body) === Object.prototype
        && Object.keys(body).every(key => allowed.has(key) && !DANGEROUS.has(key))
        && required.every(key => Object.hasOwn(body, key));
}
function opaqueId(value) {
    return typeof value === 'string' && OPAQUE_ID.test(value);
}
function failure(res, error) {
    if (error instanceof SettlementNotFoundError) return safeError(res, 404, 'Settlement evidence not found');
    if (error instanceof SettlementConflictError) return safeError(res, 409, 'Settlement request conflicts');
    if (error instanceof TypeError || error instanceof RangeError) return safeError(res, 400, 'Invalid settlement request');
    return safeError(res, 500, 'Settlement service unavailable');
}
function registerCustomerSettlementApi(app, { settlementService, settlementReadService, requireRole } = {}) {
    if (!settlementService || typeof settlementService.allocateCustomerCredit !== 'function'
        || typeof settlementService.reverseCustomerAllocation !== 'function'
        || !settlementReadService || typeof settlementReadService.getCustomerSettlement !== 'function'
        || typeof requireRole !== 'function') {
        throw new TypeError('settlement services and roles are required');
    }
    const write = requireRole('super_admin', 'admin', 'farmer');
    const read = requireRole('super_admin', 'admin', 'farmer');
    app.post('/api/customer-settlement/allocations', write, async (req, res) => {
        if (!exactBody(req.body, ALLOCATION_FIELDS, ['credit_event_id', 'debit_event_id', 'amount', 'idempotency_key'])) {
            return safeError(res, 400, 'Invalid settlement request');
        }
        if (!opaqueId(req.body.credit_event_id) || !opaqueId(req.body.debit_event_id) || !opaqueId(req.body.idempotency_key)) {
            return safeError(res, 400, 'Invalid settlement request');
        }
        try {
            const money = parseKesAmount(req.body.amount);
            const result = await settlementService.allocateCustomerCredit({
                credit_event_id: req.body.credit_event_id,
                debit_event_id: req.body.debit_event_id,
                amount_minor: money.amountMinor,
                idempotency_key: req.body.idempotency_key,
                created_by_user_id: req.session.userId
            });
            return res.status(result.created ? 201 : 200).json(result);
        } catch (error) { return failure(res, error); }
    });
    app.post('/api/customer-settlement/allocations/:id/reverse', write, async (req, res) => {
        if (!exactBody(req.body, EMPTY)) return safeError(res, 400, 'Invalid settlement request');
        if (!opaqueId(req.params.id)) return safeError(res, 400, 'Invalid settlement request');
        try {
            return res.json(await settlementService.reverseCustomerAllocation({
                id: req.params.id,
                reversed_by_user_id: req.session.userId
            }));
        } catch (error) { return failure(res, error); }
    });
    app.get('/api/customers/:id/settlement', read, async (req, res) => {
        if (Object.keys(req.query).length) return safeError(res, 400, 'Invalid settlement request');
        if (!opaqueId(req.params.id)) return safeError(res, 400, 'Invalid settlement request');
        try { return res.json(await settlementReadService.getCustomerSettlement(req.params.id)); }
        catch (error) { return failure(res, error); }
    });
}

module.exports = { registerCustomerSettlementApi, exactBody, opaqueId, failure };
