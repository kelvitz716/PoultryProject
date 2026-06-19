const test = require('node:test');
const assert = require('node:assert');

// Setup minimal global mocks for the frontend modules before dynamic imports
global.window = {};
global.document = {
    getElementById: () => null
};

test('engine.js & health.js unit tests', async (t) => {
    const engine = await import('../../js/engine.js');
    const health = await import('../../js/health.js');

    await t.test('computeTHI() returns correct value for known temp/humidity pairs', () => {
        // Formula: T - (0.31 - 0.31 * RH / 100) * (T - 14.4)
        
        // Known pair 1: Temp = 20, RH = 50
        // 20 - (0.31 - 0.31 * 0.5) * (20 - 14.4) = 20 - 0.155 * 5.6 = 20 - 0.868 = 19.132
        const thi1 = engine.computeTHI(20, 50);
        assert.ok(Math.abs(thi1 - 19.132) < 1e-4, `Expected close to 19.132, got ${thi1}`);

        // Known pair 2: Temp = 25, RH = 60
        // 25 - (0.31 - 0.31 * 0.6) * (25 - 14.4) = 25 - 0.124 * 10.6 = 25 - 1.3144 = 23.6856
        const thi2 = engine.computeTHI(25, 60);
        assert.ok(Math.abs(thi2 - 23.6856) < 1e-4, `Expected close to 23.6856, got ${thi2}`);

        // Known pair 3: Temp = 30, RH = 70
        // 30 - (0.31 - 0.31 * 0.7) * (30 - 14.4) = 30 - 0.093 * 15.6 = 30 - 1.4508 = 28.5492
        const thi3 = engine.computeTHI(30, 70);
        assert.ok(Math.abs(thi3 - 28.5492) < 1e-4, `Expected close to 28.5492, got ${thi3}`);

        // Null and undefined handling
        assert.strictEqual(engine.computeTHI(null, 50), null);
        assert.strictEqual(engine.computeTHI(20, null), null);
        assert.strictEqual(engine.computeTHI(undefined, undefined), null);
    });

    await t.test('getHeatStressStatus() boundary behavior at 22/24/27', () => {
        // Tiers: No Stress (<22) | Mild (22–24) | Moderate (24–27) | Severe (>=27)
        
        // Under 22 boundary
        assert.strictEqual(engine.getHeatStressStatus(21.9).label, 'No Stress');
        
        // 22.0 boundary (start of Mild Heat)
        assert.strictEqual(engine.getHeatStressStatus(22.0).label, 'Mild Heat');
        assert.strictEqual(engine.getHeatStressStatus(23.9).label, 'Mild Heat');
        
        // 24.0 boundary (start of Moderate Heat)
        assert.strictEqual(engine.getHeatStressStatus(24.0).label, 'Mod. Heat');
        assert.strictEqual(engine.getHeatStressStatus(26.9).label, 'Mod. Heat');
        
        // 27.0 boundary (start of Severe Heat)
        assert.strictEqual(engine.getHeatStressStatus(27.0).label, 'Severe Heat');
        assert.strictEqual(engine.getHeatStressStatus(35.0).label, 'Severe Heat');
        
        // Null/undefined index handling
        assert.strictEqual(engine.getHeatStressStatus(null).label, 'No data');
    });

    await t.test('DRUG_WITHDRAWAL_TABLE off-label override (14d egg / 28d meat)', () => {
        const drug = 'Oxytetracycline'; // Standard: egg 3d, meat 3d
        
        // 1. Standard label usage test
        const stdMeds = [{ type: 'meds', drug, date: '2026-06-19', offLabel: false }];
        const stdRes = health.getActiveWithdrawal(stdMeds, []);
        
        // Expected clear dates are 3 days after administration
        const expectedStdEggClear = new Date(new Date('2026-06-19').getTime() + 3 * 86400000);
        const expectedStdMeatClear = new Date(new Date('2026-06-19').getTime() + 3 * 86400000);
        
        assert.deepEqual(stdRes.eggClearDate, expectedStdEggClear);
        assert.deepEqual(stdRes.meatClearDate, expectedStdMeatClear);

        // 2. Off-label usage test (enforces minimum 14-day egg and 28-day meat withdrawal)
        const offLabelMeds = [{ type: 'meds', drug, date: '2026-06-19', offLabel: true }];
        const olRes = health.getActiveWithdrawal(offLabelMeds, []);
        
        const expectedOlEggClear = new Date(new Date('2026-06-19').getTime() + 14 * 86400000);
        const expectedOlMeatClear = new Date(new Date('2026-06-19').getTime() + 28 * 86400000);
        
        assert.deepEqual(olRes.eggClearDate, expectedOlEggClear);
        assert.deepEqual(olRes.meatClearDate, expectedOlMeatClear);
    });
});
