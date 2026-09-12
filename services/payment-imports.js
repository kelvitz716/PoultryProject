/**
 * Local persistence boundary for redacted M-Pesa payment-import evidence.
 * This module deliberately has no HTTP, authentication, approval, or ledger work.
 */

const crypto = require('crypto');
const { parseMpesaSms, maskPhone } = require('./payment-import-parser');

const MAX_SMS_LENGTH = 1600;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_OFFSET = 10000;
const SOURCES = new Set(['manual', 'webhook']);
const STATUSES = new Set(['received', 'needs_review', 'approved', 'duplicate', 'rejected', 'reversed']);
const PHONE_SENDER = /^(?:\+?254|0)[17](?:[\s-]?\d){8}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:@-]+$/;
const SAFE_SIM_LABEL = /^[A-Za-z0-9._:@-]+$/;
const CONFLICT_FIELDS = new Set([
    'amount_minor', 'currency', 'direction', 'event_kind', 'transaction_at_ms',
    'counterparty_name', 'counterparty_phone_masked'
]);

const SAFE_COLUMNS = [
    'id', 'source', 'source_message_id', 'sender_masked', 'device_id', 'sim_slot',
    'sent_at_ms', 'received_at_ms', 'transaction_at_ms', 'status', 'parser_version',
    'message_fingerprint', 'dedupe_identity', 'receipt_code', 'direction', 'event_kind',
    'amount_minor', 'currency', 'counterparty_name', 'counterparty_phone_masked',
    'reference_masked', 'parse_warnings', 'redacted_evidence', 'raw_retention_policy',
    'has_conflict', 'conflict_count', 'conflict_fields', 'last_conflict_at',
    'duplicate_of_id', 'reversal_of_id', 'reviewer_user_id', 'reviewed_at', 'review_notes',
    'approved_at', 'rejected_at', 'reversed_at', 'buyer_name', 'batch_id',
    'created_transaction_id', 'customer_id', 'created_account_event_id',
    'created_at', 'updated_at'
];
const SAFE_SELECT = SAFE_COLUMNS.join(', ');

function productionAdapter() {
    // Load lazily so pure, temporary-database tests do not open the application DB.
    return require('../db');
}

function resolveAdapter(adapter) {
    const resolved = adapter || productionAdapter();
    for (const name of ['runQuery', 'getQuery', 'allQuery']) {
        if (typeof resolved[name] !== 'function') {
            throw new TypeError(`payment-import database adapter requires ${name}`);
        }
    }
    return resolved;
}

function optionalString(value, field, maxLength) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > maxLength) throw new RangeError(`${field} is too long`);
    return trimmed;
}

