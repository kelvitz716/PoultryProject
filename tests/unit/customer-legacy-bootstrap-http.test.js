const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { registerLegacyCustomerBootstrapApi } = require('../../services/customer-legacy-bootstrap-http');
const { SettlementConflictError } = require('../../services/customer-settlement');

function request(server, role, userId, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method: 'POST',
            path: '/api/customers/bootstrap-legacy-buyers',
            headers: {
                'content-type': 'application/json',
                ...(role ? { 'x-role': role, 'x-user': userId } : {})
            }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString() || '{}')
            }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

test('legacy buyer bootstrap HTTP route enforces roles, empty body, actor provenance, and safe errors', async t => {
    const calls = [];
    const bootstrapService = {
        bootstrapLegacyBuyers: async input => {
            calls.push(input);
            if (input.actor_user_id === 'conflict-user') throw new SettlementConflictError('sensitive detail');
            if (input.actor_user_id === 'boom-user') throw new Error('secret profile 0712345678');
            return { imported: 0, existing: 0, links: [], issues: [] };
        }
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const role = req.headers['x-role'];
        req.session = role ? { userId: req.headers['x-user'], userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    registerLegacyCustomerBootstrapApi(app, { bootstrapService, requireRole });
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => server.close());

    assert.equal((await request(server, undefined, undefined, {})).status, 401);
    assert.equal((await request(server, 'viewer', 'viewer-1', {})).status, 403);
    assert.equal((await request(server, 'farmer', 'farmer-1', {})).status, 200);
    assert.equal((await request(server, 'admin', 'admin-1', {})).status, 200);
    assert.equal((await request(server, 'super_admin', 'root-1', {})).status, 200);
    assert.deepEqual(calls.map(call => call.actor_user_id), ['farmer-1', 'admin-1', 'root-1']);

    const smuggled = await request(server, 'farmer', 'farmer-1', { buyers: [], actor_user_id: 'evil' });
    assert.deepEqual(smuggled, { status: 400, body: { error: 'Invalid legacy buyer bootstrap request' } });
    assert.equal(calls.length, 3);
    assert.equal((await request(server, 'admin', 'conflict-user', {})).status, 409);
    const failure = await request(server, 'admin', 'boom-user', {});
    assert.deepEqual(failure, { status: 500, body: { error: 'Customer service unavailable' } });
    assert.doesNotMatch(JSON.stringify(failure.body), /secret|0712345678/i);
});
