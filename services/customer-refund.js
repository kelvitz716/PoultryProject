/** Explicit outgoing customer refunds funded by identified available credit. */

const crypto = require('crypto');
const { parseKesAmount } = require('./kes-money');
const {
    SettlementConflictError,
    SettlementNotFoundError,
    allocationIdFor,
    allocateCustomerCreditWithAdapter,
    verifyAllocationEvidence
} = require('./customer-settlement');

const OPAQUE = /^[A-Za-z0-9._:@-]+$/;
const METHODS = new Set(['cash', 'mpesa', 'bank']);
const REASONS = new Set(['overpayment', 'duplicate_payment', 'customer_request', 'returned_goods', 'other']);
const FIELDS = new Set([
    'customer_id', 'method', 'amount', 'sources', 'reason_code', 'external_reference',
    'acknowledge_method_difference', 'idempotency_key', 'created_by_user_id'
]);

class CustomerRefundNotFoundError extends Error {}
class CustomerRefundConflictError extends Error {}

function opaque(value, field, optional = false) {
    if ((value === undefined || value === null || value === '') && optional) return null;
    if (typeof value !== 'string') throw new TypeError(`${field} must be an opaque identifier`);
    const normalized = value.normalize('NFKC').trim();
    if (!normalized || normalized.length > 128 || !OPAQUE.test(normalized)) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return normalized;
}

function isOpaque(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && OPAQUE.test(value);
}

function safePositiveMinor(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function normalizedReference(value, method) {
    const reference = opaque(value, 'external_reference', method === 'cash');
    if (!reference && method !== 'cash') throw new TypeError(`${method} external_reference is required`);
    return reference ? reference.toUpperCase() : null;
}

function normalizedSources(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
        throw new TypeError('sources must be a bounded nonempty list');
    }
    const sources = value.map(source => {
        if (!source || typeof source !== 'object' || Array.isArray(source)
            || Object.getPrototypeOf(source) !== Object.prototype
            || Object.keys(source).length !== 2
            || !Object.hasOwn(source, 'credit_event_id') || !Object.hasOwn(source, 'amount')) {
            throw new TypeError('refund source is invalid');
        }
        const money = parseKesAmount(source.amount);
        return { credit_event_id: opaque(source.credit_event_id, 'credit_event_id'), amount_minor: money.amountMinor };
    }).sort((left, right) => left.credit_event_id.localeCompare(right.credit_event_id));
    if (new Set(sources.map(source => source.credit_event_id)).size !== sources.length) {
        throw new TypeError('refund sources must not repeat a credit event');
    }
    let total = 0n;
    for (const source of sources) {
        total += BigInt(source.amount_minor);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('refund source total is unsafe');
    }
    return { sources, amount_minor: Number(total) };
}

function inputFor(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.getPrototypeOf(request) !== Object.prototype
        || Object.keys(request).some(key => !FIELDS.has(key))) {
        throw new TypeError('customer refund input is invalid');
    }
    const method = typeof request.method === 'string' ? request.method.toLowerCase() : request.method;
    if (!METHODS.has(method)) throw new TypeError('refund method is invalid');
    if (!REASONS.has(request.reason_code)) throw new TypeError('refund reason_code is invalid');
    if (typeof request.acknowledge_method_difference !== 'boolean') {
        throw new TypeError('acknowledge_method_difference must be boolean');
    }
    const amount = parseKesAmount(request.amount);
    const source = normalizedSources(request.sources);
    if (source.amount_minor !== amount.amountMinor) {
        throw new TypeError('refund source allocations must equal refund amount');
    }
    return {
        customer_id: opaque(request.customer_id, 'customer_id'),
        method,
        amount: amount.amount,
        amount_minor: amount.amountMinor,
        sources: source.sources,
        sources_json: JSON.stringify(source.sources),
        reason_code: request.reason_code,
        external_reference: normalizedReference(request.external_reference, method),
        acknowledge_method_difference: request.acknowledge_method_difference,
        idempotency_key: opaque(request.idempotency_key, 'idempotency_key'),
        created_by_user_id: opaque(request.created_by_user_id, 'created_by_user_id')
    };
}

