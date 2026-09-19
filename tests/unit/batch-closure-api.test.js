const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

test('batch closure API helper encodes IDs, sends only the approved JSON shape, and never throws', async t => {
    const { api } = await import(path.resolve(__dirname, '../../js/api.js'));
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 201, json: async () => ({ batch: { id: 'batch / one' }, unresolved_count: 0 }) };
    };
    const exact = await api.closeBatch('batch / one');
    assert.deepEqual(exact, { ok: true, status: 201, body: { batch: { id: 'batch / one' }, unresolved_count: 0 } });
    assert.deepEqual(calls[0], {
        url: '/api/batches/batch%20%2F%20one/close',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    });

    await api.closeBatch('batch-2', { code: 'inventory_variance', note: 'Count retained for review.' });
    assert.deepEqual(JSON.parse(calls[1].options.body), {
        reconciliation_exception: { code: 'inventory_variance', note: 'Count retained for review.' }
    });
    assert.doesNotMatch(calls[1].options.body, /actor|reviewed_by|user_id/);

    global.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await api.closeBatch('batch-3'), {
        ok: false, status: null, error: 'Batch closure is unavailable'
    });
    assert.deepEqual(await api.closeBatch({ id: 'forged' }), {
        ok: false, status: null, error: 'Invalid batch closure request'
    });
});
