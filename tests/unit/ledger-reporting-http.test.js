const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createLedgerAccountsHandler } = require('../../services/ledger-reporting');

function request(server, role) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, path: '/api/ledger/accounts',
            headers: role ? { 'x-role': role } : {}
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('ledger reporting API retains roles and sanitizes reporting failures', async t => {
    const app = express();
    app.use((req, res, next) => {
        const role = req.headers['x-role'];
        req.session = role ? { userId: 'user-1', userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    const reporting = { listLedgerAccounts: async () => [{ code: '1000', status: 'exact' }] };
    app.get('/api/ledger/accounts', requireRole('super_admin', 'admin', 'farmer'), createLedgerAccountsHandler(reporting));
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => server.close());
    assert.equal((await request(server)).status, 401);
    assert.equal((await request(server, 'viewer')).status, 403);
    assert.equal((await request(server, 'farmer')).status, 200);
    reporting.listLedgerAccounts = async () => { throw new Error('SQL outage SELECT 0712345678'); };
    const failure = await request(server, 'admin');
    assert.deepEqual(failure, { status: 500, body: { error: 'Ledger reports unavailable' } });
    assert.doesNotMatch(JSON.stringify(failure), /SQL|0712345678|SELECT/i);
});
