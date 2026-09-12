const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Daraja callback and callback-only reconciliation surfaces remain removed', () => {
    const server = read('server.js');
    const api = read('js/api.js');
    const settings = read('js/settings.js');
    const page = read('index.html');

    assert.equal(fs.existsSync(path.join(root, 'services/mpesa.js')), false);
    assert.doesNotMatch(server, /app\.post\('\/api\/payments\/mpesa-callback'/);
    assert.doesNotMatch(server, /app\.get\('\/api\/ledger\/reconciliation'/);
    assert.doesNotMatch(server, /app\.post\('\/api\/ledger\/reconcile'/);
    assert.doesNotMatch(server, /handleMpesaCallback/);
    assert.doesNotMatch(api, /ledger\/reconciliation|ledger\/reconcile/);
    assert.doesNotMatch(settings, /reconciliation-console|reconcileTransaction/);
    assert.doesNotMatch(page, /M-Pesa Daraja API Integration|reconciliation-console-card/);
});

test('generic ledger and transaction routes continue to use the generic ledger service', () => {
    const server = read('server.js');
    const transactionRoutes = read('services/transaction-persistence-http.js');

    assert.match(server, /require\('\.\/services\/ledger'\)/);
    assert.match(server, /app\.get\('\/api\/ledger\/accounts'/);
    assert.match(server, /app\.get\('\/api\/transactions\/:batchId'/);
    assert.match(server, /registerTransactionPersistenceApi\(app/);
    assert.match(transactionRoutes, /app\.post\('\/api\/transactions\/:batchId'/);
    assert.match(transactionRoutes, /app\.delete\('\/api\/transactions\/:batchId\/:id'/);
});
