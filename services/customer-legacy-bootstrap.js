/**
 * Imports only the server-stored legacy poultryFarmProfile.buyers registry.
 * It never rewrites that JSON or infers links to historical transactions.
 */

const crypto = require('crypto');
const {
    normalizeCustomerDisplayName,
    normalizeCustomerPhone
} = require('./customer-registry');

const SOURCE_KEY = 'poultryFarmProfile';
const MAX_BUYERS = 250;
const MAX_ISSUES = 50;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function opaque(value, field) {
    if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) {
        throw new TypeError(`${field} must be an opaque identifier`);
    }
    return value.trim();
}

function boundary(value) {
    const db = value || require('../db');
    if (!db || typeof db.withDedicatedTransaction !== 'function') {
        throw new TypeError('legacy buyer bootstrap requires a dedicated transaction boundary');
    }
    return db;
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeTerms(value) {
    if (typeof value !== 'string') throw new TypeError('unknown_terms');
    const term = value.normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
    const terms = new Map([['COD', 0], ['NET 7', 7], ['NET 14', 14], ['NET 30', 30]]);
    if (!terms.has(term)) throw new TypeError('unknown_terms');
    return terms.get(term);
}

function issue(index, code) {
    return { index, code };
}

function validateLegacyBuyer(record, index) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.getPrototypeOf(record) !== Object.prototype
        || Object.keys(record).some(key => !['name', 'phone', 'terms'].includes(key))) {
        return { issue: issue(index, 'invalid_record') };
    }

    let name;
    try {
        name = normalizeCustomerDisplayName(record.name);
    } catch (error) {
        return { issue: issue(index, error.message === 'Walk-in Customer is reserved' ? 'reserved_walk_in' : 'invalid_name') };
    }

    let paymentTermsDays;
    try {
        paymentTermsDays = normalizeTerms(record.terms);
    } catch (_) {
        return { issue: issue(index, 'unknown_terms') };
    }

    let contactPhone;
    try {
        contactPhone = normalizeCustomerPhone(record.phone);
    } catch (_) {
        return { issue: issue(index, 'invalid_phone') };
    }

    const canonical = {
        display_name: name,
        payment_terms_days: paymentTermsDays,
        contact_phone: contactPhone
    };
    return { canonical, identity: hash(canonical) };
}

function validateRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'actor_user_id')) {
        throw new TypeError('legacy bootstrap input is invalid');
    }
    return opaque(input.actor_user_id, 'actor_user_id');
}

async function bootstrapLegacyBuyers(input, dbBoundary) {
    const actor = validateRequest(input);
    return boundary(dbBoundary).withDedicatedTransaction(async db => {
        const profileRow = await db.getQuery('SELECT value FROM entities WHERE key = ?', [SOURCE_KEY]);
        if (!profileRow) {
            return { profile_found: false, imported: 0, existing: 0, links: [], issues: [], issues_truncated: false };
        }

        let profile;
        try {
            profile = JSON.parse(profileRow.value);
        } catch (_) {
            return { profile_found: true, imported: 0, existing: 0, links: [], issues: [issue(0, 'invalid_profile')], issues_truncated: false };
        }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
            return { profile_found: true, imported: 0, existing: 0, links: [], issues: [issue(0, 'invalid_profile')], issues_truncated: false };
        }
        if (profile.buyers === undefined || profile.buyers === null) {
            return { profile_found: true, imported: 0, existing: 0, links: [], issues: [], issues_truncated: false };
        }
        if (!Array.isArray(profile.buyers) || profile.buyers.length > MAX_BUYERS) {
            throw new TypeError('legacy buyers must be a bounded array');
        }

        const occurrences = new Map();
        const valid = [];
        const issues = [];
        let issuesTruncated = false;
        for (let index = 0; index < profile.buyers.length; index += 1) {
            const candidate = validateLegacyBuyer(profile.buyers[index], index);
            if (candidate.issue) {
                if (issues.length < MAX_ISSUES) issues.push(candidate.issue); else issuesTruncated = true;
                continue;
            }
            const occurrenceOrdinal = occurrences.get(candidate.identity) || 0;
            occurrences.set(candidate.identity, occurrenceOrdinal + 1);
            valid.push({ index, occurrence_ordinal: occurrenceOrdinal, ...candidate });
        }

        const links = [];
        let imported = 0;
        let existing = 0;
        for (const candidate of valid) {
            const mapped = await db.getQuery(`SELECT customer_id FROM legacy_customer_links
                WHERE source_key = ? AND legacy_record_identity = ? AND occurrence_ordinal = ?`,
            [SOURCE_KEY, candidate.identity, candidate.occurrence_ordinal]);
            if (mapped) {
                existing += 1;
                links.push({ index: candidate.index, customer_id: mapped.customer_id, created: false });
                continue;
            }

            const customerId = `legacy-customer:${hash({ identity: candidate.identity, occurrence: candidate.occurrence_ordinal }).slice(0, 32)}`;
            await db.runQuery(`INSERT INTO customers
                (id, display_name, normalized_name, payment_terms_days, contact_phone, is_active, created_by_user_id, updated_by_user_id, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)`,
            [customerId, candidate.canonical.display_name,
                candidate.canonical.display_name.toLocaleUpperCase('en-US'),
                candidate.canonical.payment_terms_days, candidate.canonical.contact_phone, actor, actor]);
            await db.runQuery(`INSERT INTO legacy_customer_links
                (source_key, legacy_record_identity, occurrence_ordinal, customer_id, created_by_user_id)
                VALUES (?, ?, ?, ?, ?)`,
            [SOURCE_KEY, candidate.identity, candidate.occurrence_ordinal, customerId, actor]);
            imported += 1;
            links.push({ index: candidate.index, customer_id: customerId, created: true });
        }

        return { profile_found: true, imported, existing, links, issues, issues_truncated: issuesTruncated };
    });
}

module.exports = { bootstrapLegacyBuyers, validateLegacyBuyer };
