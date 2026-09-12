/**
 * Records manual incoming cash and bank customer receipts.
 *
 * A receipt is deliberately only customer credit plus its clearing-ledger
 * movement. It does not create a farm transaction, invoice, or allocation.
 */

const crypto = require('crypto');
const { parseKesAmount } = require('./kes-money');
const {
    SettlementConflictError,
    SettlementNotFoundError,
    recordCustomerAccountEventWithAdapter
} = require('./customer-settlement');

const OPAQUE = /^[A-Za-z0-9._:@-]+$/;
const METHODS = new Set(['cash', 'bank']);

class ManualCustomerReceiptNotFoundError extends Error {}
class ManualCustomerReceiptConflictError extends Error {}

function opaque(value, field) {
    if (typeof value !== 'string') throw new TypeError(`${field} must be an opaque identifier`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 128 || !OPAQUE.test(normalized)) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return normalized;
}

function reference(value, method) {
    if (value === undefined || value === null || value === '') {
        if (method === 'bank') throw new TypeError('bank external_reference is required');
        return null;
    }
    if (typeof value !== 'string') throw new TypeError('external_reference must be an opaque identifier');
    const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 128 || !OPAQUE.test(normalized)) {
        throw new TypeError('external_reference must be an opaque identifier');
    }
    return normalized.toUpperCase();
}

function validateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('manual customer receipt input is required');
    }
    const method = typeof input.method === 'string' ? input.method.toLowerCase() : input.method;
    if (!METHODS.has(method)) throw new TypeError('method must be cash or bank');
    const money = parseKesAmount(input.amount);
    const actor = opaque(input.created_by_user_id, 'created_by_user_id');
    if (input.reviewer_user_id !== undefined && input.reviewer_user_id !== null
        && opaque(input.reviewer_user_id, 'reviewer_user_id') !== actor) {
        throw new TypeError('manual customer receipt actor must be consistent');
    }
    return {
        customer_id: opaque(input.customer_id, 'customer_id'),
        idempotency_key: opaque(input.idempotency_key, 'idempotency_key'),
        created_by_user_id: actor,
        reviewer_user_id: actor,
        method,
        amount: money.amount,
        amount_minor: money.amountMinor,
        external_reference: reference(input.external_reference, method)
    };
}

function resolveBoundary(boundary) {
    const output = boundary || require('../db');
    if (!output || typeof output.withDedicatedTransaction !== 'function') {
        throw new TypeError('manual customer receipts require a dedicated transaction boundary');
    }
    return output;
}

function idsFor(idempotencyKey) {
    const digest = crypto.createHash('sha256')
        .update(`manual-customer-receipt:${idempotencyKey}`)
        .digest('hex');
    return {
        event_id: `manual-payment:${digest.slice(0, 40)}`,
        event_key: `manual-payment:${digest.slice(0, 48)}`,
        ledger_transaction_id: `ledger-manual:${digest.slice(0, 36)}`
    };
}

function exactAmount(amount, amountMinor) {
    return typeof amount === 'number'
        && Number.isFinite(amount)
        && Math.abs(amount - amountMinor / 100) <= 0.000000001;
}

function result(operation, event, ledgerTransactionId, idempotent) {
    return {
        idempotent,
        customer_account_event_id: event.id,
        ledger_transaction_id: ledgerTransactionId,
        recorded_at: operation.created_at,
        receipt: {
            customer_id: operation.customer_id,
            method: operation.method,
            amount_minor: operation.amount_minor,
            external_reference: operation.external_reference
        }
    };
}

function materialOperationMatches(operation, input) {
    return operation.customer_id === input.customer_id
        && operation.method === input.method
        && operation.amount_minor === input.amount_minor
        && (operation.external_reference ?? null) === input.external_reference;
}

