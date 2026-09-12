/** Customer-account event and allocation domain. No HTTP, ledger, or SMS integration. */

const crypto = require('crypto');

const EVENT_SIDES = {
    invoice: 'debit', debit_note: 'debit', refund: 'debit', payment_reversal: 'debit',
    payment: 'credit', credit_note: 'credit', write_off: 'credit'
};
const METHODS = new Set(['cash', 'mpesa', 'bank']);
const CREDIT_NOTE_REASONS = new Set(['return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other']);
class SettlementConflictError extends Error {}
class SettlementNotFoundError extends Error {}

function opaque(value, field, optional = false) {
    if ((value === undefined || value === null || value === '') && optional) return null;
    if (typeof value !== 'string') throw new TypeError(`${field} must be an opaque identifier`);
    const output = value.trim();
    if (!output || output.length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(output)) throw new TypeError(`${field} must be an opaque identifier`);
    return output;
}
function isOpaque(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 128
        && /^[A-Za-z0-9._:@-]+$/.test(value);
}
function minor(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('amount_minor must be a positive safe integer');
    return value;
}
function boundary(value) {
    const output = value || require('../db');
    if (!output || typeof output.withDedicatedTransaction !== 'function') throw new TypeError('settlement requires a dedicated transaction boundary');
    return output;
}
function normalizeName(value) {
    if (typeof value !== 'string') throw new TypeError('display_name must be text');
    const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 120 || /[\u0000-\u001F\u007F]/.test(name)) throw new TypeError('display_name must be bounded safe text');
    return name;
}
async function createCustomer({ id, display_name, created_by_user_id }, dbBoundary) {
    const customer = { id: opaque(id, 'id'), display_name: normalizeName(display_name), created_by_user_id: opaque(created_by_user_id, 'created_by_user_id', true) };
    const normalized = customer.display_name.toLocaleUpperCase('en-US');
    return boundary(dbBoundary).withDedicatedTransaction(async db => {
        await db.runQuery('INSERT INTO customers (id, display_name, normalized_name, created_by_user_id) VALUES (?, ?, ?, ?)', [customer.id, customer.display_name, normalized, customer.created_by_user_id]);
        return { ...customer, normalized_name: normalized };
    });
}
function validateEvent(input) {
    if (!input || typeof input !== 'object') throw new TypeError('event input must be an object');
    const kind = input.kind;
    if (!Object.hasOwn(EVENT_SIDES, kind)) throw new TypeError('unsupported customer event kind');
    const method = input.method === undefined || input.method === null || input.method === '' ? null : String(input.method).toLowerCase();
    if (method !== null && !METHODS.has(method)) throw new TypeError('method must be cash, mpesa, or bank');
    if (['payment', 'refund'].includes(kind) && !method) throw new TypeError(`${kind} method is required`);
    if (['invoice', 'debit_note', 'credit_note', 'write_off'].includes(kind) && method) throw new TypeError(`${kind} must not carry a payment method`);
    if (input.payment_import_id && !(kind === 'payment' && method === 'mpesa')) throw new TypeError('payment_import_id requires an M-Pesa payment');
    if (['credit_note', 'payment_reversal'].includes(kind) && !input.original_event_id) throw new TypeError(`${kind} requires original_event_id`);
    if (!['credit_note', 'payment_reversal'].includes(kind) && input.original_event_id) throw new TypeError('original_event_id is not valid for this event kind');
    const reasonCode = input.reason_code === undefined || input.reason_code === null || input.reason_code === ''
        ? null
        : opaque(input.reason_code, 'reason_code');
    if (kind === 'credit_note' && !CREDIT_NOTE_REASONS.has(reasonCode)) {
        throw new TypeError('credit_note requires a valid reason_code');
    }
    if (kind !== 'credit_note' && reasonCode !== null) {
        throw new TypeError('reason_code is only valid for credit_note');
    }
    const externalReference = opaque(input.external_reference, 'external_reference', true);
    return {
        id: input.id ? opaque(input.id, 'id') : crypto.randomUUID(), customer_id: opaque(input.customer_id, 'customer_id'),
        currency: input.currency === undefined ? 'KES' : input.currency, side: EVENT_SIDES[kind], kind,
        status: input.status === undefined ? 'posted' : input.status, amount_minor: minor(input.amount_minor), method,
        external_reference: method === 'mpesa' && externalReference ? externalReference.toUpperCase() : externalReference, payment_import_id: opaque(input.payment_import_id, 'payment_import_id', true),
        source_transaction_id: opaque(input.source_transaction_id, 'source_transaction_id', true), original_event_id: opaque(input.original_event_id, 'original_event_id', true),
        idempotency_key: opaque(input.idempotency_key, 'idempotency_key'), created_by_user_id: opaque(input.created_by_user_id, 'created_by_user_id', true),
        reviewer_user_id: opaque(input.reviewer_user_id, 'reviewer_user_id', true),
        reason_code: reasonCode
    };
}
/**
 * Records one customer-account event on an already-open dedicated SQLite
 * transaction adapter. Callers that compose this with other durable writes
 * must use this function so no nested BEGIN/COMMIT can escape their unit.
 */
