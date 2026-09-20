'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { registerBatchTransferApi } = require('../../services/batch-transfer-http');

function request(server, role, userId, body) { return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/batches/batch-1/transfers', headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role, 'x-user': userId } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })); }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end(); }); }
function historyRequest(server, role, userId, path = '/api/batches/batch-1/transfers?limit=2') { return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path, headers: role ? { 'x-role': role, 'x-user': userId } : {} }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })); }); req.on('error', reject); req.end(); }); }
function balancesRequest(server, role, userId) { return historyRequest(server, role, userId, '/api/batches/batch-1/house-balances?date=2026-09-19'); }

test('batch transfer route allows only privileged sessions and ignores forged operator fields', async t => {
    const calls = [];
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { const role = req.headers['x-role']; req.session = role ? { userId: req.headers['x-user'], userRole: role } : {}; next(); });
    const requireRole = (...roles) => (req, res, next) => !req.session.userId ? res.status(401).json({ error: 'Unauthorized' }) : !roles.includes(req.session.userRole) ? res.status(403).json({ error: 'Forbidden' }) : next();
    registerBatchTransferApi(app, {
        requireRole,
        batchTransferService: {
            recordTransfer: async input => { calls.push(input); return { idempotent: false, transfer: { id: 'transfer:1' } }; },
            listTransfers: async input => ({ transfers: [{ id: 'transfer:1', quantity: input.limit }] }),
            getHouseBalances: async input => ({ batch_id: input.batch_id, as_of_date: input.as_of_date, balances: [{ location_id: 'house:a', live_birds: 10 }] })
        }
    });
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); }); t.after(() => server.close());
    const body = { source_location_id: 'house:a', destination_location_id: 'house:b', transfer_date: '2026-09-19', quantity: 1, reason: 'Move.', idempotency_key: 'transfer-http-001', actor_user_id: 'forged' };
    assert.equal((await request(server, undefined, undefined, body)).status, 401);
    assert.equal((await request(server, 'farmer', 'farmer-1', body)).status, 403);
    assert.equal((await request(server, 'admin', 'admin-1', body)).status, 400);
    delete body.actor_user_id;
    assert.equal((await request(server, 'admin', 'admin-1', body)).status, 201);
    assert.equal(calls[0].actor_user_id, 'admin-1');
    assert.equal((await historyRequest(server, undefined, undefined)).status, 401);
    assert.equal((await historyRequest(server, 'farmer', 'farmer-1')).status, 403);
    assert.deepEqual(await historyRequest(server, 'admin', 'admin-1'), { status: 200, body: { transfers: [{ id: 'transfer:1', quantity: 2 }] } });
    assert.equal((await historyRequest(server, 'admin', 'admin-1', '/api/batches/batch-1/transfers?limit=101')).status, 400);
    assert.equal((await balancesRequest(server, undefined, undefined)).status, 401);
    assert.deepEqual(await balancesRequest(server, 'farmer', 'farmer-1'), { status: 200, body: { batch_id: 'batch-1', as_of_date: '2026-09-19', balances: [{ location_id: 'house:a', live_birds: 10 }] } });
});
