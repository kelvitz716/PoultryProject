/** Pure helpers for the Payment Inbox review surface. */

const ACCESS_ROLES = new Set(['super_admin', 'admin', 'farmer']);
const REJECT_ROLES = new Set(['super_admin', 'admin']);
const RECEIPT_CODE = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8,14}$/;
const MAX_REVIEW_NOTE_LENGTH = 500;

export function canAccessPaymentInbox(role) {
    return ACCESS_ROLES.has(role);
}

export function canApprovePaymentImport(role, paymentImport) {
    const warnings = paymentImport?.parse_warnings;
    return canAccessPaymentInbox(role)
        && paymentImport?.status === 'received'
        && paymentImport?.direction === 'received'
        && paymentImport?.event_kind === 'customer_receipt'
        && paymentImport?.currency === 'KES'
        && Number.isSafeInteger(paymentImport?.amount_minor)
        && paymentImport.amount_minor > 0
        && typeof paymentImport?.receipt_code === 'string'
        && RECEIPT_CODE.test(paymentImport.receipt_code)
        && Array.isArray(warnings)
        && warnings.length === 0
        && (paymentImport.has_conflict === 0 || paymentImport.has_conflict === false);
}

export function canRejectPaymentImport(role, paymentImport) {
    return REJECT_ROLES.has(role)
        && (paymentImport?.status === 'received' || paymentImport?.status === 'needs_review');
}

export function approvalRequestIsReady(customerId, acknowledged) {
    return typeof customerId === 'string'
        && customerId.trim().length > 0
        && acknowledged === true;
}

export function reviewNoteIsSafeForInbox(value) {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string' || value.length > MAX_REVIEW_NOTE_LENGTH) return false;
    return !(/\b[A-Z0-9]{8,14}\s+CONFIRMED\b/i.test(value)
        || /\b(?:KSH|KES)\.?\s*[\d,]+(?:\.\d{1,2})?\b[\s\S]*\b(?:RECEIVED\s+FROM|SENT\s+TO|PAID\s+TO|BUY\s+GOODS|REVERSAL)\b/i.test(value));
}

export class PaymentImportRequestError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'PaymentImportRequestError';
        this.status = status;
    }
}

export async function requestPaymentImportJson(fetchImpl, url, options = {}) {
    let response;
    try {
        response = await fetchImpl(url, options);
    } catch (_) {
        throw new PaymentImportRequestError('Payment Inbox is unavailable');
    }
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) {
        throw new PaymentImportRequestError(
            typeof body?.error === 'string' ? body.error : 'Payment Inbox request failed',
            response.status
        );
    }
    return body;
}

export function formatKesMinor(value) {
    if (!Number.isSafeInteger(value) || value < 0) return 'KES —';
    return `KES ${(value / 100).toFixed(2)}`;
}

export function paymentInboxPageLabel(offset, itemCount) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(itemCount) || itemCount <= 0) {
        return 'No results';
    }
    return `Showing ${offset + 1}–${offset + itemCount}`;
}

function text(value, fallback = '—') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function paymentImportRowModel(paymentImport) {
    return {
        id: text(paymentImport?.id),
        status: text(paymentImport?.status),
        source: text(paymentImport?.source),
        receipt: text(paymentImport?.receipt_code, 'No receipt code'),
        amount: formatKesMinor(paymentImport?.amount_minor),
        evidence: text(paymentImport?.redacted_evidence, 'No redacted evidence available'),
        warningCount: Array.isArray(paymentImport?.parse_warnings) ? paymentImport.parse_warnings.length : 0
    };
}

function detailLine(documentRef, labelText, value) {
    const row = documentRef.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:minmax(110px,0.45fr) minmax(0,1.55fr);gap:10px;padding:7px 0;border-bottom:1px solid var(--border-color);font-size:13px;';
    const label = documentRef.createElement('strong');
    label.textContent = labelText;
    const content = documentRef.createElement('span');
    content.style.overflowWrap = 'anywhere';
    content.textContent = value;
    row.append(label, content);
    return row;
}

export function appendPaymentImportRow(container, paymentImport, onOpen, documentRef = document) {
    const model = paymentImportRowModel(paymentImport);
    const row = documentRef.createElement('button');
    row.type = 'button';
    row.className = 'payment-inbox-row';
    row.style.cssText = 'width:100%;display:grid;grid-template-columns:minmax(0,1.2fr) auto;gap:8px;text-align:left;padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-main);color:inherit;cursor:pointer;margin:0 0 8px;';
    const primary = documentRef.createElement('span');
    const title = documentRef.createElement('strong');
    title.textContent = `${model.receipt} · ${model.amount}`;
    const evidence = documentRef.createElement('span');
    evidence.style.cssText = 'display:block;font-size:12px;color:var(--text-muted);margin-top:4px;overflow-wrap:anywhere;';
    evidence.textContent = model.evidence;
    primary.append(title, evidence);
    const state = documentRef.createElement('span');
    state.style.cssText = 'font-size:12px;text-align:right;white-space:nowrap;';
    state.textContent = `${model.status} · ${model.source}${model.warningCount ? ` · ${model.warningCount} warning${model.warningCount === 1 ? '' : 's'}` : ''}`;
    row.append(primary, state);
    row.addEventListener('click', () => onOpen(paymentImport.id));
    container.append(row);
    return row;
}

