'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const test = require('node:test');
const { migrateBatchTransfers } = require('../../migrations/batch-transfers');
const { createBatchTransferService, BatchTransferConflictError } = require('../../services/batch-transfer');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');

function open(filename) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

test('batch transfers are immutable, session-attributed, idempotent, and cannot bypass cohort lifecycle controls', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-batch-transfer-'));
    const filename = path.join(directory, 'transfer.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const db = await open(filename);
    try {
        await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
        await migrateBatchTransfers(db);
        await run(db, 'INSERT INTO batches (id, data) VALUES (?, ?)', ['batch-1', JSON.stringify({ id: 'batch-1', status: 'active', cohort_id: 'cohort:1', location_id: 'house:a', size: 100, stats: { birdsAlive: 90 } })]);
        await run(db, 'INSERT INTO batches (id, data) VALUES (?, ?)', ['closed', JSON.stringify({ id: 'closed', status: 'completed', cohort_id: 'cohort:2', location_id: 'house:a', size: 100, stats: { birdsAlive: 100 } })]);
    } finally { await close(db); }
    const service = createBatchTransferService({ withDedicatedTransaction: createDedicatedTransactionBoundary(filename).withDedicatedTransaction });
    const input = { batch_id: 'batch-1', source_location_id: 'house:a', destination_location_id: 'house:b', transfer_date: '2026-09-19', quantity: 20, reason: 'Reduce stocking density.', idempotency_key: 'batch-transfer-001', actor_user_id: 'admin-1' };
    const created = await service.recordTransfer(input);
    assert.deepEqual([created.idempotent, created.transfer.cohort_id, created.transfer.created_by_user_id], [false, 'cohort:1', 'admin-1']);
    assert.equal((await service.recordTransfer(input)).idempotent, true);
    await assert.rejects(service.recordTransfer({ ...input, quantity: 21 }), BatchTransferConflictError);
    await assert.rejects(service.recordTransfer({ ...input, idempotency_key: 'batch-transfer-002', source_location_id: 'house:unknown' }), /source has no recorded cohort location/);
    await assert.rejects(service.recordTransfer({ ...input, idempotency_key: 'batch-transfer-003', quantity: 91 }), /exceeds recorded live birds/);
    await assert.rejects(service.recordTransfer({ ...input, idempotency_key: 'batch-transfer-003a', transfer_date: '2026-02-30' }), /invalid transfer date/);
    await assert.rejects(service.recordTransfer({ ...input, batch_id: 'closed', idempotency_key: 'batch-transfer-004' }), /closed batches/);
    const verify = await open(filename);
    try {
        await assert.rejects(run(verify, "UPDATE batch_transfers SET quantity = 1 WHERE id = ?", [created.transfer.id]), /immutable/);
        await assert.rejects(run(verify, "DELETE FROM batch_transfers WHERE id = ?", [created.transfer.id]), /cannot be deleted/);
        assert.equal((await get(verify, 'SELECT COUNT(*) AS count FROM batch_transfers')).count, 1);
    } finally { await close(verify); }
});
