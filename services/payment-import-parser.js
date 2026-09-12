/**
 * Pure, dependency-free parser for synthetic Kenyan M-Pesa SMS evidence.
 * It extracts evidence only; it never selects a buyer/batch or posts accounting data.
 */

const crypto = require('crypto');

const PARSER_VERSION = 'mpesa-sms-v2';
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const PHONE_PATTERN = '(?:\\+?254|0)[17](?:[\\s-]?\\d){8}\\b';

function normalizeSms(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .replace(/\b(KSH|KES)\s+/gi, '$1')
        .trim()
        .toUpperCase();
}

function fingerprint(normalizedText) {
    return crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}

function maskPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 4) return null;
    return `••••${digits.slice(-4)}`;
}

function maskReference(value) {
    const compact = String(value || '').replace(/\s/g, '');
    if (!compact) return null;
    return compact.length <= 4 ? '••••' : `••••${compact.slice(-4)}`;
}

function findPhone(value) {
    const match = String(value || '').match(new RegExp(PHONE_PATTERN));
    return match ? match[0] : null;
}

function redactEvidence(value) {
    let redacted = String(value || '').replace(/\s+/g, ' ').trim();
    redacted = redacted.replace(/\b(?:new\s+)?m-?pesa\s+balance\b[\s\S]*$/i, '[sensitive account data removed]');
    redacted = redacted.replace(/\b(?:available\s+)?fuliza(?:\s+m-?pesa)?(?:\s+balance|\s+limit)?\b[\s\S]*$/i, '[sensitive account data removed]');
    redacted = redacted.replace(new RegExp(PHONE_PATTERN, 'g'), match => maskPhone(match));
    redacted = redacted.replace(/\b((?:account|acc|till)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*)(\d{4,})\b/gi, (_, label, account) => `${label}${maskReference(account)}`);
    return redacted.slice(0, 500);
}

function parseAmount(normalizedText) {
    const match = normalizedText.match(/\b(?:KSH|KES)\.?\s*([\d,]+(?:\.\d{1,2})?)\b/i);
    if (!match) return null;
    const [wholePart, decimalPart = ''] = match[1].replace(/,/g, '').split('.');
    if (!/^\d+$/.test(wholePart)) return null;
    const cents = decimalPart.padEnd(2, '0');
    return Number(wholePart) * 100 + Number(cents || 0);
}

function parseReceiptCode(normalizedText) {
    const match = normalizedText.match(/^([A-Z0-9]{8,14})\s+CONFIRMED\b/);
    if (!match || !/[A-Z]/.test(match[1]) || !/\d/.test(match[1])) return null;
    return match[1];
}

function parseTransactionTime(normalizedText) {
    const match = normalizedText.match(/\bON\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+AT\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\b/i);
    if (!match) return null;
    const [, day, month, rawYear, rawHour, minute, meridiem] = match;
    let hour = Number(rawHour);
    if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem.toUpperCase() === 'PM' && hour !== 12) hour += 12;
        if (meridiem.toUpperCase() === 'AM' && hour === 12) hour = 0;
    }
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    const timestamp = Date.UTC(year, Number(month) - 1, Number(day), hour, Number(minute));
    const parsed = new Date(timestamp);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day) && parsed.getUTCHours() === hour && parsed.getUTCMinutes() === Number(minute)
        ? timestamp - EAT_OFFSET_MS
        : null;
}

function hasTimestampShape(normalizedText) {
    return /\bON\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+AT\s+\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\b/i.test(normalizedText);
}