async function recordCustomerAccountEventWithAdapter(input, db) {
    const event = validateEvent(input);
    if (event.currency !== 'KES' || !['draft', 'posted'].includes(event.status)) throw new TypeError('only KES draft or posted events are supported');
    if (event.kind === 'refund') throw new TypeError('refunds require recordCustomerRefund');
    if (event.kind === 'payment_reversal') throw new TypeError('payment reversals are deferred');
    if (!db || typeof db.getQuery !== 'function' || typeof db.runQuery !== 'function') {
        throw new TypeError('settlement requires a transaction adapter');
    }
    const existing = await db.getQuery('SELECT * FROM customer_account_events WHERE idempotency_key = ?', [event.idempotency_key]);
    if (existing) {
        const material = ['customer_id', 'currency', 'side', 'kind', 'status', 'amount_minor', 'method', 'external_reference', 'payment_import_id', 'source_transaction_id', 'original_event_id', 'created_by_user_id', 'reviewer_user_id', 'reason_code'];
        if (material.every(field => (existing[field] ?? null) === (event[field] ?? null))) return { created: false, event: existing };
        throw new SettlementConflictError('event idempotency key conflicts');
    }
    if (!await db.getQuery('SELECT id FROM customers WHERE id = ?', [event.customer_id])) throw new SettlementNotFoundError('customer was not found');
    if (event.kind === 'credit_note' || event.kind === 'payment_reversal') {
        const original = await db.getQuery('SELECT customer_id, currency, side, kind, status FROM customer_account_events WHERE id = ?', [event.original_event_id]);
        if (!original || original.customer_id !== event.customer_id || original.currency !== event.currency
            || original.status !== 'posted'
            || (event.kind === 'credit_note' && !(original.side === 'debit' && original.kind === 'invoice'))
            || (event.kind === 'payment_reversal' && !(original.side === 'credit' && original.kind === 'payment'))) {
            throw new SettlementConflictError('original event is incompatible');
        }
        if (event.kind === 'credit_note') {
            const existingNotes = await db.allQuery("SELECT amount_minor FROM customer_account_events WHERE kind = 'credit_note' AND original_event_id = ? AND status = 'posted'", [event.original_event_id]);
            const invoice = await db.getQuery('SELECT amount_minor FROM customer_account_events WHERE id = ?', [event.original_event_id]);
            if (!Number.isSafeInteger(invoice.amount_minor) || invoice.amount_minor <= 0) {
                throw new SettlementConflictError('original invoice evidence is inconsistent');
            }
            let applied = 0n;
            for (const note of existingNotes) {
                if (!Number.isSafeInteger(note.amount_minor) || note.amount_minor <= 0) {
                    throw new SettlementConflictError('credit note evidence is inconsistent');
                }
                applied += BigInt(note.amount_minor);
                if (applied > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new SettlementConflictError('credit note evidence is inconsistent');
                }
            }
            if (BigInt(event.amount_minor) + applied > BigInt(invoice.amount_minor)) throw new SettlementConflictError('credit notes exceed original invoice');
        }
        if (event.kind === 'payment_reversal') {
            const originalPayment = await db.getQuery('SELECT method FROM customer_account_events WHERE id = ?', [event.original_event_id]);
            event.method = originalPayment.method;
        }
    }
    await db.runQuery(`INSERT INTO customer_account_events (id, customer_id, currency, side, kind, status, amount_minor, method, external_reference, payment_import_id, source_transaction_id, original_event_id, idempotency_key, created_by_user_id, reviewer_user_id, reason_code, posted_at, reversed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'posted' THEN CURRENT_TIMESTAMP END, CASE WHEN ? = 'reversed' THEN CURRENT_TIMESTAMP END)`,
    [event.id, event.customer_id, event.currency, event.side, event.kind, event.status, event.amount_minor, event.method, event.external_reference, event.payment_import_id, event.source_transaction_id, event.original_event_id, event.idempotency_key, event.created_by_user_id, event.reviewer_user_id, event.reason_code, event.status, event.status]);
    return { created: true, event: await db.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [event.id]) };
}
async function recordCustomerAccountEvent(input, dbBoundary) {
    return boundary(dbBoundary).withDedicatedTransaction(async db => recordCustomerAccountEventWithAdapter(input, db));
}
async function recordCustomerRefund(input, dbBoundary) {
    const event = validateEvent({ ...input, kind: 'refund', status: 'posted' });
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 50) throw new TypeError('refund sources must be a bounded nonempty list');
    const sources = input.sources.map(source => ({ credit_event_id: opaque(source.credit_event_id, 'credit_event_id'), amount_minor: minor(source.amount_minor) }));
    if (new Set(sources.map(source => source.credit_event_id)).size !== sources.length) throw new TypeError('refund sources must not repeat a credit event');
    const sourceTotal = sources.reduce((total, source) => {
        if (!Number.isSafeInteger(total + source.amount_minor)) throw new TypeError('refund source total is unsafe');
        return total + source.amount_minor;
    }, 0);
    if (sourceTotal !== event.amount_minor) throw new TypeError('refund source allocations must equal refund amount');
    const b = boundary(dbBoundary);
    return b.withDedicatedTransaction(async db => {
        const existing = await db.getQuery('SELECT * FROM customer_account_events WHERE idempotency_key = ?', [event.idempotency_key]);
        if (existing) {
            const material = ['customer_id', 'currency', 'kind', 'status', 'amount_minor', 'method', 'external_reference', 'source_transaction_id', 'created_by_user_id', 'reviewer_user_id'];
            if (existing.kind !== 'refund' || !material.every(field => (existing[field] ?? null) === (event[field] ?? null))) throw new SettlementConflictError('refund idempotency key conflicts');
            const allocations = await db.allQuery("SELECT credit_event_id, amount_minor FROM customer_account_allocations WHERE debit_event_id = ? AND status = 'active' ORDER BY credit_event_id", [existing.id]);
            const expected = [...sources].sort((a, z) => a.credit_event_id.localeCompare(z.credit_event_id));
            if (allocations.length !== expected.length || allocations.some((row, i) => row.credit_event_id !== expected[i].credit_event_id || row.amount_minor !== expected[i].amount_minor)) throw new SettlementConflictError('refund idempotency key conflicts');
            return { created: false, event: existing, allocations };
        }
        if (!await db.getQuery('SELECT id FROM customers WHERE id = ?', [event.customer_id])) throw new SettlementNotFoundError('customer was not found');
        for (const source of sources) {
            const credit = await db.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [source.credit_event_id]);
            if (!credit || credit.status !== 'posted' || !['payment', 'credit_note'].includes(credit.kind) || credit.customer_id !== event.customer_id || credit.currency !== 'KES') throw new SettlementConflictError('refund source is incompatible');
            if (source.amount_minor > credit.amount_minor - await activeAllocated(db, 'credit_event_id', credit.id)) throw new SettlementConflictError('refund exceeds available customer credit');
        }
        await db.runQuery(`INSERT INTO customer_account_events (id, customer_id, currency, side, kind, status, amount_minor, method, external_reference, payment_import_id, source_transaction_id, original_event_id, idempotency_key, created_by_user_id, reviewer_user_id, posted_at)
            VALUES (?, ?, ?, ?, 'refund', 'posted', ?, ?, ?, NULL, ?, NULL, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [event.id, event.customer_id, event.currency, event.side, event.amount_minor, event.method, event.external_reference, event.source_transaction_id, event.idempotency_key, event.created_by_user_id, event.reviewer_user_id]);
        for (const source of sources) await db.runQuery('INSERT INTO customer_account_allocations (id, credit_event_id, debit_event_id, amount_minor, idempotency_key, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), source.credit_event_id, event.id, source.amount_minor, `refund:${event.idempotency_key}:${source.credit_event_id}`, event.created_by_user_id]);
        return { created: true, event: await db.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [event.id]), allocations: await db.allQuery('SELECT * FROM customer_account_allocations WHERE debit_event_id = ?', [event.id]) };
    });
}
async function activeAllocated(db, field, id) {
    if (!['credit_event_id', 'debit_event_id'].includes(field)) {
        throw new SettlementConflictError('active allocation evidence is inconsistent');
    }
    const rows = await db.allQuery(`SELECT amount_minor FROM customer_account_allocations
        WHERE ${field} = ? AND status = 'active'`, [id]);
    let total = 0n;
    for (const row of rows) {
        if (!Number.isSafeInteger(row.amount_minor) || row.amount_minor <= 0) {
            throw new SettlementConflictError('active allocation evidence is inconsistent');
        }
        total += BigInt(row.amount_minor);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new SettlementConflictError('active allocation evidence is inconsistent');
        }
    }
    return Number(total);
}
function allocationIdFor(key) {
    return `allocation:${crypto.createHash('sha256').update(`customer-allocation:${key}`).digest('hex').slice(0, 40)}`;
}
function expectedAllocationUniqueness(error) {
    if (!error || error.code !== 'SQLITE_CONSTRAINT') return false;
    const message = String(error.message || '');
    return [
        'customer_account_allocations.id',
        'customer_account_allocations.idempotency_key',
        'customer_allocation_operations.idempotency_key',
        'customer_allocation_operations.allocation_id'
    ].some(field => message.includes(`UNIQUE constraint failed: ${field}`));
}
async function verifyAllocationEvidence(db, allocation, requested = null, operation = null) {
    if (!allocation
        || !isOpaque(allocation.id)
        || !isOpaque(allocation.credit_event_id)
        || !isOpaque(allocation.debit_event_id)
        || !isOpaque(allocation.idempotency_key)
        || !Number.isSafeInteger(allocation.amount_minor)
        || allocation.amount_minor <= 0
        || !['active', 'reversed'].includes(allocation.status)
        || typeof allocation.created_at !== 'string'
        || !allocation.created_at
        || (allocation.created_by_user_id !== null && allocation.created_by_user_id !== undefined && !isOpaque(allocation.created_by_user_id))) {
        throw new SettlementConflictError('allocation evidence is inconsistent');
    }
    if (requested && (allocation.id !== requested.id
        || allocation.credit_event_id !== requested.credit_event_id
        || allocation.debit_event_id !== requested.debit_event_id
        || allocation.amount_minor !== requested.amount_minor
        || allocation.idempotency_key !== requested.idempotency_key)) {
        throw new SettlementConflictError('allocation idempotency key conflicts');
    }
    if (!operation || !operationMatches(operation, allocation)) {
        throw new SettlementConflictError('allocation evidence is inconsistent');
    }
    if ((allocation.status === 'active'
        && (allocation.reversed_by_user_id !== null || allocation.reversed_at !== null))
        || (allocation.status === 'reversed'
            && (!isOpaque(allocation.reversed_by_user_id)
                || typeof allocation.reversed_at !== 'string'
                || !allocation.reversed_at))) {
        throw new SettlementConflictError('allocation evidence is inconsistent');
    }
    const credit = await db.getQuery('SELECT id, customer_id, currency, side, status FROM customer_account_events WHERE id = ?', [allocation.credit_event_id]);
    const debit = await db.getQuery('SELECT id, customer_id, currency, side, status FROM customer_account_events WHERE id = ?', [allocation.debit_event_id]);
    if (!credit || !debit || credit.status !== 'posted' || debit.status !== 'posted'
        || credit.side !== 'credit' || debit.side !== 'debit'
        || credit.customer_id !== debit.customer_id || credit.currency !== 'KES' || debit.currency !== 'KES') {
        throw new SettlementConflictError('allocation evidence is inconsistent');
    }
    return allocation;
}
function operationMatches(operation, allocation) {
    return operation
        && operation.idempotency_key === allocation.idempotency_key
        && operation.allocation_id === allocation.id
        && operation.credit_event_id === allocation.credit_event_id
        && operation.debit_event_id === allocation.debit_event_id
        && operation.amount_minor === allocation.amount_minor
        && operation.created_by_user_id === allocation.created_by_user_id
        && typeof operation.created_at === 'string'
        && operation.created_at
        && operation.created_at === allocation.created_at;
}
function operationRequestMatches(operation, allocation) {
    return operation
        && operation.idempotency_key === allocation.idempotency_key
        && operation.allocation_id === allocation.id
        && operation.credit_event_id === allocation.credit_event_id
        && operation.debit_event_id === allocation.debit_event_id
        && operation.amount_minor === allocation.amount_minor;
}
function allocationRequest({ id, credit_event_id, debit_event_id, amount_minor, idempotency_key, created_by_user_id }) {
    const key = opaque(idempotency_key, 'idempotency_key');
    const deterministicId = allocationIdFor(key);
    if (id !== undefined && id !== null && opaque(id, 'id') !== deterministicId) {
        throw new TypeError('allocation id is server-derived');
    }
    const allocation = {
        id: deterministicId,
        credit_event_id: opaque(credit_event_id, 'credit_event_id'),
        debit_event_id: opaque(debit_event_id, 'debit_event_id'),
        amount_minor: minor(amount_minor),
        idempotency_key: key,
        created_by_user_id: opaque(created_by_user_id, 'created_by_user_id', true),
        created_at: new Date().toISOString()
    };
    return allocation;
}
async function allocateCustomerCreditWithAdapter(request, db) {
    if (!db || typeof db.getQuery !== 'function' || typeof db.runQuery !== 'function' || typeof db.allQuery !== 'function') {
        throw new TypeError('allocation requires a transaction adapter');
    }
    const allocation = allocationRequest(request);
    try {
        const operation = await db.getQuery('SELECT * FROM customer_allocation_operations WHERE idempotency_key = ?', [allocation.idempotency_key]);
        if (operation) {
            if (!operationRequestMatches(operation, allocation)) {
                throw new SettlementConflictError('allocation idempotency key conflicts');
            }
            const existing = await db.getQuery('SELECT * FROM customer_account_allocations WHERE id = ?', [operation.allocation_id]);
            if (!existing) throw new SettlementConflictError('allocation evidence is inconsistent');
            return { created: false, allocation: await verifyAllocationEvidence(db, existing, allocation, operation) };
        }
        // A legacy allocation with no operation marker cannot be proved as this
        // request's immutable result, so never reinterpret or replace it.
        if (await db.getQuery('SELECT id FROM customer_account_allocations WHERE idempotency_key = ?', [allocation.idempotency_key])) {
            throw new SettlementConflictError('allocation evidence is inconsistent');
        }
        const credit = await db.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [allocation.credit_event_id]);
        const debit = await db.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [allocation.debit_event_id]);
        if (!credit || !debit) throw new SettlementNotFoundError('allocation event was not found');
        if (!Number.isSafeInteger(credit.amount_minor) || credit.amount_minor <= 0
            || !Number.isSafeInteger(debit.amount_minor) || debit.amount_minor <= 0
            || credit.status !== 'posted' || debit.status !== 'posted' || credit.side !== 'credit' || debit.side !== 'debit' || credit.customer_id !== debit.customer_id || credit.currency !== 'KES' || debit.currency !== 'KES') throw new SettlementConflictError('allocation events are incompatible');
        if (allocation.amount_minor > credit.amount_minor - await activeAllocated(db, 'credit_event_id', credit.id)
            || allocation.amount_minor > debit.amount_minor - await activeAllocated(db, 'debit_event_id', debit.id)) throw new SettlementConflictError('allocation exceeds available amount');
        await db.runQuery(`INSERT INTO customer_account_allocations
            (id, credit_event_id, debit_event_id, amount_minor, idempotency_key, created_by_user_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            allocation.id,
            allocation.credit_event_id,
            allocation.debit_event_id,
            allocation.amount_minor,
            allocation.idempotency_key,
            allocation.created_by_user_id,
            allocation.created_at
        ]);
        await db.runQuery(`INSERT INTO customer_allocation_operations
            (idempotency_key, allocation_id, credit_event_id, debit_event_id, amount_minor, created_by_user_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            allocation.idempotency_key,
            allocation.id,
            allocation.credit_event_id,
            allocation.debit_event_id,
            allocation.amount_minor,
            allocation.created_by_user_id,
            allocation.created_at
        ]);
        const saved = await db.getQuery('SELECT * FROM customer_account_allocations WHERE id = ?', [allocation.id]);
        const savedOperation = await db.getQuery('SELECT * FROM customer_allocation_operations WHERE idempotency_key = ?', [allocation.idempotency_key]);
        return { created: true, allocation: await verifyAllocationEvidence(db, saved, allocation, savedOperation) };
    } catch (error) {
        if (expectedAllocationUniqueness(error)) throw new SettlementConflictError('allocation conflicts');
        throw error;
    }
}
async function allocateCustomerCredit(request, dbBoundary) {
    return boundary(dbBoundary).withDedicatedTransaction(db => allocateCustomerCreditWithAdapter(request, db));
}
async function reverseCustomerAllocation({ id, reversed_by_user_id }, dbBoundary) {
    const allocationId = opaque(id, 'id'); const reviewer = opaque(reversed_by_user_id, 'reversed_by_user_id');
    return boundary(dbBoundary).withDedicatedTransaction(async db => {
        const reversed = await db.getQuery("UPDATE customer_account_allocations SET status = 'reversed', reversed_by_user_id = ?, reversed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active' RETURNING *", [reviewer, allocationId]);
        if (reversed) {
            const operation = await db.getQuery('SELECT * FROM customer_allocation_operations WHERE allocation_id = ?', [reversed.id]);
            return { idempotent: false, allocation: await verifyAllocationEvidence(db, reversed, null, operation) };
        }
        const existing = await db.getQuery('SELECT * FROM customer_account_allocations WHERE id = ?', [allocationId]);
        if (!existing) throw new SettlementNotFoundError('allocation was not found');
        const operation = await db.getQuery('SELECT * FROM customer_allocation_operations WHERE allocation_id = ?', [existing.id]);
        return { idempotent: true, allocation: await verifyAllocationEvidence(db, existing, null, operation) };
    });
}
async function eventPosition(id, dbAdapter) {
    const eventId = opaque(id, 'id'); const db = dbAdapter || require('../db');
    const event = await db.getQuery(`SELECT e.*, COALESCE(SUM(a.amount_minor), 0) AS allocated_minor
        FROM customer_account_events e LEFT JOIN customer_account_allocations a
        ON (a.status = 'active' AND (a.credit_event_id = e.id OR a.debit_event_id = e.id))
        WHERE e.id = ? GROUP BY e.id`, [eventId]);
    if (!event) throw new SettlementNotFoundError('event was not found');
    const allocated = event.allocated_minor;
    if (event.status === 'draft' || event.status === 'reversed') return { event_id: event.id, side: event.side, amount_minor: event.amount_minor, allocated_minor: 0, remaining_minor: 0, status: event.status };
    const remaining_minor = event.amount_minor - allocated;
    return { event_id: event.id, side: event.side, amount_minor: event.amount_minor, allocated_minor: allocated, remaining_minor, status: allocated === 0 ? 'open' : remaining_minor === 0 ? 'settled' : 'part-paid' };
}
async function customerPosition(customer_id, dbAdapter) {
    const id = opaque(customer_id, 'customer_id'); const db = dbAdapter || require('../db');
    const snapshot = await db.getQuery(`
        WITH requested_customer AS (SELECT id FROM customers WHERE id = ?),
        event_positions AS (
            SELECT e.side, e.amount_minor - COALESCE(SUM(a.amount_minor), 0) AS remaining_minor
            FROM customer_account_events e LEFT JOIN customer_account_allocations a
            ON (a.status = 'active' AND (a.credit_event_id = e.id OR a.debit_event_id = e.id))
            WHERE e.customer_id = ? AND e.currency = 'KES' AND e.status = 'posted'
            GROUP BY e.id
        )
        SELECT EXISTS(SELECT 1 FROM requested_customer) AS customer_exists,
               COALESCE(SUM(CASE WHEN side = 'debit' THEN remaining_minor ELSE 0 END), 0) AS outstanding_debit_minor,
               COALESCE(SUM(CASE WHEN side = 'credit' THEN remaining_minor ELSE 0 END), 0) AS available_credit_minor
        FROM event_positions
    `, [id, id]);
    if (!snapshot.customer_exists) throw new SettlementNotFoundError('customer was not found');
    return { customer_id: id, currency: 'KES', outstanding_debit_minor: snapshot.outstanding_debit_minor, available_credit_minor: snapshot.available_credit_minor, net_minor: snapshot.available_credit_minor - snapshot.outstanding_debit_minor };
}
module.exports = { SettlementConflictError, SettlementNotFoundError, createCustomer, recordCustomerAccountEvent, recordCustomerAccountEventWithAdapter, recordCustomerRefund, allocateCustomerCredit, allocateCustomerCreditWithAdapter, reverseCustomerAllocation, eventPosition, customerPosition, allocationIdFor, verifyAllocationEvidence };
