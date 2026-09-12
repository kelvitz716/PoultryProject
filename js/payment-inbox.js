/** Payment Inbox review, manual-paste, and explicit decision view. No settlement controls. */

import { api } from './api.js';
import { $, showToast } from './ui.js';
import {
    appendPaymentImportRow,
    canApprovePaymentImport,
    canAccessPaymentInbox,
    createPaymentInboxController,
    createPaymentInboxDecisionController,
    createPaymentInboxDecisionGate,
    paymentInboxPageLabel,
    renderPaymentImportDetail
} from './payment-inbox-model.mjs';

const PAGE_SIZE = 25;
const state = { status: '', source: '', offset: 0, loading: false, detailVersion: 0, refreshVersion: 0 };
const controller = createPaymentInboxController(api);
const decisionController = createPaymentInboxDecisionController(api);
const decisionGate = createPaymentInboxDecisionGate();

function setMessage(message, type = '') {
    const element = $('payment-inbox-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function updatePagination(itemCount) {
    const previous = $('payment-inbox-previous');
    const next = $('payment-inbox-next');
    if (previous) previous.disabled = state.loading || state.offset === 0;
    if (next) next.disabled = state.loading || itemCount < PAGE_SIZE;
    const label = $('payment-inbox-page');
    if (label) label.textContent = paymentInboxPageLabel(state.offset, itemCount);
}

function setDecisionControlsBusy(busy) {
    const detail = $('payment-inbox-detail');
    detail?.querySelectorAll?.('.payment-inbox-decision-form button, .payment-inbox-decision-form input, .payment-inbox-decision-form select, .payment-inbox-decision-form textarea')
        .forEach(control => { control.disabled = busy; });
}

function renderList(items) {
    const list = $('payment-inbox-list');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('p');
        empty.style.color = 'var(--text-muted)';
        empty.textContent = 'No payment evidence matches these filters.';
        list.append(empty);
        updatePagination(0);
        return;
    }
    items.forEach(item => appendPaymentImportRow(list, item, id => { void loadDetail(id); }));
    updatePagination(items.length);
}

async function refresh() {
    if (!canAccessPaymentInbox(window.USER_ROLE)) return;
    const version = ++state.refreshVersion;
    state.loading = true;
    setMessage('Loading payment evidence…');
    updatePagination(0);
    try {
        const loaded = await controller.load({
            status: state.status || undefined,
            source: state.source || undefined,
            limit: PAGE_SIZE,
            offset: state.offset
        });
        if (version !== state.refreshVersion || loaded.stale) return;
        if (loaded.error) throw loaded.error;
        renderList(Array.isArray(loaded.result?.items) ? loaded.result.items : []);
        setMessage('');
    } catch (error) {
        if (version !== state.refreshVersion) return;
        renderList([]);
        setMessage(error?.message || 'Payment Inbox could not be loaded.', 'error');
    } finally {
        if (version !== state.refreshVersion) return;
        state.loading = false;
        updatePagination(document.querySelectorAll('#payment-inbox-list .payment-inbox-row').length);
    }
}

async function loadDetail(id) {
    const version = ++state.detailVersion;
    const detail = $('payment-inbox-detail');
    if (detail) detail.textContent = 'Loading redacted evidence…';
    try {
        const paymentImport = await api.getPaymentImport(id);
        if (version !== state.detailVersion) return;
        let customers;
        if (canApprovePaymentImport(window.USER_ROLE, paymentImport)) {
            try {
                customers = await api.listCustomers(false);
            } catch (_) {
                customers = undefined;
            }
        }
        if (version !== state.detailVersion) return;
        renderPaymentImportDetail(detail, paymentImport, {
            role: window.USER_ROLE,
            customers,
            onApprove: customerId => approveImport(paymentImport.id, customerId, version),
            onReject: reviewNotes => rejectImport(paymentImport.id, reviewNotes, version),
            onRejectNoteRejected: () => setMessage('That note looked like a payment SMS and was cleared. Use a short review reason instead.', 'warning')
        });
        detail?.focus();
    } catch (error) {
        if (version !== state.detailVersion) return;
        if (detail) detail.textContent = error?.message || 'Payment evidence could not be loaded.';
    }
}

