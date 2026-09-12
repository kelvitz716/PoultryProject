/** HTTP boundary for read-only customer reconciliation suggestions. */

const { SettlementNotFoundError } = require('./customer-settlement');
const { opaqueId } = require('./customer-settlement-http');

function safeError(res, status, error) {
    return res.status(status).json({ error });
}

function parseQuery(query) {
    const keys = Object.keys(query);
    if (keys.some(key => key !== 'limit')) throw new TypeError('invalid query');
    if (!Object.hasOwn(query, 'limit')) return undefined;
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(query.limit)) {
        throw new TypeError('invalid limit');
    }
    const limit = Number(query.limit);
    if (limit > 100) throw new RangeError('invalid limit');
    return limit;
}

function failure(res, error) {
    if (error instanceof SettlementNotFoundError) {
        return safeError(res, 404, 'Settlement evidence not found');
    }
    if (error instanceof TypeError || error instanceof RangeError) {
        return safeError(res, 400, 'Invalid reconciliation request');
    }
    return safeError(res, 500, 'Reconciliation suggestions unavailable');
}

function registerCustomerReconciliationSuggestionsApi(app, { suggestionService, requireRole } = {}) {
    if (!suggestionService || typeof suggestionService.getCustomerReconciliationSuggestions !== 'function'
        || typeof requireRole !== 'function') {
        throw new TypeError('reconciliation suggestion service and roles are required');
    }
    app.get('/api/customers/:id/reconciliation-suggestions', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
        if (!opaqueId(req.params.id)) return safeError(res, 400, 'Invalid reconciliation request');
        try {
            const limit = parseQuery(req.query);
            return res.json(await suggestionService.getCustomerReconciliationSuggestions({
                customer_id: req.params.id,
                limit
            }));
        } catch (error) {
            return failure(res, error);
        }
    });
}

module.exports = { registerCustomerReconciliationSuggestionsApi, parseQuery, failure };
