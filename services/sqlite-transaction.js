/**
 * Small dedicated SQLite transaction boundary for financial-domain services.
 * A separate connection keeps unrelated shared-connection writes from joining
 * or being rolled back with the caller's multi-statement unit of work.
 */

const sqlite3 = require('sqlite3').verbose();

function openConnection(filename) {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(filename, error => error ? reject(error) : resolve(connection));
    });
}

function closeConnection(connection) {
    return new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve()));
}

function run(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.run(sql, params, function (error) {
        if (error) reject(error); else resolve(this);
    }));
}

function get(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function createDedicatedTransactionBoundary(filename) {
    if (typeof filename !== 'string' || !filename) throw new TypeError('SQLite filename is required');
    async function withTransaction(work, beginStatement) {
            if (typeof work !== 'function') throw new TypeError('transaction work must be a function');
            const connection = await openConnection(filename);
            const adapter = {
                runQuery: (sql, params = []) => run(connection, sql, params),
                getQuery: (sql, params = []) => get(connection, sql, params),
                allQuery: (sql, params = []) => all(connection, sql, params)
            };
            let started = false;
            try {
                await run(connection, 'PRAGMA foreign_keys=ON');
                await run(connection, 'PRAGMA busy_timeout=5000');
                await run(connection, beginStatement);
                started = true;
                const result = await work(adapter);
                await run(connection, 'COMMIT');
                return result;
            } catch (error) {
                if (started) await run(connection, 'ROLLBACK').catch(() => {});
                throw error;
            } finally {
                await closeConnection(connection).catch(() => {});
            }
    }
    return {
        withDedicatedTransaction: work => withTransaction(work, 'BEGIN IMMEDIATE'),
        // A deferred read transaction gives multi-query reporting a consistent
        // SQLite snapshot without taking the financial writer lock.
        withDedicatedReadTransaction: work => withTransaction(work, 'BEGIN')
    };
}

module.exports = { createDedicatedTransactionBoundary };
