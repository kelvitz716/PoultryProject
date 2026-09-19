/**
 * Read-only dashboard projections of customer-account settlement snapshots.
 *
 * A transaction row is commercial context, not proof that money was received.
 * This model therefore accepts only the server's immutable settlement snapshot
 * totals and turns anything incomplete or internally inconsistent into an
 * explicit reconciliation requirement.
 */

const ACCESS_ROLES = new Set(['super_admin', 'admin', 'farmer']);
const UNAVAILABLE = 'Unavailable / reconciliation required';

function safeText(value, fallback = 'Unnamed customer') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeMinor(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

export function canAccessDashboardAccountsReceivable(role) {
    return ACCESS_ROLES.has(role);
}

export function formatKesMinor(value) {
    return safeMinor(value) ? `KES ${(value / 100).toFixed(2)}` : UNAVAILABLE;
}

export function formatSignedKesMinor(value) {
    if (!Number.isSafeInteger(value)) return UNAVAILABLE;
    return `${value < 0 ? '−' : value > 0 ? '+' : ''}KES ${(Math.abs(value) / 100).toFixed(2)}`;
}

function exactSettlementFor(customer, settlement) {
    return settlement?.status === 'exact'
        && settlement.customer_id === customer?.id
        && settlement.currency === 'KES'
        && safeMinor(settlement.outstanding_debit_minor)
        && safeMinor(settlement.available_credit_minor)
        && Number.isSafeInteger(settlement.net_minor)
        && settlement.net_minor === settlement.available_credit_minor - settlement.outstanding_debit_minor;
}

export function dashboardArProjection(customer, settlement) {
    const base = {
        customerId: typeof customer?.id === 'string' ? customer.id : '',
        customerName: safeText(customer?.display_name),
        inactive: customer?.is_active === false || customer?.is_active === 0
    };
    if (!exactSettlementFor(customer, settlement)) {
        return {
            ...base,
            status: 'reconciliation_required',
            outstanding: UNAVAILABLE,
            credit: UNAVAILABLE,
            net: UNAVAILABLE
        };
    }
    return {
        ...base,
        status: 'exact',
        outstanding: formatKesMinor(settlement.outstanding_debit_minor),
        credit: formatKesMinor(settlement.available_credit_minor),
        net: formatSignedKesMinor(settlement.net_minor)
    };
}

export function dashboardArProjections(customers, settlements) {
    if (!Array.isArray(customers)) return [];
    const byCustomer = settlements instanceof Map ? settlements : new Map();
    return customers
        .filter(customer => typeof customer?.id === 'string' && customer.id)
        .map(customer => dashboardArProjection(customer, byCustomer.get(customer.id)))
        .sort((left, right) => left.customerName.localeCompare(right.customerName) || left.customerId.localeCompare(right.customerId));
}

/**
 * Keeps only the newest read result.  This makes dashboard refreshes safe when
 * a slow, older settlement snapshot finishes after a later reload.
 */
export function createDashboardArController({ listCustomers, getCustomerSettlement }) {
    if (typeof listCustomers !== 'function' || typeof getCustomerSettlement !== 'function') {
        throw new TypeError('dashboard AR requires read-only customer APIs');
    }
    let version = 0;
    return {
        invalidate() { version += 1; },
        async load(role) {
            const requestVersion = ++version;
            if (!canAccessDashboardAccountsReceivable(role)) return { status: 'unauthorized', projections: [] };
            let customers;
            try {
                // Include inactive customers: their outstanding position remains
                // part of the customer account, even when no new sales are allowed.
                customers = await listCustomers(true);
            } catch (_) {
                return requestVersion === version ? { status: 'unavailable', projections: [] } : { status: 'stale', projections: [] };
            }
            if (requestVersion !== version) return { status: 'stale', projections: [] };
            if (!Array.isArray(customers)) return { status: 'unavailable', projections: [] };
            const settlements = new Map();
            await Promise.all(customers.map(async customer => {
                if (typeof customer?.id !== 'string' || !customer.id) return;
                try { settlements.set(customer.id, await getCustomerSettlement(customer.id)); } catch (_) { /* rendered unavailable */ }
            }));
            if (requestVersion !== version) return { status: 'stale', projections: [] };
            return { status: 'ready', projections: dashboardArProjections(customers, settlements) };
        }
    };
}

function textNode(documentRef, text) {
    const node = documentRef.createElement('span');
    node.textContent = text;
    return node;
}

export function renderDashboardAr(container, result, documentRef = document) {
    container.replaceChildren();
    const notice = documentRef.createElement('p');
    notice.style.cssText = 'color:var(--text-muted); font-size:13px;';
    if (result?.status === 'unauthorized') {
        notice.textContent = 'Customer settlement details are unavailable for your role.';
        container.append(notice);
        return;
    }
    if (result?.status !== 'ready') {
        notice.textContent = UNAVAILABLE;
        container.append(notice);
        return;
    }
    if (!result.projections.length) {
        notice.textContent = 'No customer account positions recorded.';
        container.append(notice);
        return;
    }
    for (const projection of result.projections) {
        const row = documentRef.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:16px; padding:12px 0; border-bottom:1px solid var(--border-color); font-size:13px;';
        const identity = documentRef.createElement('div');
        const name = documentRef.createElement('strong');
        name.textContent = projection.customerName;
        const description = documentRef.createElement('div');
        description.style.cssText = 'color:var(--text-muted); font-size:11px; margin-top:3px;';
        description.textContent = projection.inactive ? 'Inactive customer account' : 'Customer account';
        identity.append(name, description);
        const totals = documentRef.createElement('div');
        totals.style.cssText = 'display:flex; gap:12px; text-align:right; flex-wrap:wrap; justify-content:flex-end;';
        for (const [label, value] of [['Outstanding', projection.outstanding], ['Unallocated credit', projection.credit], ['Net', projection.net]]) {
            const item = documentRef.createElement('div');
            item.append(textNode(documentRef, `${label}: `), textNode(documentRef, value));
            totals.append(item);
        }
        row.append(identity, totals);
        container.append(row);
    }
}
