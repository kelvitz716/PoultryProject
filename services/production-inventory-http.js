'use strict';

const {
    ProductionInventoryReportingValidationError,
    ProductionInventoryReportingNotFoundError
} = require('./production-inventory-reporting');

function movementLimit(value) {
    if (value === undefined) return 25;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function registerProductionInventoryApi(app, { productionInventoryReportingService, requireRole }) {
    app.get('/api/batches/:id/production-inventory', requireRole('super_admin', 'admin'), async (req, res) => {
        const limit = movementLimit(req.query.limit);
        if (limit === null) return res.status(400).json({ error: 'Invalid production inventory request' });
        try {
            return res.json(await productionInventoryReportingService.getBatchInventory({ batch_id: req.params.id, limit }));
        } catch (error) {
            if (error instanceof ProductionInventoryReportingNotFoundError) return res.status(404).json({ error: 'Batch not found' });
            if (error instanceof ProductionInventoryReportingValidationError || error instanceof TypeError || error instanceof RangeError) {
                return res.status(400).json({ error: 'Invalid production inventory request' });
            }
            return res.status(500).json({ error: 'Production inventory is unavailable' });
        }
    });
}

module.exports = { registerProductionInventoryApi };
