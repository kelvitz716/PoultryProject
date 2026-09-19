/**
 * Rerunnable schema migration for reviewed payment-import evidence.
 * Full raw SMS bodies and integration secrets are intentionally not represented.
 */

const crypto = require('crypto');
const { redactEvidence } = require('../services/payment-import-parser');
const { looksLikeRawPaymentMessage, normalizeReviewNote } = require('../services/payment-import-review');

const ALLOWED_SOURCES = new Set(['manual', 'webhook']);
const ALLOWED_STATUSES = new Set(['received', 'needs_review', 'approved', 'duplicate', 'rejected', 'reversed']);
const TERMINAL_STATUSES = new Set(['approved', 'duplicate', 'rejected', 'reversed']);
const ALLOWED_DIRECTIONS = new Set(['received', 'sent', 'paid', 'reversed', 'unknown']);
const ALLOWED_EVENT_KINDS = new Set(['customer_receipt', 'send_to_person', 'paybill_payment', 'buy_goods_payment', 'reversal', 'unknown']);
const ALLOWED_CONFLICT_FIELDS = new Set([
    'amount_minor', 'currency', 'direction', 'event_kind', 'transaction_at_ms',
    'counterparty_name', 'counterparty_phone_masked'
]);
const ALLOWED_PARSE_WARNINGS = new Set([
    'empty_message', 'missing_receipt_code', 'missing_amount', 'non_positive_amount',
    'ambiguous_direction', 'missing_direction', 'missing_counterparty',
    'invalid_transaction_time', 'legacy_schema_upgrade', 'legacy_id_reconciled',
    'dedupe_identity_reconciled', 'dedupe_identity_duplicate_group',
    'legacy_source_reconciled', 'legacy_status_reconciled',
    'legacy_direction_reconciled', 'legacy_event_kind_reconciled',
    'legacy_amount_reconciled', 'legacy_currency_reconciled',
    'legacy_parse_warnings_redacted', 'legacy_raw_fields_removed',
    'legacy_masked_field_cleared', 'legacy_receipt_code_cleared',
    'legacy_opaque_field_cleared', 'legacy_timestamp_reconciled',
    'legacy_parser_version_reconciled', 'legacy_fingerprint_reconciled',
    'legacy_evidence_redacted', 'legacy_retention_policy_reconciled',
    'legacy_conflict_metadata_reconciled', 'legacy_conflict_fields_reconciled',
    'legacy_text_field_cleared', 'legacy_name_field_cleared',
    'legacy_receipt_code_reconciled',
    'invalid_duplicate_link_cleared', 'invalid_reversal_link_cleared',
    'invalid_reviewer_link_cleared', 'invalid_batch_link_cleared',
    'invalid_transaction_link_cleared', 'invalid_customer_link_cleared',
    'invalid_event_link_cleared', 'duplicate_event_link_cleared'
]);
const UNKNOWN_LEGACY_TIMESTAMP = '1970-01-01 00:00:00';
const CANONICAL_COLUMNS = Object.freeze([
    'id', 'source', 'source_message_id', 'sender_masked', 'device_id', 'sim_slot',
    'sent_at_ms', 'received_at_ms', 'transaction_at_ms', 'status', 'parser_version',
    'message_fingerprint', 'dedupe_identity', 'receipt_code', 'direction', 'event_kind',
    'amount_minor', 'currency', 'counterparty_name', 'counterparty_phone_masked',
    'reference_masked', 'parse_warnings', 'redacted_evidence', 'raw_retention_policy',
    'has_conflict', 'conflict_count', 'conflict_fields', 'last_conflict_at',
    'duplicate_of_id', 'reversal_of_id', 'reviewer_user_id', 'reviewed_at', 'review_notes',
    'approved_at', 'rejected_at', 'reversed_at', 'buyer_name', 'batch_id',
    'created_transaction_id', 'customer_id', 'created_account_event_id', 'created_at', 'updated_at'
]);

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

async function tableExists(db, name) {
    const rows = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '" + name.replace(/'/g, "''") + "'");
    return rows.length > 0;
}