function actionMessage(kind, result) {
    if (kind === 'approve') {
        return result?.idempotent
            ? 'This receipt was already approved as unallocated customer credit. It has not marked an invoice paid.'
            : 'Receipt approved as unallocated M-Pesa customer credit. It has not marked an invoice paid.';
    }
    return result?.idempotent
        ? 'This payment evidence was already rejected; its original review decision is preserved.'
        : 'Payment evidence rejected. No financial record was created.';
}

async function decide(kind, id, value, detailVersion) {
    const decisionToken = decisionGate.start();
    if (decisionToken === null) return;
    setDecisionControlsBusy(true);
    try {
        const outcome = kind === 'approve'
            ? await decisionController.approve(id, value)
            : await decisionController.reject(id, value);
        if (outcome.ignored || !decisionGate.isCurrent(decisionToken)) return;
        const detailIsCurrent = detailVersion === state.detailVersion;
        if (outcome.error) {
            const message = outcome.error.status === 409
                ? 'This payment import changed or is not eligible for that decision.'
                : 'The payment-import decision could not be completed.';
            if (detailIsCurrent) setMessage(message, 'error');
            if (outcome.error.status === 409) {
                await refresh();
                if (decisionGate.isCurrent(decisionToken) && detailIsCurrent) await loadDetail(id);
            }
            return;
        }
        const message = actionMessage(kind, outcome.result);
        if (detailIsCurrent) {
            setMessage(message, 'success');
            showToast(message, 'success');
        }
        await refresh();
        if (decisionGate.isCurrent(decisionToken) && detailIsCurrent) await loadDetail(id);
    } finally {
        if (decisionGate.isCurrent(decisionToken)) {
            decisionGate.finish(decisionToken);
            setDecisionControlsBusy(false);
        }
    }
}

async function approveImport(id, customerId, detailVersion) {
    return decide('approve', id, customerId, detailVersion);
}

async function rejectImport(id, reviewNotes, detailVersion) {
    return decide('reject', id, reviewNotes, detailVersion);
}

async function submitManual(event) {
    event.preventDefault();
    const textarea = $('payment-inbox-manual-text');
    const sender = $('payment-inbox-manual-sender');
    const button = $('payment-inbox-manual-submit');
    const text = textarea?.value || '';
    if (!text.trim()) {
        setMessage('Paste an M-Pesa message before submitting.', 'error');
        textarea?.focus();
        return;
    }
    if (button?.disabled) return;
    if (button) button.disabled = true;
    const outcome = await controller.submitManual({ text, sender: sender?.value || undefined });
    if (button) button.disabled = false;
    if (outcome.ignored) return;
    if (outcome.clearText && textarea) textarea.value = '';
    if (outcome.error) {
        if (outcome.error.status === 409) {
            setMessage('This evidence conflicts with an existing receipt and needs review.', 'warning');
            void refresh();
        } else {
            setMessage(outcome.error.message || 'Payment evidence could not be captured.', 'error');
        }
        return;
    }
    const result = outcome.result || {};
    const message = result.conflict
        ? 'This evidence conflicts with an existing receipt and needs review.'
        : result.duplicate ? 'This evidence was already captured; the existing record is shown.'
        : 'Payment evidence captured for review. It has not marked any invoice paid.';
    setMessage(message, result.conflict ? 'warning' : 'success');
    showToast(message, result.conflict ? 'warning' : 'success');
    await refresh();
}

export function initPaymentInboxView() {
    $('payment-inbox-status')?.addEventListener('change', event => {
        state.status = event.target.value;
        state.offset = 0;
        void refresh();
    });
    $('payment-inbox-source')?.addEventListener('change', event => {
        state.source = event.target.value;
        state.offset = 0;
        void refresh();
    });
    $('payment-inbox-retry')?.addEventListener('click', () => { void refresh(); });
    $('payment-inbox-previous')?.addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - PAGE_SIZE);
        void refresh();
    });
    $('payment-inbox-next')?.addEventListener('click', () => {
        state.offset += PAGE_SIZE;
        void refresh();
    });
    $('payment-inbox-manual-form')?.addEventListener('submit', event => { void submitManual(event); });
}

export function loadPaymentInbox() {
    if (!canAccessPaymentInbox(window.USER_ROLE)) return;
    void refresh();
}
