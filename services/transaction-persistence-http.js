const {
    TransactionPersistenceConflictError,
    TransactionPersistenceValidationError
} = require('./transaction-persistence');

function shape(body) {
    return body && typeof body === 'object' && !Array.isArray(body);
}

function sendFailure(res, error) {
    if (error instanceof TransactionPersistenceConflictError) {
        return res.status(409).json({ error: 'Transaction request conflicts' });
    }
    if (error instanceof TransactionPersistenceValidationError || error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({ error: 'Invalid transaction request' });
    }
    return res.status(500).json({ error: 'Transaction could not be saved' });
}

function registerTransactionPersistenceApi(app, { transactionPersistence, requireRole }) {
    const create = requireRole('super_admin', 'admin', 'farmer');
    const remove = requireRole('super_admin', 'admin');

    app.post('/api/transactions/:batchId', create, async (req, res) => {
        if (!shape(req.body)) return res.status(400).json({ error: 'Invalid transaction request' });
        try {
            await transactionPersistence.createOrUpdateTransaction(req.params.batchId, req.body, req.session.userId);
            return res.json({ success: true });
        } catch (error) {
            return sendFailure(res, error);
        }
    });

    app.delete('/api/transactions/:batchId/:id', remove, async (req, res) => {
        try {
            await transactionPersistence.deleteTransaction(req.params.batchId, req.params.id);
            return res.json({ success: true });
        } catch (error) {
            return sendFailure(res, error);
        }
    });

    app.delete('/api/transactions/:batchId', remove, async (req, res) => {
        try {
            await transactionPersistence.deleteTransactionsForBatch(req.params.batchId);
            return res.json({ success: true });
        } catch (error) {
            return sendFailure(res, error);
        }
    });
}

module.exports = { registerTransactionPersistenceApi };