async function ensureColumn(db, table, name, definition) {
    const columns = await all(db, `PRAGMA table_info(${table})`);
    if (!columns.some(column => column.name === name)) {
        await run(db, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

async function createCanonicalTable(db, tableName, { customerReference, eventReference }) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new TypeError('invalid migration table name');
    const quotedTable = `"${tableName}"`;
    await run(db, `
        CREATE TABLE ${quotedTable} (
            id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) > 0),
            source TEXT NOT NULL CHECK(source IN ('manual', 'webhook')),
            source_message_id TEXT,
            sender_masked TEXT,
            device_id TEXT,
            sim_slot TEXT,
            sent_at_ms INTEGER CHECK(sent_at_ms IS NULL OR sent_at_ms >= 0),
            received_at_ms INTEGER CHECK(received_at_ms IS NULL OR received_at_ms >= 0),
            transaction_at_ms INTEGER CHECK(transaction_at_ms IS NULL OR transaction_at_ms >= 0),
            status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status IN ('received', 'needs_review', 'approved', 'duplicate', 'rejected', 'reversed')),
            parser_version TEXT NOT NULL CHECK(length(trim(parser_version)) > 0),
            message_fingerprint TEXT NOT NULL CHECK(length(trim(message_fingerprint)) > 0),
            dedupe_identity TEXT NOT NULL CHECK(length(trim(dedupe_identity)) > 0),
            receipt_code TEXT,
            direction TEXT NOT NULL CHECK(direction IN ('received', 'sent', 'paid', 'reversed', 'unknown')),
            event_kind TEXT NOT NULL CHECK(event_kind IN ('customer_receipt', 'send_to_person', 'paybill_payment', 'buy_goods_payment', 'reversal', 'unknown')),
            amount_minor INTEGER CHECK(amount_minor IS NULL OR amount_minor >= 0),
            currency TEXT CHECK(currency IS NULL OR currency = 'KES'),
            counterparty_name TEXT,
            counterparty_phone_masked TEXT,
            reference_masked TEXT,
            parse_warnings TEXT NOT NULL DEFAULT '[]',
            redacted_evidence TEXT NOT NULL CHECK(typeof(redacted_evidence) = 'text'),
            raw_retention_policy TEXT NOT NULL DEFAULT 'not_retained' CHECK(raw_retention_policy = 'not_retained'),
            has_conflict INTEGER NOT NULL DEFAULT 0 CHECK(has_conflict IN (0, 1)),
            conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0),
            conflict_fields TEXT NOT NULL DEFAULT '[]' CHECK(CASE WHEN json_valid(conflict_fields) THEN json_type(conflict_fields) = 'array' ELSE 0 END),
            last_conflict_at DATETIME,
            duplicate_of_id TEXT REFERENCES ${quotedTable}(id) ON DELETE SET NULL,
            reversal_of_id TEXT REFERENCES ${quotedTable}(id) ON DELETE SET NULL,
            reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at DATETIME,
            review_notes TEXT,
            approved_at DATETIME,
            rejected_at DATETIME,
            reversed_at DATETIME,
            buyer_name TEXT,
            batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
            created_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            customer_id TEXT${customerReference},
            created_account_event_id TEXT${eventReference},
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function canonicalRebuildRequired(db) {
    if (!await tableExists(db, 'payment_imports')) return false;
    const columns = await all(db, 'PRAGMA table_info(payment_imports)');
    const names = columns.map(column => column.name);
    if (names.length !== CANONICAL_COLUMNS.length || names.some(name => !CANONICAL_COLUMNS.includes(name))) return true;
    const schemaRows = await all(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_imports'");
    const schema = (schemaRows[0]?.sql || '').replace(/\s+/g, ' ');
    if (!/id\s+TEXT\s+PRIMARY\s+KEY\s+NOT\s+NULL\s+CHECK\s*\(length\s*\(trim\s*\(id\)\)\s*>\s*0\)/i.test(schema)) return true;
    if (!/dedupe_identity\s+TEXT\s+NOT NULL\s+CHECK\s*\(length\s*\(trim\s*\(dedupe_identity\)\)\s*>\s*0\)/i.test(schema)) return true;
    if (!/raw_retention_policy\s+TEXT\s+NOT NULL[^,]*CHECK\s*\(raw_retention_policy\s*=\s*'not_retained'\)/i.test(schema)) return true;
    for (const check of [
        /source\s+TEXT\s+NOT NULL\s+CHECK\s*\(source\s+IN/i,
        /status\s+TEXT\s+NOT NULL[^,]*CHECK\s*\(status\s+IN/i,
        /parser_version\s+TEXT\s+NOT NULL\s+CHECK\s*\(length\s*\(trim\s*\(parser_version\)\)\s*>\s*0\)/i,
        /message_fingerprint\s+TEXT\s+NOT NULL\s+CHECK\s*\(length\s*\(trim\s*\(message_fingerprint\)\)\s*>\s*0\)/i,
        /sent_at_ms\s+INTEGER\s+CHECK\s*\(sent_at_ms\s+IS\s+NULL\s+OR\s+sent_at_ms\s*>=\s*0\)/i,
        /received_at_ms\s+INTEGER\s+CHECK\s*\(received_at_ms\s+IS\s+NULL\s+OR\s+received_at_ms\s*>=\s*0\)/i,
        /transaction_at_ms\s+INTEGER\s+CHECK\s*\(transaction_at_ms\s+IS\s+NULL\s+OR\s+transaction_at_ms\s*>=\s*0\)/i,
        /direction\s+TEXT\s+NOT NULL\s+CHECK\s*\(direction\s+IN/i,
        /event_kind\s+TEXT\s+NOT NULL\s+CHECK\s*\(event_kind\s+IN/i,
        /amount_minor\s+INTEGER\s+CHECK\s*\(amount_minor\s+IS\s+NULL\s+OR\s+amount_minor\s*>=\s*0\)/i,
        /currency\s+TEXT\s+CHECK\s*\(currency\s+IS\s+NULL\s+OR\s+currency\s*=\s*'KES'\)/i,
        /redacted_evidence\s+TEXT\s+NOT NULL\s+CHECK\s*\(typeof\s*\(redacted_evidence\)\s*=\s*'text'\)/i,
        /has_conflict\s+INTEGER\s+NOT NULL[^,]*CHECK\s*\(has_conflict\s+IN/i,
        /conflict_count\s+INTEGER\s+NOT NULL[^,]*CHECK\s*\(conflict_count\s*>=\s*0\)/i,
        /conflict_fields\s+TEXT\s+NOT NULL[^,]*CHECK/i,
        /created_at\s+DATETIME\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i,
        /updated_at\s+DATETIME\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i
    ]) {
        if (!check.test(schema)) return true;
    }
    const foreignKeys = await all(db, 'PRAGMA foreign_key_list(payment_imports)');
    const hasForeignKey = (from, table, onDelete) => foreignKeys.some(key => key.from === from
        && key.table === table && key.to === 'id' && key.on_delete === onDelete);
    for (const [from, table, onDelete] of [
        ['duplicate_of_id', 'payment_imports', 'SET NULL'], ['reversal_of_id', 'payment_imports', 'SET NULL'],
        ['reviewer_user_id', 'users', 'SET NULL'], ['batch_id', 'batches', 'SET NULL'],
        ['created_transaction_id', 'transactions', 'SET NULL']
    ]) {
        if (!hasForeignKey(from, table, onDelete)) return true;
    }
    if (await tableExists(db, 'customers') && !hasForeignKey('customer_id', 'customers', 'RESTRICT')) return true;
    if (await tableExists(db, 'customer_account_events') && !hasForeignKey('created_account_event_id', 'customer_account_events', 'RESTRICT')) return true;
    const indexes = await all(db, 'PRAGMA index_list(payment_imports)');
    if (!indexes.some(index => index.name === 'idx_payment_imports_dedupe_identity_unique' && index.unique === 1)) return true;
    if (!indexes.some(index => index.name === 'idx_payment_imports_created_account_event' && index.unique === 1)) return true;
    return false;
}

function nonblank(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

function safeJsonStringArray(value, allowedValues) {
    let parsed = value;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (_) { return []; }
    }
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) return [];
    return allowedValues ? parsed.filter(item => allowedValues.has(item)) : parsed;
}

function canonicalWarnings(value, additions) {
    const parsed = safeJsonStringArray(value);
    const retained = parsed.filter(warning => ALLOWED_PARSE_WARNINGS.has(warning));
    const malformed = retained.length !== parsed.length
        || typeof value !== 'string'
        || (parsed.length === 0 && value !== '[]');
    if (malformed) {
        additions.push('legacy_parse_warnings_redacted');
    }
    if (!malformed && additions.length === 0) return value;
    return JSON.stringify([...new Set([...retained, ...additions])]);
}

function deterministicToken(...parts) {
    return crypto.createHash('sha256').update(parts.map(value => String(value ?? '')).join('\u001f')).digest('hex');
}

function approvalIds(importId) {
    const digest = crypto.createHash('sha256').update(`payment-import-approval:${importId}`).digest('hex');
    return {
        eventId: `payment:${digest.slice(0, 40)}`,
        eventKey: `payment:${digest.slice(0, 48)}`,
        ledgerId: `ledger-payment:${digest.slice(0, 36)}`
    };
}

function exactAmount(amount, amountMinor) {
    return typeof amount === 'number'
        && Number.isFinite(amount)
        && Math.abs(amount - amountMinor / 100) <= 0.000000001;
}

function safeIntegerOrNull(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeText(value) {
    return typeof value === 'string' ? value : null;
}

function safeOpaque(value, maxLength = 128) {
    const text = nonblank(value);
    return text && text.length <= maxLength && /^[A-Za-z0-9._:@-]+$/.test(text) ? text : null;
}

function safeSimSlot(value) {
    const text = nonblank(value);
    if (!text || text.length > 32) return null;
    return /^SIM \d{1,4}$/i.test(text) || /^[A-Za-z0-9._:@-]+$/.test(text) ? text : null;
}

function safeMasked(value) {
    const text = nonblank(value);
    if (!text) return null;
    if (text === 'M-PESA' || /^••••[A-Za-z0-9]{0,4}$/.test(text)) return text;
    return null;
}

function safeFingerprint(value) {
    const text = nonblank(value);
    return text && (/^[a-f0-9]{64}$/i.test(text) || /^legacy:[a-f0-9]{48}$/i.test(text)) ? text : null;
}

function safeDedupeIdentity(value) {
    const text = nonblank(value)?.trim() || null;
    return text && (/^(?:receipt|reversal):[A-Za-z0-9]{1,64}$/.test(text)
        || /^fingerprint:[a-f0-9]{64}$/i.test(text)
        || /^legacy-review:[a-f0-9]{48}$/i.test(text)) ? text : null;
}

function safeName(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 120 || /[\u0000-\u001F\u007F]/.test(normalized)
        || looksLikeRawPaymentMessage(normalized)
        || /\b(?:\+?254|0)[17](?:[\s-]?\d){8}\b/.test(normalized)) return null;
    return normalized;
}

function safeReviewNote(value) {
    try {
        return normalizeReviewNote(value);
    } catch (_) {
        return null;
    }
}

async function scrubCanonicalPlaintextFields(db) {
    // A canonical table can still contain values written outside the application
    // boundary. Re-run the same privacy rules used during a rebuild so these
    // human-readable fields cannot become an alternate raw-SMS retention path.
    const rows = await all(db, `SELECT rowid, counterparty_name, buyer_name, review_notes
        FROM payment_imports`);
    for (const row of rows) {
        const counterpartyName = safeName(row.counterparty_name);
        const buyerName = safeName(row.buyer_name);
        const reviewNote = safeReviewNote(row.review_notes);
        if (counterpartyName === row.counterparty_name
            && buyerName === row.buyer_name
            && reviewNote === row.review_notes) continue;
        await run(db, `UPDATE payment_imports
            SET counterparty_name = ?, buyer_name = ?, review_notes = ?
            WHERE rowid = ?`, [counterpartyName, buyerName, reviewNote, row.rowid]);
    }
}

function safeDateText(value) {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
        ? value
        : null;
}

async function existingIdSet(db, table) {
    if (!await tableExists(db, table)) return new Set();
    return new Set((await all(db, `SELECT id FROM ${table}`)).map(row => row.id));
}

async function tableColumnSet(db, table) {
    if (!await tableExists(db, table)) return new Set();
    return new Set((await all(db, `PRAGMA table_info(${table})`)).map(column => column.name));
}

function addEvidence(map, importId, value) {
    const id = nonblank(importId);
    if (!id) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(value);
}

async function loadReverseAccountingEvidence(db) {
    const eventColumns = await tableColumnSet(db, 'customer_account_events');
    const ledgerColumns = await tableColumnSet(db, 'ledger_transactions');
    const ledgerEntryColumns = await tableColumnSet(db, 'ledger_entries');
    const eventsById = new Map();
    const eventRowsByImport = new Map();
    const ledgerRowsByEvent = new Map();
    const ledgerRowsByImport = new Map();
    const ledgerEntriesByTransaction = new Map();

    // Forward event provenance must be inspectable even when the legacy event
    // table has no payment_import_id column.
    if (eventColumns.has('id')) {
        const selected = [
            'id', 'customer_id', 'currency', 'side', 'kind', 'status', 'amount_minor', 'method',
            'external_reference', 'payment_import_id', 'idempotency_key', 'created_by_user_id',
            'reviewer_user_id'
        ]
            .filter(column => eventColumns.has(column));
        for (const event of await all(db, `SELECT ${selected.join(', ')} FROM customer_account_events`)) {
            eventsById.set(event.id, event);
            if (eventColumns.has('payment_import_id')) addEvidence(eventRowsByImport, event.payment_import_id, event);
        }
    }

    if ((ledgerColumns.has('ref_type') && ledgerColumns.has('ref_id'))
        || ledgerColumns.has('customer_account_event_id')) {
        const selected = ['id', 'ref_type', 'ref_id', 'customer_account_event_id']
            .filter(column => ledgerColumns.has(column));
        for (const ledger of await all(db, `SELECT ${selected.join(', ')} FROM ledger_transactions`)) {
            if (ledgerColumns.has('ref_type') && ledgerColumns.has('ref_id')
                && ledger.ref_type === 'payment_import_approval') {
                addEvidence(ledgerRowsByImport, ledger.ref_id, ledger);
            }
            if (ledgerColumns.has('customer_account_event_id')) {
                addEvidence(ledgerRowsByEvent, ledger.customer_account_event_id, ledger);
                const event = eventsById.get(ledger.customer_account_event_id);
                if (event && eventColumns.has('payment_import_id')) {
                    addEvidence(ledgerRowsByImport, event.payment_import_id, ledger);
                }
            }
        }
    }

    if (ledgerEntryColumns.has('transaction_id')) {
        const selected = [
            'transaction_id', 'account_id', 'entry_type', 'amount', 'amount_minor', 'reconciliation_status'
        ].filter(column => ledgerEntryColumns.has(column));
        for (const entry of await all(db, `SELECT ${selected.join(', ')} FROM ledger_entries`)) {
            addEvidence(ledgerEntriesByTransaction, entry.transaction_id, entry);
        }
    }

    return {
        eventColumns,
        ledgerColumns,
        ledgerEntryColumns,
        eventsById,
        eventRowsByImport,
        ledgerRowsByEvent,
        ledgerRowsByImport,
        ledgerEntriesByTransaction
    };
}

function assertAccountingInvariant(row, statusById, accounting, reverseLookupId = row.id) {
    const reverseEvents = accounting.eventRowsByImport.get(reverseLookupId) || [];
    const reverseLedgerRows = accounting.ledgerRowsByImport.get(reverseLookupId) || [];
    const hasForwardAccounting = Boolean(row.customer_id || row.created_account_event_id || row.created_transaction_id);
    const hasReverseAccounting = reverseEvents.length > 0 || reverseLedgerRows.length > 0;

    if (row.status === 'approved') {
        const requiredEventColumns = [
            'id', 'customer_id', 'currency', 'side', 'kind', 'status', 'amount_minor', 'method',
            'external_reference', 'payment_import_id', 'idempotency_key', 'created_by_user_id',
            'reviewer_user_id'
        ];
        const requiredLedgerColumns = ['id', 'ref_type', 'ref_id', 'customer_account_event_id'];
        const requiredEntryColumns = [
            'transaction_id', 'account_id', 'entry_type', 'amount', 'amount_minor', 'reconciliation_status'
        ];
        if (!requiredEventColumns.every(column => accounting.eventColumns.has(column))
            || !requiredLedgerColumns.every(column => accounting.ledgerColumns.has(column))
            || !requiredEntryColumns.every(column => accounting.ledgerEntryColumns.has(column))
            || !row.customer_id || !row.created_account_event_id || !row.reviewer_user_id
            || typeof row.receipt_code !== 'string'
            || !/^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8,14}$/.test(row.receipt_code)) {
            throw new Error('payment-import migration cannot prove approved accounting provenance');
        }
        const ids = approvalIds(row.id);
        const event = accounting.eventsById.get(row.created_account_event_id);
        if (!event
            || event.id !== ids.eventId
            || event.customer_id !== row.customer_id
            || event.currency !== 'KES'
            || event.side !== 'credit'
            || event.kind !== 'payment'
            || event.status !== 'posted'
            || event.method !== 'mpesa'
            || event.amount_minor !== row.amount_minor
            || event.external_reference !== row.receipt_code
            || event.payment_import_id !== row.id
            || event.idempotency_key !== ids.eventKey
            || event.created_by_user_id !== row.reviewer_user_id
            || event.reviewer_user_id !== row.reviewer_user_id
            || reverseEvents.length !== 1
            || reverseEvents[0].id !== event.id) {
            throw new Error('payment-import migration cannot prove approved accounting provenance');
        }
        const headers = accounting.ledgerRowsByEvent.get(event.id) || [];
        const uniqueReverseLedgerIds = new Set(reverseLedgerRows.map(ledger => ledger.id));
        const header = headers.length === 1 ? headers[0] : null;
        if (!header
            || header.id !== ids.ledgerId
            || header.ref_type !== 'payment_import_approval'
            || header.ref_id !== row.id
            || header.customer_account_event_id !== event.id
            || uniqueReverseLedgerIds.size !== 1
            || !uniqueReverseLedgerIds.has(header.id)) {
            throw new Error('payment-import migration cannot prove approved accounting provenance');
        }
        const entries = accounting.ledgerEntriesByTransaction.get(header.id) || [];
        const expectedEntries = new Set(['1010:debit', '1200:credit']);
        if (entries.length !== 2 || entries.some(entry =>
            !expectedEntries.delete(`${entry.account_id}:${entry.entry_type}`)
            || entry.amount_minor !== row.amount_minor
            || entry.reconciliation_status !== 'exact'
            || !exactAmount(entry.amount, row.amount_minor))) {
            throw new Error('payment-import migration cannot prove approved accounting provenance');
        }
    } else if (hasForwardAccounting || hasReverseAccounting) {
        throw new Error('payment-import migration found accounting on a non-approved state');
    }

    if (row.status === 'reversed'
        && (!row.reversal_of_id
            || row.reversal_of_id === row.id
            || statusById.get(row.reversal_of_id) !== 'approved')) {
        throw new Error('payment-import migration found incoherent reversal provenance');
    }
}

async function validateCanonicalAccountingState(db) {
    if (!await tableExists(db, 'payment_imports')) return;
    const rows = await all(db, `SELECT id, status, receipt_code, amount_minor, reviewer_user_id,
        customer_id, created_account_event_id, created_transaction_id, reversal_of_id
        FROM payment_imports ORDER BY rowid`);
    const statusById = new Map(rows.map(row => [row.id, row.status]));
    const accounting = await loadReverseAccountingEvidence(db);
    for (const row of rows) assertAccountingInvariant(row, statusById, accounting);
}

function retainReference(value, ids, warning, warnings) {
    const id = nonblank(value);
    if (!id) return null;
    if (ids.has(id)) return id;
    warnings.push(warning);
    return null;
}

async function prepareCanonicalRows(db, legacyRows, legacyColumnNames, { forceReview }) {
    const referenceSets = {
        reviewer_user_id: await existingIdSet(db, 'users'),
        batch_id: await existingIdSet(db, 'batches'),
        created_transaction_id: await existingIdSet(db, 'transactions'),
        customer_id: await existingIdSet(db, 'customers'),
        created_account_event_id: await existingIdSet(db, 'customer_account_events')
    };
    const reverseAccounting = await loadReverseAccountingEvidence(db);
    const rawColumnsWerePresent = legacyColumnNames.some(name => /raw.*(?:sms|body)|(?:sms|body).*raw/i.test(name));
    const assignedIds = new Set();
    const originalIdCounts = new Map();
    const originalIdMap = new Map();
    const prepared = legacyRows.map(row => {
        const warnings = forceReview ? ['legacy_schema_upgrade'] : [];
        if (rawColumnsWerePresent) warnings.push('legacy_raw_fields_removed');
        const originalId = safeOpaque(row.id);
        if (nonblank(row.id) && !originalId) warnings.push('legacy_id_reconciled');
        if (originalId) originalIdCounts.set(originalId, (originalIdCounts.get(originalId) || 0) + 1);
        let id = originalId;
        if (!id || assignedIds.has(id)) {
            id = `legacy-import:${deterministicToken(row.__migration_rowid, originalId, row.message_fingerprint, row.redacted_evidence).slice(0, 32)}`;
            let collision = 0;
            while (assignedIds.has(id)) {
                collision += 1;
                id = `legacy-import:${deterministicToken(row.__migration_rowid, originalId, collision).slice(0, 32)}`;
            }
            warnings.push('legacy_id_reconciled');
        }
        assignedIds.add(id);
        if (originalId && !originalIdMap.has(originalId)) originalIdMap.set(originalId, id);
        return { row, id, originalId, warnings };
    });

    const dedupeCounts = new Map();
    for (const item of prepared) {
        const identity = safeDedupeIdentity(item.row.dedupe_identity);
        if (identity) dedupeCounts.set(identity, (dedupeCounts.get(identity) || 0) + 1);
    }
    const dedupeWinners = new Map();
    const assignedDedupe = new Set();
    const assignedEventLinks = new Set();
    const originalStatusById = new Map(prepared.map(item => [
        item.id,
        ALLOWED_STATUSES.has(item.row.status) ? item.row.status : 'needs_review'
    ]));

    return prepared.map(item => {
        const { row, id, warnings } = item;
        const originalIdentity = safeDedupeIdentity(row.dedupe_identity);
        if (nonblank(row.dedupe_identity) && !originalIdentity) warnings.push('dedupe_identity_reconciled');
        const duplicateGroup = originalIdentity && dedupeCounts.get(originalIdentity) > 1;
        let dedupeIdentity = originalIdentity;
        let duplicateOfId = null;
        if (!dedupeIdentity || assignedDedupe.has(dedupeIdentity)) {
            dedupeIdentity = `legacy-review:${deterministicToken(originalIdentity, id, row.__migration_rowid).slice(0, 48)}`;
            let collision = 0;
            while (assignedDedupe.has(dedupeIdentity)) {
                collision += 1;
                dedupeIdentity = `legacy-review:${deterministicToken(originalIdentity, id, collision).slice(0, 48)}`;
            }
            warnings.push('dedupe_identity_reconciled');
            if (originalIdentity && dedupeWinners.has(originalIdentity)) duplicateOfId = dedupeWinners.get(originalIdentity);
        } else if (duplicateGroup) {
            warnings.push('dedupe_identity_duplicate_group');
            dedupeWinners.set(originalIdentity, id);
        }
        assignedDedupe.add(dedupeIdentity);

        const source = ALLOWED_SOURCES.has(row.source) ? row.source : 'manual';
        const direction = ALLOWED_DIRECTIONS.has(row.direction) ? row.direction : 'unknown';
        const eventKind = ALLOWED_EVENT_KINDS.has(row.event_kind) ? row.event_kind : 'unknown';
        if (source !== row.source) warnings.push('legacy_source_reconciled');
        if (!ALLOWED_STATUSES.has(row.status)) warnings.push('legacy_status_reconciled');
        if (direction !== row.direction) warnings.push('legacy_direction_reconciled');
        if (eventKind !== row.event_kind) warnings.push('legacy_event_kind_reconciled');

        const amountMinor = safeIntegerOrNull(row.amount_minor);
        if (row.amount_minor !== undefined && row.amount_minor !== null && amountMinor === null) warnings.push('legacy_amount_reconciled');
        const currency = row.currency === 'KES' ? 'KES' : null;
        if (row.currency !== undefined && row.currency !== null && row.currency !== 'KES') warnings.push('legacy_currency_reconciled');
        const legacyEvidence = safeText(row.redacted_evidence) || '[Legacy payment evidence unavailable]';
        const redacted = redactEvidence(legacyEvidence);
        if (redacted !== legacyEvidence) warnings.push('legacy_evidence_redacted');
        const parserVersion = safeOpaque(row.parser_version, 64);
        if (!parserVersion) warnings.push('legacy_parser_version_reconciled');
        const existingFingerprint = safeFingerprint(row.message_fingerprint);
        if (!existingFingerprint) warnings.push('legacy_fingerprint_reconciled');
        const messageFingerprint = existingFingerprint || `legacy:${deterministicToken(id, redacted).slice(0, 48)}`;

        if (!duplicateOfId) {
            const requested = nonblank(row.duplicate_of_id);
            if (requested && originalIdCounts.get(requested) === 1) duplicateOfId = originalIdMap.get(requested);
            else if (requested) warnings.push('invalid_duplicate_link_cleared');
        }
        let reversalOfId = null;
        const requestedReversal = nonblank(row.reversal_of_id);
        if (requestedReversal && originalIdCounts.get(requestedReversal) === 1) reversalOfId = originalIdMap.get(requestedReversal);
        else if (requestedReversal) warnings.push('invalid_reversal_link_cleared');

        const senderMasked = safeMasked(row.sender_masked);
        const phoneMasked = safeMasked(row.counterparty_phone_masked);
        const referenceMasked = safeMasked(row.reference_masked);
        if ((nonblank(row.sender_masked) && !senderMasked)
            || (nonblank(row.counterparty_phone_masked) && !phoneMasked)
            || (nonblank(row.reference_masked) && !referenceMasked)) warnings.push('legacy_masked_field_cleared');
        const receiptCode = nonblank(row.receipt_code);
        const safeReceiptCode = receiptCode && /^[A-Za-z0-9]{8,14}$/.test(receiptCode) ? receiptCode.toUpperCase() : null;
        if (receiptCode && !safeReceiptCode) warnings.push('legacy_receipt_code_cleared');
        else if (receiptCode && safeReceiptCode !== receiptCode) warnings.push('legacy_receipt_code_reconciled');

        const sourceMessageId = safeOpaque(row.source_message_id);
        const deviceId = safeOpaque(row.device_id);
        const simSlot = safeSimSlot(row.sim_slot);
        if ((nonblank(row.source_message_id) && !sourceMessageId)
            || (nonblank(row.device_id) && !deviceId)
            || (nonblank(row.sim_slot) && !simSlot)) warnings.push('legacy_opaque_field_cleared');
        const sentAtMs = safeIntegerOrNull(row.sent_at_ms);
        const receivedAtMs = safeIntegerOrNull(row.received_at_ms);
        const transactionAtMs = safeIntegerOrNull(row.transaction_at_ms);
        if ((row.sent_at_ms !== undefined && row.sent_at_ms !== null && sentAtMs === null)
            || (row.received_at_ms !== undefined && row.received_at_ms !== null && receivedAtMs === null)
            || (row.transaction_at_ms !== undefined && row.transaction_at_ms !== null && transactionAtMs === null)) {
            warnings.push('legacy_timestamp_reconciled');
        }

        const reviewerUserId = retainReference(row.reviewer_user_id, referenceSets.reviewer_user_id, 'invalid_reviewer_link_cleared', warnings);
        const batchId = retainReference(row.batch_id, referenceSets.batch_id, 'invalid_batch_link_cleared', warnings);
        const transactionId = retainReference(row.created_transaction_id, referenceSets.created_transaction_id, 'invalid_transaction_link_cleared', warnings);
        const customerId = retainReference(row.customer_id, referenceSets.customer_id, 'invalid_customer_link_cleared', warnings);
        let eventId = retainReference(row.created_account_event_id, referenceSets.created_account_event_id, 'invalid_event_link_cleared', warnings);
        if (eventId && assignedEventLinks.has(eventId)) {
            eventId = null;
            warnings.push('duplicate_event_link_cleared');
        }
        if (eventId) assignedEventLinks.add(eventId);

        const counterpartyName = safeName(row.counterparty_name);
        const buyerName = safeName(row.buyer_name);
        if ((nonblank(row.counterparty_name) && counterpartyName !== row.counterparty_name)
            || (nonblank(row.buyer_name) && buyerName !== row.buyer_name)) warnings.push('legacy_name_field_cleared');
        const reviewNote = safeReviewNote(row.review_notes);
        if (nonblank(row.review_notes) && reviewNote !== row.review_notes) warnings.push('legacy_text_field_cleared');

        let parsedConflictFields;
        try { parsedConflictFields = JSON.parse(row.conflict_fields); } catch (_) { parsedConflictFields = null; }
        const conflictFieldsValid = Array.isArray(parsedConflictFields)
            && parsedConflictFields.every(field => typeof field === 'string' && ALLOWED_CONFLICT_FIELDS.has(field));
        const conflictFields = conflictFieldsValid ? row.conflict_fields : '[]';
        if (!conflictFieldsValid) warnings.push('legacy_conflict_fields_reconciled');
        const hasConflict = row.has_conflict === 0 || row.has_conflict === 1 ? row.has_conflict : 0;
        const conflictCount = safeIntegerOrNull(row.conflict_count);
        if (hasConflict !== row.has_conflict || conflictCount === null) warnings.push('legacy_conflict_metadata_reconciled');
        if (row.raw_retention_policy !== 'not_retained') warnings.push('legacy_retention_policy_reconciled');
        const createdAt = safeDateText(row.created_at);
        const updatedAt = safeDateText(row.updated_at);
        if (!createdAt || !updatedAt) warnings.push('legacy_timestamp_reconciled');
        const lastConflictAt = row.last_conflict_at == null ? null : safeDateText(row.last_conflict_at);
        const reviewedAt = row.reviewed_at == null ? null : safeDateText(row.reviewed_at);
        const approvedAt = row.approved_at == null ? null : safeDateText(row.approved_at);
        const rejectedAt = row.rejected_at == null ? null : safeDateText(row.rejected_at);
        const reversedAt = row.reversed_at == null ? null : safeDateText(row.reversed_at);
        if ((row.last_conflict_at != null && !lastConflictAt)
            || (row.reviewed_at != null && !reviewedAt)
            || (row.approved_at != null && !approvedAt)
            || (row.rejected_at != null && !rejectedAt)
            || (row.reversed_at != null && !reversedAt)) warnings.push('legacy_timestamp_reconciled');
        const parseWarnings = canonicalWarnings(row.parse_warnings, warnings);
        const originalStatus = ALLOWED_STATUSES.has(row.status) ? row.status : 'needs_review';
        const hasReverseAccounting = item.originalId && (
            (reverseAccounting.eventRowsByImport.get(item.originalId) || []).length > 0
            || (reverseAccounting.ledgerRowsByImport.get(item.originalId) || []).length > 0
        );
        if (hasReverseAccounting && (item.originalId !== id || originalIdCounts.get(item.originalId) !== 1)) {
            throw new Error('payment-import migration found ambiguous reverse accounting provenance');
        }
        // Privacy/schema repair never reopens a terminal workflow. Accounting
        // belongs only to an approved row whose complete provenance was proven.
        const status = TERMINAL_STATUSES.has(originalStatus)
            ? originalStatus
            : (forceReview || warnings.length > 0 ? 'needs_review' : originalStatus);
        const canonicalRow = {
            id,
            source,
            source_message_id: sourceMessageId,
            sender_masked: senderMasked,
            device_id: deviceId,
            sim_slot: simSlot,
            sent_at_ms: sentAtMs,
            received_at_ms: receivedAtMs,
            transaction_at_ms: transactionAtMs,
            status,
            parser_version: parserVersion || 'legacy-schema-v1',
            message_fingerprint: messageFingerprint,
            dedupe_identity: dedupeIdentity,
            receipt_code: safeReceiptCode,
            direction,
            event_kind: eventKind,
            amount_minor: amountMinor,
            currency,
            counterparty_name: counterpartyName,
            counterparty_phone_masked: phoneMasked,
            reference_masked: referenceMasked,
            parse_warnings: parseWarnings,
            redacted_evidence: redacted,
            raw_retention_policy: 'not_retained',
            has_conflict: hasConflict,
            conflict_count: conflictCount ?? 0,
            conflict_fields: conflictFields,
            last_conflict_at: lastConflictAt,
            duplicate_of_id: duplicateOfId,
            reversal_of_id: reversalOfId,
            reviewer_user_id: reviewerUserId,
            reviewed_at: reviewedAt,
            review_notes: reviewNote,
            approved_at: approvedAt,
            rejected_at: rejectedAt,
            reversed_at: reversedAt,
            buyer_name: buyerName,
            batch_id: batchId,
            created_transaction_id: transactionId,
            customer_id: customerId,
            created_account_event_id: eventId,
            created_at: createdAt || UNKNOWN_LEGACY_TIMESTAMP,
            updated_at: updatedAt || createdAt || UNKNOWN_LEGACY_TIMESTAMP
        };
        assertAccountingInvariant(canonicalRow, originalStatusById, reverseAccounting, item.originalId || id);
        return canonicalRow;
    });
}

async function rebuildCanonicalTable(db, context) {
    const columns = await all(db, 'PRAGMA table_info(payment_imports)');
    const legacyRows = await all(db, 'SELECT rowid AS __migration_rowid, * FROM payment_imports ORDER BY rowid');
    const legacyColumnNames = columns.map(column => column.name);
    // An exact pre-19C column set is a constraint-strengthening upgrade: valid
    // rows retain their workflow state and provenance. Incomplete/extra-column
    // schemas force every row to review; in a full schema only a row that emits
    // a material sanitizer/reconciliation warning is moved to needs_review.
    const fullPre19CShape = legacyColumnNames.length === CANONICAL_COLUMNS.length
        && legacyColumnNames.every(name => CANONICAL_COLUMNS.includes(name));
    const canonicalRows = await prepareCanonicalRows(db, legacyRows, legacyColumnNames, {
        forceReview: !fullPre19CShape
    });
    const replacement = 'payment_imports__canonical_migration';
    await run(db, `DROP TABLE IF EXISTS ${replacement}`);
    await createCanonicalTable(db, replacement, context);
    const placeholders = CANONICAL_COLUMNS.map(() => '?').join(', ');
    for (const row of canonicalRows) {
        await run(db, `INSERT INTO ${replacement} (${CANONICAL_COLUMNS.join(', ')}) VALUES (${placeholders})`,
            CANONICAL_COLUMNS.map(column => row[column]));
    }
    // Triggers owned by other tables are not removed with payment_imports and
    // SQLite validates their bodies while the replacement is renamed. They are
    // recreated below after the canonical table has its final name.
    for (const trigger of [
        'customers_payment_import_link_restrict_delete',
        'customer_events_payment_import_link_restrict_delete'
    ]) {
        await run(db, `DROP TRIGGER IF EXISTS ${trigger}`);
    }
    await run(db, 'DROP TABLE payment_imports');
    await run(db, `ALTER TABLE ${replacement} RENAME TO payment_imports`);
}

async function migratePaymentImportsWithinSavepoint(db, options) {
    const existedBeforeMigration = await tableExists(db, 'payment_imports');
    const hasCustomers = await tableExists(db, 'customers');
    const hasCustomerEvents = await tableExists(db, 'customer_account_events');
    const customerReference = hasCustomers ? ' REFERENCES customers(id) ON DELETE RESTRICT' : '';
    const eventReference = hasCustomerEvents ? ' REFERENCES customer_account_events(id) ON DELETE RESTRICT' : '';
    const context = { customerReference, eventReference };
    if (!existedBeforeMigration) {
        await createCanonicalTable(db, 'payment_imports', context);
    } else if (await canonicalRebuildRequired(db)) {
        await rebuildCanonicalTable(db, context);
    }
    if (typeof options.afterReconciliation === 'function') {
        await options.afterReconciliation(db);
    }
    await scrubCanonicalPlaintextFields(db);
    for (const trigger of [
        'payment_imports_conflict_fields_json_insert', 'payment_imports_conflict_fields_json_update',
        'payment_imports_dedupe_identity_nonempty_insert', 'payment_imports_dedupe_identity_nonempty_update',
        'payment_imports_safe_shape_insert', 'payment_imports_safe_shape_update',
        'payment_imports_upgrade_timestamps_after_insert',
        'payment_imports_customer_link_insert', 'payment_imports_customer_link_update',
        'payment_imports_event_link_insert', 'payment_imports_event_link_update',
        'customers_payment_import_link_restrict_delete', 'customer_events_payment_import_link_restrict_delete',
        'ledger_transactions_event_link_insert', 'ledger_transactions_event_link_update',
        'customer_events_ledger_link_restrict_delete'
    ]) {
        await run(db, `DROP TRIGGER IF EXISTS ${trigger}`);
    }
    for (const index of [
        'idx_payment_imports_status_created', 'idx_payment_imports_fingerprint',
        'idx_payment_imports_receipt_code', 'idx_payment_imports_id_unique',
        'idx_payment_imports_dedupe_identity', 'idx_payment_imports_dedupe_identity_unique',
        'idx_payment_imports_duplicate_of', 'idx_payment_imports_reversal_of',
        'idx_payment_imports_customer', 'idx_payment_imports_created_account_event',
        'idx_ledger_transactions_customer_account_event'
    ]) {
        await run(db, `DROP INDEX IF EXISTS ${index}`);
    }
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_conflict_fields_json_insert
        BEFORE INSERT ON payment_imports
        WHEN json_valid(NEW.conflict_fields) = 0 OR json_type(NEW.conflict_fields) <> 'array'
        BEGIN
            SELECT RAISE(ABORT, 'conflict_fields must be a JSON array');
        END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_conflict_fields_json_update
        BEFORE UPDATE OF conflict_fields ON payment_imports
        WHEN json_valid(NEW.conflict_fields) = 0 OR json_type(NEW.conflict_fields) <> 'array'
        BEGIN
            SELECT RAISE(ABORT, 'conflict_fields must be a JSON array');
        END
    `);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_status_created ON payment_imports(status, created_at DESC)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_fingerprint ON payment_imports(message_fingerprint)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_receipt_code ON payment_imports(receipt_code) WHERE receipt_code IS NOT NULL');
    await run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_imports_id_unique ON payment_imports(id)');
    await run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_imports_dedupe_identity_unique ON payment_imports(dedupe_identity)');
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_dedupe_identity_nonempty_insert
        BEFORE INSERT ON payment_imports
        WHEN NEW.dedupe_identity IS NULL OR length(trim(NEW.dedupe_identity)) = 0
        BEGIN
            SELECT RAISE(ABORT, 'dedupe_identity must be non-empty');
        END
    `);
    await run(db, `
        CREATE TRIGGER IF NOT EXISTS payment_imports_dedupe_identity_nonempty_update
        BEFORE UPDATE OF dedupe_identity ON payment_imports
        WHEN NEW.dedupe_identity IS NULL OR length(trim(NEW.dedupe_identity)) = 0
        BEGIN
            SELECT RAISE(ABORT, 'dedupe_identity must be non-empty');
        END
    `);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_duplicate_of ON payment_imports(duplicate_of_id) WHERE duplicate_of_id IS NOT NULL');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_reversal_of ON payment_imports(reversal_of_id) WHERE reversal_of_id IS NOT NULL');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_payment_imports_customer ON payment_imports(customer_id) WHERE customer_id IS NOT NULL');
    await run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_imports_created_account_event ON payment_imports(created_account_event_id) WHERE created_account_event_id IS NOT NULL');
    await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_safe_shape_insert
        BEFORE INSERT ON payment_imports
        WHEN NEW.id IS NULL OR length(trim(NEW.id)) = 0
          OR NEW.source IS NULL OR NEW.source NOT IN ('manual', 'webhook')
          OR NEW.status IS NULL OR NEW.status NOT IN ('received', 'needs_review', 'approved', 'duplicate', 'rejected', 'reversed')
          OR NEW.parser_version IS NULL OR length(trim(NEW.parser_version)) = 0
          OR NEW.message_fingerprint IS NULL OR length(trim(NEW.message_fingerprint)) = 0
          OR NEW.direction IS NULL OR NEW.direction NOT IN ('received', 'sent', 'paid', 'reversed', 'unknown')
          OR NEW.event_kind IS NULL OR NEW.event_kind NOT IN ('customer_receipt', 'send_to_person', 'paybill_payment', 'buy_goods_payment', 'reversal', 'unknown')
          OR (NEW.amount_minor IS NOT NULL AND (typeof(NEW.amount_minor) <> 'integer' OR NEW.amount_minor < 0))
          OR (NEW.currency IS NOT NULL AND NEW.currency <> 'KES')
          OR NEW.redacted_evidence IS NULL OR typeof(NEW.redacted_evidence) <> 'text'
          OR NEW.raw_retention_policy IS NULL OR NEW.raw_retention_policy <> 'not_retained'
          OR NEW.has_conflict IS NULL OR NEW.has_conflict NOT IN (0, 1)
          OR NEW.conflict_count IS NULL OR typeof(NEW.conflict_count) <> 'integer' OR NEW.conflict_count < 0
        BEGIN SELECT RAISE(ABORT, 'payment import canonical shape is invalid'); END`);
    await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_safe_shape_update
        BEFORE UPDATE OF id, source, status, parser_version, message_fingerprint, direction, event_kind,
                         amount_minor, currency, redacted_evidence, raw_retention_policy, has_conflict, conflict_count
        ON payment_imports
        WHEN NEW.id IS NULL OR length(trim(NEW.id)) = 0
          OR NEW.source IS NULL OR NEW.source NOT IN ('manual', 'webhook')
          OR NEW.status IS NULL OR NEW.status NOT IN ('received', 'needs_review', 'approved', 'duplicate', 'rejected', 'reversed')
          OR NEW.parser_version IS NULL OR length(trim(NEW.parser_version)) = 0
          OR NEW.message_fingerprint IS NULL OR length(trim(NEW.message_fingerprint)) = 0
          OR NEW.direction IS NULL OR NEW.direction NOT IN ('received', 'sent', 'paid', 'reversed', 'unknown')
          OR NEW.event_kind IS NULL OR NEW.event_kind NOT IN ('customer_receipt', 'send_to_person', 'paybill_payment', 'buy_goods_payment', 'reversal', 'unknown')
          OR (NEW.amount_minor IS NOT NULL AND (typeof(NEW.amount_minor) <> 'integer' OR NEW.amount_minor < 0))
          OR (NEW.currency IS NOT NULL AND NEW.currency <> 'KES')
          OR NEW.redacted_evidence IS NULL OR typeof(NEW.redacted_evidence) <> 'text'
          OR NEW.raw_retention_policy IS NULL OR NEW.raw_retention_policy <> 'not_retained'
          OR NEW.has_conflict IS NULL OR NEW.has_conflict NOT IN (0, 1)
          OR NEW.conflict_count IS NULL OR typeof(NEW.conflict_count) <> 'integer' OR NEW.conflict_count < 0
        BEGIN SELECT RAISE(ABORT, 'payment import canonical shape is invalid'); END`);
    await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_upgrade_timestamps_after_insert
        AFTER INSERT ON payment_imports
        WHEN NEW.created_at = '${UNKNOWN_LEGACY_TIMESTAMP}' OR NEW.updated_at = '${UNKNOWN_LEGACY_TIMESTAMP}'
        BEGIN
            UPDATE payment_imports
               SET created_at = CASE WHEN NEW.created_at = '${UNKNOWN_LEGACY_TIMESTAMP}' THEN CURRENT_TIMESTAMP ELSE NEW.created_at END,
                   updated_at = CASE WHEN NEW.updated_at = '${UNKNOWN_LEGACY_TIMESTAMP}' THEN CURRENT_TIMESTAMP ELSE NEW.updated_at END
             WHERE rowid = NEW.rowid;
        END`);

    // The generic ledger table is created by db.js before this migration in
    // production. Keep isolated migration tests and older partial schemas
    // rerunnable by adding the trace link only when that table exists.
    if (await tableExists(db, 'ledger_transactions')) {
        await ensureColumn(db, 'ledger_transactions', 'customer_account_event_id', `TEXT${eventReference}`);
        await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_transactions_customer_account_event
            ON ledger_transactions(customer_account_event_id)
            WHERE customer_account_event_id IS NOT NULL`);
    }

    // ALTER TABLE cannot add foreign-key constraints to older import tables.
    // These guards make both fresh and upgraded tables reject dangling links
    // once the customer-settlement tables are available.
    if (hasCustomers) {
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_customer_link_insert
            BEFORE INSERT ON payment_imports
            WHEN NEW.customer_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id)
            BEGIN SELECT RAISE(ABORT, 'payment import customer link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_customer_link_update
            BEFORE UPDATE OF customer_id ON payment_imports
            WHEN NEW.customer_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id)
            BEGIN SELECT RAISE(ABORT, 'payment import customer link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS customers_payment_import_link_restrict_delete
            BEFORE DELETE ON customers
            WHEN EXISTS (SELECT 1 FROM payment_imports WHERE customer_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer is linked to a payment import'); END`);
    }
    if (hasCustomerEvents) {
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_event_link_insert
            BEFORE INSERT ON payment_imports
            WHEN NEW.created_account_event_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.created_account_event_id)
            BEGIN SELECT RAISE(ABORT, 'payment import event link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS payment_imports_event_link_update
            BEFORE UPDATE OF created_account_event_id ON payment_imports
            WHEN NEW.created_account_event_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.created_account_event_id)
            BEGIN SELECT RAISE(ABORT, 'payment import event link is invalid'); END`);
        await run(db, `CREATE TRIGGER IF NOT EXISTS customer_events_payment_import_link_restrict_delete
            BEFORE DELETE ON customer_account_events
            WHEN EXISTS (SELECT 1 FROM payment_imports WHERE created_account_event_id = OLD.id)
            BEGIN SELECT RAISE(ABORT, 'customer event is linked to a payment import'); END`);
        if (await tableExists(db, 'ledger_transactions')) {
            await run(db, `CREATE TRIGGER IF NOT EXISTS ledger_transactions_event_link_insert
                BEFORE INSERT ON ledger_transactions
                WHEN NEW.customer_account_event_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.customer_account_event_id)
                BEGIN SELECT RAISE(ABORT, 'ledger customer event link is invalid'); END`);
            await run(db, `CREATE TRIGGER IF NOT EXISTS ledger_transactions_event_link_update
                BEFORE UPDATE OF customer_account_event_id ON ledger_transactions
                WHEN NEW.customer_account_event_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM customer_account_events WHERE id = NEW.customer_account_event_id)
                BEGIN SELECT RAISE(ABORT, 'ledger customer event link is invalid'); END`);
            await run(db, `CREATE TRIGGER IF NOT EXISTS customer_events_ledger_link_restrict_delete
                BEFORE DELETE ON customer_account_events
                WHEN EXISTS (SELECT 1 FROM ledger_transactions WHERE customer_account_event_id = OLD.id)
                BEGIN SELECT RAISE(ABORT, 'customer event is linked to a ledger transaction'); END`);
        }
    }
}

async function migratePaymentImports(db, options = {}) {
    if (!db || typeof db.run !== 'function' || typeof db.all !== 'function') {
        throw new TypeError('payment-import migration requires a SQLite database');
    }
    if (!options || typeof options !== 'object') throw new TypeError('payment-import migration options are invalid');
    const rebuildRequired = await canonicalRebuildRequired(db);
    const foreignKeyRows = await all(db, 'PRAGMA foreign_keys');
    const restoreForeignKeys = Boolean(foreignKeyRows[0]?.foreign_keys);
    let savepointStarted = false;
    try {
        if (rebuildRequired && restoreForeignKeys) {
            await run(db, 'PRAGMA foreign_keys = OFF');
            const disabled = await all(db, 'PRAGMA foreign_keys');
            if (disabled[0]?.foreign_keys) {
                throw new Error('payment-import canonical rebuild cannot run inside an active transaction');
            }
        }
        await run(db, 'SAVEPOINT migrate_payment_imports');
        savepointStarted = true;
        await migratePaymentImportsWithinSavepoint(db, options);
        await validateCanonicalAccountingState(db);
        const customerEventColumns = rebuildRequired && await tableExists(db, 'customer_account_events')
            ? await all(db, 'PRAGMA table_info(customer_account_events)')
            : [];
        if (customerEventColumns.some(column => column.name === 'payment_import_id')) {
            const dangling = await all(db, `SELECT e.id
                FROM customer_account_events e
                LEFT JOIN payment_imports p ON p.id = e.payment_import_id
                WHERE e.payment_import_id IS NOT NULL AND p.id IS NULL
                LIMIT 1`);
            if (dangling.length) throw new Error('payment-import canonical rebuild would orphan a customer account event');
        }
        await run(db, 'RELEASE SAVEPOINT migrate_payment_imports');
    } catch (error) {
        if (savepointStarted) {
            await run(db, 'ROLLBACK TO SAVEPOINT migrate_payment_imports').catch(() => {});
            await run(db, 'RELEASE SAVEPOINT migrate_payment_imports').catch(() => {});
        }
        throw error;
    } finally {
        if (rebuildRequired && restoreForeignKeys) await run(db, 'PRAGMA foreign_keys = ON');
    }
}

module.exports = { migratePaymentImports };
