/** Posted commercial credit notes: contra-revenue plus customer receivable credit. */

const crypto = require('crypto');
const { parseKesAmount } = require('./kes-money');
const {
    SettlementConflictError,
    SettlementNotFoundError,
    allocationIdFor,
    allocateCustomerCreditWithAdapter,
    recordCustomerAccountEventWithAdapter,
    verifyAllocationEvidence
} = require('./customer-settlement');

const OPAQUE = /^[A-Za-z0-9._:@-]+$/;
const REASONS = new Set(['return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other']);
const INPUT_FIELDS = new Set(['customer_id', 'invoice_event_id', 'amount', 'reason_code', 'external_reference', 'idempotency_key', 'created_by_user_id']);

class CustomerCreditNoteNotFoundError extends Error {}
class CustomerCreditNoteConflictError extends Error {}

function opaque(value, field, optional = false) {
    if ((value === undefined || value === null || value === '') && optional) return null;
    if (typeof value !== 'string') throw new TypeError(`${field} must be an opaque identifier`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 128 || !OPAQUE.test(normalized)) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return normalized;
}
function isOpaque(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && OPAQUE.test(value);
}

function inputFor(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('customer credit note input is required');
    }
    if (Object.getPrototypeOf(request) !== Object.prototype
        || Object.keys(request).some(key => !INPUT_FIELDS.has(key))) {
        throw new TypeError('customer credit note input is invalid');
    }
    const reason = request.reason_code;
    if (!REASONS.has(reason)) throw new TypeError('reason_code is invalid');
    const money = parseKesAmount(request.amount);
    return {
        customer_id: opaque(request.customer_id, 'customer_id'),
        invoice_event_id: opaque(request.invoice_event_id, 'invoice_event_id'),
        amount: money.amount,
        amount_minor: money.amountMinor,
        reason_code: reason,
        external_reference: opaque(request.external_reference, 'external_reference', true)?.toUpperCase() || null,
        idempotency_key: opaque(request.idempotency_key, 'idempotency_key'),
        created_by_user_id: opaque(request.created_by_user_id, 'created_by_user_id')
    };
}

function resolveBoundary(value) {
    const boundary = value || require('../db');
    if (!boundary || typeof boundary.withDedicatedTransaction !== 'function') {
        throw new TypeError('customer credit notes require a dedicated transaction boundary');
    }
    return boundary;
}

function idsFor(idempotencyKey) {
    const digest = crypto.createHash('sha256')
        .update(`customer-credit-note:${idempotencyKey}`)
        .digest('hex');
    return {
        event_id: `credit-note:${digest.slice(0, 40)}`,
        event_key: `credit-note:${digest.slice(0, 48)}`,
        ledger_transaction_id: `ledger-credit-note:${digest.slice(0, 36)}`,
        auto_allocation_key: `credit-note-allocation:${digest.slice(0, 48)}`
    };
}

function exactAmount(amount, amountMinor) {
    return typeof amount === 'number'
        && Number.isFinite(amount)
        && Math.abs(amount - amountMinor / 100) <= 0.000000001;
}

function materialOperationMatches(operation, input) {
    return operation.customer_id === input.customer_id
        && operation.invoice_event_id === input.invoice_event_id
        && operation.amount_minor === input.amount_minor
        && operation.reason_code === input.reason_code
        && (operation.external_reference ?? null) === input.external_reference;
}

function validRecordedAt(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function safePositiveMinor(value) {
    return Number.isSafeInteger(value) && value > 0;
}

async function sumPostedCreditNotes(adapter, invoice) {
    const rows = await adapter.allQuery(`SELECT customer_id, currency, side, kind, status, amount_minor, reason_code
        FROM customer_account_events
        WHERE kind = 'credit_note' AND status = 'posted' AND original_event_id = ?`, [invoice.id]);
    let total = 0n;
    for (const row of rows) {
        if (!safePositiveMinor(row.amount_minor)
            || row.customer_id !== invoice.customer_id
            || row.currency !== 'KES'
            || row.side !== 'credit'
            || row.kind !== 'credit_note'
            || row.status !== 'posted'
            || !REASONS.has(row.reason_code)) {
            throw new CustomerCreditNoteConflictError('credit note evidence is inconsistent');
        }
        total += BigInt(row.amount_minor);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new CustomerCreditNoteConflictError('credit note evidence is inconsistent');
        }
    }
    return Number(total);
}

