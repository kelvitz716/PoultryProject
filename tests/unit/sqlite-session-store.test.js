'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
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

test('SQLite session store revokes every active session for one user without affecting other users', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-session-revocation-'));
    const store = new SqliteSessionStore({ databasePath: path.join(directory, 'sessions.sqlite') });
    try {
        await callbackResult(done => store.set('user-1-a', { userId: 'user-1' }, done));
        await callbackResult(done => store.set('user-1-b', { userId: 'user-1' }, done));
        await callbackResult(done => store.set('user-2-a', { userId: 'user-2' }, done));

        assert.equal(await store.destroyByUserId('user-1'), 2);
        assert.equal(await callbackResult(done => store.get('user-1-a', done)), null);
        assert.equal(await callbackResult(done => store.get('user-1-b', done)), null);
        assert.deepEqual(await callbackResult(done => store.get('user-2-a', done)), { userId: 'user-2' });
    } finally {
        await callbackResult(done => store.close(done));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SQLite session store upgrades the legacy expired-column schema by invalidating old sessions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-session-store-legacy-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    const legacy = new sqlite3.Database(databasePath);
    await new Promise((resolve, reject) => legacy.run(
        'CREATE TABLE sessions (sid TEXT PRIMARY KEY, expired DATETIME, sess TEXT)',
        error => error ? reject(error) : resolve()
    ));
    await new Promise((resolve, reject) => legacy.run(
        'INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)',
        ['legacy-session', '2099-01-01T00:00:00.000Z', JSON.stringify({ userId: 'legacy-user' })],
        error => error ? reject(error) : resolve()
    ));
    await new Promise((resolve, reject) => legacy.close(error => error ? reject(error) : resolve()));

    const store = new SqliteSessionStore({ databasePath });
    try {
        assert.equal(await callbackResult(done => store.get('legacy-session', done)), null);
        const columns = await new Promise((resolve, reject) => store.db.all('PRAGMA table_info(sessions)', (error, rows) => error ? reject(error) : resolve(rows)));
        assert.ok(columns.some(column => column.name === 'expire'));
        await callbackResult(done => store.set('fresh-session', { userId: 'fresh-user' }, done));
        assert.deepEqual(await callbackResult(done => store.get('fresh-session', done)), { userId: 'fresh-user' });
    } finally {
        await callbackResult(done => store.close(done));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
