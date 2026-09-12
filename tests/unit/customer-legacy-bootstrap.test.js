const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { bootstrapLegacyBuyers } = require('../../services/customer-legacy-bootstrap');

function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db));
    });
}
function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        return error ? reject(error) : resolve(this);
    }));
}
function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}
function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-legacy-buyers-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'CREATE TABLE entities (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME)');
    await run(db, 'CREATE TABLE payment_imports (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await run(db, 'CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY)');
    await migrateCustomerSettlement(db);
    await migrateCustomerSettlement(db);
    t.after(async () => {
        await close(db);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, boundary: createDedicatedTransactionBoundary(file) };
}

async function saveProfile(db, value) {
    const raw = JSON.stringify(value);
    await run(db, 'INSERT INTO entities (key, value) VALUES (?, ?)', ['poultryFarmProfile', raw]);
    return raw;
}

test('legacy buyer bootstrap handles missing and empty server profiles without writes', async t => {
    const s = await store(t);
    const missing = await bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary);
    assert.deepEqual(missing, {
        profile_found: false,
        imported: 0,
        existing: 0,
        links: [],
        issues: [],
        issues_truncated: false
    });

    await saveProfile(s.db, { farm_name: 'Local Farm' });
    const empty = await bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary);
    assert.equal(empty.profile_found, true);
    assert.deepEqual([empty.imported, empty.existing, empty.links.length, empty.issues.length], [0, 0, 0, 0]);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customers')).n, 0);
});

test('legacy buyer bootstrap preserves distinct same names, duplicates, and reordered mappings', async t => {
    const s = await store(t);
    const profile = {
        buyers: [
            { name: 'Same Name', phone: '0712 345 678', terms: 'COD' },
            { name: 'Same Name', phone: '+254 722 222 222', terms: 'Net 7' },
            { name: 'Duplicate', phone: '0711 111 111', terms: 'Net 14' },
            { name: 'Duplicate', phone: '0711 111 111', terms: 'Net 14' }
        ]
    };
    const raw = await saveProfile(s.db, profile);
    const first = await bootstrapLegacyBuyers({ actor_user_id: 'admin-1' }, s.boundary);
    assert.deepEqual([first.imported, first.existing, first.issues], [4, 0, []]);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customers WHERE normalized_name = 'SAME NAME'")).n, 2);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customers WHERE normalized_name = 'DUPLICATE'")).n, 2);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM legacy_customer_links')).n, 4);
    assert.equal((await get(s.db, "SELECT value FROM entities WHERE key = 'poultryFarmProfile'")).value, raw);

    const originalCustomerIds = first.links.map(link => link.customer_id).sort();
    await run(s.db, 'UPDATE entities SET value = ? WHERE key = ?', [JSON.stringify({ buyers: [
        profile.buyers[3], profile.buyers[1], profile.buyers[2], profile.buyers[0]
    ] }), 'poultryFarmProfile']);
    const reordered = await bootstrapLegacyBuyers({ actor_user_id: 'admin-2' }, s.boundary);
    assert.deepEqual([reordered.imported, reordered.existing], [0, 4]);
    assert.deepEqual(reordered.links.map(link => link.customer_id).sort(), originalCustomerIds);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customers')).n, 4);
});

test('invalid legacy records safely require review while valid records import atomically', async t => {
    const s = await store(t);
    const raw = await saveProfile(s.db, {
        buyers: [
            { name: 'Valid Buyer', phone: '0712 333 333', terms: 'Net 30' },
            { name: 'Terms Review', phone: '0712 444 444', terms: 'Net 90' },
            { name: 'Phone Review', phone: 'not-a-phone', terms: 'COD' },
            { name: ' Walk-in Customer ', phone: '', terms: 'COD' },
            { name: 'Extra Field', phone: '', terms: 'COD', token: 'do-not-store' }
        ]
    });
    const result = await bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary);
    assert.deepEqual([result.imported, result.existing], [1, 0]);
    assert.deepEqual(result.issues, [
        { index: 1, code: 'unknown_terms' },
        { index: 2, code: 'invalid_phone' },
        { index: 3, code: 'reserved_walk_in' },
        { index: 4, code: 'invalid_record' }
    ]);
    assert.doesNotMatch(JSON.stringify(result), /not-a-phone|do-not-store|Walk-in Customer/);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customers')).n, 1);
    assert.equal((await get(s.db, "SELECT value FROM entities WHERE key = 'poultryFarmProfile'")).value, raw);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM transactions')).n, 0);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM payment_imports')).n, 0);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM ledger_transactions')).n, 0);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM ledger_entries')).n, 0);
});

test('repeated and concurrent bootstrap calls create only one link per legacy occurrence', async t => {
    const s = await store(t);
    await saveProfile(s.db, { buyers: [{ name: 'Concurrent Buyer', phone: '0712 111 222', terms: 'COD' }] });
    const results = await Promise.all([
        bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary),
        bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary)
    ]);
    assert.deepEqual(results.map(result => result.imported).sort(), [0, 1]);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customers')).n, 1);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM legacy_customer_links')).n, 1);
    const retry = await bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary);
    assert.deepEqual([retry.imported, retry.existing], [0, 1]);
});

test('legacy bootstrap rolls back all valid records if a link write fails', async t => {
    const s = await store(t);
    await saveProfile(s.db, { buyers: [
        { name: 'Rollback One', phone: '0712 111 333', terms: 'COD' },
        { name: 'Rollback Two', phone: '0712 111 444', terms: 'COD' }
    ] });
    const failingBoundary = {
        withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(async db => work({
            ...db,
            runQuery: async (sql, params = []) => {
                if (sql.includes('INSERT INTO legacy_customer_links')) throw new Error('injected link failure');
                return db.runQuery(sql, params);
            }
        }))
    };
    await assert.rejects(bootstrapLegacyBuyers({ actor_user_id: 'admin-1' }, failingBoundary), /injected link failure/);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM customers')).n, 0);
    assert.equal((await get(s.db, 'SELECT COUNT(*) AS n FROM legacy_customer_links')).n, 0);
});

test('legacy customer link migration is rerunnable and contains no raw profile field', async t => {
    const s = await store(t);
    const columns = (await all(s.db, 'PRAGMA table_info(legacy_customer_links)')).map(column => column.name);
    assert.deepEqual(columns.includes('legacy_record_identity'), true);
    assert.equal(columns.some(column => /raw|json|phone|name/i.test(column)), false);
    const logs = [];
    const originalLog = console.log;
    console.log = (...values) => logs.push(values.join(' '));
    try {
        await saveProfile(s.db, { buyers: [{ name: 'No Logs', phone: '0712 111 555', terms: 'COD' }] });
        await bootstrapLegacyBuyers({ actor_user_id: 'farmer-1' }, s.boundary);
    } finally {
        console.log = originalLog;
    }
    assert.equal(logs.join('\n'), '');
});
