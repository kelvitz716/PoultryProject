/** Pure helpers for one explicit customer-credit-to-invoice allocation. */

import { parseManualReceiptKes } from './manual-customer-receipt-ui-model.mjs';

const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const ALLOCATION_ID = /^allocation:[a-f0-9]{40}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function safeText(value, fallback = '—') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shortId(value) {
    const text = safeText(value);
    return text.length > 16 ? `…${text.slice(-12)}` : text;
}

function exactEligibleSnapshot(customer, settlement, suggestions) {
    return (customer?.is_active === true || customer?.is_active === 1)
        && settlement?.status === 'exact'
        && suggestions?.status === 'exact'
        && settlement.customer_id === customer.id
        && settlement.currency === 'KES'
        && Array.isArray(settlement.events);
}

function eligibleEvent(event, customerId, side, kinds) {
    return event
        && event.customer_id === customerId
        && event.currency === 'KES'
        && event.side === side
        && kinds.has(event.kind)
        && ['open', 'part-paid'].includes(event.status)
        && typeof event.id === 'string'
        && OPAQUE_ID.test(event.id)
        && Number.isSafeInteger(event.remaining_minor)
        && event.remaining_minor > 0;
}

export function allocationCandidates(customer, settlement, suggestions) {
    if (!exactEligibleSnapshot(customer, settlement, suggestions)) return { available: false, credits: [], debits: [] };
    const credits = settlement.events
        .filter(event => eligibleEvent(event, customer.id, 'credit', new Set(['payment', 'credit_note'])))
        .map(event => ({
            id: event.id,
            remaining_minor: event.remaining_minor,
            label: `${safeText(event.kind)} · ${safeText(event.method, 'no tender')} · ${safeText(event.external_reference)} · ID ${shortId(event.id)} · KES ${(event.remaining_minor / 100).toFixed(2)}`
        }));
    const debits = settlement.events
        .filter(event => eligibleEvent(event, customer.id, 'debit', new Set(['invoice'])))
        .map(event => ({
            id: event.id,
            remaining_minor: event.remaining_minor,
            label: `invoice · ${safeText(event.external_reference)} · ID ${shortId(event.id)} · KES ${(event.remaining_minor / 100).toFixed(2)}`
        }));
    return { available: credits.length > 0 && debits.length > 0, credits, debits };
}

export function appendAllocationOptions(select, rows, placeholder, documentRef = document) {
    // Availability changes happen while a request is being confirmed. Keep an
    // eligible explicit choice so an uncertain result can be retried with its
    // original idempotency key; an ineligible choice is intentionally cleared.
    const selectedValue = select.value;
    select.replaceChildren();
    const blank = documentRef.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.append(blank);
    rows.forEach(row => {
        const option = documentRef.createElement('option');
        option.value = row.id;
        option.textContent = row.label;
        select.append(option);
    });
    if (rows.some(row => row.id === selectedValue)) select.value = selectedValue;
}

export function allocationDraft({ customer, settlement, suggestions, creditEventId, debitEventId, amount, confirmed }) {
    const candidates = allocationCandidates(customer, settlement, suggestions);
    if (!candidates.available || confirmed !== true) throw new TypeError('Current allocation evidence must be selected and confirmed');
    const credit = candidates.credits.find(row => row.id === creditEventId);
    const debit = candidates.debits.find(row => row.id === debitEventId);
    if (!credit || !debit) throw new TypeError('Select eligible current credit and invoice evidence');
    const parsed = parseManualReceiptKes(amount);
    if (parsed.amountMinor > credit.remaining_minor || parsed.amountMinor > debit.remaining_minor) {
        throw new RangeError('Allocation exceeds the displayed available amount');
    }
    return {
        credit_event_id: credit.id,
        debit_event_id: debit.id,
        amount: parsed.amount,
        amount_minor: parsed.amountMinor
    };
}

export function allocationFingerprint(draft) {
    return JSON.stringify([draft.credit_event_id, draft.debit_event_id, draft.amount]);
}

export function createAllocationRetryTracker(createKey) {
    let uncertain = null;
    return {
        keyFor(draft) {
            const fingerprint = allocationFingerprint(draft);
            if (uncertain?.fingerprint === fingerprint) return uncertain.key;
            const key = createKey();
            if (typeof key !== 'string' || !OPAQUE_ID.test(key)) throw new TypeError('Could not create a safe allocation key');
            return key;
        },
        retainUncertain(draft, key) {
            uncertain = { fingerprint: allocationFingerprint(draft), key };
        },
        clear() { uncertain = null; },
        invalidate() { uncertain = null; }
    };
}

export function createAllocationIdentityLock() {
    let pending = false;
    return {
        begin() { pending = true; },
        finish() { pending = false; },
        canChange() { return pending !== true; }
    };
}

export function validAllocationResponse(result, draft) {
    const allocation = result?.allocation;
    return !!result
        && typeof result === 'object'
        && typeof result.created === 'boolean'
        && allocation
        && typeof allocation === 'object'
        && typeof allocation.id === 'string'
        && ALLOCATION_ID.test(allocation.id)
        && allocation.credit_event_id === draft.credit_event_id
        && allocation.debit_event_id === draft.debit_event_id
        && allocation.amount_minor === draft.amount_minor
        && allocation.idempotency_key === draft.idempotency_key
        && allocation.status === 'active'
        && typeof allocation.created_by_user_id === 'string'
        && OPAQUE_ID.test(allocation.created_by_user_id)
        && typeof allocation.created_at === 'string'
        && ISO_TIMESTAMP.test(allocation.created_at)
        && allocation.reversed_by_user_id === null
        && allocation.reversed_at === null;
}

export function allocationResponseIsCurrent(submission, current) {
    return submission?.customerId === current?.customerId
        && submission?.selectionVersion === current?.selectionVersion
        && submission?.snapshotVersion === current?.snapshotVersion
        && submission?.requestVersion === current?.requestVersion;
}
