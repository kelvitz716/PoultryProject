/** Pure helpers for reversing one existing customer credit-to-invoice allocation. */

const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function safeText(value, fallback = '—') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shortId(value) {
    const text = safeText(value);
    return text.length > 16 ? `…${text.slice(-12)}` : text;
}

function safeTimestamp(value) {
    return typeof value === 'string' && (ISO_TIMESTAMP.test(value) || SQLITE_TIMESTAMP.test(value));
}

function exactSnapshot(customer, settlement, suggestions) {
    return !!customer
        && settlement?.status === 'exact'
        && suggestions?.status === 'exact'
        && settlement.customer_id === customer.id
        && settlement.currency === 'KES'
        && Array.isArray(settlement.events)
        && Array.isArray(settlement.allocations);
}

function eligibleEvent(event, customerId, side, kinds) {
    return event
        && event.customer_id === customerId
        && event.currency === 'KES'
        && event.side === side
        && kinds.has(event.kind)
        && typeof event.id === 'string'
        && OPAQUE_ID.test(event.id);
}

export function allocationReversalCandidates(customer, settlement, suggestions) {
    if (!exactSnapshot(customer, settlement, suggestions)) return { available: false, allocations: [] };
    const events = new Map(settlement.events.map(event => [event?.id, event]));
    const allocations = settlement.allocations
        .filter(allocation => {
            if (!allocation || allocation.status !== 'active'
                || allocation.reversed_by_user_id !== null || allocation.reversed_at !== null
                || typeof allocation.id !== 'string' || !OPAQUE_ID.test(allocation.id)
                || typeof allocation.idempotency_key !== 'string' || !OPAQUE_ID.test(allocation.idempotency_key)
                || (allocation.created_by_user_id !== null
                    && (typeof allocation.created_by_user_id !== 'string' || !OPAQUE_ID.test(allocation.created_by_user_id)))
                || !Number.isSafeInteger(allocation.amount_minor) || allocation.amount_minor <= 0
                || !safeTimestamp(allocation.created_at)) return false;
            const credit = events.get(allocation.credit_event_id);
            const debit = events.get(allocation.debit_event_id);
            return eligibleEvent(credit, customer.id, 'credit', new Set(['payment', 'credit_note']))
                && eligibleEvent(debit, customer.id, 'debit', new Set(['invoice']));
        })
        .map(allocation => {
            const credit = events.get(allocation.credit_event_id);
            const debit = events.get(allocation.debit_event_id);
            return {
                id: allocation.id,
                credit_event_id: allocation.credit_event_id,
                debit_event_id: allocation.debit_event_id,
                amount_minor: allocation.amount_minor,
                idempotency_key: allocation.idempotency_key,
                created_by_user_id: allocation.created_by_user_id,
                created_at: allocation.created_at,
                label: `Allocation ${shortId(allocation.id)} · ${safeText(credit.kind)} ${safeText(credit.external_reference)} → invoice ${safeText(debit.external_reference)} · KES ${(allocation.amount_minor / 100).toFixed(2)} · ${allocation.created_at}`
            };
        });
    return { available: allocations.length > 0, allocations };
}

export function appendAllocationReversalOptions(select, rows, placeholder, documentRef = document) {
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

export function allocationReversalDraft({ customer, settlement, suggestions, allocationId, confirmed }) {
    const candidates = allocationReversalCandidates(customer, settlement, suggestions);
    if (confirmed !== true || !candidates.available) throw new TypeError('Select and confirm a current active allocation');
    const allocation = candidates.allocations.find(item => item.id === allocationId);
    if (!allocation) throw new TypeError('Select a current active allocation');
    return allocation;
}

export function createAllocationReversalIdentityLock() {
    let pending = false;
    return {
        begin() { pending = true; },
        finish() { pending = false; },
        canChange() { return pending !== true; }
    };
}

export function validAllocationReversalResponse(result, requested) {
    const allocation = result?.allocation;
    return !!result
        && typeof result === 'object'
        && typeof result.idempotent === 'boolean'
        && allocation
        && typeof allocation === 'object'
        && allocation.id === requested.id
        && allocation.credit_event_id === requested.credit_event_id
        && allocation.debit_event_id === requested.debit_event_id
        && allocation.amount_minor === requested.amount_minor
        && allocation.idempotency_key === requested.idempotency_key
        && allocation.created_by_user_id === requested.created_by_user_id
        && allocation.created_at === requested.created_at
        && allocation.status === 'reversed'
        && typeof allocation.reversed_by_user_id === 'string'
        && OPAQUE_ID.test(allocation.reversed_by_user_id)
        && safeTimestamp(allocation.reversed_at);
}

export function allocationReversalResponseIsCurrent(submission, current) {
    return submission?.customerId === current?.customerId
        && submission?.selectionVersion === current?.selectionVersion
        && submission?.snapshotVersion === current?.snapshotVersion
        && submission?.requestVersion === current?.requestVersion;
}
