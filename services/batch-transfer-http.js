'use strict';

const { BatchTransferConflictError, BatchTransferNotFoundError, BatchTransferValidationError } = require('./batch-transfer');

function shape(body) {
    const allowed = new Set(['source_location_id', 'destination_location_id', 'transfer_date', 'quantity', 'reason', 'idempotency_key']);
    return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => allowed.has(key));
}
function registerBatchTransferApi(app, { batchTransferService, requireRole }) {
    app.post('/api/batches/:id/transfers', requireRole('super_admin', 'admin'), async (req, res) => {
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
