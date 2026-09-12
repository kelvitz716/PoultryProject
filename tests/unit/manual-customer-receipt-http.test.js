const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    ManualCustomerReceiptNotFoundError,
    ManualCustomerReceiptConflictError
} = require('../../services/manual-customer-receipt');
const { registerManualCustomerReceiptApi } = require('../../services/manual-customer-receipt-http');

function request(server, { method = 'POST', body = {}, role, userId = 'session-actor' } = {}) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const wire = JSON.stringify(body);
        const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) };
        if (role) headers['x-test-role'] = role;
        if (userId) headers['x-test-user'] = userId;
        const req = http.request({ host: '127.0.0.1', port: address.port, path: '/api/customer-receipts/manual', method, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        req.end(wire);
    });
}

async function appFor(t, implementation) {
    const calls = [];
    const app = express();
    app.use((req, res, next) => {
        const role = req.headers['x-test-role'];
        req.session = role ? { userId: req.headers['x-test-user'], userRole: role } : {};
        next();
    });
    app.use(express.json());
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    registerManualCustomerReceiptApi(app, {
        requireRole,
        receiptService: {
            recordManualCustomerReceipt: async input => {
                calls.push(input);
                return implementation ? implementation(input) : {
                    idempotent: false,
                    customer_account_event_id: 'manual-payment:test',
                    ledger_transaction_id: 'ledger-manual:test',
                    receipt: { customer_id: input.customer_id, method: input.method, amount_minor: 100, external_reference: input.external_reference ?? null }
                };
            }
        }
    });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    return { server, calls };
}

const valid = {
    customer_id: 'customer:a', method: 'cash', amount: '1.00', idempotency_key: 'manual-http-1'
};

test('manual receipt HTTP endpoint restricts roles, body shape, and session actor provenance', async t => {
    const { server, calls } = await appFor(t);
    assert.equal((await request(server, { body: valid, role: undefined })).status, 401);
    assert.equal((await request(server, { body: valid, role: 'viewer' })).status, 403);
    for (const role of ['farmer', 'admin', 'super_admin']) {
        const response = await request(server, { body: valid, role, userId: `${role}-actor` });
        assert.equal(response.status, 201);
    }
    assert.equal(calls[0].created_by_user_id, 'farmer-actor');
    assert.equal(calls[0].reviewer_user_id, 'farmer-actor');
    assert.equal((await request(server, {
        role: 'farmer',
        body: { ...valid, created_by_user_id: 'forged', status: 'posted' }
    })).status, 400);
    assert.equal((await request(server, { role: 'farmer', body: { ...valid, amount: '1.00', unknown: true } })).status, 400);
});

test('manual receipt HTTP endpoint returns retry, validation, conflict, not-found, and safe operational failures', async t => {
    const sensitive = 'PRIVATE-SMS-0712345678';
    const idempotent = await appFor(t, async input => ({
        idempotent: true,
        customer_account_event_id: 'manual-payment:one',
        ledger_transaction_id: 'ledger-manual:one',
        receipt: { customer_id: input.customer_id, method: input.method, amount_minor: 100, external_reference: null }
    }));
    assert.equal((await request(idempotent.server, { role: 'farmer', body: valid })).status, 200);

    const client = await appFor(t, async () => { throw new TypeError(`bad ${sensitive}`); });
    const conflict = await appFor(t, async () => { throw new ManualCustomerReceiptConflictError(`conflict ${sensitive}`); });
    const missing = await appFor(t, async () => { throw new ManualCustomerReceiptNotFoundError(`missing ${sensitive}`); });
    const operational = await appFor(t, async () => { throw new Error(`database ${sensitive}`); });
    const cases = [
        [client.server, 400, 'Invalid manual customer receipt'],
        [conflict.server, 409, 'Manual customer receipt conflicts'],
        [missing.server, 404, 'Customer not found'],
        [operational.server, 500, 'Manual customer receipt service unavailable']
    ];
    for (const [server, status, error] of cases) {
        const response = await request(server, { role: 'farmer', body: valid });
        assert.deepEqual([response.status, response.body], [status, { error }]);
        assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE-SMS|0712345678|database/);
    }
});
