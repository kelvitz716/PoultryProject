export const CUSTOMER_WRITE_ROLES = new Set(['super_admin', 'admin', 'farmer']);

export function canWriteCustomers(role) {
    return CUSTOMER_WRITE_ROLES.has(role);
}

export function customerTermsLabel(days) {
    return Number(days) === 0 ? 'COD' : `Net ${Number(days)}`;
}

export function customerTermsDays(value) {
    const days = Number(value);
    if (![0, 7, 14, 30].includes(days)) throw new TypeError('Unsupported payment terms');
    return days;
}

export function customerDisambiguator(customer) {
    const suffix = `ID …${String(customer.id || '').slice(-6)}`;
    return customer.contact_phone ? `${customer.contact_phone} · ${suffix}` : suffix;
}

export function customerRowModel(customer) {
    return {
        id: customer.id,
        displayName: customer.display_name,
        termsLabel: customerTermsLabel(customer.payment_terms_days),
        disambiguator: customerDisambiguator(customer),
        isActive: customer.is_active === 1 || customer.is_active === true
    };
}

export function appendCustomerRegistryRow(container, customer, documentRef = document) {
    const model = customerRowModel(customer);
    const row = documentRef.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border-color);font-size:13px;gap:8px;';
    const details = documentRef.createElement('div');
    const name = documentRef.createElement('strong');
    name.textContent = model.displayName;
    const metadata = documentRef.createElement('span');
    metadata.style.cssText = 'color:var(--text-muted);margin-left:8px;';
    metadata.textContent = `${model.disambiguator} · ${model.termsLabel}${model.isActive ? '' : ' · inactive'}`;
    details.append(name, metadata);
    row.append(details);
    container.append(row);
    return row;
}

export function saleCustomerFields(customer) {
    if (!customer) {
        return {
            customerId: null,
            buyerName: 'Walk-in Customer',
            buyerTerms: 'COD',
            paymentTermsDays: 0
        };
    }
    const paymentTermsDays = Number(customer.payment_terms_days);
    return {
        customerId: customer.id,
        buyerName: customer.display_name,
        buyerTerms: customerTermsLabel(paymentTermsDays),
        paymentTermsDays
    };
}

export function appendSaleCustomerSelector(container, customers, documentRef = document) {
    const group = documentRef.createElement('div');
    group.className = 'input-group';
    const label = documentRef.createElement('label');
    label.htmlFor = 'tx-customer';
    label.textContent = 'Buyer / Customer';
    const select = documentRef.createElement('select');
    select.id = 'tx-customer';
    const walkIn = documentRef.createElement('option');
    walkIn.value = '';
    walkIn.textContent = 'Walk-in Customer (COD)';
    select.append(walkIn);
    customers.forEach(customer => {
        const option = documentRef.createElement('option');
        option.value = customer.id;
        option.textContent = `${customer.display_name} (${customerDisambiguator(customer)} · ${customerTermsLabel(customer.payment_terms_days)})`;
        select.append(option);
    });
    group.append(label, select);
    container.append(group);
    return select;
}

export function canSaveSaleForCustomer(fields) {
    return !(Number(fields.paymentTermsDays) > 0 && !fields.customerId);
}

export function bootstrapIssueMessage(issue) {
    const messages = {
        invalid_profile: 'Legacy profile data needs review.',
        invalid_record: 'Buyer record needs a corrected named customer.',
        invalid_name: 'Buyer name needs correction before import.',
        reserved_walk_in: 'Walk-in Customer is transaction-local; create a named customer instead.',
        unknown_terms: 'Payment terms need correction before import.',
        invalid_phone: 'Phone number needs correction before import.'
    };
    return messages[issue.code] || 'Buyer record needs review.';
}

export function newIdempotencyKey(prefix, randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
    const value = randomUuid ? randomUuid() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}:${value}`;
}

async function requestJson(fetchImpl, url, options, unavailableMessage, failedMessage) {
    let response;
    try {
        response = await fetchImpl(url, options);
    } catch (_) {
        const error = new Error(unavailableMessage);
        error.status = 0;
        throw error;
    }
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) {
        const error = new Error(typeof body?.error === 'string' ? body.error : failedMessage);
        error.status = response.status;
        throw error;
    }
    return body;
}

export function requestCustomerJson(fetchImpl, url, options = {}) {
    return requestJson(fetchImpl, url, options, 'Customer service is unavailable', 'Customer request failed');
}

export function requestTransactionJson(fetchImpl, url, options = {}) {
    return requestJson(fetchImpl, url, options, 'Transaction service is unavailable', 'Transaction could not be saved');
}
