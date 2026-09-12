/** Integer-only reporting for generic ledger accounts. */

const { parseKesAmount } = require('./kes-money');

const EXACT_ENTRY_STATUSES = new Set(['exact', 'legacy_backfilled']);

function safeAdd(left, right) {
    const total = left + right;
    return Number.isSafeInteger(total) ? total : null;
}

function decimalFromMinor(minor) {
    if (!Number.isSafeInteger(minor)) return null;
    if (minor === 0) return 0;
    const sign = minor < 0 ? -1 : 1;
    try {
        const parsed = parseKesAmount(Math.abs(minor) / 100);
        return parsed.amountMinor === Math.abs(minor) ? sign * parsed.amount : null;
    } catch {
        return null;
    }
}

function signedBalance(type, debitMinor, creditMinor) {
    const balance = type === 'asset' || type === 'expense'
        ? debitMinor - creditMinor
        : creditMinor - debitMinor;
    return Number.isSafeInteger(balance) ? balance : null;
}

function reportAccount(metadata, entries) {
    let debitMinor = 0;
    let creditMinor = 0;
    let unresolvedEntryCount = 0;
    let overflowed = false;

    for (const entry of entries) {
        if (!EXACT_ENTRY_STATUSES.has(entry.reconciliation_status)
            || !Number.isSafeInteger(entry.amount_minor)
            || entry.amount_minor <= 0
            || !['debit', 'credit'].includes(entry.entry_type)) {
            unresolvedEntryCount += 1;
            continue;
        }
        if (entry.entry_type === 'debit') {
            debitMinor = safeAdd(debitMinor, entry.amount_minor);
            if (debitMinor === null) overflowed = true;
        } else {
            creditMinor = safeAdd(creditMinor, entry.amount_minor);
            if (creditMinor === null) overflowed = true;
        }
        if (overflowed) break;
    }

    const entryCount = entries.length;
    let balanceMinor = overflowed ? null : signedBalance(metadata.type, debitMinor, creditMinor);
    let status = unresolvedEntryCount > 0 || overflowed || balanceMinor === null
        ? 'reconciliation_required'
        : 'exact';

    const debit = status === 'exact' ? decimalFromMinor(debitMinor) : null;
    const credit = status === 'exact' ? decimalFromMinor(creditMinor) : null;
    const balance = status === 'exact' ? decimalFromMinor(balanceMinor) : null;
    if (status === 'exact' && (debit === null || credit === null || balance === null)) {
        status = 'reconciliation_required';
        balanceMinor = null;
    }

    return {
        ...metadata,
        status,
        entry_count: entryCount,
        unresolved_entry_count: unresolvedEntryCount,
        debit_minor: status === 'exact' ? debitMinor : null,
        credit_minor: status === 'exact' ? creditMinor : null,
        balance_minor: status === 'exact' ? balanceMinor : null,
        debit: status === 'exact' ? debit : null,
        credit: status === 'exact' ? credit : null,
        balance: status === 'exact' ? balance : null
    };
}

function resolveAdapter(adapter) {
    const resolved = adapter || require('../db');
    if (typeof resolved.allQuery !== 'function') throw new TypeError('ledger reporting requires a database reader');
    return resolved;
}

async function listLedgerAccounts(adapter) {
    const rows = await resolveAdapter(adapter).allQuery(`
        SELECT a.id, a.name, a.type, a.code,
               e.id AS entry_id, e.entry_type, e.amount_minor, e.reconciliation_status
        FROM ledger_accounts a
        LEFT JOIN ledger_entries e ON a.id = e.account_id
        ORDER BY a.code, e.id
    `);
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.id)) {
            grouped.set(row.id, {
                metadata: { id: row.id, name: row.name, type: row.type, code: row.code },
                entries: []
            });
        }
        if (row.entry_id !== null && row.entry_id !== undefined) {
            grouped.get(row.id).entries.push(row);
        }
    }
    return [...grouped.values()].map(({ metadata, entries }) => reportAccount(metadata, entries));
}

function createLedgerAccountsHandler(ledgerReporting) {
    return async (req, res) => {
        try {
            return res.json(await ledgerReporting.listLedgerAccounts());
        } catch {
            return res.status(500).json({ error: 'Ledger reports unavailable' });
        }
    };
}

module.exports = {
    createLedgerAccountsHandler,
    decimalFromMinor,
    listLedgerAccounts,
    reportAccount
};
