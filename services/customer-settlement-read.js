/** Read-only, reconciliation-safe customer settlement snapshot. */

const { SettlementNotFoundError } = require('./customer-settlement');

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function customerId(value) {
    if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) throw new TypeError('customer_id must be an opaque identifier');
    return value.trim();
}
function safeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function add(total, amount) {
    const next = total + BigInt(amount);
    if (next > MAX) throw new RangeError('settlement aggregate is unsafe');
    return next;
}
function unavailable(customer, events = [], allocations = [], evidenceCount = events.length, allocationCount = allocations.length) {
    return {
        customer_id: customer.id,
        currency: 'KES',
        status: 'reconciliation_required',
        outstanding_debit_minor: null,
        available_credit_minor: null,
        net_minor: null,
        evidence_count: evidenceCount,
        allocation_count: allocationCount,
        issue_count: 1,
        events,
        allocations
    };
}
function safeEvent(row, position) {
    return {
        id: row.id,
        customer_id: row.customer_id,
        currency: row.currency,
        side: row.side,
        kind: row.kind,
        status: position.status,
        amount_minor: row.amount_minor,
        allocated_minor: position.allocated_minor,
        remaining_minor: position.remaining_minor,
        method: row.method,
        external_reference: row.external_reference,
        source_transaction_id: row.source_transaction_id,
        original_event_id: row.original_event_id,
        created_by_user_id: row.created_by_user_id,
        reviewer_user_id: row.reviewer_user_id,
        created_at: row.created_at,
        posted_at: row.posted_at
    };
}
function safeAllocation(row) {
    return {
        id: row.id,
        credit_event_id: row.credit_event_id,
        debit_event_id: row.debit_event_id,
        amount_minor: row.amount_minor,
        idempotency_key: row.idempotency_key,
        status: row.status,
        created_by_user_id: row.created_by_user_id,
        reversed_by_user_id: row.reversed_by_user_id,
        created_at: row.created_at,
        reversed_at: row.reversed_at
    };
}
function resolveBoundary(value) {
    const boundary = value || require('../db');
    if (!boundary || typeof boundary.withDedicatedReadTransaction !== 'function') {
        throw new TypeError('settlement reporting requires a dedicated read transaction');
    }
    return boundary;
}

/**
 * Build a safe settlement snapshot using an already-open dedicated read
 * adapter.  Keeping this adapter form lets other strictly read-only services
 * share the exact same SQLite snapshot instead of taking a second read.
 */
async function getCustomerSettlementWithAdapter(customer_id, db) {
    const id = customerId(customer_id);
    if (!db || typeof db.getQuery !== 'function' || typeof db.allQuery !== 'function') {
        throw new TypeError('settlement reporting requires a read adapter');
    }
    const customer = await db.getQuery('SELECT id FROM customers WHERE id = ?', [id]);
    if (!customer) throw new SettlementNotFoundError('customer was not found');
    const events = await db.allQuery(`SELECT id, customer_id, currency, side, kind, status, amount_minor, method,
            external_reference, source_transaction_id, original_event_id, created_by_user_id, reviewer_user_id,
            created_at, posted_at
            FROM customer_account_events WHERE customer_id = ? ORDER BY created_at ASC, id ASC`, [id]);
    const allocations = await db.allQuery(`SELECT a.*,
            c.customer_id AS credit_customer_id, c.currency AS credit_currency, c.side AS credit_side, c.status AS credit_status,
            d.customer_id AS debit_customer_id, d.currency AS debit_currency, d.side AS debit_side, d.status AS debit_status
            FROM customer_account_allocations a
            LEFT JOIN customer_account_events c ON c.id = a.credit_event_id
            LEFT JOIN customer_account_events d ON d.id = a.debit_event_id
            WHERE c.customer_id = ? OR d.customer_id = ? ORDER BY a.created_at ASC, a.id ASC`, [id, id]);
    try {
            const positions = new Map();
            for (const event of events) {
                if (!SAFE_ID.test(event.id) || event.customer_id !== id || event.currency !== 'KES'
                    || !['credit', 'debit'].includes(event.side) || !['draft', 'posted'].includes(event.status)
                    || !safeInteger(event.amount_minor) || event.amount_minor <= 0) {
                    return unavailable(customer, [], [], events.length, allocations.length);
                }
                positions.set(event.id, 0n);
            }
            const visibleAllocations = [];
            for (const allocation of allocations) {
                if (!SAFE_ID.test(allocation.id) || !SAFE_ID.test(allocation.credit_event_id) || !SAFE_ID.test(allocation.debit_event_id)
                    || !SAFE_ID.test(allocation.idempotency_key || '')
                    || !safeInteger(allocation.amount_minor) || allocation.amount_minor <= 0
                    || !['active', 'reversed'].includes(allocation.status)
                    || (allocation.status === 'active'
                        && (allocation.reversed_by_user_id !== null || allocation.reversed_at !== null))
                    || (allocation.status === 'reversed'
                        && (!SAFE_ID.test(allocation.reversed_by_user_id || '')
                            || typeof allocation.reversed_at !== 'string'
                            || !allocation.reversed_at))
                    || allocation.credit_customer_id !== id || allocation.debit_customer_id !== id
                    || allocation.credit_currency !== 'KES' || allocation.debit_currency !== 'KES'
                    || allocation.credit_side !== 'credit' || allocation.debit_side !== 'debit'
                    || allocation.credit_status !== 'posted' || allocation.debit_status !== 'posted') {
                    return unavailable(customer, [], [], events.length, allocations.length);
                }
                visibleAllocations.push(safeAllocation(allocation));
                if (allocation.status === 'active') {
                    positions.set(allocation.credit_event_id, add(positions.get(allocation.credit_event_id) || 0n, allocation.amount_minor));
                    positions.set(allocation.debit_event_id, add(positions.get(allocation.debit_event_id) || 0n, allocation.amount_minor));
                }
            }
            let debit = 0n;
            let credit = 0n;
            const outputEvents = [];
            for (const event of events) {
                const allocated = positions.get(event.id) || 0n;
                const amount = BigInt(event.amount_minor);
                if (allocated > amount) return unavailable(customer, [], [], events.length, allocations.length);
                if (event.status === 'draft') {
                    outputEvents.push(safeEvent(event, { status: 'draft', allocated_minor: 0, remaining_minor: 0 }));
                    continue;
                }
                const remaining = amount - allocated;
                const status = allocated === 0n ? 'open' : remaining === 0n ? 'settled' : 'part-paid';
                if (event.side === 'debit') debit += remaining; else credit += remaining;
                if (debit > MAX || credit > MAX || credit - debit > MAX || debit - credit > MAX) return unavailable(customer, [], [], events.length, allocations.length);
                outputEvents.push(safeEvent(event, {
                    status,
                    allocated_minor: Number(allocated),
                    remaining_minor: Number(remaining)
                }));
            }
        return {
                customer_id: id,
                currency: 'KES',
                status: 'exact',
                outstanding_debit_minor: Number(debit),
                available_credit_minor: Number(credit),
                net_minor: Number(credit - debit),
                evidence_count: outputEvents.length,
                allocation_count: visibleAllocations.length,
                issue_count: 0,
                events: outputEvents,
                allocations: visibleAllocations
        };
    } catch (_) {
        return unavailable(customer, [], [], events.length, allocations.length);
    }
}

async function getCustomerSettlement(customer_id, dbBoundary) {
    return resolveBoundary(dbBoundary).withDedicatedReadTransaction(db => getCustomerSettlementWithAdapter(customer_id, db));
}

module.exports = { getCustomerSettlement, getCustomerSettlementWithAdapter };
