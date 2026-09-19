const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

test('batch closure guard fails closed without invoking a mutation', async () => {
    const guard = await import(path.resolve(__dirname, '../../js/batch-closure-guard.mjs'));
    const notifications = [];

    const result = guard.blockBatchClosure((message, type) => notifications.push({ message, type }));

    assert.deepEqual(result, {
        ok: false,
        reason: 'closure_contract_required',
        recordsChanged: false
    });
    assert.deepEqual(notifications, [{
        message: guard.BATCH_CLOSURE_UNAVAILABLE_MESSAGE,
        type: 'warning'
    }]);
    assert.match(notifications[0].message, /No records were changed\./);
});