function customerLabel(customer) {
    const phone = typeof customer.contact_phone === 'string' && customer.contact_phone.trim()
        ? customer.contact_phone.trim()
        : null;
    const suffix = `ID …${String(customer.id || '').slice(-6)}`;
    const terms = Number(customer.payment_terms_days) === 0 ? 'COD' : `Net ${Number(customer.payment_terms_days)}`;
    return `${customer.display_name} (${phone ? `${phone} · ` : ''}${suffix} · ${terms})`;
}

function activeCustomers(customers) {
    if (!Array.isArray(customers)) return [];
    return customers
        .filter(customer => customer
            && typeof customer.id === 'string'
            && customer.id.trim()
            && typeof customer.display_name === 'string'
            && customer.display_name.trim()
            && (customer.is_active === 1 || customer.is_active === true))
        .slice()
        .sort((left, right) => left.display_name.localeCompare(right.display_name) || left.id.localeCompare(right.id));
}

function appendDecisionControls(container, paymentImport, options, documentRef) {
    const role = options.role;
    const mayApprove = canApprovePaymentImport(role, paymentImport);
    const mayReject = canRejectPaymentImport(role, paymentImport);
    if (!mayApprove && !mayReject) {
        const readOnly = documentRef.createElement('p');
        readOnly.style.cssText = 'margin:14px 0 0;font-size:13px;color:var(--text-muted);';
        readOnly.textContent = 'This import is read-only in the Inbox.';
        container.append(readOnly);
        return;
    }

    const heading = documentRef.createElement('strong');
    heading.style.cssText = 'display:block;margin-top:16px;';
    heading.textContent = 'Review decision';
    container.append(heading);

    if (mayApprove) {
        if (!Array.isArray(options.customers)) {
            const unavailable = documentRef.createElement('p');
            unavailable.style.cssText = 'font-size:13px;color:var(--text-muted);';
            unavailable.textContent = 'Active customers could not be loaded. Approval is unavailable until they can be loaded.';
            container.append(unavailable);
        } else {
            const form = documentRef.createElement('form');
            form.className = 'payment-inbox-decision-form';
            form.style.cssText = 'margin-top:10px;padding:12px;border:1px solid var(--border-color);border-radius:8px;';
            const explanation = documentRef.createElement('p');
            explanation.style.cssText = 'margin:0 0 10px;font-size:13px;color:var(--text-muted);';
            explanation.textContent = 'This receipt belongs to this customer and will become unallocated customer credit. It does not mark an invoice paid.';
            const label = documentRef.createElement('label');
            label.textContent = 'Customer';
            const select = documentRef.createElement('select');
            select.required = true;
            select.style.cssText = 'display:block;width:100%;margin:4px 0 10px;';
            const placeholder = documentRef.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Select an active customer';
            select.append(placeholder);
            activeCustomers(options.customers).forEach(customer => {
                const choice = documentRef.createElement('option');
                choice.value = customer.id;
                choice.textContent = customerLabel(customer);
                select.append(choice);
            });
            const acknowledgementLabel = documentRef.createElement('label');
            acknowledgementLabel.style.cssText = 'display:flex;gap:8px;align-items:flex-start;font-size:13px;';
            const acknowledgement = documentRef.createElement('input');
            acknowledgement.type = 'checkbox';
            acknowledgementLabel.append(acknowledgement, documentRef.createTextNode('I confirm this customer assignment.'));
            const submit = documentRef.createElement('button');
            submit.type = 'submit';
            submit.className = 'btn btn-primary btn-sm';
            submit.style.marginTop = '10px';
            submit.textContent = 'Approve as customer credit';
            submit.disabled = true;
            const updateReady = () => { submit.disabled = !approvalRequestIsReady(select.value, acknowledgement.checked); };
            select.addEventListener('change', updateReady);
            acknowledgement.addEventListener('change', updateReady);
            form.addEventListener('submit', event => {
                event.preventDefault();
                if (!approvalRequestIsReady(select.value, acknowledgement.checked)) return;
                submit.disabled = true;
                Promise.resolve(options.onApprove?.(select.value)).finally(() => { submit.disabled = false; });
            });
            form.append(explanation, label, select, acknowledgementLabel, submit);
            container.append(form);
        }
    }

    if (mayReject) {
        const form = documentRef.createElement('form');
        form.className = 'payment-inbox-decision-form';
        form.style.cssText = 'margin-top:10px;padding:12px;border:1px solid var(--border-color);border-radius:8px;';
        const guidance = documentRef.createElement('p');
        guidance.style.cssText = 'margin:0 0 10px;font-size:13px;color:var(--text-muted);';
        guidance.textContent = 'Rejecting creates no finance. Add an optional short review note; do not paste an SMS message here.';
        const label = documentRef.createElement('label');
        label.textContent = 'Review note (optional)';
        const note = documentRef.createElement('textarea');
        note.rows = 3;
        note.maxLength = MAX_REVIEW_NOTE_LENGTH;
        note.autocomplete = 'off';
        note.placeholder = 'Short reason for rejection';
        note.style.cssText = 'display:block;width:100%;margin:4px 0 10px;';
        const confirmationLabel = documentRef.createElement('label');
        confirmationLabel.style.cssText = 'display:flex;gap:8px;align-items:flex-start;font-size:13px;';
        const confirmation = documentRef.createElement('input');
        confirmation.type = 'checkbox';
        confirmationLabel.append(confirmation, documentRef.createTextNode('I confirm this evidence should be rejected.'));
        const submit = documentRef.createElement('button');
        submit.type = 'submit';
        submit.className = 'btn btn-secondary btn-sm';
        submit.style.marginTop = '10px';
        submit.textContent = 'Reject evidence';
        submit.disabled = true;
        const updateReady = () => { submit.disabled = confirmation.checked === true; };
        confirmation.addEventListener('change', updateReady);
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (!confirmation.checked) return;
            if (!reviewNoteIsSafeForInbox(note.value)) {
                note.value = '';
                options.onRejectNoteRejected?.();
                return;
            }
            const reviewNotes = note.value;
            note.value = '';
            submit.disabled = true;
            Promise.resolve(options.onReject?.(reviewNotes)).finally(() => { submit.disabled = false; });
        });
        form.append(guidance, label, note, confirmationLabel, submit);
        container.append(form);
    }
}

