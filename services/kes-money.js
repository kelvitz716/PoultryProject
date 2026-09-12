/** Strict KES amount parsing for new generic-ledger writes. */

const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const PLAIN_KES = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

class KesMoneyValidationError extends RangeError {}

function minorFromPlainDecimal(text) {
    const [wholeText, fractionText = ''] = text.split('.');
    const minor = BigInt(wholeText) * 100n + BigInt((fractionText + '00').slice(0, 2));
    if (minor <= 0n || minor > BigInt(MAX_MINOR)) {
        throw new KesMoneyValidationError('KES amount is outside the supported range');
    }
    return Number(minor);
}

function parseKesAmount(value) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new KesMoneyValidationError('KES amount must be a number or plain decimal string');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new KesMoneyValidationError('KES amount must be finite');
    }
    const text = typeof value === 'number' ? String(value) : value;
    if (!PLAIN_KES.test(text)) {
        throw new KesMoneyValidationError('KES amount must be a plain positive decimal with at most two places');
    }
    const amountMinor = minorFromPlainDecimal(text);
    const amount = Number(text);
    // The legacy REAL field remains a compatibility mirror only. Reject values
    // whose decimal-string representation cannot round-trip to the same cents.
    if (!Number.isFinite(amount) || !PLAIN_KES.test(String(amount)) || minorFromPlainDecimal(String(amount)) !== amountMinor) {
        throw new KesMoneyValidationError('KES amount cannot be represented safely');
    }
    return { amount, amountMinor };
}

function normalizeNewTransactionAmount(transaction) {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
        throw new KesMoneyValidationError('transaction is invalid');
    }
    if (Object.hasOwn(transaction, 'amountMinor') || Object.hasOwn(transaction, 'amount_minor')) {
        throw new KesMoneyValidationError('minor amounts are server-derived');
    }
    const parsed = parseKesAmount(transaction.amount);
    return { transaction: { ...transaction, amount: parsed.amount }, amountMinor: parsed.amountMinor };
}

module.exports = {
    KesMoneyValidationError,
    MAX_MINOR,
    parseKesAmount,
    normalizeNewTransactionAmount
};
