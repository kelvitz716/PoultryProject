/**
 * Read-only, deterministic reconciliation suggestions.  These are advisory
 * candidates only: allocation, payment, ledger, and transaction rows are
 * never changed here.
 */

const { getCustomerSettlementWithAdapter } = require('./customer-settlement-read');

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function customerId(value) {
    if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) {
        throw new TypeError('customer_id must be an opaque identifier');
    }
    return value.trim();
}

function boundedLimit(value) {
    if (value === undefined) return 50;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
        throw new RangeError('limit must be between 1 and 100');
    }
    return value;
}

function validActiveAllocationOperation(row) {
    return row
        && SAFE_ID.test(row.id || '')
        && SAFE_ID.test(row.credit_event_id || '')
        && SAFE_ID.test(row.debit_event_id || '')
        && SAFE_ID.test(row.idempotency_key || '')
        && Number.isSafeInteger(row.amount_minor)
        && row.amount_minor > 0
        && row.status === 'active'
        && row.reversed_by_user_id === null
        && row.reversed_at === null
        && row.operation_key === row.idempotency_key
        && row.operation_allocation_id === row.id
        && row.operation_credit_event_id === row.credit_event_id
        && row.operation_debit_event_id === row.debit_event_id
        && row.operation_amount_minor === row.amount_minor
        && (row.created_by_user_id === null || SAFE_ID.test(row.created_by_user_id))
        && row.operation_created_by_user_id === row.created_by_user_id
        && typeof row.created_at === 'string'
        && row.created_at.length > 0
        && row.operation_created_at === row.created_at;
}

async function hasCoherentActiveAllocationProvenance(db, id) {
    const rows = await db.allQuery(`SELECT a.id, a.credit_event_id, a.debit_event_id, a.amount_minor, a.status,
            a.idempotency_key, a.created_by_user_id, a.reversed_by_user_id, a.created_at, a.reversed_at,
            o.idempotency_key AS operation_key, o.allocation_id AS operation_allocation_id,
            o.credit_event_id AS operation_credit_event_id, o.debit_event_id AS operation_debit_event_id,
            o.amount_minor AS operation_amount_minor, o.created_by_user_id AS operation_created_by_user_id,
            o.created_at AS operation_created_at
        FROM customer_account_allocations a
        JOIN customer_account_events c ON c.id = a.credit_event_id
        JOIN customer_account_events d ON d.id = a.debit_event_id
        LEFT JOIN customer_allocation_operations o ON o.allocation_id = a.id
        WHERE a.status = 'active' AND c.customer_id = ? AND d.customer_id = ?
        ORDER BY a.created_at ASC, a.id ASC`, [id, id]);
    return rows.every(validActiveAllocationOperation);
}

function unavailable(snapshot) {
    return {
        customer_id: snapshot.customer_id,
        currency: 'KES',
        status: 'reconciliation_required',
        outstanding_debit_minor: null,
        available_credit_minor: null,
        net_minor: null,
        evidence_count: snapshot.evidence_count,
        allocation_count: snapshot.allocation_count,
        issue_count: Math.max(1, snapshot.issue_count || 0),
        suggestion_count: 0,
        suggestions: []
    };
}

function candidates(snapshot, limit) {
    const credits = snapshot.events.filter(event => event.side === 'credit'
        && ['payment', 'credit_note'].includes(event.kind)
        && ['open', 'part-paid'].includes(event.status)
        && Number.isSafeInteger(event.remaining_minor)
        && event.remaining_minor > 0)
        .map(event => ({ ...event, remaining: event.remaining_minor }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const invoices = snapshot.events.filter(event => event.side === 'debit'
        && event.kind === 'invoice'
        && ['open', 'part-paid'].includes(event.status)
        && Number.isSafeInteger(event.remaining_minor)
        && event.remaining_minor > 0)
        .map(event => ({ ...event, remaining: event.remaining_minor }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const output = [];

    // An amount index emits exact candidates first without constructing the
    // credits × invoices product.  Both source lists are already ID-sorted.
    const invoicesByRemaining = new Map();
    for (const invoice of invoices) {
        const matching = invoicesByRemaining.get(invoice.remaining) || [];
        matching.push(invoice);
        invoicesByRemaining.set(invoice.remaining, matching);
    }
    for (const credit of credits) {
        for (const invoice of invoicesByRemaining.get(credit.remaining) || []) {
            output.push({
                credit_event_id: credit.id,
                debit_event_id: invoice.id,
                amount_minor: credit.remaining,
                credit_remaining_minor: credit.remaining,
                invoice_deficit_minor: invoice.remaining,
                reason_code: 'exact_remaining_match'
            });
            if (output.length === limit) return output;
        }
    }
    for (const credit of credits) {
        for (const invoice of invoices) {
            if (credit.remaining === invoice.remaining) continue;
            output.push({
                credit_event_id: credit.id,
                debit_event_id: invoice.id,
                amount_minor: Math.min(credit.remaining, invoice.remaining),
                credit_remaining_minor: credit.remaining,
                invoice_deficit_minor: invoice.remaining,
                reason_code: 'partial_capacity_match'
            });
            if (output.length === limit) return output;
        }
    }
    return output;
}

function resolveBoundary(value) {
    const boundary = value || require('../db');
    if (!boundary || typeof boundary.withDedicatedReadTransaction !== 'function') {
        throw new TypeError('reconciliation suggestions require a dedicated read transaction');
    }
    return boundary;
}

async function getCustomerReconciliationSuggestions({ customer_id, limit }, dbBoundary) {
    const id = customerId(customer_id);
    const safeLimit = boundedLimit(limit);
    return resolveBoundary(dbBoundary).withDedicatedReadTransaction(async db => {
        const snapshot = await getCustomerSettlementWithAdapter(id, db);
        if (snapshot.status !== 'exact' || !await hasCoherentActiveAllocationProvenance(db, id)) {
            return unavailable(snapshot);
        }
        const suggestions = candidates(snapshot, safeLimit);
        return {
            customer_id: id,
            currency: 'KES',
            status: 'exact',
            outstanding_debit_minor: snapshot.outstanding_debit_minor,
            available_credit_minor: snapshot.available_credit_minor,
            net_minor: snapshot.net_minor,
            evidence_count: snapshot.evidence_count,
            allocation_count: snapshot.allocation_count,
            issue_count: 0,
            suggestion_count: suggestions.length,
            suggestions
        };
    });
}

module.exports = { getCustomerReconciliationSuggestions, boundedLimit, candidates, hasCoherentActiveAllocationProvenance };
