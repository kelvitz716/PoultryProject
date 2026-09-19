'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionStore } = require('../../services/sqlite-session-store');

function callbackResult(invoke) {
    return new Promise((resolve, reject) => invoke((error, value) => error ? reject(error) : resolve(value)));
}

test('SQLite session store persists signed-session JSON, expires stale rows, and cleans up deterministically', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-session-store-'));
    const store = new SqliteSessionStore({ databasePath: path.join(directory, 'sessions.sqlite') });
    try {
        const active = { cookie: { expires: new Date(Date.now() + 60_000).toISOString(), httpOnly: true }, userId: 'user-1', role: 'admin' };
        await callbackResult(done => store.set('active', active, done));
        assert.deepEqual(await callbackResult(done => store.get('active', done)), active);
        assert.equal(await callbackResult(done => store.length(done)), 1);

        await store._run('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)', ['expired', JSON.stringify({ userId: 'old' }), Date.now() - 1]);
        assert.equal(await callbackResult(done => store.get('expired', done)), null);
        assert.equal(await callbackResult(done => store.length(done)), 1);
        assert.deepEqual(await callbackResult(done => store.all(done)), [active]);

        await callbackResult(done => store.destroy('active', done));
        assert.equal(await callbackResult(done => store.length(done)), 0);
    } finally {
        await callbackResult(done => store.close(done));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
