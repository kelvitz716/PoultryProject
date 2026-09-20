'use strict';

// House allocation is intentionally derived from the immutable transfer ledger
// plus deaths.  This keeps older, batch-level records valid: untagged deaths
// belong to the batch's opening house.
const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function opaque(value, field) {
    if (typeof value !== 'string' || !OPAQUE_ID.test(value.trim())) throw new TypeError(`${field} must be an opaque identifier`);
    return value.trim();
}

function dateOnly(value, field = 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`invalid ${field}`);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`invalid ${field}`);
    return value;
}

function integer(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function parseJson(value) {
    try { return JSON.parse(value); } catch (_) { return null; }
}

function deathEvents(log, openingLocation) {
    if (Array.isArray(log.mortality_events) && log.mortality_events.length > 0) {
        return log.mortality_events.map(event => ({
            location_id: typeof event?.location_id === 'string' && OPAQUE_ID.test(event.location_id) ? event.location_id : openingLocation,
            quantity: integer(event?.count)
        })).filter(event => event.quantity > 0);
    }
    const quantity = integer(log.mortality);
    return quantity ? [{ location_id: openingLocation, quantity }] : [];
}

function applyEvents(batch, transfers, logs, stagedDeaths, asOfDate) {
    const openingLocation = opaque(batch.location_id, 'batch location');
    const openingSize = integer(batch.size);
    const balances = new Map([[openingLocation, openingSize]]);
    const events = [];
    transfers.forEach(transfer => {
        if (transfer.transfer_date <= asOfDate) events.push({
            date: transfer.transfer_date, rank: 0, order: transfer.created_at || '', id: transfer.id || '', type: 'transfer',
            source_location_id: transfer.source_location_id, destination_location_id: transfer.destination_location_id,
            quantity: integer(transfer.quantity)
        });
    });
    logs.forEach(row => {
        const log = parseJson(row.data);
        if (!log || row.date > asOfDate) return;
        deathEvents(log, openingLocation).forEach((event, index) => events.push({
            date: row.date, rank: 1, id: `${row.id || ''}:${index}`, type: 'death', ...event
        }));
    });
    stagedDeaths.forEach(row => {
        const death = parseJson(row.data);
        if (!death || row.date > asOfDate) return;
        const location_id = typeof death.location_id === 'string' && OPAQUE_ID.test(death.location_id) ? death.location_id : openingLocation;
        const quantity = integer(death.count);
        if (quantity) events.push({ date: row.date, rank: 1, id: row.id || '', type: 'death', location_id, quantity });
    });
    // Transfers become effective at the start of their stated date. For more
    // than one transfer that day, immutable record time (then ID) settles the
    // sequence deterministically; deaths are applied after those moves.
    events.sort((left, right) => left.date.localeCompare(right.date) || left.rank - right.rank || String(left.order || '').localeCompare(String(right.order || '')) || String(left.id).localeCompare(String(right.id)));
    for (const event of events) {
        if (event.type === 'transfer') {
            const available = balances.get(event.source_location_id) || 0;
            if (available < event.quantity) {
                return { balances, events, conflict: { event, available, reason: 'transfer_exceeds_source' } };
            }
            balances.set(event.source_location_id, available - event.quantity);
            balances.set(event.destination_location_id, (balances.get(event.destination_location_id) || 0) + event.quantity);
        } else {
            const available = balances.get(event.location_id) || 0;
            if (available < event.quantity) {
                return { balances, events, conflict: { event, available, reason: 'mortality_exceeds_house' } };
            }
            balances.set(event.location_id, available - event.quantity);
        }
    }
    return { balances, events, conflict: null };
}

async function getBatchHouseBalances(adapter, { batch_id, as_of_date, additional_transfers = [] } = {}) {
    const requestedId = opaque(String(batch_id || '').replace(/\.0$/, ''), 'batch id');
    const asOfDate = dateOnly(as_of_date || new Date().toISOString().slice(0, 10), 'as-of date');
    const row = await adapter.getQuery('SELECT id, data FROM batches WHERE id IN (?, ?) ORDER BY id = ? DESC LIMIT 1', [requestedId, `${requestedId}.0`, requestedId]);
    if (!row) return null;
    const batch = parseJson(row.data);
    if (!batch) throw new TypeError('batch record is unreadable');
    const [transfers, logs, stagedDeaths] = await Promise.all([
        adapter.allQuery('SELECT id, source_location_id, destination_location_id, transfer_date, quantity, created_at FROM batch_transfers WHERE batch_id = ?', [row.id]),
        adapter.allQuery('SELECT id, date, data FROM logs WHERE batch_id = ?', [row.id]),
        adapter.allQuery("SELECT id, date, data FROM staging WHERE batch_id = ? AND module = 'mortality' AND status IN ('pending', 'amendment')", [row.id])
    ]);
    const projection = applyEvents(batch, transfers.concat(additional_transfers), logs, stagedDeaths, asOfDate);
    return {
        batch_id: row.id,
        as_of_date: asOfDate,
        opening_location_id: opaque(batch.location_id, 'batch location'),
        balances: [...projection.balances.entries()].map(([location_id, live_birds]) => ({ location_id, live_birds })).sort((a, b) => a.location_id.localeCompare(b.location_id)),
        conflict: projection.conflict
    };
}

module.exports = { OPAQUE_ID, dateOnly, getBatchHouseBalances };
