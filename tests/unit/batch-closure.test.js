'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const test = require('node:test');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { BatchClosureConflictError, createBatchClosureService } = require('../../services/batch-closure');

function open(filename) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db)); }); }
function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); })); }
function get(db, sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); }
function close(db) { return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }

async function setup(filename) {
    const db = await open(filename);
    try {
        await run(db, 'PRAGMA foreign_keys=ON');
        await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
        await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, ref_id TEXT)');
        await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, transaction_id TEXT, reconciliation_status TEXT)');
        for (const [id, data] of [
            ['exact', { id: 'exact', status: 'post_batch', cohort_id: 'cohort:one', location_id: 'house:a' }],
            ['review', { id: 'review', status: 'post_batch', cohort_id: 'cohort:two', location_id: 'house:b' }],
            ['unknown-status', { id: 'unknown-status', status: 'post_batch', cohort_id: 'cohort:three', location_id: 'house:c' }],
            ['missing-entry', { id: 'missing-entry', status: 'post_batch', cohort_id: 'cohort:four', location_id: 'house:d' }],
            ['missing', { id: 'missing', status: 'post_batch' }]
        ]) await run(db, 'INSERT INTO batches (id, data) VALUES (?, ?)', [id, JSON.stringify(data)]);
        await run(db, "INSERT INTO ledger_transactions (id, ref_id) VALUES ('ledger-review', 'review')");
        await run(db, "INSERT INTO ledger_entries (id, transaction_id, reconciliation_status) VALUES ('entry-review', 'ledger-review', 'reconciliation_required')");
        await run(db, "INSERT INTO ledger_transactions (id, ref_id) VALUES ('ledger-unknown', 'unknown-status')");
        await run(db, "INSERT INTO ledger_entries (id, transaction_id, reconciliation_status) VALUES ('entry-unknown', 'ledger-unknown', NULL)");
        await run(db, "INSERT INTO ledger_transactions (id, ref_id) VALUES ('ledger-empty', 'missing-entry')");
    } finally { await close(db); }
}

test('batch closure requires cohort/location identity and records an immutable reviewed reconciliation exception', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-batch-closure-'));
    const filename = path.join(directory, 'closure.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await setup(filename);
    const service = createBatchClosureService({ withDedicatedTransaction: createDedicatedTransactionBoundary(filename).withDedicatedTransaction });

    const exact = await service.closeBatch({ batch_id: 'exact', actor_user_id: 'admin-1', closed_at: '2026-09-19T12:00:00.000Z' });
    assert.deepEqual([exact.batch.status, exact.batch.closure_review.status, exact.unresolved_count], ['completed', 'exact', 0]);
    await assert.rejects(service.closeBatch({ batch_id: 'exact', actor_user_id: 'admin-1' }), BatchClosureConflictError);
    await assert.rejects(service.closeBatch({ batch_id: 'missing', actor_user_id: 'admin-1' }), /requires explicit cohort and location/);
    await assert.rejects(service.closeBatch({ batch_id: 'review', actor_user_id: 'admin-1' }), /unresolved reconciliation/);
    await assert.rejects(service.closeBatch({ batch_id: 'unknown-status', actor_user_id: 'admin-1' }), /unresolved reconciliation/);
    await assert.rejects(service.closeBatch({ batch_id: 'missing-entry', actor_user_id: 'admin-1' }), /unresolved reconciliation/);

    const reviewed = await service.closeBatch({
        batch_id: 'review', actor_user_id: 'admin-2', closed_at: '2026-09-19T13:00:00.000Z',
        reconciliation_exception: { code: 'inventory_variance', note: 'Physical count variance retained for review.' }
    });
    assert.deepEqual([
        reviewed.batch.closure_review.status,
        reviewed.batch.closure_review.unresolved_ledger_transaction_ids,
        reviewed.batch.closure_review.reconciliation_exception.code,
        reviewed.batch.closure_review.reviewed_by_user_id
    ], ['exception_accepted', ['ledger-review'], 'inventory_variance', 'admin-2']);
    const db = await open(filename);
    try {
        const row = await get(db, "SELECT data FROM batches WHERE id = 'review'");
        assert.equal(JSON.parse(row.data).status, 'completed');
    } finally { await close(db); }
});
