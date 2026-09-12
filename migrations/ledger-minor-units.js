/** Rerunnable exact-KES migration for legacy generic-ledger entries. */

const { parseKesAmount } = require('../services/kes-money');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function ensureColumn(db, column, definition) {
    const columns = await all(db, 'PRAGMA table_info(ledger_entries)');
    if (!columns.some(row => row.name === column)) {
        await run(db, `ALTER TABLE ledger_entries ADD COLUMN ${column} ${definition}`);
    }
}

function legacyMoneyDecision(amount) {
    try {
        // SQLite delivers REAL values as JS numbers. Reparse their shortest
        // decimal representation so 0.29 does not become a false binary
        // floating-point mismatch merely because 0.29 * 100 is 28.999... .
        const parsed = parseKesAmount(String(amount));
        return { amountMinor: parsed.amountMinor, reconciliationStatus: 'legacy_backfilled' };
    } catch {
        return { amountMinor: null, reconciliationStatus: 'reconciliation_required' };
    }
}

async function migrateLedgerMinorUnits(db) {
    await ensureColumn(db, 'amount_minor', 'INTEGER CHECK(amount_minor IS NULL OR amount_minor > 0)');
    await ensureColumn(db, 'reconciliation_status', "TEXT NOT NULL DEFAULT 'legacy_pending' CHECK(reconciliation_status IN ('legacy_pending', 'legacy_backfilled', 'reconciliation_required', 'exact'))");
    await run(db, 'DROP TRIGGER IF EXISTS ledger_entries_minor_integrity_insert');
    await run(db, 'DROP TRIGGER IF EXISTS ledger_entries_minor_integrity_update');
    await run(db, 'DROP TRIGGER IF EXISTS ledger_entries_minor_pending_insert');
    await run(db, `
        CREATE TRIGGER ledger_entries_minor_integrity_insert
        BEFORE INSERT ON ledger_entries
        WHEN (NEW.reconciliation_status IN ('exact', 'legacy_backfilled')
              AND (NEW.amount_minor IS NULL OR NEW.amount_minor <= 0
                   OR NEW.amount IS NULL OR NEW.amount <= 0
                   OR ABS(NEW.amount - (CAST(NEW.amount_minor AS REAL) / 100.0))
                        > (0.000000001 + ABS(NEW.amount) * 0.000000000000001)))
          OR (NEW.reconciliation_status = 'reconciliation_required' AND NEW.amount_minor IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'invalid ledger minor-unit reconciliation state'); END
    `);
    await run(db, `
        CREATE TRIGGER ledger_entries_minor_integrity_update
        BEFORE UPDATE OF amount, amount_minor, reconciliation_status ON ledger_entries
        WHEN (NEW.reconciliation_status IN ('exact', 'legacy_backfilled')
              AND (NEW.amount_minor IS NULL OR NEW.amount_minor <= 0
                   OR NEW.amount IS NULL OR NEW.amount <= 0
                   OR ABS(NEW.amount - (CAST(NEW.amount_minor AS REAL) / 100.0))
                        > (0.000000001 + ABS(NEW.amount) * 0.000000000000001)))
          OR (NEW.reconciliation_status = 'reconciliation_required' AND NEW.amount_minor IS NOT NULL)
          OR NEW.reconciliation_status = 'legacy_pending'
        BEGIN SELECT RAISE(ABORT, 'invalid ledger minor-unit reconciliation state'); END
    `);
    await run(db, `
        CREATE TRIGGER ledger_entries_minor_pending_insert
        BEFORE INSERT ON ledger_entries
        WHEN NEW.reconciliation_status = 'legacy_pending'
        BEGIN SELECT RAISE(ABORT, 'legacy_pending is migration-only'); END
    `);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_ledger_entries_reconciliation_status ON ledger_entries(reconciliation_status)');

    const pending = await all(db, `SELECT id, amount FROM ledger_entries
        WHERE reconciliation_status = 'legacy_pending'`);
    for (const row of pending) {
        const decision = legacyMoneyDecision(row.amount);
        await run(db, `UPDATE ledger_entries
            SET amount_minor = ?, reconciliation_status = ?
            WHERE id = ? AND reconciliation_status = 'legacy_pending'`,
        [decision.amountMinor, decision.reconciliationStatus, row.id]);
    }
}

module.exports = { legacyMoneyDecision, migrateLedgerMinorUnits };
