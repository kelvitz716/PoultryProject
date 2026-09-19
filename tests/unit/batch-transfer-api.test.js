const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

test('batch transfer API helpers use encoded bounded requests and never send actor provenance', async t => {
    const { api } = await import(path.resolve(__dirname, '../../js/api.js'));
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: options?.method === 'POST' ? 201 : 200, json: async () => ({ transfers: [] }) };
    };
    const saved = await api.recordBatchTransfer('batch / one', {
        source_location_id: 'house:a', destination_location_id: 'house:b', transfer_date: '2026-09-19',
        quantity: 3, reason: 'Separate groups.', idempotency_key: 'transfer-ui-001', actor_user_id: 'forged'
    });
    assert.deepEqual(saved, { ok: true, status: 201, body: { transfers: [] } });
    assert.equal(calls[0].url, '/api/batches/batch%20%2F%20one/transfers');
    const posted = JSON.parse(calls[0].options.body);
    assert.deepEqual(Object.keys(posted).sort(), ['destination_location_id', 'idempotency_key', 'quantity', 'reason', 'source_location_id', 'transfer_date']);
    assert.equal(posted.actor_user_id, undefined);
    assert.deepEqual(await api.getBatchTransfers('batch / one', 2), { ok: true, status: 200, body: { transfers: [] } });
    assert.equal(calls[1].url, '/api/batches/batch%20%2F%20one/transfers?limit=2');
    assert.deepEqual(await api.getBatchTransfers('batch-1', 101), { ok: false, status: null, error: 'Invalid transfer history request' });
});
