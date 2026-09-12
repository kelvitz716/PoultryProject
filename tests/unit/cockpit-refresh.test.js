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
            getLogs: async () => [],
            getTransactions: async () => [],
            getHealthLogs: async () => [],
            getTodayStaging: async () => null,
            getLedgerAccounts: async () => []
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
