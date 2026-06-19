const test = require('node:test');
const assert = require('node:assert');

// 1. Setup minimal database mock
const mockDb = {
    queriesRun: [],
    runQuery: async function(query, params) {
        mockDb.queriesRun.push({ query, params });
    },
    allQueryMock: () => [],
    allQuery: async function(query, params) {
        return mockDb.allQueryMock(query, params);
    },
    getQueryMock: () => null,
    getQuery: async function(query, params) {
        return mockDb.getQueryMock(query, params);
    },
    reset: function() {
        mockDb.queriesRun = [];
        mockDb.allQueryMock = () => [];
        mockDb.getQueryMock = () => null;
    }
};

// 2. Intercept and cache require('../db') in staging service
require.cache[require.resolve('../../db')] = {
    exports: mockDb
};

// 3. Require the staging service
const staging = require('../../services/staging');

test('staging compiler unit tests', async (t) => {
    
    t.beforeEach(() => {
        mockDb.reset();
    });

    await t.test('calling commitDayStaging twice in one day produces correctly weighted temperature/humidity averages and counts', async () => {
        const date = '2026-06-19';
        const batchId = 123;

        // --- FIRST CALL: 3 sensor readings (Temp: 20, 22, 24; Hum: 50, 52, 54) ---
        const firstBatchStaging = [
            {
                id: 101,
                batch_id: batchId,
                date,
                module: 'sensors',
                data: JSON.stringify({ temperature: 20.0, humidity: 50.0 }),
                status: 'pending',
                timestamp: '2026-06-19T10:00:00+03:00'
            },
            {
                id: 102,
                batch_id: batchId,
                date,
                module: 'sensors',
                data: JSON.stringify({ temperature: 22.0, humidity: 52.0 }),
                status: 'pending',
                timestamp: '2026-06-19T11:00:00+03:00'
            },
            {
                id: 103,
                batch_id: batchId,
                date,
                module: 'sensors',
                data: JSON.stringify({ temperature: 24.0, humidity: 54.0 }),
                status: 'pending',
                timestamp: '2026-06-19T12:00:00+03:00'
            }
        ];

        mockDb.allQueryMock = (query, params) => {
            return firstBatchStaging;
        };
        mockDb.getQueryMock = (query, params) => {
            return null; // No existing log
        };

        await staging.commitDayStaging(date, batchId);

        // Find the log insertion query in queriesRun
        const insertLogQuery1 = mockDb.queriesRun.find(q => q.query.includes('INSERT INTO logs'));
        assert.ok(insertLogQuery1, 'Should have run log insertion query');
        
        const logDataCall1 = JSON.parse(insertLogQuery1.params[2]);
        assert.strictEqual(logDataCall1.temperature_avg, 22.0); // (20 + 22 + 24) / 3
        assert.strictEqual(logDataCall1.humidity_avg, 52); // (50 + 52 + 54) / 3
        assert.strictEqual(logDataCall1.sample_count, 3);

        // Reset queries run tracker
        mockDb.queriesRun = [];

        // --- SECOND CALL: 2 sensor readings (Temp: 26, 28; Hum: 56, 58) ---
        const secondBatchStaging = [
            {
                id: 104,
                batch_id: batchId,
                date,
                module: 'sensors',
                data: JSON.stringify({ temperature: 26.0, humidity: 56.0 }),
                status: 'pending',
                timestamp: '2026-06-19T13:00:00+03:00'
            },
            {
                id: 105,
                batch_id: batchId,
                date,
                module: 'sensors',
                data: JSON.stringify({ temperature: 28.0, humidity: 58.0 }),
                status: 'pending',
                timestamp: '2026-06-19T14:00:00+03:00'
            }
        ];

        mockDb.allQueryMock = (query, params) => {
            return secondBatchStaging;
        };
        mockDb.getQueryMock = (query, params) => {
            // Return log data saved from first call
            return { data: JSON.stringify(logDataCall1) };
        };

        await staging.commitDayStaging(date, batchId);

        const insertLogQuery2 = mockDb.queriesRun.find(q => q.query.includes('INSERT INTO logs'));
        assert.ok(insertLogQuery2, 'Should have run log updates query');
        
        const logDataCall2 = JSON.parse(insertLogQuery2.params[2]);
        
        // Expected Temp Avg: (22.0 * 3 + 26.0 + 28.0) / 5 = (66 + 54) / 5 = 24.0
        assert.strictEqual(logDataCall2.temperature_avg, 24.0);
        
        // Expected Hum Avg: (52 * 3 + 56 + 58) / 5 = (156 + 114) / 5 = 270 / 5 = 54
        assert.strictEqual(logDataCall2.humidity_avg, 54);
        
        // Expected Sample Count: 3 + 2 = 5
        assert.strictEqual(logDataCall2.sample_count, 5);
    });

    await t.test('egg collections from two separate calls are merged and deduped by staging id', async () => {
        const date = '2026-06-19';
        const batchId = 123;

        // --- FIRST CALL: 2 egg collections ---
        const firstEggStaging = [
            {
                id: 'event-1',
                batch_id: batchId,
                date,
                module: 'eggs',
                data: JSON.stringify({ count: 10, broken: 0, time: '08:00', label: 'Round 1' }),
                status: 'pending',
                timestamp: '2026-06-19T08:05:00+03:00'
            },
            {
                id: 'event-2',
                batch_id: batchId,
                date,
                module: 'eggs',
                data: JSON.stringify({ count: 15, broken: 1, time: '12:00', label: 'Round 2' }),
                status: 'pending',
                timestamp: '2026-06-19T12:05:00+03:00'
            }
        ];

        mockDb.allQueryMock = (query, params) => {
            return firstEggStaging;
        };
        mockDb.getQueryMock = (query, params) => {
            return null; // No existing log
        };

        await staging.commitDayStaging(date, batchId);

        const insertLogQuery1 = mockDb.queriesRun.find(q => q.query.includes('INSERT INTO logs'));
        assert.ok(insertLogQuery1, 'Should insert log row');
        
        const logDataCall1 = JSON.parse(insertLogQuery1.params[2]);
        assert.strictEqual(logDataCall1.collections.length, 2);
        assert.strictEqual(logDataCall1.eggs, 26); // 10 + 15 + 1
        assert.strictEqual(logDataCall1.eggs_broken, 1);

        // Reset queries run tracker
        mockDb.queriesRun = [];

        // --- SECOND CALL: 1 duplicate (amended) egg collection, 1 new egg collection ---
        const secondEggStaging = [
            {
                id: 'event-1', // same event-1 ID
                batch_id: batchId,
                date,
                module: 'eggs',
                data: JSON.stringify({ count: 12, broken: 0, time: '08:00', label: 'Round 1' }), // count changed to 12
                status: 'pending',
                timestamp: '2026-06-19T15:00:00+03:00'
            },
            {
                id: 'event-3', // new collection
                batch_id: batchId,
                date,
                module: 'eggs',
                data: JSON.stringify({ count: 20, broken: 0, time: '16:00', label: 'Round 3' }),
                status: 'pending',
                timestamp: '2026-06-19T16:05:00+03:00'
            }
        ];

        mockDb.allQueryMock = (query, params) => {
            return secondEggStaging;
        };
        mockDb.getQueryMock = (query, params) => {
            return { data: JSON.stringify(logDataCall1) };
        };

        await staging.commitDayStaging(date, batchId);

        const insertLogQuery2 = mockDb.queriesRun.find(q => q.query.includes('INSERT INTO logs'));
        assert.ok(insertLogQuery2, 'Should update log row');
        
        const logDataCall2 = JSON.parse(insertLogQuery2.params[2]);
        
        // Assertions
        assert.strictEqual(logDataCall2.collections.length, 3, 'Should deduplicate and contain exactly 3 egg collections');
        
        const c1 = logDataCall2.collections.find(c => c._id === 'event-1');
        const c2 = logDataCall2.collections.find(c => c._id === 'event-2');
        const c3 = logDataCall2.collections.find(c => c._id === 'event-3');
        
        assert.ok(c1 && c2 && c3, 'All three collections must be present');
        assert.strictEqual(c1.count, 12, 'First collection count should be updated to 12');
        assert.strictEqual(c2.count, 15, 'Second collection count should remain 15');
        assert.strictEqual(c3.count, 20, 'Third collection count should be 20');
        
        assert.strictEqual(logDataCall2.eggs, 48, 'Should sum all intact + broken eggs: 12 + 15 + 1 + 20 = 48');
        assert.strictEqual(logDataCall2.eggs_broken, 1, 'Should count 1 broken egg');
    });
});
