'use strict';

const {
    BatchDeletionConflictError,
    BatchDeletionValidationError
} = require('./batch-deletion');

function sendFailure(res, error) {
    if (error instanceof BatchDeletionConflictError) {
        return res.status(409).json({ error: 'Batch deletion conflicts with retained records' });
    }
    if (error instanceof BatchDeletionValidationError || error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({ error: 'Invalid batch deletion request' });
    }
    return res.status(500).json({ error: 'Batch could not be deleted' });
}

function registerBatchDeletionApi(app, { batchDeletionService, requireRole, requireConfirm }) {
    const remove = requireRole('super_admin', 'admin');

    app.delete('/api/batches/:id', remove, async (req, res) => {
        try {
            await batchDeletionService.deleteBatch(req.params.id);
            return res.json({ success: true });
        } catch (error) {
            return sendFailure(res, error);
        }
    });

    app.delete('/api/batches', remove, requireConfirm, async (_req, res) => {
        try {
            await batchDeletionService.deleteAllBatches();
            return res.json({ success: true });
        } catch (error) {
            return sendFailure(res, error);
        }
    });
}

module.exports = { registerBatchDeletionApi };