function classifyDirection(normalizedText) {
    if (/\b(?:REVERSAL|REVERSED)\b/.test(normalizedText)) return { direction: 'reversed', eventKind: 'reversal' };
    const canonicalReceived = /\bYOU\s+HAVE\s+RECEIVED\s+(?:KSH|KES)\.?\s*[\d,]+(?:\.\d{1,2})?\s+FROM\b/.test(normalizedText);
    const received = /\bRECEIVED\s+FROM\b/.test(normalizedText) || canonicalReceived;
    const sentToAccount = /\bSENT\s+TO\b[\s\S]*\bFOR\s+ACCOUNT\b/.test(normalizedText);
    const sent = /\bSENT\s+TO\b/.test(normalizedText) && !sentToAccount;
    const paid = /\b(?:PAID\s+TO|PAYBILL|PAY\s+BILL|BUY\s+GOODS|TILL\s+NUMBER)\b/.test(normalizedText);
    if ([received, sent, paid, sentToAccount].filter(Boolean).length > 1) return { direction: 'unknown', eventKind: 'unknown', ambiguous: true };
    if (received) return { direction: 'received', eventKind: 'customer_receipt', marker: canonicalReceived ? 'from' : 'received from' };
    if (sentToAccount) return { direction: 'paid', eventKind: 'paybill_payment', marker: 'sent to' };
    if (sent) return { direction: 'sent', eventKind: 'send_to_person', marker: 'sent to' };
    if (/\b(?:BUY\s+GOODS|TILL\s+NUMBER)\b/.test(normalizedText)) return { direction: 'paid', eventKind: 'buy_goods_payment', marker: 'buy goods at' };
    if (/\b(?:PAYBILL|PAY\s+BILL)\b/.test(normalizedText) || /\bPAID\s+TO\b[\s\S]*\bFOR\s+ACCOUNT\b/.test(normalizedText)) {
        return { direction: 'paid', eventKind: 'paybill_payment', marker: 'paid to' };
    }
    if (paid) return { direction: 'paid', eventKind: 'unknown', marker: 'paid to' };
    return { direction: 'unknown', eventKind: 'unknown' };
}

function parseCounterparty(normalizedText, marker) {
    if (!marker) return { name: null, phoneMasked: null };
    const index = normalizedText.indexOf(marker.toUpperCase());
    if (index < 0) return { name: null, phoneMasked: null };
    const tail = normalizedText.slice(index + marker.length)
        .split(/\s+ON\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b|\s+AT\s+\d{1,2}:\d{2}\b|\s+FOR\s+(?:ACCOUNT|ACC|TILL)\b|\s+TILL\s+NUMBER\b|\.\s*(?:NEW\s+)?M-?PESA\s+BALANCE\b/i)[0];
    const phone = findPhone(tail);
    const name = tail.replace(new RegExp(PHONE_PATTERN, 'g'), '').replace(/[.,;]+$/g, '').trim();
    return { name: name || null, phoneMasked: maskPhone(phone) };
}

function parseReference(normalizedText) {
    const match = normalizedText.match(/\b(?:FOR\s+)?(?:ACCOUNT|ACC|TILL)(?:\s+(?:NUMBER|NO\.?))?\s*[:#-]?\s*(\d{4,})\b/i);
    return match ? maskReference(match[1]) : null;
}

function parseMpesaSms(rawText) {
    const normalizedText = normalizeSms(rawText);
    const warnings = [];
    const receiptCode = parseReceiptCode(normalizedText);
    const amountMinor = parseAmount(normalizedText);
    const classification = classifyDirection(normalizedText);
    const counterparty = parseCounterparty(normalizedText, classification.marker);

    if (!normalizedText) warnings.push('empty_message');
    if (!receiptCode) warnings.push('missing_receipt_code');
    if (amountMinor === null) warnings.push('missing_amount');
    if (amountMinor !== null && amountMinor <= 0) warnings.push('non_positive_amount');
    if (classification.direction === 'unknown') warnings.push(classification.ambiguous ? 'ambiguous_direction' : 'missing_direction');
    if (classification.direction !== 'unknown' && !counterparty.name) warnings.push('missing_counterparty');
    const transactionAtMs = parseTransactionTime(normalizedText);
    if (hasTimestampShape(normalizedText) && transactionAtMs === null) warnings.push('invalid_transaction_time');

    const evidenceComplete = Boolean(receiptCode && amountMinor !== null && amountMinor > 0 && classification.direction !== 'unknown');
    let status = 'needs_review';
    if (evidenceComplete && classification.direction === 'received' && warnings.length === 0) status = 'received';
    if (evidenceComplete && classification.direction === 'reversed') status = 'reversed';

    return {
        parser_version: PARSER_VERSION,
        message_fingerprint: fingerprint(normalizedText),
        receipt_code: receiptCode,
        amount_minor: amountMinor,
        currency: amountMinor === null ? null : 'KES',
        direction: classification.direction,
        event_kind: classification.eventKind,
        transaction_at_ms: transactionAtMs,
        counterparty_name: counterparty.name,
        counterparty_phone_masked: counterparty.phoneMasked,
        reference_masked: parseReference(normalizedText),
        parse_warnings: warnings,
        redacted_evidence: redactEvidence(rawText),
        status,
        is_postable: false
    };
}

module.exports = {
    PARSER_VERSION,
    normalizeSms,
    fingerprint,
    maskPhone,
    redactEvidence,
    parseMpesaSms
};
