'use strict';

const { BatchClosureConflictError, BatchClosureValidationError } = require('./batch-closure');

function registerBatchClosureApi(app, { batchClosureService, requireRole }) {
    const close = requireRole('super_admin', 'admin');
    app.post('/api/batches/:id/close', close, async (req, res) => {
        try {
            const result = await batchClosureService.closeBatch({
                batch_id: req.params.id,
                reconciliation_exception: req.body?.reconciliation_exception,
                actor_user_id: req.session.userId
            });
            return res.status(201).json({ batch: result.batch, unresolved_count: result.unresolved_count });
        } catch (error) {
            if (error instanceof BatchClosureValidationError || error instanceof TypeError || error instanceof RangeError) {
                return res.status(400).json({ error: 'Invalid batch closure request' });
            }
            if (error instanceof BatchClosureConflictError) return res.status(409).json({ error: error.message });
            return res.status(500).json({ error: 'Batch closure failed' });
        }
    });
}

module.exports = { registerBatchClosureApi };
