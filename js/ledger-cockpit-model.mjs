export const RECONCILIATION_REQUIRED_TEXT = 'Unavailable / reconciliation required';

function exactAccount(account) {
    return account
        && account.status === 'exact'
        && Number.isSafeInteger(account.balance_minor)
        && Number.isSafeInteger(account.entry_count);
}

function minorToAmount(minor) {
    if (!Number.isSafeInteger(minor)) return null;
    const amount = minor / 100;
    return Number.isFinite(amount) ? amount : null;
}

function formatKes(amount) {
    return `KES ${amount.toLocaleString()}`;
}

export function deriveCockpitLedgerDisplay({ accounts, initialCash = 0, isFarmer = false } = {}) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return {
            liquid_cash: null,
            outstanding_credit: null,
            cash_text: isFarmer ? 'KES —' : RECONCILIATION_REQUIRED_TEXT,
            credit_text: RECONCILIATION_REQUIRED_TEXT
        };
    }
    const cash = accounts.find(account => account.code === '1000');
    const mpesa = accounts.find(account => account.code === '1010');
    const receivables = accounts.find(account => account.code === '1200');
    const ledgerEmpty = accounts.every(account => exactAccount(account) && account.entry_count === 0);
    const initial = typeof initialCash === 'number' && Number.isFinite(initialCash) ? initialCash : 0;

    let liquidCash = null;
    if (exactAccount(cash) && exactAccount(mpesa)) {
        const cashMinor = cash.balance_minor + mpesa.balance_minor;
        if (Number.isSafeInteger(cashMinor)) {
            const ledgerAmount = minorToAmount(cashMinor);
            liquidCash = ledgerAmount === null ? null : ledgerAmount + (ledgerEmpty ? initial : 0);
            if (!Number.isFinite(liquidCash)) liquidCash = null;
        }
    }
    const outstandingCredit = exactAccount(receivables)
        ? minorToAmount(receivables.balance_minor)
        : null;

    return {
        liquid_cash: liquidCash,
        outstanding_credit: outstandingCredit,
        cash_text: isFarmer ? 'KES —' : liquidCash === null ? RECONCILIATION_REQUIRED_TEXT : formatKes(liquidCash),
        credit_text: outstandingCredit === null ? RECONCILIATION_REQUIRED_TEXT : formatKes(outstandingCredit)
    };
}
