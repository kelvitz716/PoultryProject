/** Pure, read-only helpers for the Customer Settlement Timeline. */

const ACCESS_ROLES = new Set(['super_admin', 'admin', 'farmer']);

export function canAccessCustomerSettlement(role) {
    return ACCESS_ROLES.has(role);
}

// Receipt recording and allocation are separate financial actions. A pending
// action freezes both forms, while allocation also requires an exact snapshot.
export function customerFinancialFormAvailability({
    customer,
    allocationAvailable,
    settlementLoading,
    receiptPending,
    allocationPending,
    reversalPending,
    creditNotePending,
    refundPending
}) {
    const active = customer?.is_active === true || customer?.is_active === 1;
    const busy = receiptPending === true || allocationPending === true || reversalPending === true || creditNotePending === true || refundPending === true;
    return {
        receiptEnabled: active && !busy,
        allocationEnabled: active && allocationAvailable === true && settlementLoading !== true && !busy,
        reversalEnabled: !!customer && allocationAvailable === true && settlementLoading !== true && !busy,
        creditNoteEnabled: !!customer && allocationAvailable === true && settlementLoading !== true && !busy,
        refundEnabled: !!customer && allocationAvailable === true && settlementLoading !== true && !busy,
        identityEnabled: !busy
    };
}

export function formatKesMinor(value) {
    if (!Number.isSafeInteger(value) || value < 0) return 'Unavailable / reconciliation required';
    return `KES ${(value / 100).toFixed(2)}`;
}

export function formatSignedKesMinor(value) {
    if (!Number.isSafeInteger(value)) return 'Unavailable / reconciliation required';
    const prefix = value > 0 ? '+' : value < 0 ? '−' : '';
    return `${prefix}KES ${(Math.abs(value) / 100).toFixed(2)}`;
}

function safeText(value, fallback = '—') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shortId(value) {
    const text = safeText(value);
    return text.length > 16 ? `…${text.slice(-12)}` : text;
}

function exact(settlement, suggestions) {
    return settlement?.status === 'exact' && suggestions?.status === 'exact';
}

export function settlementSummaryModel(settlement, suggestions) {
    const available = exact(settlement, suggestions);
    const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
    return {
        status: available ? 'exact' : 'reconciliation_required',
        outstanding: available ? formatKesMinor(settlement.outstanding_debit_minor) : 'Unavailable / reconciliation required',
        credit: available ? formatKesMinor(settlement.available_credit_minor) : 'Unavailable / reconciliation required',
        net: available ? formatSignedKesMinor(settlement.net_minor) : 'Unavailable / reconciliation required',
        evidenceCount: count(settlement?.evidence_count),
        allocationCount: count(settlement?.allocation_count),
        issueCount: count(Math.max(settlement?.issue_count || 0, suggestions?.issue_count || 0))
    };
}

export function eventLane(event) {
    return ['invoice', 'credit_note', 'debit_note'].includes(event?.kind) ? 'commercial' : 'money';
}

function compareChronological(left, right) {
    return safeText(left.created_at, '')?.localeCompare(safeText(right.created_at, ''))
        || safeText(left.id, '').localeCompare(safeText(right.id, ''));
}

export function timelineModel(settlement) {
    const events = Array.isArray(settlement?.events) ? settlement.events.slice().sort(compareChronological) : [];
    const allocations = Array.isArray(settlement?.allocations) ? settlement.allocations.slice().sort(compareChronological) : [];
    const eventById = new Map(events.map(event => [event.id, event]));
    const eventRow = event => ({
        lane: eventLane(event),
        id: shortId(event.id),
        kind: safeText(event.kind),
        status: safeText(event.status),
        amount: formatKesMinor(event.amount_minor),
        remaining: formatKesMinor(event.remaining_minor),
        reference: safeText(event.external_reference),
        recordedAt: safeText(event.posted_at || event.created_at)
    });
    const allocationRow = allocation => {
        const credit = eventById.get(allocation.credit_event_id);
        const debit = eventById.get(allocation.debit_event_id);
        return {
            lane: 'allocations',
            id: shortId(allocation.id),
            status: safeText(allocation.status),
            amount: formatKesMinor(allocation.amount_minor),
            recordedAt: safeText(allocation.reversed_at || allocation.created_at),
            from: `${safeText(credit?.kind, 'credit')} ${shortId(allocation.credit_event_id)}`,
            to: `${safeText(debit?.kind, 'debit')} ${shortId(allocation.debit_event_id)}`
        };
    };
    return {
        commercial: events.filter(event => eventLane(event) === 'commercial').map(eventRow),
        money: events.filter(event => eventLane(event) === 'money').map(eventRow),
        allocations: allocations.map(allocationRow)
    };
}

export function suggestionModel(suggestions) {
    if (suggestions?.status !== 'exact' || !Array.isArray(suggestions?.suggestions)) return [];
    const rank = value => value.reason_code === 'exact_remaining_match' ? 0 : 1;
    return suggestions.suggestions.slice()
        .sort((left, right) => rank(left) - rank(right)
            || safeText(left.credit_event_id, '').localeCompare(safeText(right.credit_event_id, ''))
            || safeText(left.debit_event_id, '').localeCompare(safeText(right.debit_event_id, '')))
        .map(item => ({
            reason: item.reason_code === 'exact_remaining_match' ? 'Exact remaining match' : 'Partial capacity match',
            amount: formatKesMinor(item.amount_minor),
            credit: shortId(item.credit_event_id),
            debit: shortId(item.debit_event_id),
            explanation: item.reason_code === 'exact_remaining_match'
                ? `The available credit and invoice deficit are both ${formatKesMinor(item.amount_minor)}.`
                : `Up to ${formatKesMinor(item.amount_minor)} could be confirmed later; this is not an allocation.`
        }));
}