export function renderPaymentImportDetail(container, paymentImport, optionsOrDocument = {}, documentArg = globalThis.document) {
    const documentRef = typeof optionsOrDocument?.createElement === 'function' ? optionsOrDocument : documentArg;
    const options = typeof optionsOrDocument?.createElement === 'function' ? {} : optionsOrDocument;
    container.replaceChildren();
    if (!paymentImport) {
        const empty = documentRef.createElement('p');
        empty.textContent = 'Select an import to review its redacted evidence.';
        container.append(empty);
        return;
    }
    const model = paymentImportRowModel(paymentImport);
    const fields = [
        ['Status', model.status], ['Source', model.source], ['Receipt', model.receipt], ['Amount', model.amount],
        ['Direction', text(paymentImport.direction)], ['Event', text(paymentImport.event_kind)],
        ['Sender', text(paymentImport.sender_masked)], ['Counterparty', text(paymentImport.counterparty_name)],
        ['Reference', text(paymentImport.reference_masked)], ['Recorded', text(paymentImport.created_at)],
        ['Evidence', model.evidence]
    ];
    fields.forEach(([label, value]) => container.append(detailLine(documentRef, label, value)));
    const warnings = Array.isArray(paymentImport.parse_warnings) ? paymentImport.parse_warnings : [];
    if (warnings.length) {
        const warningTitle = documentRef.createElement('strong');
        warningTitle.style.display = 'block';
        warningTitle.style.marginTop = '12px';
        warningTitle.textContent = 'Parser warnings';
        const list = documentRef.createElement('ul');
        list.style.cssText = 'margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--text-muted);';
        warnings.forEach(warning => {
            const item = documentRef.createElement('li');
            item.textContent = text(warning, 'Unspecified warning');
            list.append(item);
        });
        container.append(warningTitle, list);
    }
    appendDecisionControls(container, paymentImport, options || {}, documentRef);
}

export function createPaymentInboxController(apiClient) {
    let listVersion = 0;
    let submitting = false;
    return {
        async load(filters) {
            const version = ++listVersion;
            try {
                const result = await apiClient.listPaymentImports(filters);
                return { stale: version !== listVersion, result };
            } catch (error) {
                return { stale: version !== listVersion, error };
            }
        },
        async submitManual(payload) {
            if (submitting) return { ignored: true, clearText: false };
            submitting = true;
            try {
                return { ignored: false, clearText: true, result: await apiClient.ingestManualPaymentImport(payload) };
            } catch (error) {
                return { ignored: false, clearText: error?.status === 409, error };
            } finally {
                submitting = false;
            }
        }
    };
}

export function createPaymentInboxDecisionController(apiClient) {
    let submitting = false;
    async function submit(method, id, value) {
        if (submitting) return { ignored: true };
        submitting = true;
        try {
            return { ignored: false, result: await apiClient[method](id, value) };
        } catch (error) {
            return { ignored: false, error };
        } finally {
            submitting = false;
        }
    }
    return {
        approve(id, customerId) {
            return submit('approvePaymentImport', id, customerId);
        },
        reject(id, reviewNotes) {
            return submit('rejectPaymentImport', id, reviewNotes);
        }
    };
}

export function createPaymentInboxDecisionGate() {
    let busy = false;
    let token = 0;
    return {
        start() {
            if (busy) return null;
            busy = true;
            token += 1;
            return token;
        },
        isCurrent(candidate) {
            return busy && candidate === token;
        },
        finish(candidate) {
            if (candidate === token) busy = false;
        },
        get busy() {
            return busy;
        }
    };
}