function resolveBoundary(value) {
    const boundary = value || require('../db');
    if (!boundary || typeof boundary.withDedicatedTransaction !== 'function') {
        throw new TypeError('customer refunds require a dedicated transaction boundary');
    }
    return boundary;
}

function idsFor(idempotencyKey) {
    const digest = crypto.createHash('sha256').update(`customer-refund:${idempotencyKey}`).digest('hex');
    const base = digest.slice(0, 48);
    return {
        refund_event_id: `customer-refund:${digest.slice(0, 40)}`,
        refund_event_key: `customer-refund:${base}`,
        ledger_transaction_id: `ledger-customer-refund:${digest.slice(0, 36)}`,
        sourceAllocationKey: ordinal => `customer-refund-allocation:${base}:${ordinal}`
    };
}

function exactAmount(amount, amountMinor) {
    return typeof amount === 'number' && Number.isFinite(amount)
        && Math.abs(amount - amountMinor / 100) <= 0.000000001;
}

function validRecordedAt(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function operationMatches(operation, input) {
    return operation.customer_id === input.customer_id
        && operation.method === input.method
        && operation.amount_minor === input.amount_minor
        && operation.reason_code === input.reason_code
        && (operation.external_reference ?? null) === input.external_reference
        && Boolean(operation.acknowledge_method_difference) === input.acknowledge_method_difference
        && operation.sources_json === input.sources_json;
}

function parseStoredSources(value) {
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) return null;
        const sources = parsed.map(source => {
            if (!source || Object.getPrototypeOf(source) !== Object.prototype
                || Object.keys(source).length !== 2
                || !isOpaque(source.credit_event_id) || !safePositiveMinor(source.amount_minor)) return null;
            return { credit_event_id: source.credit_event_id, amount_minor: source.amount_minor };
        });
        if (sources.includes(null)
            || new Set(sources.map(source => source.credit_event_id)).size !== sources.length
            || sources.some((source, index) => index > 0 && sources[index - 1].credit_event_id.localeCompare(source.credit_event_id) >= 0)) return null;
        return sources;
    } catch (_) {
        return null;
    }
}

async function activeAllocationTotal(adapter, creditEventId) {
    const rows = await adapter.allQuery(`SELECT amount_minor FROM customer_account_allocations
        WHERE credit_event_id = ? AND status = 'active'`, [creditEventId]);
    let total = 0n;
    for (const row of rows) {
        if (!safePositiveMinor(row.amount_minor)) throw new CustomerRefundConflictError('refund source evidence is inconsistent');
        total += BigInt(row.amount_minor);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new CustomerRefundConflictError('refund source evidence is inconsistent');
    }
    return Number(total);
}

function sourceIsEligible(source, customerId) {
    return source && source.customer_id === customerId && source.currency === 'KES'
        && source.side === 'credit' && source.status === 'posted'
        && ['payment', 'credit_note'].includes(source.kind)
        && safePositiveMinor(source.amount_minor)
        && ((source.kind === 'payment' && METHODS.has(source.method))
            || (source.kind === 'credit_note' && source.method === null));
}

async function checkedSources(adapter, input) {
    const sources = [];
    let methodDifference = false;
    for (const requested of input.sources) {
        const event = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [requested.credit_event_id]);
        if (!event) throw new CustomerRefundNotFoundError('refund source was not found');
        if (!sourceIsEligible(event, input.customer_id)) {
            throw new CustomerRefundConflictError('refund source is incompatible');
        }
        const allocated = await activeAllocationTotal(adapter, event.id);
        if (allocated > event.amount_minor || requested.amount_minor > event.amount_minor - allocated) {
            throw new CustomerRefundConflictError('refund exceeds available customer credit');
        }
        const differs = event.kind === 'payment' && event.method !== input.method;
        methodDifference = methodDifference || differs;
        sources.push({ ...requested, event, method_difference: differs });
    }
    if (methodDifference && !input.acknowledge_method_difference) {
        throw new CustomerRefundConflictError('refund method difference requires acknowledgement');
    }
    return { sources, method_difference: methodDifference };
}