async function postReceiptLedgerWithAdapter(adapter, receipt) {
    const debitAccount = receipt.method === 'cash' ? '1000' : '1020';
    if (typeof receipt.event_posted_at !== 'string' || !receipt.event_posted_at) {
        throw new TypeError('manual customer receipt event timestamp is required');
    }
    await adapter.runQuery(`INSERT INTO ledger_transactions
        (id, date, description, ref_type, ref_id, customer_account_event_id)
        VALUES (?, ?, ?, ?, ?, ?)`, [
        receipt.ledger_transaction_id,
        receipt.event_posted_at,
        `Manual ${receipt.method} customer receipt`,
        'manual_customer_receipt',
        receipt.idempotency_key,
        receipt.event_id
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, ?, 'debit', ?, ?, 'exact')`, [
        `${receipt.ledger_transaction_id}:dr`,
        receipt.ledger_transaction_id,
        debitAccount,
        receipt.amount,
        receipt.amount_minor
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1200', 'credit', ?, ?, 'exact')`, [
        `${receipt.ledger_transaction_id}:cr`,
        receipt.ledger_transaction_id,
        receipt.amount,
        receipt.amount_minor
    ]);
}

async function verifyReceipt(adapter, operation, input) {
    if (!materialOperationMatches(operation, input)) {
        throw new ManualCustomerReceiptConflictError('manual customer receipt idempotency conflicts');
    }
    const ids = idsFor(operation.idempotency_key);
    if (operation.customer_account_event_id !== ids.event_id
        || operation.ledger_transaction_id !== ids.ledger_transaction_id) {
        throw new ManualCustomerReceiptConflictError('manual customer receipt provenance is inconsistent');
    }
    const event = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [operation.customer_account_event_id]);
    if (!event
        || event.idempotency_key !== ids.event_key
        || event.customer_id !== operation.customer_id
        || event.currency !== 'KES'
        || event.side !== 'credit'
        || event.kind !== 'payment'
        || event.status !== 'posted'
        || event.method !== operation.method
        || event.amount_minor !== operation.amount_minor
        || (event.external_reference ?? null) !== (operation.external_reference ?? null)
        || event.payment_import_id !== null
        || event.source_transaction_id !== null
        || event.original_event_id !== null
        || event.created_by_user_id !== operation.created_by_user_id
        || event.reviewer_user_id !== operation.created_by_user_id
        || !operation.created_at
        || !event.created_at
        || !event.posted_at) {
        throw new ManualCustomerReceiptConflictError('manual customer receipt event is inconsistent');
    }
    const header = await adapter.getQuery(`SELECT id, date, description, ref_type, ref_id, customer_account_event_id
        FROM ledger_transactions WHERE id = ?`, [operation.ledger_transaction_id]);
    if (!header
        || header.date !== event.posted_at
        || header.description !== `Manual ${operation.method} customer receipt`
        || header.ref_type !== 'manual_customer_receipt'
        || header.ref_id !== operation.idempotency_key
        || header.customer_account_event_id !== event.id) {
        throw new ManualCustomerReceiptConflictError('manual customer receipt ledger is inconsistent');
    }
    const debitAccount = operation.method === 'cash' ? '1000' : '1020';
    const expected = new Map([
        [`${header.id}:dr`, `${debitAccount}:debit`],
        [`${header.id}:cr`, '1200:credit']
    ]);
    const entries = await adapter.allQuery(`SELECT id, account_id, entry_type, amount, amount_minor, reconciliation_status
        FROM ledger_entries WHERE transaction_id = ?`, [header.id]);
    if (entries.length !== expected.size || entries.some(entry =>
        expected.get(entry.id) !== `${entry.account_id}:${entry.entry_type}`
        || entry.amount_minor !== operation.amount_minor
        || entry.reconciliation_status !== 'exact'
        || !exactAmount(entry.amount, operation.amount_minor))) {
        throw new ManualCustomerReceiptConflictError('manual customer receipt ledger is inconsistent');
    }
    return result(operation, event, header.id, true);
}

function isExpectedUniqueness(error) {
    if (!error || error.code !== 'SQLITE_CONSTRAINT') return false;
    const message = String(error.message || '');
    return [
        'customer_account_events.idempotency_key',
        'customer_account_events.method, customer_account_events.external_reference',
        'ledger_transactions.id',
        'ledger_transactions.ref_type, ledger_transactions.ref_id',
        'ledger_transactions.customer_account_event_id',
        'manual_customer_receipt_operations.idempotency_key'
    ].some(expected => message.includes(`UNIQUE constraint failed: ${expected}`));
}

