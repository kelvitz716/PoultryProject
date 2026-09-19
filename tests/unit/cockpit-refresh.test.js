'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function extractRefreshCockpitBody() {
    const source = fs.readFileSync(path.join(__dirname, '../../js/cockpit.js'), 'utf8');
    const marker = 'window.refreshCockpitData = async function(batch) {';
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, 'refreshCockpitData assignment must exist');

    const bodyStart = start + marker.length;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (let index = bodyStart; index < source.length; index += 1) {
        const char = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote) {
            if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            quote = char;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(bodyStart, index);
        }
    }
    throw new Error('refreshCockpitData function body is incomplete');
}

test('cockpit refresh passes one derived initial cash value through ledger and transaction rendering', async () => {
    const seen = { ledgerInitialCash: null, renderedInitialCash: null };
    const dependencies = {
        api: {
            getCockpitLogs: async () => [],
            getCockpitTransactions: async () => [],
            getCockpitHealthLogs: async () => [],
            getCockpitTodayStaging: async () => null,
            getCockpitLedgerAccounts: async () => []
        },
        store: {
            farmProfile: {
                defaultFeedPrice: 4000,
                sackWeightKg: 50,
                eggStorageType: 'ambient'
            }
        },
        window: {
            USER_ROLE: 'admin',
            updateLiveSensorWidget: async () => {}
        },
        document: { getElementById: () => null },
        $: () => null,
        computeKPIs: () => ({
            todayLayRate: 0,
            avg7LayRate: 0,
            feedConversion: 0,
            projectedEggs: 0,
            layRateTrend: 0,
            currentBirds: 0,
            currentHens: 0,
            currentRoosters: 0,
            totalEggs: 0,
            totalFeed: 0,
            avgDailyFeedPerBird: 0,
            recent30: []
        }),
        deriveCockpitLedgerDisplay: ({ initialCash }) => {
            seen.ledgerInitialCash = initialCash;
            return { liquid_cash: initialCash, cash_text: '', credit_text: '' };
        },
        computeEggInventoryAging: () => ({ totalUnsold: 0, unsoldBatches: [] }),
        getActiveWithdrawal: () => ({ eggsUnderWithdrawal: false }),
        _eggCollections: [],
        _renderEggCollectionList: () => {},
        _renderTodayStagedNonEggsList: () => {},
        updateCockpitAlerts: () => {},
        renderCockpitChart: () => {},
        renderHistoryTable: () => {},
        renderCockpitTransactions: (_transactions, initialCash) => {
            seen.renderedInitialCash = initialCash;
        }
    };

    const names = Object.keys(dependencies);
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const refreshCockpitData = new AsyncFunction(...names, 'batch', extractRefreshCockpitBody());
    await refreshCockpitData(...Object.values(dependencies), {
        id: 7,
        assumptions: { workingCapital: 4321 }
    });

    assert.deepEqual(seen, { ledgerInitialCash: 4321, renderedInitialCash: 4321 });
});

test('cockpit refresh exposes a core refresh failure to both the UI and its caller', async () => {
    const seen = { toast: null };
    const dependencies = {
        api: {
            getCockpitLogs: async () => [],
            getCockpitTransactions: async () => [],
            getCockpitHealthLogs: async () => [],
            getCockpitTodayStaging: async () => null,
            getCockpitLedgerAccounts: async () => { throw new Error('ledger unavailable'); }
        },
        store: {
            farmProfile: {
                defaultFeedPrice: 4000,
                sackWeightKg: 50,
                eggStorageType: 'ambient'
            }
        },
        window: { USER_ROLE: 'admin', updateLiveSensorWidget: async () => {} },
        document: { getElementById: () => null },
        $: () => null,
        showToast: (...args) => { seen.toast = args; },
        computeKPIs: () => ({
            todayLayRate: 0,
            avg7LayRate: 0,
            feedConversion: 0,
            projectedEggs: 0,
            layRateTrend: 0,
            currentBirds: 0,
            currentHens: 0,
            currentRoosters: 0,
            totalEggs: 0,
            totalFeed: 0,
            avgDailyFeedPerBird: 0,
            recent30: []
        }),
        deriveCockpitLedgerDisplay: () => ({ liquid_cash: null, cash_text: '', credit_text: '' }),
        computeEggInventoryAging: () => ({ totalUnsold: 0, unsoldBatches: [] }),
        getActiveWithdrawal: () => ({ eggsUnderWithdrawal: false }),
        _eggCollections: [],
        _renderEggCollectionList: () => {},
        _renderTodayStagedNonEggsList: () => {},
        updateCockpitAlerts: () => {},
        renderCockpitChart: () => {},
        renderHistoryTable: () => {},
        renderCockpitTransactions: () => {}
    };

    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const refreshCockpitData = new AsyncFunction(...Object.keys(dependencies), 'batch', extractRefreshCockpitBody());
    await assert.rejects(
        refreshCockpitData(...Object.values(dependencies), { id: 7, assumptions: { workingCapital: 0 } }),
        /ledger unavailable/
    );
    assert.deepEqual(seen.toast, ['Cockpit refresh failed. Displayed figures may be stale; retry the refresh.', 'error']);
});

