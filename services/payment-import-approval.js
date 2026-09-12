/**
 * Approves clean incoming M-Pesa evidence as one unallocated customer payment.
 * It deliberately creates neither a sale/invoice nor an allocation.
 */

const crypto = require('crypto');
const {
    SettlementConflictError,
    SettlementNotFoundError,
    recordCustomerAccountEventWithAdapter
} = require('./customer-settlement');
const { PAYMENT_IMPORT_SAFE_SELECT, toSafePaymentImport } = require('./payment-imports');

const OPAQUE_ID = /^[A-Za-z0-9._:@-]+$/;
const RECEIPT_CODE = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8,14}$/;
const APPROVAL_IMPORT_COLUMNS = `${PAYMENT_IMPORT_SAFE_SELECT}`;

class PaymentImportApprovalNotFoundError extends Error {}
class PaymentImportApprovalConflictError extends Error {}

function opaque(value, field) {
    if (typeof value !== 'string') throw new TypeError(`${field} must be an opaque identifier`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 128 || !OPAQUE_ID.test(normalized)) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return normalized;
}

function receiptCode(value) {
    if (typeof value !== 'string' || !RECEIPT_CODE.test(value)) {
        throw new PaymentImportApprovalConflictError('payment import receipt evidence is invalid');
    }
    return value;
}

function parseWarningsAreEmpty(value) {
    if (typeof value !== 'string') return false;
    try {
        const warnings = JSON.parse(value);
        return Array.isArray(warnings) && warnings.length === 0;
    } catch (_) {
        return false;
    }
}

function resolveBoundary(value) {
    const boundary = value || require('../db');
    if (!boundary || typeof boundary.withDedicatedTransaction !== 'function') {
        throw new TypeError('payment-import approval requires a dedicated transaction boundary');
    }
    return boundary;
}

function token(importId) {
    return crypto.createHash('sha256').update(`payment-import-approval:${importId}`).digest('hex');
}

function idsFor(importId) {
    const digest = token(importId);
    return {
        eventId: `payment:${digest.slice(0, 40)}`,
        eventKey: `payment:${digest.slice(0, 48)}`,
        ledgerId: `ledger-payment:${digest.slice(0, 36)}`
    };
}

function importDate(importRow) {
    if (Number.isSafeInteger(importRow.transaction_at_ms)
        && importRow.transaction_at_ms >= 0
        && importRow.transaction_at_ms <= 8640000000000000) {
        return new Date(importRow.transaction_at_ms).toISOString();
    }
    return new Date().toISOString();
}

function validateApprovableImport(importRow) {
    if (!importRow
        || importRow.status !== 'received'
        || importRow.has_conflict !== 0
        || importRow.direction !== 'received'
        || importRow.event_kind !== 'customer_receipt'
        || importRow.currency !== 'KES'
        || !Number.isSafeInteger(importRow.amount_minor)
        || importRow.amount_minor <= 0
        || !parseWarningsAreEmpty(importRow.parse_warnings)) {
        throw new PaymentImportApprovalConflictError('payment import is not approvable');
    }
    if (importRow.transaction_at_ms !== null
        && (!Number.isSafeInteger(importRow.transaction_at_ms)
            || importRow.transaction_at_ms < 0
            || importRow.transaction_at_ms > 8640000000000000)) {
        throw new PaymentImportApprovalConflictError('payment import timestamp is invalid');
    }
    return receiptCode(importRow.receipt_code);
}

