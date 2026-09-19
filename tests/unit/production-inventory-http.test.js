'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { registerProductionInventoryApi } = require('../../services/production-inventory-http');

function request(server, role, path = '/api/batches/batch-1/production-inventory?limit=2') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path, headers: role ? { 'x-role': role } : {} }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        });
        req.on('error', reject); req.end();
    });
}

test('production inventory reporting is admin-only and validates a bounded movement history request', async t => {
    const app = express();
    app.use((req, _res, next) => { req.session = req.headers['x-role'] ? { userId: 'user-1', userRole: req.headers['x-role'] } : {}; next(); });
    const requireRole = (...roles) => (req, res, next) => !req.session.userId ? res.status(401).json({ error: 'Unauthorized' }) : !roles.includes(req.session.userRole) ? res.status(403).json({ error: 'Forbidden' }) : next();
    registerProductionInventoryApi(app, {
        requireRole,
        productionInventoryReportingService: { getBatchInventory: async input => ({ batch_id: input.batch_id, movements: [], balances: {} }) }
    });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => server.close());
    assert.equal((await request(server)).status, 401);
    assert.equal((await request(server, 'farmer')).status, 403);
    assert.deepEqual(await request(server, 'admin'), { status: 200, body: { batch_id: 'batch-1', movements: [], balances: {} } });
    assert.equal((await request(server, 'admin', '/api/batches/batch-1/production-inventory?limit=101')).status, 400);
});