async function insertRefundEventWithAdapter(adapter, refund) {
    await adapter.runQuery(`INSERT INTO customer_account_events
        (id, customer_id, currency, side, kind, status, amount_minor, method, external_reference,
         payment_import_id, source_transaction_id, original_event_id, reason_code, idempotency_key,
         created_by_user_id, reviewer_user_id, created_at, posted_at)
        VALUES (?, ?, 'KES', 'debit', 'refund', 'posted', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        refund.refund_event_id,
        refund.customer_id,
        refund.amount_minor,
        refund.method,
        refund.external_reference,
        refund.refund_event_key,
        refund.created_by_user_id,
        refund.created_by_user_id
    ]);
    return adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [refund.refund_event_id]);
}

async function postRefundLedgerWithAdapter(adapter, refund) {
    const creditAccount = refund.method === 'cash' ? '1000' : refund.method === 'mpesa' ? '1010' : '1020';
    await adapter.runQuery(`INSERT INTO ledger_transactions
        (id, date, description, ref_type, ref_id, customer_account_event_id)
        VALUES (?, ?, ?, 'customer_refund', ?, ?)`, [
        refund.ledger_transaction_id,
        refund.recorded_at,
        `Customer refund: ${refund.reason_code}`,
        refund.idempotency_key,
        refund.refund_event_id
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1200', 'debit', ?, ?, 'exact')`, [
        `${refund.ledger_transaction_id}:dr`, refund.ledger_transaction_id, refund.amount, refund.amount_minor
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, ?, 'credit', ?, ?, 'exact')`, [
        `${refund.ledger_transaction_id}:cr`, refund.ledger_transaction_id, creditAccount, refund.amount, refund.amount_minor
    ]);
}

async function insertRefundOperationWithAdapter(adapter, operation, sourceAllocations) {
    await adapter.runQuery(`INSERT INTO customer_refund_operations
        (idempotency_key, customer_id, refund_event_id, ledger_transaction_id, method, amount_minor,
         external_reference, reason_code, method_difference, acknowledge_method_difference, sources_json,
         created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        operation.idempotency_key,
        operation.customer_id,
        operation.refund_event_id,
        operation.ledger_transaction_id,
        operation.method,
        operation.amount_minor,
        operation.external_reference,
        operation.reason_code,
        operation.method_difference ? 1 : 0,
        operation.acknowledge_method_difference ? 1 : 0,
        operation.sources_json,
        operation.created_by_user_id,
        operation.created_at
    ]);
    for (const [ordinal, allocation] of sourceAllocations.entries()) {
        await adapter.runQuery(`INSERT INTO customer_refund_source_allocations
            (refund_idempotency_key, source_ordinal, credit_event_id, allocation_id, amount_minor)
            VALUES (?, ?, ?, ?, ?)`, [
            operation.idempotency_key,
            ordinal,
            allocation.credit_event_id,
            allocation.id,
            allocation.amount_minor
        ]);
    }
}

function result(operation, sourceAllocations, idempotent) {
    return {
        idempotent,
        refund_event_id: operation.refund_event_id,
        ledger_transaction_id: operation.ledger_transaction_id,
        amount_minor: operation.amount_minor,
        method: operation.method,
        external_reference: operation.external_reference,
        reason_code: operation.reason_code,
        method_difference: Boolean(operation.method_difference),
        acknowledge_method_difference: Boolean(operation.acknowledge_method_difference),
        source_allocations: sourceAllocations.map(row => ({
            credit_event_id: row.credit_event_id,
            allocation_id: row.allocation_id,
            amount_minor: row.amount_minor
        })),
        recorded_at: operation.created_at,
        recorded_by_user_id: operation.created_by_user_id
    };
}