export function customerSettlementLabel(customer) {
    const name = safeText(customer?.display_name, 'Unnamed customer');
    const suffix = shortId(customer?.id);
    const inactive = customer?.is_active === false || customer?.is_active === 0 ? ' · inactive' : '';
    return `${name} (ID ${suffix}${inactive})`;
}

export function appendCustomerSettlementOptions(select, customers, documentRef = document) {
    select.replaceChildren();
    const placeholder = documentRef.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a customer';
    select.append(placeholder);
    (Array.isArray(customers) ? customers : []).forEach(customer => {
        if (typeof customer?.id !== 'string' || !customer.id.trim()) return;
        const option = documentRef.createElement('option');
        option.value = customer.id;
        option.textContent = customerSettlementLabel(customer);
        select.append(option);
    });
}

function appendLine(container, labelText, value, documentRef) {
    const row = documentRef.createElement('div');
    row.className = 'customer-settlement-timeline-row';
    const label = documentRef.createElement('strong');
    label.textContent = labelText;
    const content = documentRef.createElement('span');
    content.textContent = value;
    row.append(label, content);
    container.append(row);
}

function appendTimelineLane(container, labelText, rows, documentRef) {
    const lane = documentRef.createElement('section');
    lane.className = 'customer-settlement-lane';
    const heading = documentRef.createElement('h4');
    heading.textContent = labelText;
    lane.append(heading);
    if (!rows.length) {
        const empty = documentRef.createElement('p');
        empty.textContent = 'No recorded evidence on this track.';
        lane.append(empty);
    } else {
        rows.forEach(row => {
            const card = documentRef.createElement('article');
            card.className = 'customer-settlement-event';
            const title = documentRef.createElement('strong');
            title.textContent = row.lane === 'allocations'
                ? `${row.status} allocation ${row.id}`
                : `${row.kind} ${row.id} · ${row.status}`;
            card.append(title);
            if (row.lane === 'allocations') {
                appendLine(card, 'Connection', `${row.from} → ${row.to}`, documentRef);
            } else {
                appendLine(card, 'Remaining', row.remaining, documentRef);
                appendLine(card, 'Reference', row.reference, documentRef);
            }
            appendLine(card, 'Amount', row.amount, documentRef);
            appendLine(card, 'Recorded', row.recordedAt, documentRef);
            lane.append(card);
        });
    }
    container.append(lane);
}

export function renderCustomerSettlementTimeline(container, settlement, documentRef = document) {
    container.replaceChildren();
    const timeline = timelineModel(settlement);
    appendTimelineLane(container, 'Commercial track', timeline.commercial, documentRef);
    appendTimelineLane(container, 'Money track', timeline.money, documentRef);
    appendTimelineLane(container, 'Allocation links', timeline.allocations, documentRef);
}

export function renderCustomerSettlementSuggestions(container, suggestions, documentRef = document) {
    container.replaceChildren();
    const rows = suggestionModel(suggestions);
    if (!rows.length) {
        const empty = documentRef.createElement('p');
        empty.textContent = suggestions?.status === 'reconciliation_required'
            ? 'Unavailable / reconciliation required'
            : 'No safe reconciliation suggestions are available.';
        container.append(empty);
        return;
    }
    rows.forEach(row => {
        const card = documentRef.createElement('article');
        card.className = 'customer-settlement-suggestion';
        const title = documentRef.createElement('strong');
        title.textContent = `${row.reason} · ${row.amount}`;
        const relation = documentRef.createElement('p');
        relation.textContent = `Credit ${row.credit} → invoice ${row.debit}`;
        const explanation = documentRef.createElement('p');
        explanation.textContent = row.explanation;
        card.append(title, relation, explanation);
        container.append(card);
    });
}

export function createCustomerSettlementTimelineController(apiClient) {
    let customerVersion = 0;
    let readVersion = 0;
    return {
        async loadCustomers(includeInactive) {
            const version = ++customerVersion;
            try {
                const customers = await apiClient.listCustomers(includeInactive);
                return { stale: version !== customerVersion, customers };
            } catch (error) {
                return { stale: version !== customerVersion, error };
            }
        },
        async load(customerId, onStart) {
            const version = ++readVersion;
            onStart?.(customerId);
            const [settlement, suggestions] = await Promise.allSettled([
                apiClient.getCustomerSettlement(customerId),
                apiClient.getCustomerReconciliationSuggestions(customerId, { limit: 50 })
            ]);
            const error = [settlement, suggestions].find(result => result.status === 'rejected')?.reason;
            return {
                stale: version !== readVersion,
                settlement: settlement.status === 'fulfilled' ? settlement.value : null,
                suggestions: suggestions.status === 'fulfilled' ? suggestions.value : null,
                error
            };
        }
    };
}