function optionalTimestamp(value, field) {
    if (value === undefined || value === null || value === '') return null;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a nonnegative safe integer`);
    }
    return value;
}

function opaqueIdentifier(value, field, maxLength) {
    const normalized = optionalString(value, field, maxLength);
    if (!normalized) return null;
    if (!OPAQUE_ID.test(normalized)) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return normalized;
}

function normalizeSim(value) {
    if (value === undefined || value === null || value === '') return null;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value !== 'string') throw new TypeError('sim must be a safe slot label or nonnegative integer');
    const normalized = value.trim();
    if (!normalized || normalized.length > 32) throw new TypeError('sim must be a safe slot label or nonnegative integer');
    if (/^\d+$/.test(normalized)) {
        const numeric = Number(normalized);
        if (!Number.isSafeInteger(numeric)) throw new TypeError('sim must be a safe slot label or nonnegative integer');
        return String(numeric);
    }
    const namedSlot = normalized.match(/^SIM\s+(\d{1,4})$/i);
    if (namedSlot) return `SIM ${Number(namedSlot[1])}`;
    if (!SAFE_SIM_LABEL.test(normalized)) throw new TypeError('sim must be a safe slot label or nonnegative integer');
    return normalized;
}

function sanitizeSender(sender) {
    const value = optionalString(sender, 'sender', 64);
    if (!value) return null;
    if (/^M-?PESA$/i.test(value)) return 'M-PESA';
    if (PHONE_SENDER.test(value)) return maskPhone(value);
    return null;
}

function validateInput(input) {
    if (!input || typeof input !== 'object') throw new TypeError('payment-import input must be an object');
    if (!SOURCES.has(input.source)) throw new TypeError('source must be manual or webhook');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new TypeError('text must be nonblank');
    if (input.text.length > MAX_SMS_LENGTH) throw new RangeError(`text exceeds ${MAX_SMS_LENGTH} characters`);

    return {
        source: input.source,
        text: input.text,
        source_message_id: opaqueIdentifier(input.source_message_id, 'source_message_id', 128),
        sender_masked: sanitizeSender(input.sender),
        device_id: opaqueIdentifier(input.device_id, 'device_id', 128),
        sim_slot: normalizeSim(input.sim),
        sent_at_ms: optionalTimestamp(input.sent_at_ms, 'sent_at_ms'),
        received_at_ms: optionalTimestamp(input.received_at_ms, 'received_at_ms')
    };
}

function dedupeIdentity(parsed) {
    if (parsed.receipt_code) {
        return `${parsed.direction === 'reversed' ? 'reversal' : 'receipt'}:${parsed.receipt_code.toUpperCase()}`;
    }
    return `fingerprint:${parsed.message_fingerprint}`;
}

function safeWarnings(value) {
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
    if (typeof value !== 'string') return ['malformed_stored_parse_warnings'];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every(item => typeof item === 'string')
            ? parsed
            : ['malformed_stored_parse_warnings'];
    } catch (_) {
        return ['malformed_stored_parse_warnings'];
    }
}

function safeConflictFields(value) {
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every(field => CONFLICT_FIELDS.has(field)) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function toSafePaymentImport(row) {
    if (!row) return null;
    const result = {};
    for (const column of SAFE_COLUMNS) {
        if (column !== 'parse_warnings' && column !== 'conflict_fields') result[column] = row[column] ?? null;
    }
    result.parse_warnings = safeWarnings(row.parse_warnings);
    result.conflict_fields = safeConflictFields(row.conflict_fields);
    return result;
}

function isDedupeConflict(error) {
    return error && error.code === 'SQLITE_CONSTRAINT'
        && /UNIQUE constraint failed:\s*payment_imports\.dedupe_identity/i.test(error.message || '');
}

function materialConflictFields(parsed, canonical) {
    const fields = [];
    for (const field of ['amount_minor', 'currency', 'direction', 'event_kind']) {
        if (parsed[field] !== canonical[field]) fields.push(field);
    }
    for (const field of ['transaction_at_ms', 'counterparty_name', 'counterparty_phone_masked']) {
        if (parsed[field] !== null && canonical[field] !== null && parsed[field] !== canonical[field]) {
            fields.push(field);
        }
    }
    return fields;
}

function buildInsert(input, parsed) {
    const dedupe_identity = dedupeIdentity(parsed);
    const row = {
        id: crypto.randomUUID(),
        source: input.source,
        source_message_id: input.source_message_id,
        sender_masked: input.sender_masked,
        device_id: input.device_id,
        sim_slot: input.sim_slot,
        sent_at_ms: input.sent_at_ms,
        received_at_ms: input.received_at_ms,
        transaction_at_ms: parsed.transaction_at_ms,
        status: parsed.status,
        parser_version: parsed.parser_version,
        message_fingerprint: parsed.message_fingerprint,
        dedupe_identity,
        receipt_code: parsed.receipt_code,
        direction: parsed.direction,
        event_kind: parsed.event_kind,
        amount_minor: parsed.amount_minor,
        currency: parsed.currency,
        counterparty_name: parsed.counterparty_name,
        counterparty_phone_masked: parsed.counterparty_phone_masked,
        reference_masked: parsed.reference_masked,
        parse_warnings: JSON.stringify(parsed.parse_warnings),
        redacted_evidence: parsed.redacted_evidence,
        raw_retention_policy: 'not_retained'
    };
    const columns = Object.keys(row);
    return {
        dedupe_identity,
        sql: `INSERT INTO payment_imports (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        params: columns.map(column => row[column])
    };
}

