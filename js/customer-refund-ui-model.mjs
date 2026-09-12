/** Pure validation, preview, and response checks for one explicit customer refund. */

import { parseManualReceiptKes } from './manual-customer-receipt-ui-model.mjs';

const OPAQUE = /^[A-Za-z0-9._:@-]{1,128}$/;
const REFUND_ID = /^customer-refund:[a-f0-9]{40}$/;
const LEDGER_ID = /^ledger-customer-refund:[a-f0-9]{36}$/;
const ALLOCATION_ID = /^allocation:[a-f0-9]{40}$/;
const METHODS = new Set(['cash', 'mpesa', 'bank']);
const REASONS = new Set(['overpayment', 'duplicate_payment', 'customer_request', 'returned_goods', 'other']);
const ADMIN_ROLES = new Set(['super_admin', 'admin']);
const METHOD_LABELS = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank' };
const REASON_LABELS = {
    overpayment: 'Overpayment',
    duplicate_payment: 'Duplicate payment',
    customer_request: 'Customer request',
    returned_goods: 'Returned goods',
    other: 'Other'
};

function safeMinor(value) { return Number.isSafeInteger(value) && value >= 0; }
function safeActor(value) { return typeof value === 'string' && OPAQUE.test(value); }
function safeTimestamp(value) { return typeof value === 'string' && value.length <= 40 && value.length > 0 && !Number.isNaN(Date.parse(value)); }
function safeText(value, fallback = '—') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function shortId(value) { const text = safeText(value); return text.length > 16 ? `…${text.slice(-12)}` : text; }
function format(value) { return `KES ${(value / 100).toFixed(2)}`; }

function exactSnapshot(customer, settlement, suggestions) {
    return !!customer && settlement?.status === 'exact' && suggestions?.status === 'exact'
        && settlement.customer_id === customer.id && settlement.currency === 'KES' && Array.isArray(settlement.events);
}

function eligible(event, customerId) {
    return event && event.customer_id === customerId && event.currency === 'KES' && event.side === 'credit'
        && ['payment', 'credit_note'].includes(event.kind) && ['open', 'part-paid'].includes(event.status)
        && typeof event.id === 'string' && OPAQUE.test(event.id)
        && safeMinor(event.amount_minor) && event.amount_minor > 0
        && safeMinor(event.allocated_minor) && safeMinor(event.remaining_minor)
        && event.allocated_minor + event.remaining_minor === event.amount_minor && event.remaining_minor > 0
        && ((event.kind === 'payment' && METHODS.has(event.method)) || (event.kind === 'credit_note' && event.method === null));
}

export function canIssueCustomerRefunds(role) { return ADMIN_ROLES.has(role); }

export function refundCandidates(customer, settlement, suggestions) {
    if (!exactSnapshot(customer, settlement, suggestions)) return { available: false, sources: [] };
    const candidateEvents = settlement.events.filter(event => event.customer_id === customer.id
        && event.currency === 'KES' && event.side === 'credit' && ['payment', 'credit_note'].includes(event.kind)
        && ['open', 'part-paid'].includes(event.status));
    if (!candidateEvents.every(event => eligible(event, customer.id))) return { available: false, sources: [] };
    const sources = candidateEvents.map(event => ({
        id: event.id,
        kind: event.kind,
        method: event.kind === 'payment' ? event.method : null,
        reference: safeText(event.external_reference),
        original_amount_minor: event.amount_minor,
        allocated_minor: event.allocated_minor,
        remaining_minor: event.remaining_minor,
        label: `${safeText(event.kind)} · ${event.kind === 'payment' ? safeText(event.method) : 'no tender'} · ${safeText(event.external_reference)} · ID ${shortId(event.id)} · original ${format(event.amount_minor)} · allocated ${format(event.allocated_minor)} · available ${format(event.remaining_minor)}`
    }));
    return { available: sources.length > 0, sources };
}

