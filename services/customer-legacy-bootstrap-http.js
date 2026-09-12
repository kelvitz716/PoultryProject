const { SettlementConflictError, SettlementNotFoundError } = require('./customer-settlement');

function fail(res, error) {
    if (error instanceof SettlementNotFoundError) return res.status(404).json({ error: 'Customer not found' });
    if (error instanceof SettlementConflictError) return res.status(409).json({ error: 'Customer request conflicts' });
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: 'Invalid legacy buyer bootstrap request' });
    return res.status(500).json({ error: 'Customer service unavailable' });
}

function emptyObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

function registerLegacyCustomerBootstrapApi(app, { bootstrapService, requireRole }) {
    if (!bootstrapService || typeof bootstrapService.bootstrapLegacyBuyers !== 'function' || typeof requireRole !== 'function') {
        throw new TypeError('legacy buyer bootstrap service and role middleware are required');
    }
    const write = requireRole('super_admin', 'admin', 'farmer');
    app.post('/api/customers/bootstrap-legacy-buyers', write, async (req, res) => {
        if (!emptyObject(req.body)) return res.status(400).json({ error: 'Invalid legacy buyer bootstrap request' });
        try {
            return res.status(200).json(await bootstrapService.bootstrapLegacyBuyers({ actor_user_id: req.session.userId }));
        } catch (error) {
            return fail(res, error);
        }
    });
}

module.exports = { registerLegacyCustomerBootstrapApi };
