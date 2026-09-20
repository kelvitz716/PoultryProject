'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getBatchHouseBalances } = require('../../services/batch-house-balance');

function adapter({ batch, transfers = [], logs = [], stagedDeaths = [] }) {
    return {
        async getQuery() { return batch ? { id: batch.id, data: JSON.stringify(batch.data) } : undefined; },
        async allQuery(sql) {
            if (sql.includes('batch_transfers')) return transfers;
            if (sql.includes('FROM logs')) return logs;
            if (sql.includes('FROM staging')) return stagedDeaths;
            return [];
        }
    };
}

test('house balances preserve legacy deaths at opening house and enforce each transfer source', async () => {
    const db = adapter({
        batch: { id: 'batch-1', data: { location_id: 'house:a', size: 100 } },
        transfers: [
            { id: 'move-1', source_location_id: 'house:a', destination_location_id: 'house:b', transfer_date: '2026-09-10', quantity: 40 },
            { id: 'move-2', source_location_id: 'house:b', destination_location_id: 'house:c', transfer_date: '2026-09-12', quantity: 5 }
        ],
        logs: [{ id: 'log-1', date: '2026-09-11', data: JSON.stringify({ mortality: 3 }) }],
        stagedDeaths: [{ id: 'death-1', date: '2026-09-12', data: JSON.stringify({ location_id: 'house:b', count: 5 }) }]
    });
    const result = await getBatchHouseBalances(db, { batch_id: 'batch-1', as_of_date: '2026-09-12' });
    assert.equal(result.conflict, null);
    assert.deepEqual(result.balances, [
        { location_id: 'house:a', live_birds: 57 },
        { location_id: 'house:b', live_birds: 30 },
        { location_id: 'house:c', live_birds: 5 }
    ]);

    const impossible = await getBatchHouseBalances(db, {
        batch_id: 'batch-1', as_of_date: '2026-09-12',
        additional_transfers: [{ id: 'move-3', source_location_id: 'house:b', destination_location_id: 'house:d', transfer_date: '2026-09-12', quantity: 36 }]
    });
    assert.equal(impossible.conflict.reason, 'transfer_exceeds_source');
});