async function verifyRefund(adapter, operation, input) {
    if (!operation || !operationMatches(operation, input)
        || !safePositiveMinor(operation.amount_minor)
        || !REASONS.has(operation.reason_code)
        || !METHODS.has(operation.method)
        || !isOpaque(operation.created_by_user_id)
        || !validRecordedAt(operation.created_at)
        || ![0, 1, false, true].includes(operation.method_difference)
        || ![0, 1, false, true].includes(operation.acknowledge_method_difference)) {
        throw new CustomerRefundConflictError('customer refund provenance is inconsistent');
    }
    const storedSources = parseStoredSources(operation.sources_json);
    if (!storedSources || JSON.stringify(storedSources) !== input.sources_json) {
        throw new CustomerRefundConflictError('customer refund provenance is inconsistent');
    }
    const ids = idsFor(operation.idempotency_key);
    if (operation.refund_event_id !== ids.refund_event_id || operation.ledger_transaction_id !== ids.ledger_transaction_id) {
        throw new CustomerRefundConflictError('customer refund provenance is inconsistent');
    }
    const event = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [operation.refund_event_id]);
    if (!event || event.idempotency_key !== ids.refund_event_key || event.customer_id !== operation.customer_id
        || event.currency !== 'KES' || event.side !== 'debit' || event.kind !== 'refund' || event.status !== 'posted'
        || event.amount_minor !== operation.amount_minor || event.method !== operation.method
        || (event.external_reference ?? null) !== (operation.external_reference ?? null)
        || event.payment_import_id !== null || event.source_transaction_id !== null || event.original_event_id !== null
        || event.reason_code !== null || event.created_by_user_id !== operation.created_by_user_id
        || event.reviewer_user_id !== operation.created_by_user_id || !validRecordedAt(event.created_at)
        || !validRecordedAt(event.posted_at) || event.created_at !== operation.created_at
        || event.posted_at !== operation.created_at) {
        throw new CustomerRefundConflictError('customer refund event is inconsistent');
    }
    const customer = await adapter.getQuery('SELECT id FROM customers WHERE id = ?', [operation.customer_id]);
    if (!customer) throw new CustomerRefundConflictError('customer refund customer is inconsistent');
    const links = await adapter.allQuery(`SELECT refund_idempotency_key, source_ordinal, credit_event_id, allocation_id, amount_minor
        FROM customer_refund_source_allocations WHERE refund_idempotency_key = ? ORDER BY source_ordinal ASC`, [operation.idempotency_key]);
    const allRefundAllocations = await adapter.allQuery(`SELECT id FROM customer_account_allocations
        WHERE debit_event_id = ? ORDER BY id`, [event.id]);
    if (links.length !== storedSources.length || allRefundAllocations.length !== links.length
        || links.some((link, ordinal) => link.refund_idempotency_key !== operation.idempotency_key
            || link.source_ordinal !== ordinal
            || link.credit_event_id !== storedSources[ordinal].credit_event_id
            || link.amount_minor !== storedSources[ordinal].amount_minor
            || link.allocation_id !== allocationIdFor(ids.sourceAllocationKey(ordinal)))
        || allRefundAllocations.some((row, ordinal) => row.id !== links.map(link => link.allocation_id).sort()[ordinal])) {
        throw new CustomerRefundConflictError('customer refund allocation provenance is inconsistent');
    }
    let methodDifference = false;
    let sourceTotal = 0n;
    for (const [ordinal, link] of links.entries()) {
        const source = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [link.credit_event_id]);
        if (!sourceIsEligible(source, operation.customer_id)) {
            throw new CustomerRefundConflictError('customer refund source is inconsistent');
        }
        methodDifference = methodDifference || (source.kind === 'payment' && source.method !== operation.method);
        const allocation = await adapter.getQuery('SELECT * FROM customer_account_allocations WHERE id = ?', [link.allocation_id]);
        const allocationOperation = await adapter.getQuery(`SELECT * FROM customer_allocation_operations
            WHERE allocation_id = ?`, [link.allocation_id]);
        try {
            await verifyAllocationEvidence(adapter, allocation, {
                id: allocationIdFor(ids.sourceAllocationKey(ordinal)),
                credit_event_id: source.id,
                debit_event_id: event.id,
                amount_minor: link.amount_minor,
                idempotency_key: ids.sourceAllocationKey(ordinal),
                created_by_user_id: operation.created_by_user_id
            }, allocationOperation);
        } catch (_) {
            throw new CustomerRefundConflictError('customer refund allocation provenance is inconsistent');
        }
        const allocated = await activeAllocationTotal(adapter, source.id);
        if (allocated > source.amount_minor) throw new CustomerRefundConflictError('customer refund source is inconsistent');
        sourceTotal += BigInt(link.amount_minor);
        if (sourceTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new CustomerRefundConflictError('customer refund source is inconsistent');
    }
    if (Number(sourceTotal) !== operation.amount_minor || Boolean(operation.method_difference) !== methodDifference
        || (methodDifference && !Boolean(operation.acknowledge_method_difference))
        || (operation.method !== 'cash' && !(typeof operation.external_reference === 'string' && operation.external_reference.length > 0))) {
        throw new CustomerRefundConflictError('customer refund provenance is inconsistent');
    }
    const header = await adapter.getQuery(`SELECT id, date, description, ref_type, ref_id, customer_account_event_id
        FROM ledger_transactions WHERE id = ?`, [operation.ledger_transaction_id]);
    if (!header || header.date !== operation.created_at || header.description !== `Customer refund: ${operation.reason_code}`
        || header.ref_type !== 'customer_refund' || header.ref_id !== operation.idempotency_key
        || header.customer_account_event_id !== event.id) {
        throw new CustomerRefundConflictError('customer refund ledger is inconsistent');
    }
    const creditAccount = operation.method === 'cash' ? '1000' : operation.method === 'mpesa' ? '1010' : '1020';
    const expectedEntries = new Map([
        [`${header.id}:dr`, '1200:debit'],
        [`${header.id}:cr`, `${creditAccount}:credit`]
    ]);
    const entries = await adapter.allQuery(`SELECT id, account_id, entry_type, amount, amount_minor, reconciliation_status
        FROM ledger_entries WHERE transaction_id = ?`, [header.id]);
    if (entries.length !== expectedEntries.size || entries.some(entry => expectedEntries.get(entry.id) !== `${entry.account_id}:${entry.entry_type}`
        || entry.amount_minor !== operation.amount_minor || entry.reconciliation_status !== 'exact'
        || !exactAmount(entry.amount, operation.amount_minor))) {
        throw new CustomerRefundConflictError('customer refund ledger is inconsistent');
    }
    return result(operation, links, true);
}