async function invoiceDeficit(adapter, invoice) {
    const rows = await adapter.allQuery(`SELECT amount_minor FROM customer_account_allocations
        WHERE debit_event_id = ? AND status = 'active'`, [invoice.id]);
    let allocated = 0n;
    for (const row of rows) {
        if (!safePositiveMinor(row.amount_minor)) {
            throw new CustomerCreditNoteConflictError('invoice allocation evidence is inconsistent');
        }
        allocated += BigInt(row.amount_minor);
        if (allocated > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new CustomerCreditNoteConflictError('invoice allocation evidence is inconsistent');
        }
    }
    if (!safePositiveMinor(invoice.amount_minor) || allocated > BigInt(invoice.amount_minor)) {
        throw new CustomerCreditNoteConflictError('invoice allocation evidence is inconsistent');
    }
    return Number(BigInt(invoice.amount_minor) - allocated);
}

async function postCreditNoteLedgerWithAdapter(adapter, note) {
    await adapter.runQuery(`INSERT INTO ledger_transactions
        (id, date, description, ref_type, ref_id, customer_account_event_id)
        VALUES (?, ?, ?, 'customer_credit_note', ?, ?)`, [
        note.ledger_transaction_id,
        note.recorded_at,
        `Customer credit note: ${note.reason_code}`,
        note.idempotency_key,
        note.event_id
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '4050', 'debit', ?, ?, 'exact')`, [
        `${note.ledger_transaction_id}:dr`,
        note.ledger_transaction_id,
        note.amount,
        note.amount_minor
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1200', 'credit', ?, ?, 'exact')`, [
        `${note.ledger_transaction_id}:cr`,
        note.ledger_transaction_id,
        note.amount,
        note.amount_minor
    ]);
}

function result(operation, idempotent) {
    return {
        idempotent,
        credit_note_event_id: operation.credit_note_event_id,
        ledger_transaction_id: operation.ledger_transaction_id,
        amount_minor: operation.amount_minor,
        automatically_allocated_minor: operation.automatically_allocated_minor,
        remaining_credit_minor: operation.remaining_credit_minor,
        reason_code: operation.reason_code,
        original_invoice_event_id: operation.invoice_event_id,
        recorded_at: operation.created_at,
        recorded_by_user_id: operation.created_by_user_id
    };
}

function expectedAutoAllocation(operation) {
    if (operation.auto_allocation_id === null) return null;
    const ids = idsFor(operation.idempotency_key);
    return {
        id: allocationIdFor(ids.auto_allocation_key),
        credit_event_id: operation.credit_note_event_id,
        debit_event_id: operation.invoice_event_id,
        amount_minor: operation.automatically_allocated_minor,
        idempotency_key: ids.auto_allocation_key,
        created_by_user_id: operation.created_by_user_id
    };
}

