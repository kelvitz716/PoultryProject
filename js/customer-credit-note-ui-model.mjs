/** Pure preview, validation, and retry helpers for one commercial customer credit note. */

import { parseManualReceiptKes } from './manual-customer-receipt-ui-model.mjs';

const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const NOTE_ID = /^credit-note:[a-f0-9]{40}$/;
const LEDGER_ID = /^ledger-credit-note:[a-f0-9]{36}$/;
const REASONS = new Set(['return', 'pricing_adjustment', 'quality_issue', 'cancellation', 'other']);
const ADMIN_ROLES = new Set(['super_admin', 'admin']);

function safeText(value, fallback = '—') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shortId(value) {
    const text = safeText(value);
    return text.length > 16 ? `…${text.slice(-12)}` : text;
}

function safeTimestamp(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function safeMinor(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function exactSnapshot(customer, settlement, suggestions) {
    return !!customer
        && settlement?.status === 'exact'
        && suggestions?.status === 'exact'
        && settlement.customer_id === customer.id
        && settlement.currency === 'KES'
        && Array.isArray(settlement.events);
}

export function canIssueCustomerCreditNotes(role) {
    return ADMIN_ROLES.has(role);
}

export function normalizeCreditNoteReference(value) {
    const normalized = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
    if (!normalized) return null;
    if (normalized.length > 128 || !OPAQUE_ID.test(normalized)) {
        throw new TypeError('Reference must be a short reference code');
    }
    return normalized.toUpperCase();
}

function validEvent(event, customerId) {
    return event
        && event.customer_id === customerId
        && event.currency === 'KES'
        && typeof event.id === 'string'
        && OPAQUE_ID.test(event.id)
        && ['credit', 'debit'].includes(event.side)
        && ['draft', 'open', 'part-paid', 'settled'].includes(event.status)
        && safeMinor(event.amount_minor)
        && event.amount_minor > 0
        && safeMinor(event.allocated_minor)
        && safeMinor(event.remaining_minor)
        && event.allocated_minor + event.remaining_minor === event.amount_minor;
}

export function creditNoteCandidates(customer, settlement, suggestions) {
    if (!exactSnapshot(customer, settlement, suggestions)) return { available: false, invoices: [] };
    const events = settlement.events;
    const invoices = events.filter(event => event.side === 'debit' && event.kind === 'invoice' && event.status !== 'draft');
    if (!invoices.every(invoice => validEvent(invoice, customer.id))) return { available: false, invoices: [] };
    const invoiceById = new Map(invoices.map(invoice => [invoice.id, invoice]));
    const notedByInvoice = new Map();
    for (const event of events.filter(event => event.kind === 'credit_note')) {
        if (!validEvent(event, customer.id) || event.side !== 'credit' || event.status === 'draft'
            || typeof event.original_event_id !== 'string' || !OPAQUE_ID.test(event.original_event_id)
            || !invoiceById.has(event.original_event_id)) return { available: false, invoices: [] };
        const total = (notedByInvoice.get(event.original_event_id) || 0n) + BigInt(event.amount_minor);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) return { available: false, invoices: [] };
        notedByInvoice.set(event.original_event_id, total);
    }
    const rows = [];
    for (const invoice of invoices) {
        const priorNotesMinor = Number(notedByInvoice.get(invoice.id) || 0n);
        if (priorNotesMinor > invoice.amount_minor) return { available: false, invoices: [] };
        const remainingAllowanceMinor = invoice.amount_minor - priorNotesMinor;
        if (remainingAllowanceMinor <= 0) continue;
        rows.push({
            id: invoice.id,
            original_amount_minor: invoice.amount_minor,
            active_allocated_minor: invoice.allocated_minor,
            current_deficit_minor: invoice.remaining_minor,
            prior_notes_minor: priorNotesMinor,
            remaining_allowance_minor: remainingAllowanceMinor,
            label: `Invoice ${safeText(invoice.external_reference)} · ID ${shortId(invoice.id)} · original KES ${(invoice.amount_minor / 100).toFixed(2)} · allocated KES ${(invoice.allocated_minor / 100).toFixed(2)} · prior notes KES ${(priorNotesMinor / 100).toFixed(2)} · note allowance KES ${(remainingAllowanceMinor / 100).toFixed(2)}`
        });
    }
    return { available: rows.length > 0, invoices: rows };
}

export function appendCreditNoteInvoiceOptions(select, rows, placeholder, documentRef = document) {
    const selectedValue = select.value;
    select.replaceChildren();
    const blank = documentRef.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.append(blank);
    rows.forEach(row => {
        const option = documentRef.createElement('option');
        option.value = row.id;
        option.textContent = row.label;
        select.append(option);
    });
    if (rows.some(row => row.id === selectedValue)) select.value = selectedValue;
}

export function creditNotePreview({ customer, settlement, suggestions, invoiceEventId, amount }) {
    const candidates = creditNoteCandidates(customer, settlement, suggestions);
    if (!candidates.available) throw new TypeError('Current invoice evidence is unavailable');
    const invoice = candidates.invoices.find(item => item.id === invoiceEventId);
    if (!invoice) throw new TypeError('Select a current invoice');
    const parsed = parseManualReceiptKes(amount);
    if (parsed.amountMinor > invoice.remaining_allowance_minor) {
        throw new RangeError('Credit note exceeds the remaining allowance');
    }
    const automaticallyAllocatedMinor = Math.min(parsed.amountMinor, invoice.current_deficit_minor);
    return {
        ...invoice,
        amount: parsed.amount,
        amount_minor: parsed.amountMinor,
        automatically_allocated_minor: automaticallyAllocatedMinor,
        remaining_credit_minor: parsed.amountMinor - automaticallyAllocatedMinor
    };
}

export function creditNoteDraft({ customer, settlement, suggestions, invoiceEventId, amount, reasonCode, externalReference, confirmed }) {
    if (confirmed !== true) throw new TypeError('Confirm the commercial credit note before issuing it');
    if (!REASONS.has(reasonCode)) throw new TypeError('Select a credit note reason');
    const preview = creditNotePreview({ customer, settlement, suggestions, invoiceEventId, amount });
    return {
        customer_id: customer.id,
        invoice_event_id: preview.id,
        amount: preview.amount,
        amount_minor: preview.amount_minor,
        reason_code: reasonCode,
        external_reference: normalizeCreditNoteReference(externalReference),
        automatically_allocated_minor: preview.automatically_allocated_minor,
        remaining_credit_minor: preview.remaining_credit_minor
    };
}

export function creditNoteFingerprint(draft) {
    return JSON.stringify([
        draft.customer_id,
        draft.invoice_event_id,
        draft.amount,
        draft.reason_code,
        draft.external_reference
    ]);
}

export function createCreditNoteRetryTracker(createKey) {
    let uncertain = null;
    return {
        keyFor(draft) {
            const fingerprint = creditNoteFingerprint(draft);
            if (uncertain?.fingerprint === fingerprint) return uncertain.key;
            const key = createKey();
            if (typeof key !== 'string' || !OPAQUE_ID.test(key)) throw new TypeError('Could not create a safe credit note key');
            return key;
        },
        retainUncertain(draft, key) { uncertain = { fingerprint: creditNoteFingerprint(draft), key }; },
        clear() { uncertain = null; },
        invalidate() { uncertain = null; }
    };
}

export function createCreditNoteIdentityLock() {
    let pending = false;
    return { begin() { pending = true; }, finish() { pending = false; }, canChange() { return pending !== true; } };
}

export function validCreditNoteResponse(result, requested) {
    return !!result
        && typeof result === 'object'
        && typeof result.idempotent === 'boolean'
        && typeof result.credit_note_event_id === 'string' && NOTE_ID.test(result.credit_note_event_id)
        && typeof result.ledger_transaction_id === 'string' && LEDGER_ID.test(result.ledger_transaction_id)
        && result.amount_minor === requested.amount_minor
        && result.reason_code === requested.reason_code
        && result.original_invoice_event_id === requested.invoice_event_id
        && Number.isSafeInteger(result.automatically_allocated_minor)
        && Number.isSafeInteger(result.remaining_credit_minor)
        && result.automatically_allocated_minor >= 0
        && result.remaining_credit_minor >= 0
        && result.automatically_allocated_minor + result.remaining_credit_minor === result.amount_minor
        && safeTimestamp(result.recorded_at)
        && typeof result.recorded_by_user_id === 'string' && OPAQUE_ID.test(result.recorded_by_user_id);
}

export function creditNoteResponseIsCurrent(submission, current) {
    return submission?.customerId === current?.customerId
        && submission?.selectionVersion === current?.selectionVersion
        && submission?.snapshotVersion === current?.snapshotVersion
        && submission?.requestVersion === current?.requestVersion;
}
