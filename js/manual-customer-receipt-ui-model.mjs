/** Pure validation and retry-state helpers for the manual customer-receipt form. */

const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const PLAIN_KES = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const METHODS = new Set(['cash', 'bank']);
const RECORDED_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const EVENT_ID = /^manual-payment:[a-f0-9]{40}$/;
const LEDGER_ID = /^ledger-manual:[a-f0-9]{36}$/;

function exactMinor(text) {
    const [whole, fraction = ''] = text.split('.');
    const value = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
    if (value <= 0n || value > BigInt(MAX_MINOR)) throw new RangeError('Amount is outside the supported range');
    return Number(value);
}

export function parseManualReceiptKes(value) {
    if (typeof value !== 'string' || !PLAIN_KES.test(value)) {
        throw new TypeError('Enter a positive KES amount with no more than two decimal places');
    }
    const amountMinor = exactMinor(value);
    const [whole, fraction = ''] = value.split('.');
    return { amount: `${whole}.${(fraction + '00').slice(0, 2)}`, amountMinor };
}

export function normalizeManualReceiptReference(value, method) {
    if (!METHODS.has(method)) throw new TypeError('Choose cash or bank');
    const normalized = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
    if (!normalized) {
        if (method === 'bank') throw new TypeError('A bank reference is required');
        return null;
    }
    if (normalized.length > 128 || !OPAQUE_ID.test(normalized)) {
        throw new TypeError('Reference must be a short reference code');
    }
    return normalized.toUpperCase();
}

export function manualReceiptDraft({ customerId, customerIsActive, method, amount, externalReference, confirmed }) {
    if (customerIsActive !== true || typeof customerId !== 'string' || !OPAQUE_ID.test(customerId)) {
        throw new TypeError('Select an active named customer');
    }
    if (!METHODS.has(method)) throw new TypeError('Choose cash or bank');
    if (confirmed !== true) throw new TypeError('Confirm before recording customer credit');
    const parsed = parseManualReceiptKes(amount);
    return {
        customer_id: customerId,
        method,
        amount: parsed.amount,
        external_reference: normalizeManualReceiptReference(externalReference, method)
    };
}

export function manualReceiptFingerprint(draft) {
    return JSON.stringify([
        draft.customer_id,
        draft.method,
        draft.amount,
        draft.external_reference
    ]);
}

export function createManualReceiptRetryTracker(createKey) {
    let uncertain = null;
    return {
        keyFor(draft) {
            const fingerprint = manualReceiptFingerprint(draft);
            if (uncertain?.fingerprint === fingerprint) return uncertain.key;
            const key = createKey();
            if (typeof key !== 'string' || !OPAQUE_ID.test(key)) throw new TypeError('Could not create a safe receipt key');
            return key;
        },
        retainUncertain(draft, key) {
            uncertain = { fingerprint: manualReceiptFingerprint(draft), key };
        },
        clear() {
            uncertain = null;
        },
        invalidate() {
            uncertain = null;
        }
    };
}

export function createManualReceiptIdentityLock() {
    let pending = false;
    return {
        begin() {
            pending = true;
        },
        finish() {
            pending = false;
        },
        canChange() {
            return pending !== true;
        }
    };
}

export function receiptResponseIsCurrent(submission, current) {
    return submission?.customerId === current?.customerId
        && submission?.selectionVersion === current?.selectionVersion
        && submission?.requestVersion === current?.requestVersion;
}

export function validManualReceiptResponse(result, draft) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || typeof result.idempotent !== 'boolean'
        || typeof result.customer_account_event_id !== 'string' || !EVENT_ID.test(result.customer_account_event_id)
        || typeof result.ledger_transaction_id !== 'string' || !LEDGER_ID.test(result.ledger_transaction_id)
        || typeof result.recorded_at !== 'string' || !RECORDED_AT.test(result.recorded_at)
        || !result.receipt || typeof result.receipt !== 'object' || Array.isArray(result.receipt)) {
        return false;
    }
    let amountMinor;
    try {
        amountMinor = parseManualReceiptKes(draft.amount).amountMinor;
    } catch (_) {
        return false;
    }
    return result.receipt.customer_id === draft.customer_id
        && result.receipt.method === draft.method
        && result.receipt.amount_minor === amountMinor
        && result.receipt.external_reference === draft.external_reference;
}