async function postMpesatillLedgerWithAdapter(adapter, { importRow, eventId, ledgerId }) {
    const amount = importRow.amount_minor / 100;
    await adapter.runQuery(`INSERT INTO ledger_transactions
        (id, date, description, ref_type, ref_id, customer_account_event_id)
        VALUES (?, ?, ?, ?, ?, ?)`, [
        ledgerId,
        importDate(importRow),
        'Approved M-Pesa customer payment',
        'payment_import_approval',
        importRow.id,
        eventId
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1010', 'debit', ?, ?, 'exact')`, [
        `${ledgerId}:dr`, ledgerId, amount, importRow.amount_minor
    ]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, '1200', 'credit', ?, ?, 'exact')`, [
        `${ledgerId}:cr`, ledgerId, amount, importRow.amount_minor
    ]);
}

function exactAmount(amount, amountMinor) {
    return typeof amount === 'number'
        && Number.isFinite(amount)
        && Math.abs(amount - amountMinor / 100) <= 0.000000001;
}

async function verifyApprovedLinks(adapter, importRow, customerId) {
    if (importRow.customer_id !== customerId || !importRow.created_account_event_id) {
        throw new PaymentImportApprovalConflictError('approved payment import links are inconsistent');
    }
    const code = receiptCode(importRow.receipt_code);
    const ids = idsFor(importRow.id);
    const event = await adapter.getQuery('SELECT * FROM customer_account_events WHERE id = ?', [importRow.created_account_event_id]);
    if (!event
        || event.id !== ids.eventId
        || event.customer_id !== customerId
        || event.currency !== 'KES'
        || event.side !== 'credit'
        || event.kind !== 'payment'
        || event.status !== 'posted'
        || event.method !== 'mpesa'
        || event.amount_minor !== importRow.amount_minor
        || event.external_reference !== code
        || event.payment_import_id !== importRow.id
        || event.idempotency_key !== ids.eventKey
        || !importRow.reviewer_user_id
        || event.created_by_user_id !== importRow.reviewer_user_id
        || event.reviewer_user_id !== importRow.reviewer_user_id) {
        throw new PaymentImportApprovalConflictError('approved payment import event is inconsistent');
    }
    const header = await adapter.getQuery(`SELECT id, ref_type, ref_id, customer_account_event_id
        FROM ledger_transactions WHERE customer_account_event_id = ?`, [event.id]);
    if (!header
        || header.id !== ids.ledgerId
        || header.ref_type !== 'payment_import_approval'
        || header.ref_id !== importRow.id
        || header.customer_account_event_id !== event.id) {
        throw new PaymentImportApprovalConflictError('approved payment import ledger is inconsistent');
    }
    const entries = await adapter.allQuery(`SELECT account_id, entry_type, amount, amount_minor, reconciliation_status
        FROM ledger_entries WHERE transaction_id = ?`, [header.id]);
    const expected = new Map([['1010:debit', true], ['1200:credit', true]]);
    if (entries.length !== expected.size || entries.some(entry =>
        !expected.has(`${entry.account_id}:${entry.entry_type}`)
        || entry.amount_minor !== importRow.amount_minor
        || entry.reconciliation_status !== 'exact'
        || !exactAmount(entry.amount, importRow.amount_minor))) {
        throw new PaymentImportApprovalConflictError('approved payment import ledger is inconsistent');
    }
    return { event, ledger_transaction_id: header.id };
}

function isConstraint(error) {
    return error && error.code === 'SQLITE_CONSTRAINT';
}

function createPaymentImportApprovalService(overrides = {}) {
    const defaults = overrides.withDedicatedTransaction === undefined
        ? { withDedicatedTransaction: resolveBoundary().withDedicatedTransaction }
        : {};
    const dependencies = {
        ...defaults,
        recordCustomerAccountEventWithAdapter,
        postMpesatillLedgerWithAdapter,
        ...overrides
    };
    for (const name of ['withDedicatedTransaction', 'recordCustomerAccountEventWithAdapter', 'postMpesatillLedgerWithAdapter']) {
        if (typeof dependencies[name] !== 'function') throw new TypeError(`payment-import approval requires ${name}`);
    }

    async function approvePaymentImport({ id, customer_id, reviewer_user_id, created_by_user_id }) {
        const importId = opaque(id, 'id');
        const customerId = opaque(customer_id, 'customer_id');
        const reviewerId = opaque(reviewer_user_id, 'reviewer_user_id');
        const creatorId = opaque(created_by_user_id, 'created_by_user_id');
        try {
            return await dependencies.withDedicatedTransaction(async adapter => {
                const importRow = await adapter.getQuery(`SELECT ${APPROVAL_IMPORT_COLUMNS}
                    FROM payment_imports WHERE id = ?`, [importId]);
                if (!importRow) throw new PaymentImportApprovalNotFoundError('payment import was not found');

                if (importRow.status === 'approved') {
                    const verified = await verifyApprovedLinks(adapter, importRow, customerId);
                    return {
                        idempotent: true,
                        payment_import: toSafePaymentImport(importRow),
                        customer_account_event_id: verified.event.id,
                        ledger_transaction_id: verified.ledger_transaction_id
                    };
                }

                const code = validateApprovableImport(importRow);
                const customer = await adapter.getQuery('SELECT id, is_active FROM customers WHERE id = ?', [customerId]);
                if (!customer) throw new PaymentImportApprovalNotFoundError('customer was not found');
                if (!(customer.is_active === 1 || customer.is_active === true)) {
                    throw new PaymentImportApprovalConflictError('customer is inactive');
                }
                const ids = idsFor(importId);
                let recorded;
                try {
                    recorded = await dependencies.recordCustomerAccountEventWithAdapter({
                        id: ids.eventId,
                        customer_id: customerId,
                        kind: 'payment',
                        status: 'posted',
                        amount_minor: importRow.amount_minor,
                        method: 'mpesa',
                        external_reference: code,
                        payment_import_id: importId,
                        idempotency_key: ids.eventKey,
                        created_by_user_id: creatorId,
                        reviewer_user_id: reviewerId
                    }, adapter);
                } catch (error) {
                    if (error instanceof SettlementConflictError || error instanceof SettlementNotFoundError || isConstraint(error)) {
                        throw new PaymentImportApprovalConflictError('payment event conflicts');
                    }
                    throw error;
                }
                if (!recorded.created) throw new PaymentImportApprovalConflictError('payment event conflicts');
                await dependencies.postMpesatillLedgerWithAdapter(adapter, {
                    importRow,
                    eventId: recorded.event.id,
                    ledgerId: ids.ledgerId
                });
                const approved = await adapter.getQuery(`UPDATE payment_imports
                    SET status = 'approved',
                        customer_id = ?,
                        created_account_event_id = ?,
                        reviewer_user_id = ?,
                        reviewed_at = CURRENT_TIMESTAMP,
                        approved_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'received'
                    RETURNING ${PAYMENT_IMPORT_SAFE_SELECT}`,
                [customerId, recorded.event.id, reviewerId, importId]);
                if (!approved) throw new PaymentImportApprovalConflictError('payment import approval conflicts');
                return {
                    idempotent: false,
                    payment_import: toSafePaymentImport(approved),
                    customer_account_event_id: recorded.event.id,
                    ledger_transaction_id: ids.ledgerId
                };
            });
        } catch (error) {
            if (isConstraint(error)) throw new PaymentImportApprovalConflictError('payment import approval conflicts');
            throw error;
        }
    }

    return { approvePaymentImport };
}

function approvePaymentImport(input, boundary) {
    return createPaymentImportApprovalService({
        withDedicatedTransaction: resolveBoundary(boundary).withDedicatedTransaction
    }).approvePaymentImport(input);
}

module.exports = {
    PaymentImportApprovalNotFoundError,
    PaymentImportApprovalConflictError,
    createPaymentImportApprovalService,
    approvePaymentImport,
    postMpesatillLedgerWithAdapter,
    validateApprovableImport
};
