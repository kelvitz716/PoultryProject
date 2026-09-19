'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { registerBatchClosureApi } = require('../../services/batch-closure-http');
const { BatchClosureConflictError, BatchClosureValidationError } = require('../../services/batch-closure');

function request(server, { role, userId, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method: 'POST',
            path: '/api/batches/batch-1/close',
            headers: {
                'content-type': 'application/json',
                ...(role ? { 'x-role': role, 'x-user': userId } : {})
            }
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

test('batch closure HTTP route enforces privileged review, preserves server-side actor provenance, and returns safe errors', async t => {
    const calls = [];
    const batchClosureService = {
        closeBatch: async input => {
            calls.push(input);
            if (input.actor_user_id === 'conflict-user') throw new BatchClosureConflictError('batch is already closed');
            if (input.actor_user_id === 'invalid-user') throw new BatchClosureValidationError('sensitive invalid value');
            if (input.actor_user_id === 'boom-user') throw new Error('secret batch detail');
            return { batch: { id: input.batch_id, status: 'completed' }, unresolved_count: 0 };
        }
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const role = req.headers['x-role'];
        req.session = role ? { userId: req.headers['x-user'], userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => !req.session.userId
        ? res.status(401).json({ error: 'Unauthorized' })
        : !roles.includes(req.session.userRole)
            ? res.status(403).json({ error: 'Forbidden' })
            : next();
    registerBatchClosureApi(app, { batchClosureService, requireRole });
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => server.close());

    assert.equal((await request(server)).status, 401);
    assert.equal((await request(server, { role: 'farmer', userId: 'farmer-1' })).status, 403);
    const closed = await request(server, {
        role: 'admin', userId: 'admin-1',
        body: { actor_user_id: 'forged-user', reconciliation_exception: { code: 'other', note: 'Recorded for review.' } }
    });
    assert.deepEqual(closed, { status: 201, body: { batch: { id: 'batch-1', status: 'completed' }, unresolved_count: 0 } });
    assert.deepEqual(calls[0], {
        batch_id: 'batch-1',
        reconciliation_exception: { code: 'other', note: 'Recorded for review.' },
        actor_user_id: 'admin-1'
    });
    assert.equal((await request(server, { role: 'super_admin', userId: 'root-1' })).status, 201);
    assert.deepEqual(await request(server, { role: 'admin', userId: 'conflict-user' }), {
        status: 409, body: { error: 'batch is already closed' }
    });
    assert.deepEqual(await request(server, { role: 'admin', userId: 'invalid-user' }), {
        status: 400, body: { error: 'Invalid batch closure request' }
    });
    const failed = await request(server, { role: 'admin', userId: 'boom-user' });
    assert.deepEqual(failed, { status: 500, body: { error: 'Batch closure failed' } });
    assert.doesNotMatch(JSON.stringify(failed.body), /secret/i);
});
