/** Resolves customer snapshots for new transaction POSTs without creating account events. */

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const CUSTOMER_FIELDS = ['customerId', 'buyerName', 'buyerTerms', 'paymentTermsDays'];
const TRANSACTION_TYPES = new Set(['sale', 'purchase', 'return', 'write_off']);

class TransactionCustomerValidationError extends Error {}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function safeText(value, field, maxLength) {
    if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new TransactionCustomerValidationError(`${field} is invalid`);
    }
    return value;
}

function validateOptionalSnapshot(tx) {
    if (hasOwn(tx, 'buyerName')) safeText(tx.buyerName, 'buyerName', 120);
    if (hasOwn(tx, 'buyerTerms')) {
        const terms = safeText(tx.buyerTerms, 'buyerTerms', 16);
        if (!/^(?:COD|Net (?:0|[1-9]\d{0,2}))$/.test(terms)) {
            throw new TransactionCustomerValidationError('buyerTerms is invalid');
        }
    }
    if (hasOwn(tx, 'paymentTermsDays')
        && (!Number.isSafeInteger(tx.paymentTermsDays) || tx.paymentTermsDays < 0 || tx.paymentTermsDays > 365)) {
        throw new TransactionCustomerValidationError('paymentTermsDays is invalid');
    }
    if (hasOwn(tx, 'status') && !['paid', 'unpaid'].includes(tx.status)) {
        throw new TransactionCustomerValidationError('status is invalid');
    }
}

function customerId(value) {
    if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) {
        throw new TransactionCustomerValidationError('customerId is invalid');
    }
    return value.trim();
}

function termsLabel(days) {
    return days === 0 ? 'COD' : `Net ${days}`;
}

function isActive(value) {
    return value === 1 || value === true;
}

function hasCustomerFields(tx) {
    return CUSTOMER_FIELDS.some(field => hasOwn(tx, field));
}

function stripEmptyLegacyCustomerSnapshot(tx) {
    if (!hasCustomerFields(tx)) return tx;
    const hasCompleteSnapshot = CUSTOMER_FIELDS.every(field => hasOwn(tx, field));
    const allEmpty = hasCompleteSnapshot && CUSTOMER_FIELDS.every(field => tx[field] === null || tx[field] === '');
    if (!allEmpty) {
        throw new TransactionCustomerValidationError('customer fields are only valid for sales');
    }
    const resolved = { ...tx };
    for (const field of CUSTOMER_FIELDS) delete resolved[field];
    return resolved;
}

async function resolveTransactionCustomer(tx, dbAdapter) {
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
        throw new TransactionCustomerValidationError('transaction is invalid');
    }
    if (!dbAdapter || typeof dbAdapter.getQuery !== 'function') {
        throw new TypeError('transaction customer validation requires a database reader');
    }
    const resolved = { ...tx };
    if (typeof resolved.type !== 'string' || !TRANSACTION_TYPES.has(resolved.type)) {
        throw new TransactionCustomerValidationError('transaction type is invalid');
    }
    if (resolved.type !== 'sale') {
        return stripEmptyLegacyCustomerSnapshot(resolved);
    }
    if (!hasOwn(resolved, 'customerId')) {
        throw new TransactionCustomerValidationError('sale customerId is required');
    }
    validateOptionalSnapshot(resolved);

    if (resolved.customerId === null) {
        if ((hasOwn(resolved, 'buyerTerms') && resolved.buyerTerms !== 'COD')
            || (hasOwn(resolved, 'paymentTermsDays') && resolved.paymentTermsDays !== 0)
            || (hasOwn(resolved, 'status') && resolved.status !== 'paid')) {
            throw new TransactionCustomerValidationError('walk-in sales must be COD and paid');
        }
        return {
            ...resolved,
            customerId: null,
            buyerName: 'Walk-in Customer',
            buyerTerms: 'COD',
            paymentTermsDays: 0,
            status: 'paid'
        };
    }

    const id = customerId(resolved.customerId);
    const customer = await dbAdapter.getQuery(`SELECT id, display_name, payment_terms_days, is_active
        FROM customers WHERE id = ?`, [id]);
    if (!customer) throw new TransactionCustomerValidationError('customer was not found');
    if (!isActive(customer.is_active)) throw new TransactionCustomerValidationError('customer is inactive');
    if (!Number.isSafeInteger(customer.payment_terms_days)
        || customer.payment_terms_days < 0 || customer.payment_terms_days > 365) {
        throw new TransactionCustomerValidationError('customer payment terms are invalid');
    }
    return {
        ...resolved,
        customerId: customer.id,
        buyerName: customer.display_name,
        buyerTerms: termsLabel(customer.payment_terms_days),
        paymentTermsDays: customer.payment_terms_days,
        // Terms express when an invoice is due, never proof that it was paid.
        status: 'unpaid'
    };
}

module.exports = { TransactionCustomerValidationError, resolveTransactionCustomer };