async function verifyCreditNote(adapter, operation, input) {
    if (!operation || !materialOperationMatches(operation, input)
        || !validRecordedAt(operation.created_at)
        || !safePositiveMinor(operation.amount_minor)
        || !Number.isSafeInteger(operation.automatically_allocated_minor)
        || !Number.isSafeInteger(operation.remaining_credit_minor)
        || operation.automatically_allocated_minor < 0
        || operation.remaining_credit_minor < 0
        || operation.automatically_allocated_minor + operation.remaining_credit_minor !== operation.amount_minor
        || !REASONS.has(operation.reason_code)
        || !isOpaque(operation.created_by_user_id)) {
        throw new CustomerCreditNoteConflictError('credit note provenance is inconsistent');
    }
    const ids = idsFor(operation.idempotency_key);
    if (operation.credit_note_event_id !== ids.event_id
        || operation.ledger_transaction_id !== ids.ledger_transaction_id) {
        throw new CustomerCreditNoteConflictError('credit note provenance is inconsistent');
    }
    const event = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [operation.credit_note_event_id]);
    if (!event
        || event.idempotency_key !== ids.event_key
        || event.customer_id !== operation.customer_id
        || event.currency !== 'KES'
        || event.side !== 'credit'
        || event.kind !== 'credit_note'
        || event.status !== 'posted'
        || event.amount_minor !== operation.amount_minor
        || event.method !== null
        || (event.external_reference ?? null) !== (operation.external_reference ?? null)
        || event.payment_import_id !== null
        || event.source_transaction_id !== null
        || event.original_event_id !== operation.invoice_event_id
        || event.reason_code !== operation.reason_code
        || event.created_by_user_id !== operation.created_by_user_id
        || event.reviewer_user_id !== operation.created_by_user_id
        || !validRecordedAt(event.created_at)
        || event.posted_at !== operation.created_at) {
        throw new CustomerCreditNoteConflictError('credit note event is inconsistent');
    }
    const invoice = await adapter.getQuery(`SELECT customer_id, currency, side, kind, status, amount_minor
        FROM customer_account_events WHERE id = ?`, [operation.invoice_event_id]);
    if (!invoice || invoice.customer_id !== operation.customer_id || invoice.currency !== 'KES'
        || invoice.side !== 'debit' || invoice.kind !== 'invoice' || invoice.status !== 'posted'
        || !safePositiveMinor(invoice.amount_minor)) {
        throw new CustomerCreditNoteConflictError('credit note invoice is inconsistent');
    }
    const totalNotes = await sumPostedCreditNotes(adapter, { ...invoice, id: operation.invoice_event_id });
    if (totalNotes > invoice.amount_minor) {
        throw new CustomerCreditNoteConflictError('credit note aggregate is inconsistent');
    }
    const header = await adapter.getQuery(`SELECT id, date, description, ref_type, ref_id, customer_account_event_id
        FROM ledger_transactions WHERE id = ?`, [operation.ledger_transaction_id]);
    if (!header
        || header.date !== operation.created_at
        || header.description !== `Customer credit note: ${operation.reason_code}`
        || header.ref_type !== 'customer_credit_note'
        || header.ref_id !== operation.idempotency_key
        || header.customer_account_event_id !== event.id) {
        throw new CustomerCreditNoteConflictError('credit note ledger is inconsistent');
    }
    const expectedEntries = new Map([
        [`${header.id}:dr`, '4050:debit'],
        [`${header.id}:cr`, '1200:credit']
    ]);
    const entries = await adapter.allQuery(`SELECT id, account_id, entry_type, amount, amount_minor, reconciliation_status
        FROM ledger_entries WHERE transaction_id = ?`, [header.id]);
    if (entries.length !== expectedEntries.size || entries.some(entry =>
        expectedEntries.get(entry.id) !== `${entry.account_id}:${entry.entry_type}`
        || entry.amount_minor !== operation.amount_minor
        || entry.reconciliation_status !== 'exact'
        || !exactAmount(entry.amount, operation.amount_minor))) {
        throw new CustomerCreditNoteConflictError('credit note ledger is inconsistent');
    }
    const expectedAllocation = expectedAutoAllocation(operation);
    if (!expectedAllocation) {
        if (operation.automatically_allocated_minor !== 0 || operation.remaining_credit_minor !== operation.amount_minor
            || await adapter.getQuery('SELECT id FROM customer_account_allocations WHERE id = ?', [allocationIdFor(ids.auto_allocation_key)])
            || await adapter.getQuery(`SELECT idempotency_key FROM customer_allocation_operations
                WHERE idempotency_key = ? OR allocation_id = ?`, [ids.auto_allocation_key, allocationIdFor(ids.auto_allocation_key)])) {
            throw new CustomerCreditNoteConflictError('credit note allocation is inconsistent');
        }
    } else {
        if (operation.auto_allocation_id !== expectedAllocation.id
            || operation.automatically_allocated_minor <= 0
            || operation.remaining_credit_minor !== operation.amount_minor - operation.automatically_allocated_minor) {
            throw new CustomerCreditNoteConflictError('credit note allocation is inconsistent');
        }
        const allocation = await adapter.getQuery('SELECT * FROM customer_account_allocations WHERE id = ?', [expectedAllocation.id]);
        const allocationOperation = await adapter.getQuery(`SELECT * FROM customer_allocation_operations
            WHERE allocation_id = ?`, [expectedAllocation.id]);
        try {
            if (!allocation || allocation.status !== 'active') {
                throw new CustomerCreditNoteConflictError('credit note allocation is inconsistent');
            }
            await verifyAllocationEvidence(adapter, allocation, expectedAllocation, allocationOperation);
        } catch (_) {
            throw new CustomerCreditNoteConflictError('credit note allocation is inconsistent');
        }
    }
    return result(operation, true);
}