function createManualCustomerReceiptService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined
        ? { withDedicatedTransaction: resolveBoundary().withDedicatedTransaction }
        : {};
    const dependencies = {
        ...defaults,
        recordCustomerAccountEventWithAdapter,
        postReceiptLedgerWithAdapter,
        ...overrides
    };
    for (const name of ['withDedicatedTransaction', 'recordCustomerAccountEventWithAdapter', 'postReceiptLedgerWithAdapter']) {
        if (typeof dependencies[name] !== 'function') {
            throw new TypeError(`manual customer receipts require ${name}`);
        }
    }

    async function recordManualCustomerReceipt(request) {
        const input = validateInput(request);
        try {
            return await dependencies.withDedicatedTransaction(async adapter => {
                const existing = await adapter.getQuery(`SELECT *
                    FROM manual_customer_receipt_operations WHERE idempotency_key = ?`, [input.idempotency_key]);
                if (existing) return verifyReceipt(adapter, existing, input);

                const customer = await adapter.getQuery('SELECT id, is_active FROM customers WHERE id = ?', [input.customer_id]);
                if (!customer) throw new ManualCustomerReceiptNotFoundError('customer was not found');
                if (!(customer.is_active === 1 || customer.is_active === true)) {
                    throw new ManualCustomerReceiptConflictError('customer is inactive');
                }
                const ids = idsFor(input.idempotency_key);
                let recorded;
                try {
                    recorded = await dependencies.recordCustomerAccountEventWithAdapter({
                        id: ids.event_id,
                        customer_id: input.customer_id,
                        kind: 'payment',
                        status: 'posted',
                        amount_minor: input.amount_minor,
                        method: input.method,
                        external_reference: input.external_reference,
                        idempotency_key: ids.event_key,
                        created_by_user_id: input.created_by_user_id,
                        reviewer_user_id: input.reviewer_user_id
                    }, adapter);
                } catch (error) {
                    if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError || isExpectedUniqueness(error)) {
                        throw new ManualCustomerReceiptConflictError('manual customer receipt conflicts');
                    }
                    throw error;
                }
                if (!recorded.created) throw new ManualCustomerReceiptConflictError('manual customer receipt conflicts');
                await dependencies.postReceiptLedgerWithAdapter(adapter, {
                    ...input,
                    ...ids,
                    event_posted_at: recorded.event.posted_at
                });
                await adapter.runQuery(`INSERT INTO manual_customer_receipt_operations
                    (idempotency_key, customer_id, customer_account_event_id, ledger_transaction_id,
                     method, amount_minor, external_reference, created_by_user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                    input.idempotency_key,
                    input.customer_id,
                    recorded.event.id,
                    ids.ledger_transaction_id,
                    input.method,
                    input.amount_minor,
                    input.external_reference,
                    input.created_by_user_id
                ]);
                const operation = await adapter.getQuery(`SELECT * FROM manual_customer_receipt_operations
                    WHERE idempotency_key = ?`, [input.idempotency_key]);
                return result(operation, recorded.event, ids.ledger_transaction_id, false);
            });
        } catch (error) {
            if (isExpectedUniqueness(error)) {
                throw new ManualCustomerReceiptConflictError('manual customer receipt conflicts');
            }
            throw error;
        }
    }

    return { recordManualCustomerReceipt };
}

function recordManualCustomerReceipt(input, boundary) {
    return createManualCustomerReceiptService({
        withDedicatedTransaction: resolveBoundary(boundary).withDedicatedTransaction
    }).recordManualCustomerReceipt(input);
}

module.exports = {
    ManualCustomerReceiptNotFoundError,
    ManualCustomerReceiptConflictError,
    createManualCustomerReceiptService,
    recordManualCustomerReceipt,
    postReceiptLedgerWithAdapter,
    validateInput,
    idsFor
};