export function normalizeRefundReference(value, method) {
    if (!METHODS.has(method)) throw new TypeError('Choose cash, M-Pesa, or bank');
    const reference = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
    if (!reference) {
        if (method !== 'cash') throw new TypeError('A M-Pesa or bank reference is required');
        return null;
    }
    if (!OPAQUE.test(reference)) throw new TypeError('Reference must be a short reference code');
    return reference.toUpperCase();
}

function normalizedSources(candidates, values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 50) throw new TypeError('Select one or more customer credit sources');
    const rows = values.map(value => {
        if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
            || Object.keys(value).length !== 2 || typeof value.credit_event_id !== 'string') throw new TypeError('Refund source is invalid');
        const source = candidates.sources.find(item => item.id === value.credit_event_id);
        if (!source) throw new TypeError('Select current eligible customer credit');
        const money = parseManualReceiptKes(value.amount);
        if (money.amountMinor > source.remaining_minor) throw new RangeError('Refund source exceeds its displayed available credit');
        return { credit_event_id: source.id, amount: money.amount, amount_minor: money.amountMinor, source };
    }).sort((left, right) => left.credit_event_id.localeCompare(right.credit_event_id));
    if (new Set(rows.map(row => row.credit_event_id)).size !== rows.length) throw new TypeError('Refund sources must not repeat');
    return rows;
}

export function refundPreview({ customer, settlement, suggestions, method, amount, sources, reasonCode, externalReference }) {
    const candidates = refundCandidates(customer, settlement, suggestions);
    if (!candidates.available) throw new TypeError('Current customer-credit evidence is unavailable');
    if (!METHODS.has(method)) throw new TypeError('Choose cash, M-Pesa, or bank');
    if (!REASONS.has(reasonCode)) throw new TypeError('Select a refund reason');
    const total = parseManualReceiptKes(amount);
    const rows = normalizedSources(candidates, sources);
    const sourceTotal = rows.reduce((sum, row) => sum + row.amount_minor, 0);
    if (!Number.isSafeInteger(sourceTotal) || sourceTotal !== total.amountMinor) throw new TypeError('Selected refund sources must total the outgoing amount exactly');
    const methodDifference = rows.some(row => row.source.kind === 'payment' && row.source.method !== method);
    return {
        amount: total.amount,
        amount_minor: total.amountMinor,
        method,
        method_label: METHOD_LABELS[method],
        reason_code: reasonCode,
        reason_label: REASON_LABELS[reasonCode],
        external_reference: normalizeRefundReference(externalReference, method),
        method_difference: methodDifference,
        sources: rows.map(row => ({
            credit_event_id: row.credit_event_id,
            amount: row.amount,
            amount_minor: row.amount_minor,
            kind: row.source.kind,
            method: row.source.method,
            reference: row.source.reference,
            original_amount_minor: row.source.original_amount_minor,
            allocated_minor: row.source.allocated_minor,
            remaining_minor: row.source.remaining_minor,
            resulting_remaining_minor: row.source.remaining_minor - row.amount_minor
        }))
    };
}

export function refundDraft({ customer, settlement, suggestions, method, amount, sources, reasonCode, externalReference, acknowledgeMethodDifference, confirmed }) {
    if (confirmed !== true) throw new TypeError('Confirm that money will leave the business');
    const preview = refundPreview({ customer, settlement, suggestions, method, amount, sources, reasonCode, externalReference });
    if (typeof acknowledgeMethodDifference !== 'boolean') throw new TypeError('Refund acknowledgement is invalid');
    if (preview.method_difference && acknowledgeMethodDifference !== true) throw new TypeError('Acknowledge the payment-method difference');
    return {
        customer_id: customer.id,
        method: preview.method,
        amount: preview.amount,
        amount_minor: preview.amount_minor,
        sources: preview.sources.map(row => ({ credit_event_id: row.credit_event_id, amount: row.amount, amount_minor: row.amount_minor })),
        reason_code: preview.reason_code,
        external_reference: preview.external_reference,
        acknowledge_method_difference: acknowledgeMethodDifference,
        method_difference: preview.method_difference
    };
}

