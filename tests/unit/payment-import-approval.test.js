const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const { migrateCustomerSettlement } = require('../../migrations/customer-settlement');
const { migratePaymentImports } = require('../../migrations/payment-imports');
const { migrateLedgerMinorUnits } = require('../../migrations/ledger-minor-units');
const { createDedicatedTransactionBoundary } = require('../../services/sqlite-transaction');
const { ingestPaymentImport, getPaymentImport, listPaymentImports } = require('../../services/payment-imports');
const { rejectPaymentImport } = require('../../services/payment-import-review');
const {
    PaymentImportApprovalNotFoundError,
    PaymentImportApprovalConflictError,
    createPaymentImportApprovalService,
    postMpesatillLedgerWithAdapter,
    validateApprovableImport
} = require('../../services/payment-import-approval');
const { registerPaymentImportApi } = require('../../services/payment-import-http');

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-import-approval-'));
    const file = path.join(dir, 'db.sqlite');
    const db = await open(file);
    await run(db, 'PRAGMA foreign_keys=ON');
    await run(db, 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE batches (id TEXT PRIMARY KEY)');
    await run(db, 'CREATE TABLE transactions (id TEXT PRIMARY KEY, batch_id TEXT, data TEXT)');
    await run(db, `CREATE TABLE ledger_accounts (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, code TEXT
    )`);
    await run(db, `CREATE TABLE ledger_transactions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id TEXT
    )`);
    await run(db, `CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY, transaction_id TEXT REFERENCES ledger_transactions(id) ON DELETE CASCADE,
        account_id TEXT, entry_type TEXT, amount REAL NOT NULL
    )`);
    await run(db, 'CREATE UNIQUE INDEX ledger_ref_type_id ON ledger_transactions(ref_type, ref_id)');
    await run(db, "INSERT INTO users (id) VALUES ('reviewer-1'), ('reviewer-2'), ('http-user')");
    await run(db, "INSERT INTO ledger_accounts (id, name, type, code) VALUES ('1010','M-Pesa Till','asset','1010'), ('1200','Accounts Receivable','asset','1200'), ('4000','Egg Sales','revenue','4000')");
    await migrateCustomerSettlement(db);
    await migratePaymentImports(db);
    await migrateLedgerMinorUnits(db);
    await run(db, `INSERT INTO customers (id, display_name, normalized_name, payment_terms_days, is_active)
        VALUES ('customer:a', 'Customer A', 'CUSTOMER A', 14, 1),
               ('customer:b', 'Customer B', 'CUSTOMER B', 0, 1),
               ('customer:inactive', 'Inactive Customer', 'INACTIVE CUSTOMER', 7, 0)`);
    t.after(async () => {
        await close(db);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const adapter = {
        runQuery: (sql, params = []) => run(db, sql, params),
        getQuery: (sql, params = []) => get(db, sql, params),
        allQuery: (sql, params = []) => all(db, sql, params)
    };
    return { db, boundary: createDedicatedTransactionBoundary(file), adapter };
}

function service(boundary, overrides = {}) {
    return createPaymentImportApprovalService({
        withDedicatedTransaction: boundary.withDedicatedTransaction,
        ...overrides
    });
}

async function imported(s, code = 'APR1234XYZ', amount = '125.50') {
    return ingestPaymentImport({
        source: 'manual', sender: 'MPESA',
        text: `${code} Confirmed. Ksh${amount} received from PAYMENT BUYER 0712345678 on 6/9/26 at 10:30 AM.`
    }, s.adapter);
}

function approvalInput(id, customer = 'customer:a', actor = 'reviewer-1') {
    return { id, customer_id: customer, reviewer_user_id: actor, created_by_user_id: actor };
}

async function surfaces(db, importId) {
    const paymentImport = await get(db, `SELECT status, customer_id, created_account_event_id, reviewer_user_id,
        reviewed_at, approved_at FROM payment_imports WHERE id = ?`, [importId]);
    const event = paymentImport?.created_account_event_id
        ? await get(db, 'SELECT * FROM customer_account_events WHERE id = ?', [paymentImport.created_account_event_id])
        : undefined;
    const header = event
        ? await get(db, 'SELECT * FROM ledger_transactions WHERE customer_account_event_id = ?', [event.id])
        : undefined;
    const entries = header
        ? await all(db, 'SELECT account_id, entry_type, amount, amount_minor, reconciliation_status FROM ledger_entries WHERE transaction_id = ? ORDER BY id', [header.id])
        : [];
    return { paymentImport, event, header, entries };
}

async function counts(db) {
    return {
        flatTransactions: (await get(db, 'SELECT COUNT(*) AS n FROM transactions')).n,
        invoices: (await get(db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'invoice'")).n,
        payments: (await get(db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE kind = 'payment'")).n,
        allocations: (await get(db, 'SELECT COUNT(*) AS n FROM customer_account_allocations')).n,
        revenue: (await get(db, "SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id IN ('4000', '4010')")).n
    };
}

test('approves one clean receipt into one unallocated M-Pesa payment and AR credit', async t => {
    const s = await store(t);
    const incoming = await imported(s);
    const result = await service(s.boundary).approvePaymentImport(approvalInput(incoming.payment_import.id));
    const saved = await surfaces(s.db, incoming.payment_import.id);
    assert.equal(result.idempotent, false);
    assert.deepEqual(
        [saved.paymentImport.status, saved.paymentImport.customer_id, saved.paymentImport.created_account_event_id, saved.paymentImport.reviewer_user_id],
        ['approved', 'customer:a', saved.event.id, 'reviewer-1']
    );
    assert.deepEqual(
        [saved.event.customer_id, saved.event.kind, saved.event.side, saved.event.status, saved.event.method,
            saved.event.amount_minor, saved.event.external_reference, saved.event.payment_import_id, saved.event.created_by_user_id],
        ['customer:a', 'payment', 'credit', 'posted', 'mpesa', 12550, 'APR1234XYZ', incoming.payment_import.id, 'reviewer-1']
    );
    assert.deepEqual(saved.entries.map(row => [row.account_id, row.entry_type, row.amount, row.amount_minor, row.reconciliation_status]).sort(), [
        ['1010', 'debit', 125.5, 12550, 'exact'],
        ['1200', 'credit', 125.5, 12550, 'exact']
    ].sort());
    const safeRead = await getPaymentImport(incoming.payment_import.id, s.adapter);
    assert.deepEqual([safeRead.customer_id, safeRead.created_account_event_id], ['customer:a', saved.event.id]);
    assert.doesNotMatch(JSON.stringify(safeRead), /0712345678/);
    assert.deepEqual(await counts(s.db), { flatTransactions: 0, invoices: 0, payments: 1, allocations: 0, revenue: 0 });
});

test('non-approvable evidence and inactive or missing customers leave every financial surface untouched', async t => {
    const s = await store(t);
    const candidates = [
        await imported(s, 'REVIE1234X', '0.00'),
        await imported(s, 'WARN1234XYZ', '1.00'),
        await imported(s, 'CONF1234XYZ', '1.00'),
        await imported(s, 'OUTG1234XYZ', '1.00'),
        await imported(s, 'REVR1234XYZ', '1.00'),
        await imported(s, 'NORE1234XYZ', '1.00'),
        await imported(s, 'MALF1234XYZ', '1.00'),
        await imported(s, 'PAID1234XYZ', '1.00'),
        await imported(s, 'UNKN1234XYZ', '1.00'),
        await imported(s, 'BADR1234XYZ', '1.00'),
        await imported(s, 'STAT1234XYZ', '1.00')
    ];
    await run(s.db, "UPDATE payment_imports SET parse_warnings = '[\"manual_warning\"]' WHERE id = ?", [candidates[1].payment_import.id]);
    await run(s.db, 'UPDATE payment_imports SET has_conflict = 1 WHERE id = ?', [candidates[2].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET direction = 'sent', event_kind = 'send_to_person' WHERE id = ?", [candidates[3].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET direction = 'reversed', event_kind = 'reversal' WHERE id = ?", [candidates[4].payment_import.id]);
    await run(s.db, 'UPDATE payment_imports SET receipt_code = NULL WHERE id = ?', [candidates[5].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET parse_warnings = 'not-json' WHERE id = ?", [candidates[6].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET direction = 'paid', event_kind = 'buy_goods_payment' WHERE id = ?", [candidates[7].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET direction = 'unknown', event_kind = 'unknown' WHERE id = ?", [candidates[8].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET receipt_code = 'bad' WHERE id = ?", [candidates[9].payment_import.id]);
    await run(s.db, "UPDATE payment_imports SET status = 'needs_review' WHERE id = ?", [candidates[10].payment_import.id]);
    for (const candidate of candidates) {
        await assert.rejects(
            service(s.boundary).approvePaymentImport(approvalInput(candidate.payment_import.id)),
            PaymentImportApprovalConflictError
        );
    }
    const outOfRangeTime = await imported(s, 'TIME1234XYZ', '1.00');
    await run(s.db, 'UPDATE payment_imports SET transaction_at_ms = ? WHERE id = ?', [8640000000000001, outOfRangeTime.payment_import.id]);
    await assert.rejects(service(s.boundary).approvePaymentImport(approvalInput(outOfRangeTime.payment_import.id)), PaymentImportApprovalConflictError);
    const base = {
        status: 'received', has_conflict: 0, direction: 'received', event_kind: 'customer_receipt',
        currency: 'KES', amount_minor: 100, receipt_code: 'BOUND1234', parse_warnings: '[]'
    };
    for (const corrupted of [
        { ...base, currency: null },
        { ...base, currency: 'USD' },
        { ...base, amount_minor: Number.MAX_SAFE_INTEGER + 1 },
        { ...base, receipt_code: null },
        { ...base, receipt_code: 'bad' }
    ]) {
        assert.throws(() => validateApprovableImport(corrupted), PaymentImportApprovalConflictError);
    }
    const clean = await imported(s, 'CUST1234XYZ', '1.00');
    await assert.rejects(service(s.boundary).approvePaymentImport(approvalInput(clean.payment_import.id, 'customer:inactive')), PaymentImportApprovalConflictError);
    await assert.rejects(service(s.boundary).approvePaymentImport(approvalInput(clean.payment_import.id, 'customer:missing')), PaymentImportApprovalNotFoundError);
    assert.deepEqual(await counts(s.db), { flatTransactions: 0, invoices: 0, payments: 0, allocations: 0, revenue: 0 });
    assert.equal((await get(s.db, 'SELECT status FROM payment_imports WHERE id = ?', [clean.payment_import.id])).status, 'received');
});

test('exact and concurrent same-customer retries remain one immutable payment, while another customer loses', async t => {
    const s = await store(t);
    const same = await imported(s, 'SAME1234XYZ', '25.00');
    const persistence = service(s.boundary);
    const results = await Promise.all([
        persistence.approvePaymentImport(approvalInput(same.payment_import.id, 'customer:a', 'reviewer-1')),
        persistence.approvePaymentImport(approvalInput(same.payment_import.id, 'customer:a', 'reviewer-2'))
    ]);
    assert.deepEqual(results.map(result => result.idempotent).sort(), [false, true]);
    const winner = results.find(result => !result.idempotent);
    const retry = await persistence.approvePaymentImport(approvalInput(same.payment_import.id, 'customer:a', 'reviewer-2'));
    const saved = await surfaces(s.db, same.payment_import.id);
    assert.equal(retry.idempotent, true);
    assert.equal(saved.event.created_by_user_id, winner.payment_import.reviewer_user_id);
    assert.equal(saved.paymentImport.reviewer_user_id, winner.payment_import.reviewer_user_id);
    assert.equal((await counts(s.db)).payments, 1);

    const different = await imported(s, 'DIFF1234XYZ', '26.00');
    const competing = await Promise.allSettled([
        persistence.approvePaymentImport(approvalInput(different.payment_import.id, 'customer:a', 'reviewer-1')),
        persistence.approvePaymentImport(approvalInput(different.payment_import.id, 'customer:b', 'reviewer-2'))
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(result => result.status === 'rejected' && result.reason instanceof PaymentImportApprovalConflictError).length, 1);
});

test('event, ledger-header, first-entry, and import-write failures roll back every approval surface', async t => {
    const s = await store(t);
    const cases = [
        ['event', { recordCustomerAccountEventWithAdapter: async () => { throw new Error('event write failure'); } }],
        ['ledger-header', {
            postMpesatillLedgerWithAdapter: async (adapter, details) => postMpesatillLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.includes('INSERT INTO ledger_transactions')) throw new Error('ledger header failure');
                    return adapter.runQuery(sql, params);
                }
            }, details)
        }],
        ['first-entry', {
            postMpesatillLedgerWithAdapter: async (adapter, details) => postMpesatillLedgerWithAdapter({
                ...adapter,
                runQuery: async (sql, params = []) => {
                    if (sql.includes("INSERT INTO ledger_entries") && sql.includes("'1010'")) throw new Error('first ledger entry failure');
                    return adapter.runQuery(sql, params);
                }
            }, details)
        }],
        ['import', {
            withDedicatedTransaction: work => s.boundary.withDedicatedTransaction(adapter => work({
                ...adapter,
                getQuery: async (sql, params = []) => {
                    if (sql.trim().startsWith('UPDATE payment_imports')) throw new Error('import update failure');
                    return adapter.getQuery(sql, params);
                }
            }))
        }]
    ];
    const codes = { event: 'FAILEV123', 'ledger-header': 'FAILHD123', 'first-entry': 'FAILFE123', import: 'FAILUP123' };
    for (const [label, overrides] of cases) {
        const candidate = await imported(s, codes[label], '2.00');
        await assert.rejects(service(s.boundary, overrides).approvePaymentImport(approvalInput(candidate.payment_import.id)), /failure/);
        assert.deepEqual(await surfaces(s.db, candidate.payment_import.id), {
            paymentImport: { status: 'received', customer_id: null, created_account_event_id: null, reviewer_user_id: null, reviewed_at: null, approved_at: null },
            event: undefined, header: undefined, entries: []
        });
    }
    assert.deepEqual(await counts(s.db), { flatTransactions: 0, invoices: 0, payments: 0, allocations: 0, revenue: 0 });
});

test('external-receipt and ledger uniqueness collisions become domain conflicts without residue', async t => {
    const s = await store(t);
    const candidate = await imported(s, 'COLL1234XYZ', '3.00');
    await run(s.db, `INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, method, external_reference, payment_import_id, idempotency_key)
        VALUES ('existing-payment', 'customer:b', 'KES', 'credit', 'payment', 'posted', 300, 'mpesa', 'COLL1234XYZ', NULL, 'existing-payment-key')`);
    await assert.rejects(service(s.boundary).approvePaymentImport(approvalInput(candidate.payment_import.id)), PaymentImportApprovalConflictError);
    assert.equal((await get(s.db, 'SELECT status FROM payment_imports WHERE id = ?', [candidate.payment_import.id])).status, 'received');
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM ledger_transactions WHERE ref_id = ?", [candidate.payment_import.id])).n, 0);

    const ledgerCollision = await imported(s, 'LEDC1234XYZ', '3.01');
    await run(s.db, `INSERT INTO ledger_transactions (id, date, ref_type, ref_id)
        VALUES ('existing-ledger-ref', CURRENT_TIMESTAMP, 'payment_import_approval', ?)`, [ledgerCollision.payment_import.id]);
    await assert.rejects(service(s.boundary).approvePaymentImport(approvalInput(ledgerCollision.payment_import.id)), PaymentImportApprovalConflictError);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE payment_import_id = ?", [ledgerCollision.payment_import.id])).n, 0);

    const deterministicCollision = await imported(s, 'DLED1234XYZ', '3.02');
    const digest = crypto.createHash('sha256')
        .update(`payment-import-approval:${deterministicCollision.payment_import.id}`).digest('hex');
    const deterministicLedgerId = `ledger-payment:${digest.slice(0, 36)}`;
    await run(s.db, `INSERT INTO ledger_transactions (id, date, ref_type, ref_id)
        VALUES (?, CURRENT_TIMESTAMP, 'unrelated', 'deterministic-collision')`, [deterministicLedgerId]);
    await assert.rejects(service(s.boundary).approvePaymentImport(approvalInput(deterministicCollision.payment_import.id)), PaymentImportApprovalConflictError);
    assert.equal((await get(s.db, "SELECT COUNT(*) AS n FROM customer_account_events WHERE payment_import_id = ?", [deterministicCollision.payment_import.id])).n, 0);
});

test('approved retry verifies deterministic IDs and original provenance, and fails closed on corruption', async t => {
    const s = await store(t);
    const persistence = service(s.boundary);
    const provenance = await imported(s, 'PROV1234XYZ', '4.00');
    await persistence.approvePaymentImport(approvalInput(provenance.payment_import.id));
    const provenanceState = await surfaces(s.db, provenance.payment_import.id);
    await run(s.db, 'UPDATE customer_account_events SET created_by_user_id = ? WHERE id = ?', ['tampered-actor', provenanceState.event.id]);
    await assert.rejects(persistence.approvePaymentImport(approvalInput(provenance.payment_import.id, 'customer:a', 'reviewer-2')), PaymentImportApprovalConflictError);

    const key = await imported(s, 'KEYS1234XYZ', '4.01');
    await persistence.approvePaymentImport(approvalInput(key.payment_import.id));
    const keyState = await surfaces(s.db, key.payment_import.id);
    await run(s.db, 'DROP TRIGGER customer_events_immutable_posted');
    await run(s.db, 'UPDATE customer_account_events SET idempotency_key = ? WHERE id = ?', ['tampered-key', keyState.event.id]);
    await assert.rejects(persistence.approvePaymentImport(approvalInput(key.payment_import.id)), PaymentImportApprovalConflictError);

    const ledger = await imported(s, 'LINK1234XYZ', '4.02');
    await persistence.approvePaymentImport(approvalInput(ledger.payment_import.id));
    const ledgerState = await surfaces(s.db, ledger.payment_import.id);
    await run(s.db, 'DELETE FROM ledger_transactions WHERE id = ?', [ledgerState.header.id]);
    await run(s.db, `INSERT INTO ledger_transactions
        (id, date, ref_type, ref_id, customer_account_event_id)
        VALUES ('tampered-ledger', CURRENT_TIMESTAMP, 'payment_import_approval', ?, ?)`,
    [ledger.payment_import.id, ledgerState.event.id]);
    await assert.rejects(persistence.approvePaymentImport(approvalInput(ledger.payment_import.id)), PaymentImportApprovalConflictError);
});

function request(server, { method = 'POST', pathname, role, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, method, path: pathname,
            headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

test('approval HTTP route enforces roles, exact payload, session actor, and safe failures', async t => {
    const s = await store(t);
    const candidate = await imported(s, 'HTTP1234XYZ', '5.00');
    const actual = service(s.boundary);
    const calls = [];
    const approvalService = {
        approvePaymentImport: async input => {
            calls.push(input);
            if (input.customer_id === 'customer:boom') throw new Error('SQL payment SMS 0712345678 secret');
            return actual.approvePaymentImport(input);
        }
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const role = req.headers['x-role'];
        req.session = role ? { userId: 'http-user', userRole: role } : {};
        next();
    });
    const requireRole = (...roles) => (req, res, next) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.session.userRole)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
    registerPaymentImportApi(app, {
        paymentService: { getPaymentImport: id => getPaymentImport(id, s.adapter), listPaymentImports: options => listPaymentImports(options, s.adapter), ingestPaymentImport: () => { throw new Error('unused'); } },
        reviewService: { rejectPaymentImport }, approvalService, requireRole
    });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => server.close());
    const route = `/api/payment-imports/${candidate.payment_import.id}/approve`;
    assert.equal((await request(server, { pathname: route, body: { customer_id: 'customer:a' } })).status, 401);
    assert.equal((await request(server, { pathname: route, role: 'viewer', body: { customer_id: 'customer:a' } })).status, 403);
    assert.equal((await request(server, { pathname: route, role: 'farmer', body: { customer_id: 'customer:a', reviewer_user_id: 'forged' } })).status, 400);
    assert.equal((await request(server, { pathname: `/api/payment-imports/${'x'.repeat(129)}/approve`, role: 'farmer', body: { customer_id: 'customer:a' } })).status, 400);
    const approved = await request(server, { pathname: route, role: 'farmer', body: { customer_id: 'customer:a' } });
    assert.equal(approved.status, 200);
    assert.deepEqual(calls.find(call => call.id === candidate.payment_import.id), { id: candidate.payment_import.id, customer_id: 'customer:a', reviewer_user_id: 'http-user', created_by_user_id: 'http-user' });
    assert.equal((await request(server, { pathname: '/api/payment-imports/missing/approve', role: 'admin', body: { customer_id: 'customer:a' } })).status, 404);
    const conflict = await request(server, { pathname: route, role: 'admin', body: { customer_id: 'customer:b' } });
    assert.deepEqual(conflict, { status: 409, body: { error: 'Payment import cannot be approved' } });
    assert.doesNotMatch(JSON.stringify(conflict), /0712345678|SQL|secret/i);
    const failure = await request(server, { pathname: route, role: 'admin', body: { customer_id: 'customer:boom' } });
    assert.deepEqual(failure, { status: 500, body: { error: 'Payment import service unavailable' } });
    assert.doesNotMatch(JSON.stringify(failure), /0712345678|SQL|secret/i);
});
