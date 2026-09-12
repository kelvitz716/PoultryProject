const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    TransactionPersistenceConflictError,
    TransactionPersistenceValidationError
} = require('../../services/transaction-persistence');
const { registerTransactionPersistenceApi } = require('../../services/transaction-persistence-http');

function request(server, method, pathname, role, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method,
            path: pathname,
            headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString() || '{}')
            }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

test('transaction persistence HTTP routes retain roles and return only safe failures', async t => {
    const calls = [];
    const transactionPersistence = {
        createOrUpdateTransaction: async (batchId, body, actor) => {
            calls.push(['save', batchId, body, actor]);
            if (body.mode === 'bad') throw new TransactionPersistenceValidationError('invalid customer evidence');
            if (body.mode === 'conflict') throw new TransactionPersistenceConflictError('different batch');
            if (body.mode === 'boom') throw new Error('SQL failure SMS 0712345678 super-secret');
        },
        deleteTransaction: async (batchId, id) => calls.push(['delete', batchId, id]),
        deleteTransactionsForBatch: async batchId => calls.push(['bulk', batchId])
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const role = req.headers['x-role'];
        req.session = role ? { userId: 'session-user', userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    registerTransactionPersistenceApi(app, { transactionPersistence, requireRole });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => server.close());

    assert.equal((await request(server, 'POST', '/api/transactions/batch-1')).status, 401);
    assert.equal((await request(server, 'POST', '/api/transactions/batch-1', 'viewer', { type: 'sale' })).status, 403);
    assert.equal((await request(server, 'POST', '/api/transactions/batch-1', 'farmer', [])).status, 400);
    assert.equal((await request(server, 'POST', '/api/transactions/batch-1', 'farmer', { type: 'sale' })).status, 200);
    assert.deepEqual(calls[0], ['save', 'batch-1', { type: 'sale' }, 'session-user']);
    assert.equal((await request(server, 'DELETE', '/api/transactions/batch-1/tx-1', 'farmer')).status, 403);
    assert.equal((await request(server, 'DELETE', '/api/transactions/batch-1/tx-1', 'admin')).status, 200);
    assert.equal((await request(server, 'DELETE', '/api/transactions/batch-1', 'super_admin')).status, 200);
    assert.equal((await request(server, 'POST', '/api/transactions/batch-1', 'admin', { mode: 'bad' })).status, 400);
    const conflict = await request(server, 'POST', '/api/transactions/batch-1', 'admin', { mode: 'conflict' });
    assert.deepEqual(conflict, { status: 409, body: { error: 'Transaction request conflicts' } });
    assert.doesNotMatch(JSON.stringify(conflict), /different batch|existing|internal/i);
    const failed = await request(server, 'POST', '/api/transactions/batch-1', 'admin', { mode: 'boom' });
    assert.deepEqual(failed, { status: 500, body: { error: 'Transaction could not be saved' } });
    assert.doesNotMatch(JSON.stringify(failed), /0712345678|secret|SQL/i);
});