export function refundPreviewText(preview) {
    if (!preview || !safeMinor(preview.amount_minor) || !METHODS.has(preview.method)
        || typeof preview.method_label !== 'string' || typeof preview.reason_label !== 'string'
        || !Array.isArray(preview.sources)) throw new TypeError('Refund preview is invalid');
    const account = preview.method === 'cash' ? 'Cash (1000)' : preview.method === 'mpesa' ? 'M-Pesa Till (1010)' : 'Bank (1020)';
    const reference = preview.external_reference || 'No external reference (cash)';
    const breakdown = preview.sources.map(source => `${source.kind} …${source.credit_event_id.slice(-12)}: ${format(source.amount_minor)} (remaining ${format(source.resulting_remaining_minor)})`).join(' · ');
    return `Outgoing ${format(preview.amount_minor)} by ${preview.method_label}. Reference: ${reference}. Reason: ${preview.reason_label}. ${breakdown}. Accounting: Dr Accounts Receivable (1200) / Cr ${account}.`;
}

export function refundFingerprint(draft) {
    return JSON.stringify([draft.customer_id, draft.method, draft.amount, draft.sources.map(row => [row.credit_event_id, row.amount]), draft.reason_code, draft.external_reference, draft.acknowledge_method_difference]);
}

export function createRefundRetryTracker(createKey) {
    let uncertain = null;
    return {
        keyFor(draft) { const fingerprint = refundFingerprint(draft); if (uncertain?.fingerprint === fingerprint) return uncertain.key; const key = createKey(); if (!safeActor(key)) throw new TypeError('Could not create a safe refund key'); return key; },
        retainUncertain(draft, key) { uncertain = { fingerprint: refundFingerprint(draft), key }; },
        clear() { uncertain = null; },
        invalidate() { uncertain = null; }
    };
}

export function createRefundIdentityLock() {
    let pending = false;
    return { begin() { pending = true; }, finish() { pending = false; }, canChange() { return !pending; } };
}

export function refundAcknowledgementState({ methodDifference, pending, checked }) {
    if (typeof methodDifference !== 'boolean' || typeof pending !== 'boolean') throw new TypeError('Refund acknowledgement state is invalid');
    return {
        visible: methodDifference,
        // A frozen request keeps its immutable draft. Once the editable draft no longer
        // has a tender mismatch, a previously checked acknowledgement must not travel on.
        checked: methodDifference || pending ? checked === true : false
    };
}

export function validRefundResponse(result, requested) {
    if (!result || typeof result !== 'object' || typeof result.idempotent !== 'boolean'
        || typeof result.refund_event_id !== 'string' || !REFUND_ID.test(result.refund_event_id)
        || typeof result.ledger_transaction_id !== 'string' || !LEDGER_ID.test(result.ledger_transaction_id)
        || result.amount_minor !== requested.amount_minor || result.method !== requested.method
        || result.reason_code !== requested.reason_code || (result.external_reference ?? null) !== requested.external_reference
        || result.method_difference !== requested.method_difference
        || result.acknowledge_method_difference !== requested.acknowledge_method_difference
        || !safeTimestamp(result.recorded_at) || !safeActor(result.recorded_by_user_id)
        || !Array.isArray(result.source_allocations) || result.source_allocations.length !== requested.sources.length) return false;
    let total = 0;
    return result.source_allocations.every((row, index) => {
        const expected = requested.sources[index];
        if (!row || typeof row !== 'object' || row.credit_event_id !== expected.credit_event_id
            || typeof row.allocation_id !== 'string' || !ALLOCATION_ID.test(row.allocation_id)
            || row.amount_minor !== expected.amount_minor || !safeMinor(row.amount_minor) || row.amount_minor <= 0) return false;
        total += row.amount_minor;
        return Number.isSafeInteger(total);
    }) && total === result.amount_minor;
}

export function refundResponseIsCurrent(submission, current) {
    return submission?.customerId === current?.customerId && submission?.selectionVersion === current?.selectionVersion
        && submission?.snapshotVersion === current?.snapshotVersion && submission?.requestVersion === current?.requestVersion;
}