function isExpectedUniqueness(error) {
    if (!error || error.code !== 'SQLITE_CONSTRAINT') return false;
    const message = String(error.message || '');
    return [
        'customer_account_events.id',
        'customer_account_events.idempotency_key',
        'customer_account_events.external_reference',
        'ledger_transactions.id',
        'ledger_transactions.ref_type, ledger_transactions.ref_id',
        'ledger_transactions.customer_account_event_id',
        'customer_credit_note_operations.idempotency_key',
        'customer_credit_note_operations.credit_note_event_id',
        'customer_credit_note_operations.ledger_transaction_id',
        'customer_credit_note_operations.auto_allocation_id',
        'customer_account_allocations.id',
        'customer_account_allocations.idempotency_key',
        'customer_allocation_operations.idempotency_key',
        'customer_allocation_operations.allocation_id'
    ].some(expected => message.includes(`UNIQUE constraint failed: ${expected}`));
}

function createCustomerCreditNoteService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined
        ? { withDedicatedTransaction: resolveBoundary().withDedicatedTransaction }
        : {};
    const dependencies = {
        ...defaults,
        recordCustomerAccountEventWithAdapter,
        allocateCustomerCreditWithAdapter,
        postCreditNoteLedgerWithAdapter,
        ...overrides
    };
    for (const name of ['withDedicatedTransaction', 'recordCustomerAccountEventWithAdapter', 'allocateCustomerCreditWithAdapter', 'postCreditNoteLedgerWithAdapter']) {
        if (typeof dependencies[name] !== 'function') {
            throw new TypeError(`customer credit notes require ${name}`);
        }
    }

    async function issueCustomerCreditNote(request) {
        const input = inputFor(request);
        try {
            return await dependencies.withDedicatedTransaction(async adapter => {
                const existing = await adapter.getQuery(`SELECT * FROM customer_credit_note_operations
                    WHERE idempotency_key = ?`, [input.idempotency_key]);
                if (existing) return verifyCreditNote(adapter, existing, input);

                const customer = await adapter.getQuery('SELECT id FROM customers WHERE id = ?', [input.customer_id]);
                if (!customer) throw new CustomerCreditNoteNotFoundError('customer was not found');
    const invoice = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [input.invoice_event_id]);
                if (!invoice) throw new CustomerCreditNoteNotFoundError('invoice was not found');
                if (invoice.customer_id !== input.customer_id || invoice.currency !== 'KES'
                    || invoice.side !== 'debit' || invoice.kind !== 'invoice' || invoice.status !== 'posted'
                    || !safePositiveMinor(invoice.amount_minor)) {
                    throw new CustomerCreditNoteConflictError('invoice is not eligible for a credit note');
                }
                const priorNotes = await sumPostedCreditNotes(adapter, invoice);
                if (BigInt(priorNotes) + BigInt(input.amount_minor) > BigInt(invoice.amount_minor)) {
                    throw new CustomerCreditNoteConflictError('credit notes exceed the original invoice');
                }
                const ids = idsFor(input.idempotency_key);
                let recorded;
                try {
                    recorded = await dependencies.recordCustomerAccountEventWithAdapter({
                        id: ids.event_id,
                        customer_id: input.customer_id,
                        kind: 'credit_note',
                        status: 'posted',
                        amount_minor: input.amount_minor,
                        external_reference: input.external_reference,
                        original_event_id: invoice.id,
                        reason_code: input.reason_code,
                        idempotency_key: ids.event_key,
                        created_by_user_id: input.created_by_user_id,
                        reviewer_user_id: input.created_by_user_id
                    }, adapter);
                } catch (error) {
                    if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError || isExpectedUniqueness(error)) {
                        throw new CustomerCreditNoteConflictError('credit note event conflicts');
                    }
                    throw error;
                }
                if (!recorded.created) throw new CustomerCreditNoteConflictError('credit note event conflicts');
                const recordedAt = recorded.event.posted_at;
                if (!validRecordedAt(recordedAt)) {
                    throw new CustomerCreditNoteConflictError('credit note event timestamp is inconsistent');
                }
                await dependencies.postCreditNoteLedgerWithAdapter(adapter, {
                    ...input,
                    ...ids,
                    event_id: recorded.event.id,
                    recorded_at: recordedAt
                });
                const deficit = await invoiceDeficit(adapter, invoice);
                const automaticallyAllocated = Math.min(input.amount_minor, deficit);
                let autoAllocationId = null;
                if (automaticallyAllocated > 0) {
                    let allocated;
                    try {
                        allocated = await dependencies.allocateCustomerCreditWithAdapter({
                            credit_event_id: recorded.event.id,
                            debit_event_id: invoice.id,
                            amount_minor: automaticallyAllocated,
                            idempotency_key: ids.auto_allocation_key,
                            created_by_user_id: input.created_by_user_id
                        }, adapter);
                    } catch (error) {
                        if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError || isExpectedUniqueness(error)) {
                            throw new CustomerCreditNoteConflictError('credit note allocation conflicts');
                        }
                        throw error;
                    }
                    if (!allocated.created) throw new CustomerCreditNoteConflictError('credit note allocation conflicts');
                    autoAllocationId = allocated.allocation.id;
                }
                await adapter.runQuery(`INSERT INTO customer_credit_note_operations
                    (idempotency_key, customer_id, invoice_event_id, credit_note_event_id, ledger_transaction_id,
                     auto_allocation_id, amount_minor, automatically_allocated_minor, remaining_credit_minor,
                     reason_code, external_reference, created_by_user_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    input.idempotency_key,
                    input.customer_id,
                    invoice.id,
                    recorded.event.id,
                    ids.ledger_transaction_id,
                    autoAllocationId,
                    input.amount_minor,
                    automaticallyAllocated,
                    input.amount_minor - automaticallyAllocated,
                    input.reason_code,
                    input.external_reference,
                    input.created_by_user_id,
                    recordedAt
                ]);
                const operation = await adapter.getQuery(`SELECT * FROM customer_credit_note_operations
                    WHERE idempotency_key = ?`, [input.idempotency_key]);
                return verifyCreditNote(adapter, operation, input).then(value => ({ ...value, idempotent: false }));
            });
        } catch (error) {
            if (isExpectedUniqueness(error)) {
                throw new CustomerCreditNoteConflictError('customer credit note conflicts');
            }
            throw error;
        }
    }

    return { issueCustomerCreditNote };
}

function issueCustomerCreditNote(input, boundary) {
    return createCustomerCreditNoteService({
        withDedicatedTransaction: resolveBoundary(boundary).withDedicatedTransaction
    }).issueCustomerCreditNote(input);
}

module.exports = {
    CustomerCreditNoteNotFoundError,
    CustomerCreditNoteConflictError,
    createCustomerCreditNoteService,
    issueCustomerCreditNote,
    postCreditNoteLedgerWithAdapter,
    inputFor,
    idsFor,
    verifyCreditNote
};