async function canonicalByDedupe(dedupe_identity, adapter) {
    const row = await adapter.getQuery(
        `SELECT ${SAFE_SELECT} FROM payment_imports WHERE dedupe_identity = ?`,
        [dedupe_identity]
    );
    return toSafePaymentImport(row);
}

async function recordConflict(canonicalId, conflictFields, adapter) {
    await adapter.runQuery(`
        UPDATE payment_imports
        SET has_conflict = 1,
            conflict_count = conflict_count + 1,
            conflict_fields = ?,
            last_conflict_at = CURRENT_TIMESTAMP,
            status = CASE WHEN status = 'received' THEN 'needs_review' ELSE status END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [JSON.stringify(conflictFields), canonicalId]);
}

async function ingestPaymentImport(input, dbAdapter) {
    const adapter = resolveAdapter(dbAdapter);
    const validated = validateInput(input);
    const parsed = parseMpesaSms(validated.text);
    const insert = buildInsert(validated, parsed);

    try {
        await adapter.runQuery(insert.sql, insert.params);
    } catch (error) {
        if (!isDedupeConflict(error)) throw error;
        const existing = await canonicalByDedupe(insert.dedupe_identity, adapter);
        if (!existing) throw error;
        const conflict_fields = materialConflictFields(parsed, existing);
        if (conflict_fields.length) {
            await recordConflict(existing.id, conflict_fields, adapter);
        }
        const canonical = conflict_fields.length
            ? await canonicalByDedupe(insert.dedupe_identity, adapter)
            : existing;
        return {
            created: false,
            duplicate: true,
            conflict: conflict_fields.length > 0,
            conflict_fields,
            payment_import: canonical
        };
    }

    const created = await canonicalByDedupe(insert.dedupe_identity, adapter);
    if (!created) throw new Error('payment import insert could not be read back');
    return { created: true, duplicate: false, conflict: false, conflict_fields: [], payment_import: created };
}

function boundedInteger(value, defaultValue, minimum, maximum) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (!Number.isSafeInteger(value)) throw new TypeError('pagination values must be safe integers');
    return Math.min(maximum, Math.max(minimum, value));
}

async function getPaymentImport(id, dbAdapter) {
    const adapter = resolveAdapter(dbAdapter);
    const paymentImportId = optionalString(id, 'id', 128);
    if (!paymentImportId) throw new TypeError('id must be nonblank');
    return toSafePaymentImport(await adapter.getQuery(
        `SELECT ${SAFE_SELECT} FROM payment_imports WHERE id = ?`,
        [paymentImportId]
    ));
}

async function listPaymentImports(options = {}, dbAdapter) {
    const adapter = resolveAdapter(dbAdapter);
    if (!options || typeof options !== 'object') throw new TypeError('list options must be an object');
    const limit = boundedInteger(options.limit, 50, 1, MAX_PAGE_SIZE);
    const offset = boundedInteger(options.offset, 0, 0, MAX_PAGE_OFFSET);
    const clauses = [];
    const params = [];
    if (options.status !== undefined && options.status !== null && options.status !== '') {
        if (!STATUSES.has(options.status)) throw new TypeError('invalid payment-import status filter');
        clauses.push('status = ?');
        params.push(options.status);
    }
    if (options.source !== undefined && options.source !== null && options.source !== '') {
        if (!SOURCES.has(options.source)) throw new TypeError('invalid payment-import source filter');
        clauses.push('source = ?');
        params.push(options.source);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = await adapter.allQuery(
        `SELECT ${SAFE_SELECT} FROM payment_imports${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    return { items: rows.map(toSafePaymentImport), limit, offset };
}

module.exports = {
    MAX_SMS_LENGTH,
    MAX_PAGE_SIZE,
    sanitizeSender,
    normalizeSim,
    dedupeIdentity,
    PAYMENT_IMPORT_SAFE_SELECT: SAFE_SELECT,
    toSafePaymentImport,
    ingestPaymentImport,
    getPaymentImport,
    listPaymentImports
};
