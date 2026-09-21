'use strict';

const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function callbackOrThrow(callback, error, value) {
    if (typeof callback === 'function') {
        callback(error || null, value);
        return;
    }
    if (error) throw error;
}

function expiresAt(serializedSession) {
    const candidate = serializedSession?.cookie?.expires;
    const parsed = candidate ? new Date(candidate).getTime() : NaN;
    return Number.isSafeInteger(parsed) && parsed > Date.now() ? parsed : Date.now() + DEFAULT_TTL_MS;
}

/**
 * Minimal SQLite session store compatible with the established connect-sqlite3
 * table shape. It deliberately owns no application data beyond signed-session
 * JSON, and uses the project-pinned sqlite3 runtime rather than a stale nested
 * native dependency tree.
 */
class SqliteSessionStore extends session.Store {
    constructor({ databasePath, table = 'sessions' } = {}) {
        super();
        if (typeof databasePath !== 'string' || !databasePath) {
            throw new Error('SqliteSessionStore requires an absolute database path');
        }
        if (table !== 'sessions') {
            throw new Error('SqliteSessionStore only supports the fixed sessions table');
        }
        this.db = new sqlite3.Database(databasePath);
        this.ready = new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(
                    'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL)',
                    error => {
                        if (error) return reject(error);
                        this.db.all('PRAGMA table_info(sessions)', (columnError, columns) => {
                            if (columnError) return reject(columnError);
                            if (columns.some(column => column.name === 'expire')) return resolve();
                            // Older connect-sqlite3 deployments used `expired` rather than
                            // `expire`. Do not infer validity from legacy serialized rows:
                            // adding the zero default safely requires a fresh login instead.
                            this.db.run('ALTER TABLE sessions ADD COLUMN expire INTEGER NOT NULL DEFAULT 0', alterError => {
                                if (alterError) reject(alterError);
                                else resolve();
                            });
                        });
                    }
                );
            });
        });
    }

    _run(sql, params) {
        return this.ready.then(() => new Promise((resolve, reject) => {
            this.db.run(sql, params, function (error) {
                if (error) reject(error);
                else resolve(this);
            });
        }));
    }

    _get(sql, params) {
        return this.ready.then(() => new Promise((resolve, reject) => {
            this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
        }));
    }

    _all(sql, params) {
        return this.ready.then(() => new Promise((resolve, reject) => {
            this.db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
        }));
    }

    get(sid, callback) {
        this._get('SELECT sess FROM sessions WHERE sid = ? AND expire > ?', [sid, Date.now()])
            .then(row => callbackOrThrow(callback, null, row ? JSON.parse(row.sess) : null))
            .catch(error => callbackOrThrow(callback, error));
    }

    set(sid, value, callback) {
        let serialized;
        try { serialized = JSON.stringify(value); } catch (error) { callbackOrThrow(callback, error); return; }
        this._run(
            'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire',
            [sid, serialized, expiresAt(value)]
        ).then(() => callbackOrThrow(callback)).catch(error => callbackOrThrow(callback, error));
    }

    touch(sid, value, callback) {
        this._run('UPDATE sessions SET expire = ? WHERE sid = ?', [expiresAt(value), sid])
            .then(() => callbackOrThrow(callback)).catch(error => callbackOrThrow(callback, error));
    }

    destroy(sid, callback) {
        this._run('DELETE FROM sessions WHERE sid = ?', [sid])
            .then(() => callbackOrThrow(callback)).catch(error => callbackOrThrow(callback, error));
    }

    /**
     * Removes every persisted session belonging to one application user.
     * Session JSON is deliberately parsed in JavaScript instead of relying on
     * SQLite JSON extensions, which are not guaranteed by every supported
     * SQLite build.
     */
    async destroyByUserId(userId) {
        if (typeof userId !== 'string' || !userId) {
            throw new Error('destroyByUserId requires a user ID');
        }
        const rows = await this._all('SELECT sid, sess FROM sessions', []);
        const sessionIds = rows.flatMap(({ sid, sess }) => {
            try {
                return JSON.parse(sess)?.userId === userId ? [sid] : [];
            } catch {
                // Leave malformed rows for the regular session read path to
                // surface; they cannot safely be attributed to this user.
                return [];
            }
        });
        await Promise.all(sessionIds.map(sid => this._run('DELETE FROM sessions WHERE sid = ?', [sid])));
        return sessionIds.length;
    }

    clear(callback) {
        this._run('DELETE FROM sessions', [])
            .then(() => callbackOrThrow(callback)).catch(error => callbackOrThrow(callback, error));
    }

    length(callback) {
        this._get('SELECT COUNT(*) AS count FROM sessions WHERE expire > ?', [Date.now()])
            .then(row => callbackOrThrow(callback, null, row.count)).catch(error => callbackOrThrow(callback, error));
    }

    all(callback) {
        this._all('SELECT sess FROM sessions WHERE expire > ? ORDER BY sid ASC', [Date.now()])
            .then(rows => callbackOrThrow(callback, null, rows.map(row => JSON.parse(row.sess))))
            .catch(error => callbackOrThrow(callback, error));
    }

    close(callback) {
        this.ready.then(() => this.db.close(error => callbackOrThrow(callback, error))).catch(error => callbackOrThrow(callback, error));
    }
}

module.exports = { SqliteSessionStore, expiresAt };
