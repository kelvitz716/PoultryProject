const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { listLedgerAccounts } = require('../../services/ledger-reporting');

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

async function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-ledger-report-'));
    const db = await open(path.join(dir, 'ledger.sqlite'));
    await run(db, 'CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, code TEXT)');
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, account_id TEXT, entry_type TEXT,
        amount_minor INTEGER, reconciliation_status TEXT, amount REAL
    )`);
    await run(db, `INSERT INTO ledger_accounts (id, name, type, code) VALUES
        ('1000', 'Cash', 'asset', '1000'),
        ('1010', 'M-Pesa Till', 'asset', '1010'),
        ('1200', 'Receivables', 'asset', '1200'),
        ('4000', 'Egg Sales', 'revenue', '4000')`);
    t.after(async () => {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, adapter: { allQuery: (sql, params = []) => all(db, sql, params) } };
}

async function entry(db, id, accountId, type, minor, status = 'exact') {
    await run(db, `INSERT INTO ledger_entries (id, account_id, entry_type, amount_minor, reconciliation_status, amount)
        VALUES (?, ?, ?, ?, ?, ?)`, [id, accountId, type, minor, status, minor === null ? 1.234 : minor / 100]);
}

function account(accounts, code) {
    return accounts.find(item => item.code === code);
}

test('integer-only ledger reporting derives correct balances for exact and backfilled entries', async t => {
    const s = await store(t);
    await entry(s.db, 'cash-dr', '1000', 'debit', 10000, 'legacy_backfilled');
    await entry(s.db, 'cash-cr', '1000', 'credit', 2500);
    await entry(s.db, 'revenue', '4000', 'credit', 7500);
    const accounts = await listLedgerAccounts(s.adapter);
    assert.deepEqual(account(accounts, '1000'), {
        id: '1000', name: 'Cash', type: 'asset', code: '1000', status: 'exact',
        entry_count: 2, unresolved_entry_count: 0,
        debit_minor: 10000, credit_minor: 2500, balance_minor: 7500,
        debit: 100, credit: 25, balance: 75
    });
    assert.deepEqual(account(accounts, '4000'), {
        id: '4000', name: 'Egg Sales', type: 'revenue', code: '4000', status: 'exact',
        entry_count: 1, unresolved_entry_count: 0,
        debit_minor: 0, credit_minor: 7500, balance_minor: 7500,
        debit: 0, credit: 75, balance: 75
    });
});

test('empty accounts are exact zero while unresolved rows affect only their own account', async t => {
    const s = await store(t);
    await entry(s.db, 'cash-good', '1000', 'debit', 5000);
    await entry(s.db, 'cash-ambiguous', '1000', 'debit', null, 'reconciliation_required');
    await entry(s.db, 'mpesa-good', '1010', 'debit', 7000);
    const accounts = await listLedgerAccounts(s.adapter);
    assert.deepEqual(account(accounts, '1200'), {
        id: '1200', name: 'Receivables', type: 'asset', code: '1200', status: 'exact',
        entry_count: 0, unresolved_entry_count: 0,
        debit_minor: 0, credit_minor: 0, balance_minor: 0,
        debit: 0, credit: 0, balance: 0
    });
    assert.deepEqual(account(accounts, '1000'), {
        id: '1000', name: 'Cash', type: 'asset', code: '1000', status: 'reconciliation_required',
        entry_count: 2, unresolved_entry_count: 1,
        debit_minor: null, credit_minor: null, balance_minor: null,
        debit: null, credit: null, balance: null
    });
    assert.equal(account(accounts, '1010').balance, 70);
});

test('unsafe integer aggregates are unavailable instead of rounded', async t => {
    const s = await store(t);
    await entry(s.db, 'large-a', '1010', 'debit', Number.MAX_SAFE_INTEGER);
    await entry(s.db, 'large-b', '1010', 'debit', Number.MAX_SAFE_INTEGER);
    const mpesa = account(await listLedgerAccounts(s.adapter), '1010');
    assert.deepEqual([mpesa.status, mpesa.unresolved_entry_count, mpesa.debit_minor, mpesa.balance], [
        'reconciliation_required', 0, null, null
    ]);
});