function isExpectedUniqueness(error) {
    if (!error || error.code !== 'SQLITE_CONSTRAINT') return false;
    const message = String(error.message || '');
    return [
        'customer_account_events.id', 'customer_account_events.idempotency_key',
        'customer_account_events.method, customer_account_events.external_reference',
        'ledger_transactions.id', 'ledger_transactions.ref_type, ledger_transactions.ref_id',
        'ledger_transactions.customer_account_event_id', 'customer_refund_operations.idempotency_key',
        'customer_refund_operations.refund_event_id', 'customer_refund_operations.ledger_transaction_id',
        'customer_refund_source_allocations.refund_idempotency_key, customer_refund_source_allocations.source_ordinal',
        'customer_refund_source_allocations.allocation_id',
        'customer_account_allocations.id', 'customer_account_allocations.idempotency_key',
        'customer_allocation_operations.idempotency_key', 'customer_allocation_operations.allocation_id'
    ].some(expected => message.includes(`UNIQUE constraint failed: ${expected}`));
}

function createCustomerRefundService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined
        ? { withDedicatedTransaction: resolveBoundary().withDedicatedTransaction }
        : {};
    const dependencies = {
        ...defaults,
        insertRefundEventWithAdapter,
        postRefundLedgerWithAdapter,
        allocateCustomerCreditWithAdapter,
        insertRefundOperationWithAdapter,
        ...overrides
    };
    for (const name of ['withDedicatedTransaction', 'insertRefundEventWithAdapter', 'postRefundLedgerWithAdapter', 'allocateCustomerCreditWithAdapter', 'insertRefundOperationWithAdapter']) {
        if (typeof dependencies[name] !== 'function') throw new TypeError(`customer refunds require ${name}`);
    }

    async function issueCustomerRefund(request) {
        const input = inputFor(request);
        try {
            return await dependencies.withDedicatedTransaction(async adapter => {
                const existing = await adapter.getQuery('SELECT * FROM customer_refund_operations WHERE idempotency_key = ?', [input.idempotency_key]);
                if (existing) return verifyRefund(adapter, existing, input);
                if (!await adapter.getQuery('SELECT id FROM customers WHERE id = ?', [input.customer_id])) {
                    throw new CustomerRefundNotFoundError('customer was not found');
                }
                const checked = await checkedSources(adapter, input);
                const ids = idsFor(input.idempotency_key);
                let event;
                try {
                    event = await dependencies.insertRefundEventWithAdapter(adapter, { ...input, ...ids });
                } catch (error) {
                    if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError || isExpectedUniqueness(error)) {
                        throw new CustomerRefundConflictError('customer refund event conflicts');
                    }
                    throw error;
                }
                if (!event || !validRecordedAt(event.posted_at)) {
                    throw new CustomerRefundConflictError('customer refund event timestamp is inconsistent');
                }
                const operation = {
                    ...input,
                    ...ids,
                    refund_event_id: event.id,
                    recorded_at: event.posted_at,
                    created_at: event.posted_at,
                    method_difference: checked.method_difference
                };
                await dependencies.postRefundLedgerWithAdapter(adapter, operation);
                const allocations = [];
                for (const [ordinal, source] of checked.sources.entries()) {
                    let allocated;
                    try {
                        allocated = await dependencies.allocateCustomerCreditWithAdapter({
                            credit_event_id: source.credit_event_id,
                            debit_event_id: event.id,
                            amount_minor: source.amount_minor,
                            idempotency_key: ids.sourceAllocationKey(ordinal),
                            created_by_user_id: input.created_by_user_id
                        }, adapter);
                    } catch (error) {
                        if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError || isExpectedUniqueness(error)) {
                            throw new CustomerRefundConflictError('customer refund allocation conflicts');
                        }
                        throw error;
                    }
                    if (!allocated.created) throw new CustomerRefundConflictError('customer refund allocation conflicts');
                    allocations.push(allocated.allocation);
                }
                await dependencies.insertRefundOperationWithAdapter(adapter, operation, allocations);
                const saved = await adapter.getQuery('SELECT * FROM customer_refund_operations WHERE idempotency_key = ?', [input.idempotency_key]);
                return { ...(await verifyRefund(adapter, saved, input)), idempotent: false };
            });
        } catch (error) {
            if (isExpectedUniqueness(error)) throw new CustomerRefundConflictError('customer refund conflicts');
            throw error;
        }
    }
    return { issueCustomerRefund };
}

function issueCustomerRefund(input, boundary) {
    return createCustomerRefundService({
        withDedicatedTransaction: resolveBoundary(boundary).withDedicatedTransaction
    }).issueCustomerRefund(input);
}

module.exports = {
    CustomerRefundNotFoundError,
    CustomerRefundConflictError,
    createCustomerRefundService,
    issueCustomerRefund,
    inputFor,
    idsFor,
    verifyRefund,
    insertRefundEventWithAdapter,
    postRefundLedgerWithAdapter,
    insertRefundOperationWithAdapter
};