test('cockpit ledger chips state their actual ledger and opening-capital scope', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../js/cockpit.js'), 'utf8');
    assert.match(source, /Cash \(farm ledger \+ this batch opening capital when ledger empty\):/);
    assert.match(source, /Farm credit:/);
    assert.match(source, /Farm ledger cash plus this batch's opening capital only when the farm ledger has no entries\./);
    assert.match(source, /Farm-wide receivables balance; it is not limited to this batch\./);
});

test('cockpit strict reads preserve successful empties and retain non-OK status for a bounded optional absence', async () => {
    const { CockpitReadError, requestCockpitReadJson } = await import('../../js/api.js');
    assert.deepEqual(await requestCockpitReadJson(async () => ({ ok: true, json: async () => [] }), '/api/logs/batch-1'), []);
    await assert.rejects(
        requestCockpitReadJson(async () => ({ ok: false, status: 503, json: async () => ({}) }), '/api/ledger/accounts'),
        error => error instanceof CockpitReadError
            && error.status === 503
            && /failed \(503\).*ledger\/accounts/.test(error.message)
    );
    await assert.rejects(
        requestCockpitReadJson(async () => { throw new Error('offline'); }, '/api/health/batch-1'),
        error => error instanceof CockpitReadError
            && error.status === null
            && /unavailable.*health\/batch-1/.test(error.message)
    );
});

test('cockpit only treats an explicitly absent staging draft as optional, while protecting viewer and header paths', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../js/cockpit.js'), 'utf8');
    const refresh = extractRefreshCockpitBody();
    const openStart = source.indexOf('window.openBatchCockpit = async function(id) {');
    const headerEnd = source.indexOf("const cockpit = $('view-batch-cockpit');", openStart);
    const header = source.slice(openStart, headerEnd);

    assert.match(refresh, /error instanceof CockpitReadError && error\.status === 404/);
    assert.doesNotMatch(refresh, /getCockpitTodayStaging\(batch\.id\)\.catch\(\(\) => null\)/);
    assert.match(refresh, /window\.USER_ROLE === 'viewer'\s*\? \{ liquid_cash: null, outstanding_credit: null, cash_text: 'KES —', credit_text: 'KES —' \}/);
    assert.match(refresh, /accounts: await api\.getCockpitLedgerAccounts\(\)/);
    assert.match(header, /logs = await api\.getCockpitLogs\(id\)/);
    assert.match(header, /showToast\('Cockpit could not open\. Retry when the batch data service is available\.', 'error'\)/);
    assert.doesNotMatch(header, /api\.getLogs\(id\)/);
});

test('all fire-and-forget cockpit refresh callers use the handled-result wrapper', () => {
    const root = path.join(__dirname, '../..');
    const cockpit = fs.readFileSync(path.join(root, 'js/cockpit.js'), 'utf8');
    const sales = fs.readFileSync(path.join(root, 'js/sales.js'), 'utf8');
    const health = fs.readFileSync(path.join(root, 'js/health.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'js/api.js'), 'utf8');
    const wrapperStart = cockpit.indexOf("window.refreshCockpitSafely = async function(batch, source = 'unspecified') {");
    const wrapperEnd = cockpit.indexOf('\n};', wrapperStart) + 3;
    const cockpitOutsideWrapper = cockpit.slice(0, wrapperStart) + cockpit.slice(wrapperEnd);

    assert.notEqual(wrapperStart, -1, 'safe refresh wrapper must exist');
    assert.match(cockpit, /window\.lastCockpitRefreshResult = result/);
    assert.match(cockpit, /const result = \{ ok: false, source, error \}/);
    assert.doesNotMatch(cockpitOutsideWrapper, /refreshCockpitData\(/);
    assert.match(cockpit, /refreshCockpitSafely\(batch, 'initial cockpit load'\)/);
    assert.match(sales, /refreshCockpitSafely\(batch, 'sale save'\)/);
    assert.match(health, /refreshCockpitSafely\(batch, 'health log save'\)/);
    assert.match(api, /refreshCockpitSafely\(batch, 'offline queue replay'\)/);
});
