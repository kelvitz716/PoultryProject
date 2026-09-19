'use strict';

const { BatchTransferConflictError, BatchTransferNotFoundError, BatchTransferValidationError } = require('./batch-transfer');

function shape(body) {
    const allowed = new Set(['source_location_id', 'destination_location_id', 'transfer_date', 'quantity', 'reason', 'idempotency_key']);
    return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => allowed.has(key));
}
function listLimit(value) {
    if (value === undefined) return 50;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}
function registerBatchTransferApi(app, { batchTransferService, requireRole }) {
    const transferRole = requireRole('super_admin', 'admin');
    app.get('/api/batches/:id/transfers', transferRole, async (req, res) => {
        const limit = listLimit(req.query.limit);
        if (limit === null) return res.status(400).json({ error: 'Invalid transfer history request' });
        try {
            const result = await batchTransferService.listTransfers({ batch_id: req.params.id, limit });
            return res.json({ transfers: result.transfers });
        } catch (error) {
            if (error instanceof BatchTransferNotFoundError) return res.status(404).json({ error: 'Batch not found' });
            if (error instanceof BatchTransferValidationError || error instanceof TypeError || error instanceof RangeError) {
                return res.status(400).json({ error: 'Invalid transfer history request' });
            }
            return res.status(500).json({ error: 'Batch transfer history failed' });
        }
    });
    app.post('/api/batches/:id/transfers', transferRole, async (req, res) => {
        if (!shape(req.body)) return res.status(400).json({ error: 'Invalid batch transfer request' });
        try {
            const result = await batchTransferService.recordTransfer({ ...req.body, batch_id: req.params.id, actor_user_id: req.session.userId });
            return res.status(result.idempotent ? 200 : 201).json(result);
        } catch (error) {
            if (error instanceof BatchTransferNotFoundError) return res.status(404).json({ error: 'Batch not found' });
            if (error instanceof BatchTransferConflictError) return res.status(409).json({ error: 'Batch transfer conflicts' });
            if (error instanceof BatchTransferValidationError || error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: 'Invalid batch transfer request' });
            return res.status(500).json({ error: 'Batch transfer failed' });
        }
    });
}

module.exports = { registerBatchTransferApi };
