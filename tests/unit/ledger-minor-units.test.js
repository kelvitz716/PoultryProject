const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { parseKesAmount } = require('../../services/kes-money');
const { migrateLedgerMinorUnits } = require('../../migrations/ledger-minor-units');

function open(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function legacyDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-ledger-minor-'));
    const db = await open(path.join(dir, 'ledger.sqlite'));
    await run(db, 'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, amount REAL)');
    t.after(async () => {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

test('ledger minor-unit migration upgrades legacy rows conservatively and reruns without changing decisions', async t => {
    const db = await legacyDatabase(t);
    await run(db, `INSERT INTO ledger_entries (id, amount) VALUES
        ('integer', 100), ('penny', 0.01), ('decimal', 1250.50),
        ('binary-007', 0.07), ('binary-029', 0.29), ('binary-1012', 10.12),
        ('three-decimal', 1.234), ('zero', 0), ('negative', -1), ('unsafe', 90071992547410)`);

    await migrateLedgerMinorUnits(db);
    const first = await all(db, `SELECT id, amount, amount_minor, reconciliation_status
        FROM ledger_entries ORDER BY id`);
    assert.deepEqual(first, [
        { id: 'binary-007', amount: 0.07, amount_minor: 7, reconciliation_status: 'legacy_backfilled' },
        { id: 'binary-029', amount: 0.29, amount_minor: 29, reconciliation_status: 'legacy_backfilled' },
        { id: 'binary-1012', amount: 10.12, amount_minor: 1012, reconciliation_status: 'legacy_backfilled' },
        { id: 'decimal', amount: 1250.5, amount_minor: 125050, reconciliation_status: 'legacy_backfilled' },
        { id: 'integer', amount: 100, amount_minor: 10000, reconciliation_status: 'legacy_backfilled' },
        { id: 'negative', amount: -1, amount_minor: null, reconciliation_status: 'reconciliation_required' },
        { id: 'penny', amount: 0.01, amount_minor: 1, reconciliation_status: 'legacy_backfilled' },
        { id: 'three-decimal', amount: 1.234, amount_minor: null, reconciliation_status: 'reconciliation_required' },
        { id: 'unsafe', amount: 90071992547410, amount_minor: null, reconciliation_status: 'reconciliation_required' },
        { id: 'zero', amount: 0, amount_minor: null, reconciliation_status: 'reconciliation_required' }
    ]);
    await migrateLedgerMinorUnits(db);
    assert.deepEqual(await all(db, `SELECT id, amount, amount_minor, reconciliation_status
        FROM ledger_entries ORDER BY id`), first);
});

test('fresh migrated schema constrains exact and reconciliation-required minor-unit states', async t => {
    const db = await legacyDatabase(t);
    await migrateLedgerMinorUnits(db);
    await run(db, `INSERT INTO ledger_entries (id, amount, amount_minor, reconciliation_status)
        VALUES ('exact', 12.34, 1234, 'exact')`);
    await assert.rejects(
        run(db, "INSERT INTO ledger_entries (id, amount, amount_minor, reconciliation_status) VALUES ('bad-exact', 1, NULL, 'exact')"),
        /invalid ledger minor-unit reconciliation state/
    );
    await assert.rejects(
        run(db, "INSERT INTO ledger_entries (id, amount, amount_minor, reconciliation_status) VALUES ('bad-review', 1.234, 123, 'reconciliation_required')"),
        /invalid ledger minor-unit reconciliation state/
    );
    await assert.rejects(
        run(db, "INSERT INTO ledger_entries (id, amount, amount_minor, reconciliation_status) VALUES ('mismatch', 1, 200, 'exact')"),
        /invalid ledger minor-unit reconciliation state/
    );
    await assert.rejects(
        run(db, "UPDATE ledger_entries SET amount = 2 WHERE id = 'exact'"),
        /invalid ledger minor-unit reconciliation state/
    );
    await assert.rejects(
        run(db, "INSERT INTO ledger_entries (id, amount, reconciliation_status) VALUES ('pending', 1, 'legacy_pending')"),
        /legacy_pending is migration-only/
    );
});

test('strict KES parser accepts only positive plain decimal values that round-trip safely', () => {
    assert.deepEqual(parseKesAmount(1), { amount: 1, amountMinor: 100 });
    assert.deepEqual(parseKesAmount(0.01), { amount: 0.01, amountMinor: 1 });
    assert.deepEqual(parseKesAmount('1250.50'), { amount: 1250.5, amountMinor: 125050 });
    assert.deepEqual(parseKesAmount('9.9'), { amount: 9.9, amountMinor: 990 });
    for (const invalid of [
        '1.234', '1e3', '1,000', '100KES', ' 1', '1 ', '', 'NaN', 'Infinity',
        NaN, Infinity, -1, 0, '0', '-0.01', '90071992547409.92'
    ]) {
        assert.throws(() => parseKesAmount(invalid), RangeError, String(invalid));
    }
});
