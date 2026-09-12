/** Read-only Customer Settlement Timeline view. */

import { api } from './api.js';
import { $ } from './ui.js';
import { newIdempotencyKey } from './customer-ui-model.mjs';
import {
    createManualReceiptRetryTracker,
    createManualReceiptIdentityLock,
    manualReceiptDraft,
    validManualReceiptResponse,
    receiptResponseIsCurrent
} from './manual-customer-receipt-ui-model.mjs';
import {
    allocationCandidates,
    allocationDraft,
    allocationResponseIsCurrent,
    appendAllocationOptions,
    createAllocationIdentityLock,
    createAllocationRetryTracker,
    validAllocationResponse
} from './customer-allocation-ui-model.mjs';
import {
    allocationReversalCandidates,
    allocationReversalDraft,
    allocationReversalResponseIsCurrent,
    appendAllocationReversalOptions,
    createAllocationReversalIdentityLock,
    validAllocationReversalResponse
} from './customer-allocation-reversal-ui-model.mjs';
import {
    appendCreditNoteInvoiceOptions,
    canIssueCustomerCreditNotes,
    creditNoteCandidates,
    creditNoteDraft,
    creditNotePreview,
    creditNoteResponseIsCurrent,
    createCreditNoteIdentityLock,
    createCreditNoteRetryTracker,
    validCreditNoteResponse
} from './customer-credit-note-ui-model.mjs';
import {
    canIssueCustomerRefunds,
    createRefundIdentityLock,
    createRefundRetryTracker,
    refundCandidates,
    refundDraft,
    refundAcknowledgementState,
    refundPreview,
    refundPreviewText,
    refundResponseIsCurrent,
    validRefundResponse
} from './customer-refund-ui-model.mjs';
import {
    appendCustomerSettlementOptions,
    canAccessCustomerSettlement,
    customerFinancialFormAvailability,
    createCustomerSettlementTimelineController,
    renderCustomerSettlementSuggestions,
    renderCustomerSettlementTimeline,
    settlementSummaryModel
} from './customer-settlement-timeline-model.mjs';

const state = {
    includeInactive: false,
    selectedId: '',
    selectedCustomer: null,
    selectionVersion: 0,
    snapshotVersion: 0,
    customerLoadVersion: 0,
    customerLoading: false,
    receiptPending: false,
    receiptVersion: 0,
    allocationPending: false,
    allocationVersion: 0,
    reversalPending: false,
    reversalVersion: 0,
    creditNotePending: false,
    creditNoteVersion: 0,
    refundPending: false,
    refundVersion: 0,
    settlementLoading: false,
    settlement: null,
    suggestions: null
};
const controller = createCustomerSettlementTimelineController(api);
const receiptRetryTracker = createManualReceiptRetryTracker(() => newIdempotencyKey('manual-receipt'));
const receiptIdentityLock = createManualReceiptIdentityLock();
const allocationRetryTracker = createAllocationRetryTracker(() => newIdempotencyKey('customer-allocation'));
const allocationIdentityLock = createAllocationIdentityLock();
const reversalIdentityLock = createAllocationReversalIdentityLock();
const creditNoteRetryTracker = createCreditNoteRetryTracker(() => newIdempotencyKey('customer-credit-note'));
const creditNoteIdentityLock = createCreditNoteIdentityLock();
const refundRetryTracker = createRefundRetryTracker(() => newIdempotencyKey('customer-refund'));
const refundIdentityLock = createRefundIdentityLock();

function setMessage(message, type = '') {
    const element = $('customer-settlement-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function setSummaryValue(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function renderSummary(settlement, suggestions) {
    const summary = settlementSummaryModel(settlement, suggestions);
    setSummaryValue('customer-settlement-outstanding', summary.outstanding);
    setSummaryValue('customer-settlement-credit', summary.credit);
    setSummaryValue('customer-settlement-net', summary.net);
    setSummaryValue('customer-settlement-counts', `${summary.evidenceCount} evidence · ${summary.allocationCount} allocation links`);
    const notice = $('customer-settlement-reconciliation');
    if (notice) {
        notice.textContent = summary.status === 'exact'
            ? ''
            : 'Unavailable / reconciliation required. Review the recorded evidence before taking any financial action.';
    }
}

function clearSettlement(message) {
    renderSummary({ status: 'reconciliation_required', evidence_count: 0, allocation_count: 0 }, { status: 'reconciliation_required' });
    const timeline = $('customer-settlement-timeline');
    const suggestions = $('customer-settlement-suggestions');
    if (timeline) timeline.textContent = message;
    if (suggestions) suggestions.textContent = message;
}

function selectedCustomer() {
    return state.selectedCustomer;
}

function setReceiptMessage(message, type = '') {
    const element = $('manual-customer-receipt-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function updateManualReceiptAvailability() {
    const customer = selectedCustomer();
    const active = customer?.is_active === true || customer?.is_active === 1;
    const availability = customerFinancialFormAvailability({
        customer,
        receiptPending: state.receiptPending,
        allocationPending: state.allocationPending,
        reversalPending: state.reversalPending,
        creditNotePending: state.creditNotePending,
        refundPending: state.refundPending
    });
    const fields = $('manual-customer-receipt-fields');
    const label = $('manual-customer-receipt-customer');
    if (fields) fields.disabled = !availability.receiptEnabled;
    if (!label) return;
    if (!customer) {
        label.textContent = 'Select an active named customer to record a receipt.';
    } else if (!active) {
        label.textContent = 'This customer is inactive. Historical evidence is available, but new receipts are disabled.';
    } else if (state.receiptPending) {
        label.textContent = 'A receipt is still being confirmed. New receipts are disabled until it finishes.';
    } else if (state.allocationPending) {
        label.textContent = 'An allocation is still being confirmed. New receipts are disabled until it finishes.';
    } else if (state.reversalPending) {
        label.textContent = 'An allocation reversal is still being confirmed. New receipts are disabled until it finishes.';
    } else if (state.creditNotePending) {
        label.textContent = 'A credit note is still being confirmed. New receipts are disabled until it finishes.';
    } else {
        label.textContent = 'Receipt will be recorded for the selected active named customer.';
    }
}

function updateIdentityControls() {
    const availability = customerFinancialFormAvailability({
        customer: selectedCustomer(),
        receiptPending: state.receiptPending,
        allocationPending: state.allocationPending,
        reversalPending: state.reversalPending,
        creditNotePending: state.creditNotePending,
        refundPending: state.refundPending
    });
    const disabled = !availability.identityEnabled || state.customerLoading;
    const select = $('customer-settlement-customer');
    const includeInactive = $('customer-settlement-include-inactive');
    const retry = $('customer-settlement-retry');
    if (select) select.disabled = disabled;
    if (includeInactive) includeInactive.disabled = !availability.identityEnabled;
    if (retry) retry.disabled = !availability.identityEnabled;
}

function identityCanChange() {
    return receiptIdentityLock.canChange() && allocationIdentityLock.canChange()
        && reversalIdentityLock.canChange() && creditNoteIdentityLock.canChange() && refundIdentityLock.canChange();
}

function setSelectedCustomer(id) {
    const changed = id !== state.selectedId;
    state.selectedId = id;
    state.selectedCustomer = state.customers?.find(customer => customer.id === id) || null;
    if (changed) {
        state.selectionVersion += 1;
        receiptRetryTracker.invalidate();
        allocationRetryTracker.invalidate();
        creditNoteRetryTracker.invalidate();
        refundRetryTracker.invalidate();
        setReceiptMessage('');
        setAllocationMessage('');
        setCreditNoteMessage('');
        setRefundMessage('');
    }
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
}

function receiptInputs() {
    return {
        method: $('manual-customer-receipt-method')?.value,
        amount: $('manual-customer-receipt-amount')?.value,
        externalReference: $('manual-customer-receipt-reference')?.value,
        confirmed: $('manual-customer-receipt-confirm')?.checked === true
    };
}

function invalidateReceiptRetry() {
    if (state.receiptPending) return;
    receiptRetryTracker.invalidate();
}

function setAllocationMessage(message, type = '') {
    const element = $('customer-allocation-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function setAllocationReversalMessage(message, type = '') {
    const element = $('customer-allocation-reversal-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function setCreditNoteMessage(message, type = '') {
    const element = $('customer-credit-note-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function setRefundMessage(message, type = '') {
    const element = $('customer-refund-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = type;
}

function allocationInputs() {
    return {
        creditEventId: $('customer-allocation-credit')?.value,
        debitEventId: $('customer-allocation-invoice')?.value,
        amount: $('customer-allocation-amount')?.value,
        confirmed: $('customer-allocation-confirm')?.checked === true
    };
}

function reversalInputs() {
    return {
        allocationId: $('customer-allocation-reversal-select')?.value,
        confirmed: $('customer-allocation-reversal-confirm')?.checked === true
    };
}

function creditNoteInputs() {
    return {
        invoiceEventId: $('customer-credit-note-invoice')?.value,
        amount: $('customer-credit-note-amount')?.value,
        reasonCode: $('customer-credit-note-reason')?.value,
        externalReference: $('customer-credit-note-reference')?.value,
        confirmed: $('customer-credit-note-confirm')?.checked === true
    };
}

function refundInputs() {
    const container = $('customer-refund-sources');
    const amounts = new Map(Array.from(container?.querySelectorAll('[data-refund-source-amount]') || [])
        .map(input => [input.dataset.refundSourceAmount, input.value]));
    const sources = Array.from(container?.querySelectorAll('[data-refund-source-id]') || [])
        .filter(input => input.checked === true)
        .map(input => ({ credit_event_id: input.dataset.refundSourceId, amount: amounts.get(input.dataset.refundSourceId) || '' }));
    return {
        method: $('customer-refund-method')?.value,
        amount: $('customer-refund-amount')?.value,
        reasonCode: $('customer-refund-reason')?.value,
        externalReference: $('customer-refund-reference')?.value,
        acknowledgeMethodDifference: $('customer-refund-mismatch-confirm')?.checked === true,
        confirmed: $('customer-refund-confirm')?.checked === true,
        sources
    };
}

function renderAllocationChoices() {
    const candidates = allocationCandidates(selectedCustomer(), state.settlement, state.suggestions);
    const credit = $('customer-allocation-credit');
    const debit = $('customer-allocation-invoice');
    if (credit) appendAllocationOptions(credit, candidates.credits, 'Select recorded customer credit');
    if (debit) appendAllocationOptions(debit, candidates.debits, 'Select open invoice');
    return candidates;
}

function updateAllocationAvailability() {
    const candidates = renderAllocationChoices();
    const fields = $('customer-allocation-fields');
    const label = $('customer-allocation-customer');
    const availability = customerFinancialFormAvailability({
        customer: selectedCustomer(),
        allocationAvailable: candidates.available,
        settlementLoading: state.settlementLoading,
        receiptPending: state.receiptPending,
        allocationPending: state.allocationPending,
        reversalPending: state.reversalPending,
        creditNotePending: state.creditNotePending,
        refundPending: state.refundPending
    });
    if (fields) fields.disabled = !availability.allocationEnabled;
    if (!label) return;
    if (state.allocationPending) {
        label.textContent = 'An allocation is still being confirmed. Customer selection and allocation choices are frozen.';
    } else if (state.reversalPending) {
        label.textContent = 'An allocation reversal is still being confirmed. New allocations are disabled until it finishes.';
    } else if (state.creditNotePending) {
        label.textContent = 'A credit note is still being confirmed. New allocations are disabled until it finishes.';
    } else if (state.receiptPending) {
        label.textContent = 'A receipt is still being confirmed. New allocations are disabled until it finishes.';
    } else if (state.settlementLoading) {
        label.textContent = 'Loading current settlement evidence before an allocation can be recorded.';
    } else if (!selectedCustomer()) {
        label.textContent = 'Select an active named customer and load an exact settlement snapshot to apply credit.';
    } else if (!(selectedCustomer().is_active === true || selectedCustomer().is_active === 1)) {
        label.textContent = 'This customer is inactive. Historical evidence is available, but new allocations are disabled.';
    } else if (!candidates.available) {
        label.textContent = 'No exact eligible customer credit and open invoice pair is currently available.';
    } else {
        label.textContent = 'Select one recorded credit and one open invoice, then confirm the exact amount.';
    }
}

function renderAllocationReversalChoices() {
    const candidates = allocationReversalCandidates(selectedCustomer(), state.settlement, state.suggestions);
    const select = $('customer-allocation-reversal-select');
    if (select) appendAllocationReversalOptions(select, candidates.allocations, 'Select active allocation to reverse');
    return candidates;
}

function updateAllocationReversalAvailability() {
    const candidates = renderAllocationReversalChoices();
    const fields = $('customer-allocation-reversal-fields');
    const label = $('customer-allocation-reversal-customer');
    const availability = customerFinancialFormAvailability({
        customer: selectedCustomer(),
        allocationAvailable: candidates.available,
        settlementLoading: state.settlementLoading,
        receiptPending: state.receiptPending,
        allocationPending: state.allocationPending,
        reversalPending: state.reversalPending,
        creditNotePending: state.creditNotePending,
        refundPending: state.refundPending
    });
    if (fields) fields.disabled = !availability.reversalEnabled;
    if (!label) return;
    if (state.reversalPending) {
        label.textContent = 'The allocation reversal is still being confirmed. Customer selection and financial controls are frozen.';
    } else if (state.receiptPending || state.allocationPending) {
        label.textContent = 'Another financial action is still being confirmed. Allocation reversal is disabled until it finishes.';
    } else if (state.creditNotePending) {
        label.textContent = 'A credit note is still being confirmed. Allocation reversal is disabled until it finishes.';
    } else if (state.settlementLoading) {
        label.textContent = 'Loading current settlement evidence before a historical correction can be recorded.';
    } else if (!selectedCustomer()) {
        label.textContent = 'Select a customer and load an exact settlement snapshot to reverse one active allocation.';
    } else if (!candidates.available) {
        label.textContent = 'No current active customer-credit-to-invoice allocation is available to reverse.';
    } else if (selectedCustomer().is_active === false || selectedCustomer().is_active === 0) {
        label.textContent = 'This customer is inactive. This historical correction remains available for the selected active allocation.';
    } else {
        label.textContent = 'Select one active allocation and confirm its historical reversal.';
    }
}

function renderCreditNoteChoices() {
    const candidates = creditNoteCandidates(selectedCustomer(), state.settlement, state.suggestions);
    const select = $('customer-credit-note-invoice');
    if (select) appendCreditNoteInvoiceOptions(select, candidates.invoices, 'Select original posted invoice');
    return candidates;
}

function renderRefundSources() {
    const candidates = refundCandidates(selectedCustomer(), state.settlement, state.suggestions);
    const container = $('customer-refund-sources');
    if (!container) return candidates;
    const selected = new Map(Array.from(container.querySelectorAll('[data-refund-source-id]'))
        .map(input => [input.dataset.refundSourceId, input.checked === true]));
    const amounts = new Map(Array.from(container.querySelectorAll('[data-refund-source-amount]'))
        .map(input => [input.dataset.refundSourceAmount, input.value]));
    container.replaceChildren();
    candidates.sources.forEach(source => {
        const row = document.createElement('div');
        row.className = 'customer-refund-source';
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.refundSourceId = source.id;
        check.checked = selected.get(source.id) === true;
        const text = document.createElement('span');
        text.textContent = source.label;
        label.append(check, text);
        const amount = document.createElement('input');
        amount.type = 'text';
        amount.inputMode = 'decimal';
        amount.autocomplete = 'off';
        amount.maxLength = 32;
        amount.placeholder = 'KES amount';
        amount.dataset.refundSourceAmount = source.id;
        amount.value = amounts.get(source.id) || '';
        row.append(label, amount);
        container.append(row);
    });
    return candidates;
}

function renderRefundPreview() {
    const previewElement = $('customer-refund-preview');
    const mismatch = $('customer-refund-mismatch');
    const acknowledgement = $('customer-refund-mismatch-confirm-wrap');
    const acknowledgementInput = $('customer-refund-mismatch-confirm');
    if (!previewElement) return;
    try {
        const preview = refundPreview({ customer: selectedCustomer(), settlement: state.settlement, suggestions: state.suggestions, ...refundInputs() });
        previewElement.textContent = refundPreviewText(preview);
        const acknowledgementState = refundAcknowledgementState({
            methodDifference: preview.method_difference,
            pending: state.refundPending,
            checked: acknowledgementInput?.checked === true
        });
        if (mismatch) mismatch.textContent = acknowledgementState.visible ? 'The selected payment evidence includes a different tender method. Acknowledge this before issuing the refund.' : '';
        if (acknowledgement) acknowledgement.hidden = !acknowledgementState.visible;
        if (acknowledgementInput) acknowledgementInput.checked = acknowledgementState.checked;
    } catch (_) {
        previewElement.textContent = 'Select current customer-credit sources and enter exact amounts that total the outgoing refund.';
        if (mismatch) mismatch.textContent = '';
        if (acknowledgement) acknowledgement.hidden = true;
    }
}

function updateRefundAvailability() {
    const candidates = renderRefundSources();
    const fields = $('customer-refund-fields');
    const label = $('customer-refund-customer');
    const canIssue = canIssueCustomerRefunds(window.USER_ROLE);
    const availability = customerFinancialFormAvailability({
        customer: selectedCustomer(), allocationAvailable: candidates.available, settlementLoading: state.settlementLoading,
        receiptPending: state.receiptPending, allocationPending: state.allocationPending, reversalPending: state.reversalPending,
        creditNotePending: state.creditNotePending, refundPending: state.refundPending
    });
    if (fields) fields.disabled = !canIssue || !availability.refundEnabled;
    renderRefundPreview();
    if (!label) return;
    if (!canIssue) label.textContent = 'Only an administrator may issue an outgoing customer refund.';
    else if (state.refundPending) label.textContent = 'The refund is still being confirmed. Customer selection and financial controls are frozen.';
    else if (state.receiptPending || state.allocationPending || state.reversalPending || state.creditNotePending) label.textContent = 'Another financial action is still being confirmed. Refunds are disabled until it finishes.';
    else if (state.settlementLoading) label.textContent = 'Loading current settlement evidence before a refund can be issued.';
    else if (!selectedCustomer()) label.textContent = 'Select a customer and load an exact settlement snapshot to issue a refund.';
    else if (!candidates.available) label.textContent = 'No coherent available customer credit is currently available to refund.';
    else if (selectedCustomer().is_active === false || selectedCustomer().is_active === 0) label.textContent = 'This customer is inactive. This historical refund remains available from selected customer credit.';
    else label.textContent = 'Select the existing customer-credit sources to consume and confirm the outgoing refund.';
}

function invalidateRefundRetry() {
    if (!state.refundPending) refundRetryTracker.invalidate();
}

function renderCreditNotePreview() {
    const preview = $('customer-credit-note-preview');
    if (!preview) return;
    try {
        const result = creditNotePreview({
            customer: selectedCustomer(), settlement: state.settlement, suggestions: state.suggestions,
            invoiceEventId: creditNoteInputs().invoiceEventId, amount: creditNoteInputs().amount
        });
        preview.textContent = `Original invoice KES ${(result.original_amount_minor / 100).toFixed(2)} · active allocated KES ${(result.active_allocated_minor / 100).toFixed(2)} · current deficit KES ${(result.current_deficit_minor / 100).toFixed(2)} · prior credit notes KES ${(result.prior_notes_minor / 100).toFixed(2)} · remaining note allowance KES ${(result.remaining_allowance_minor / 100).toFixed(2)}. This note will apply KES ${(result.automatically_allocated_minor / 100).toFixed(2)} and leave KES ${(result.remaining_credit_minor / 100).toFixed(2)} as customer credit.`;
    } catch (_) {
        preview.textContent = 'Select a current invoice and enter an exact KES amount to preview the linked invoice correction.';
    }
}

function updateCreditNoteAvailability() {
    const candidates = renderCreditNoteChoices();
    const fields = $('customer-credit-note-fields');
    const label = $('customer-credit-note-customer');
    const canIssue = canIssueCustomerCreditNotes(window.USER_ROLE);
    const availability = customerFinancialFormAvailability({
        customer: selectedCustomer(), allocationAvailable: candidates.available,
        settlementLoading: state.settlementLoading,
        receiptPending: state.receiptPending,
        allocationPending: state.allocationPending,
        reversalPending: state.reversalPending,
        creditNotePending: state.creditNotePending,
        refundPending: state.refundPending
    });
    if (fields) fields.disabled = !canIssue || !availability.creditNoteEnabled;
    renderCreditNotePreview();
    if (!label) return;
    if (!canIssue) {
        label.textContent = 'Only an administrator may issue a commercial credit note.';
    } else if (state.creditNotePending) {
        label.textContent = 'The credit note is still being confirmed. Customer selection and financial controls are frozen.';
    } else if (state.receiptPending || state.allocationPending || state.reversalPending) {
        label.textContent = 'Another financial action is still being confirmed. Credit notes are disabled until it finishes.';
    } else if (state.settlementLoading) {
        label.textContent = 'Loading current settlement evidence before a credit note can be issued.';
    } else if (!selectedCustomer()) {
        label.textContent = 'Select a customer and load an exact settlement snapshot to issue a credit note.';
    } else if (!candidates.available) {
        label.textContent = 'No coherent posted invoice with remaining credit-note allowance is currently available.';
    } else if (selectedCustomer().is_active === false || selectedCustomer().is_active === 0) {
        label.textContent = 'This customer is inactive. A historical commercial correction remains available from the selected invoice.';
    } else {
        label.textContent = 'Select the original posted invoice and confirm the commercial correction.';
    }
}

function invalidateCreditNoteRetry() {
    if (state.creditNotePending) return;
    creditNoteRetryTracker.invalidate();
}

function invalidateAllocationRetry() {
    if (state.allocationPending) return;
    allocationRetryTracker.invalidate();
}

function allocationErrorMessage(error) {
    if (error?.status === 404) return 'The selected settlement evidence is no longer available. Refresh and review it again.';
    if (error?.status === 409) return 'The selected credit or invoice changed. Refresh and review the current remaining amounts.';
    if (error?.status === 400) return 'Check the selected evidence, exact amount, and confirmation, then try again.';
    return 'The allocation could not be confirmed. You may retry the same unchanged details.';
}

function isUncertainAllocationError(error) {
    return !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;
}

function reversalErrorMessage(error) {
    if (error?.status === 404) return 'The selected allocation is no longer available. Refresh and review the current evidence.';
    if (error?.status === 409) return 'The selected allocation changed. Refresh and review the recorded evidence.';
    if (error?.status === 400) return 'Check the selected active allocation and confirmation, then try again.';
    return 'The allocation reversal could not be confirmed. You may retry the same allocation.';
}

function isUncertainReversalError(error) {
    return !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;
}

function creditNoteErrorMessage(error) {
    if (error?.status === 404) return 'The selected customer or invoice is no longer available. Refresh and review it again.';
    if (error?.status === 409) return 'The selected invoice changed. Refresh and review its current credit-note allowance.';
    if (error?.status === 400) return 'Check the exact amount, reason, reference, and confirmation, then try again.';
    return 'The credit note could not be confirmed. You may retry the same unchanged details.';
}

function isUncertainCreditNoteError(error) {
    return !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;
}

async function submitCustomerCreditNote(event) {
    event.preventDefault();
    if (state.creditNotePending || state.receiptPending || state.allocationPending || state.reversalPending || state.refundPending
        || !canIssueCustomerCreditNotes(window.USER_ROLE)) return;
    let draft;
    try {
        draft = creditNoteDraft({
            customer: selectedCustomer(), settlement: state.settlement, suggestions: state.suggestions, ...creditNoteInputs()
        });
    } catch (_) {
        setCreditNoteMessage('Check the original invoice, exact amount, reason, reference, and confirmation.', 'error');
        return;
    }
    const idempotencyKey = creditNoteRetryTracker.keyFor(draft);
    const requested = { ...draft, idempotency_key: idempotencyKey };
    const submission = {
        customerId: state.selectedId,
        selectionVersion: state.selectionVersion,
        snapshotVersion: state.snapshotVersion,
        requestVersion: ++state.creditNoteVersion
    };
    state.creditNotePending = true;
    creditNoteIdentityLock.begin();
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    updateIdentityControls();
    setCreditNoteMessage('Issuing the commercial credit note and verifying its linked invoice effect…');
    try {
        const result = await api.issueCustomerCreditNote({
            customer_id: requested.customer_id,
            invoice_event_id: requested.invoice_event_id,
            amount: requested.amount,
            reason_code: requested.reason_code,
            external_reference: requested.external_reference,
            idempotency_key: requested.idempotency_key
        });
        if (!validCreditNoteResponse(result, requested)) {
            const error = new Error('Customer credit note response could not be verified');
            error.status = 0;
            throw error;
        }
        creditNoteRetryTracker.clear();
        if (!creditNoteResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion,
            requestVersion: state.creditNoteVersion
        })) return;
        $('customer-credit-note-form')?.reset();
        setCreditNoteMessage(`Credit note recorded (…${result.credit_note_event_id.slice(-12)}): KES ${(result.automatically_allocated_minor / 100).toFixed(2)} applied to the invoice and KES ${(result.remaining_credit_minor / 100).toFixed(2)} remains customer credit. No cash was transferred.`, 'success');
        void loadSettlement(submission.customerId);
    } catch (error) {
        if (isUncertainCreditNoteError(error)) creditNoteRetryTracker.retainUncertain(draft, idempotencyKey);
        else creditNoteRetryTracker.clear();
        if (!creditNoteResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion,
            requestVersion: state.creditNoteVersion
        })) return;
        setCreditNoteMessage(creditNoteErrorMessage(error), 'error');
    } finally {
        if (submission.requestVersion === state.creditNoteVersion) {
            state.creditNotePending = false;
            creditNoteIdentityLock.finish();
            updateManualReceiptAvailability();
            updateAllocationAvailability();
            updateAllocationReversalAvailability();
            updateCreditNoteAvailability();
            updateRefundAvailability();
            updateIdentityControls();
        }
    }
}

function refundErrorMessage(error) {
    if (error?.status === 404) return 'The selected customer credit is no longer available. Refresh and review it again.';
    if (error?.status === 409) return 'The selected customer credit changed. Refresh and review the available amounts.';
    if (error?.status === 400) return 'Check the exact sources, amount, method, reference, and confirmations, then try again.';
    return 'The refund could not be confirmed. You may retry the same unchanged details.';
}

function isUncertainRefundError(error) {
    return !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;
}

async function submitCustomerRefund(event) {
    event.preventDefault();
    if (state.refundPending || state.receiptPending || state.allocationPending || state.reversalPending || state.creditNotePending
        || !canIssueCustomerRefunds(window.USER_ROLE)) return;
    let draft;
    try {
        draft = refundDraft({ customer: selectedCustomer(), settlement: state.settlement, suggestions: state.suggestions, ...refundInputs() });
    } catch (_) {
        setRefundMessage('Check the selected customer credit, exact amounts, method, reference, and confirmations.', 'error');
        return;
    }
    const idempotencyKey = refundRetryTracker.keyFor(draft);
    const requested = { ...draft, idempotency_key: idempotencyKey };
    const submission = {
        customerId: state.selectedId,
        selectionVersion: state.selectionVersion,
        snapshotVersion: state.snapshotVersion,
        requestVersion: ++state.refundVersion
    };
    state.refundPending = true;
    refundIdentityLock.begin();
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    updateIdentityControls();
    setRefundMessage('Issuing the outgoing refund and verifying the selected customer-credit evidence…');
    try {
        const result = await api.issueCustomerRefund({
            customer_id: requested.customer_id,
            method: requested.method,
            amount: requested.amount,
            sources: requested.sources.map(source => ({ credit_event_id: source.credit_event_id, amount: source.amount })),
            reason_code: requested.reason_code,
            external_reference: requested.external_reference,
            acknowledge_method_difference: requested.acknowledge_method_difference,
            idempotency_key: requested.idempotency_key
        });
        if (!validRefundResponse(result, requested)) {
            const failure = new Error('Customer refund response could not be verified');
            failure.status = 0;
            throw failure;
        }
        refundRetryTracker.clear();
        if (!refundResponseIsCurrent(submission, {
            customerId: state.selectedId, selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion, requestVersion: state.refundVersion
        })) return;
        $('customer-refund-form')?.reset();
        setRefundMessage(`Refund recorded (…${result.refund_event_id.slice(-12)}): KES ${(result.amount_minor / 100).toFixed(2)} transferred by ${result.method}. Selected customer credit was consumed.`, 'success');
        void loadSettlement(submission.customerId);
    } catch (error) {
        if (isUncertainRefundError(error)) refundRetryTracker.retainUncertain(draft, idempotencyKey);
        else refundRetryTracker.clear();
        if (!refundResponseIsCurrent(submission, {
            customerId: state.selectedId, selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion, requestVersion: state.refundVersion
        })) return;
        setRefundMessage(refundErrorMessage(error), 'error');
    } finally {
        if (submission.requestVersion === state.refundVersion) {
            state.refundPending = false;
            refundIdentityLock.finish();
            updateManualReceiptAvailability();
            updateAllocationAvailability();
            updateAllocationReversalAvailability();
            updateCreditNoteAvailability();
            updateRefundAvailability();
            updateIdentityControls();
        }
    }
}

async function submitCustomerAllocationReversal(event) {
    event.preventDefault();
    if (state.reversalPending || state.receiptPending || state.allocationPending || state.creditNotePending || state.refundPending) return;
    let requested;
    try {
        requested = allocationReversalDraft({
            customer: selectedCustomer(), settlement: state.settlement, suggestions: state.suggestions, ...reversalInputs()
        });
    } catch (_) {
        setAllocationReversalMessage('Select one current active allocation and confirm the historical correction.', 'error');
        return;
    }
    const submission = {
        customerId: state.selectedId,
        selectionVersion: state.selectionVersion,
        snapshotVersion: state.snapshotVersion,
        requestVersion: ++state.reversalVersion
    };
    state.reversalPending = true;
    reversalIdentityLock.begin();
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    updateIdentityControls();
    setAllocationReversalMessage('Reversing the selected allocation while retaining its history…');
    try {
        const result = await api.reverseCustomerAllocation(requested.id);
        if (!validAllocationReversalResponse(result, requested)) {
            const error = new Error('Allocation reversal response could not be verified');
            error.status = 0;
            throw error;
        }
        if (!allocationReversalResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion,
            requestVersion: state.reversalVersion
        })) return;
        $('customer-allocation-reversal-form')?.reset();
        setAllocationReversalMessage(`Allocation reversed (…${result.allocation.id.slice(-12)}). Credit and invoice positions will be refreshed; no money moved.`, 'success');
        void loadSettlement(submission.customerId);
    } catch (error) {
        if (!allocationReversalResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion,
            requestVersion: state.reversalVersion
        })) return;
        setAllocationReversalMessage(isUncertainReversalError(error)
            ? 'The allocation reversal could not be confirmed. You may retry the same allocation.'
            : reversalErrorMessage(error), 'error');
    } finally {
        if (submission.requestVersion === state.reversalVersion) {
            state.reversalPending = false;
            reversalIdentityLock.finish();
            updateManualReceiptAvailability();
            updateAllocationAvailability();
            updateAllocationReversalAvailability();
            updateCreditNoteAvailability();
            updateRefundAvailability();
            updateIdentityControls();
        }
    }
}

async function submitCustomerAllocation(event) {
    event.preventDefault();
    if (state.allocationPending || state.receiptPending || state.reversalPending || state.creditNotePending || state.refundPending) return;
    let draft;
    try {
        draft = allocationDraft({
            customer: selectedCustomer(), settlement: state.settlement, suggestions: state.suggestions, ...allocationInputs()
        });
    } catch (_) {
        setAllocationMessage('Check the exact current evidence, amount, and confirmation before applying credit.', 'error');
        return;
    }
    const idempotencyKey = allocationRetryTracker.keyFor(draft);
    const requested = { ...draft, idempotency_key: idempotencyKey };
    const submission = {
        customerId: state.selectedId,
        selectionVersion: state.selectionVersion,
        snapshotVersion: state.snapshotVersion,
        requestVersion: ++state.allocationVersion
    };
    state.allocationPending = true;
    allocationIdentityLock.begin();
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    updateIdentityControls();
    setAllocationMessage('Applying recorded customer credit to the selected invoice…');
    try {
        const result = await api.allocateCustomerCredit({
            credit_event_id: requested.credit_event_id,
            debit_event_id: requested.debit_event_id,
            amount: requested.amount,
            idempotency_key: requested.idempotency_key
        });
        if (!validAllocationResponse(result, requested)) {
            const error = new Error('Customer allocation response could not be verified');
            error.status = 0;
            throw error;
        }
        allocationRetryTracker.clear();
        if (!allocationResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion,
            requestVersion: state.allocationVersion
        })) return;
        $('customer-allocation-form')?.reset();
        setAllocationMessage(`Credit applied (allocation …${result.allocation.id.slice(-12)}). No new money was recorded.`, 'success');
        void loadSettlement(submission.customerId);
    } catch (error) {
        if (isUncertainAllocationError(error)) allocationRetryTracker.retainUncertain(requested, idempotencyKey);
        else allocationRetryTracker.clear();
        if (!allocationResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            snapshotVersion: state.snapshotVersion,
            requestVersion: state.allocationVersion
        })) return;
        setAllocationMessage(allocationErrorMessage(error), 'error');
    } finally {
        if (submission.requestVersion === state.allocationVersion) {
            state.allocationPending = false;
            allocationIdentityLock.finish();
            updateManualReceiptAvailability();
            updateAllocationAvailability();
            updateAllocationReversalAvailability();
            updateCreditNoteAvailability();
            updateRefundAvailability();
            updateIdentityControls();
        }
    }
}

function receiptErrorMessage(error) {
    if (error?.status === 409) return 'This receipt conflicts with existing evidence. Check the details before trying again.';
    if (error?.status === 400) return 'Check the customer, exact amount, method, and reference, then try again.';
    return 'The receipt could not be confirmed. You may retry the same unchanged details.';
}

function isUncertainReceiptError(error) {
    return !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;
}

function resetReceiptForm() {
    $('manual-customer-receipt-form')?.reset();
    const referenceHelp = $('manual-customer-receipt-reference-help');
    if (referenceHelp) referenceHelp.textContent = '(optional for cash)';
}

function updateReceiptReferenceHelp() {
    const help = $('manual-customer-receipt-reference-help');
    if (help) help.textContent = $('manual-customer-receipt-method')?.value === 'bank'
        ? '(required for bank)'
        : '(optional for cash)';
}

async function submitManualReceipt(event) {
    event.preventDefault();
    if (state.receiptPending || state.allocationPending || state.reversalPending || state.creditNotePending || state.refundPending) return;
    const customer = selectedCustomer();
    let draft;
    try {
        draft = manualReceiptDraft({
            customerId: state.selectedId,
            customerIsActive: customer?.is_active === true || customer?.is_active === 1,
            ...receiptInputs()
        });
    } catch (_) {
        setReceiptMessage('Check the active customer, exact KES amount, method, reference, and confirmation.', 'error');
        return;
    }

    const idempotencyKey = receiptRetryTracker.keyFor(draft);
    const submission = {
        customerId: draft.customer_id,
        selectionVersion: state.selectionVersion,
        requestVersion: ++state.receiptVersion
    };
    state.receiptPending = true;
    receiptIdentityLock.begin();
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    updateIdentityControls();
    setReceiptMessage('Recording unallocated customer credit…');
    try {
        const result = await api.recordManualCustomerReceipt({ ...draft, idempotency_key: idempotencyKey });
        if (!validManualReceiptResponse(result, draft)) {
            const error = new Error('Manual receipt response could not be verified');
            error.status = 0;
            throw error;
        }
        receiptRetryTracker.clear();
        if (!receiptResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            requestVersion: state.receiptVersion
        })) return;
        resetReceiptForm();
        setReceiptMessage(`Receipt recorded as customer credit (event …${String(result.customer_account_event_id || '').slice(-12)}). It has not been applied to an invoice.`, 'success');
        void loadSettlement(draft.customer_id);
    } catch (error) {
        if (isUncertainReceiptError(error)) receiptRetryTracker.retainUncertain(draft, idempotencyKey);
        else receiptRetryTracker.clear();
        if (!receiptResponseIsCurrent(submission, {
            customerId: state.selectedId,
            selectionVersion: state.selectionVersion,
            requestVersion: state.receiptVersion
        })) return;
        setReceiptMessage(receiptErrorMessage(error), 'error');
    } finally {
        if (submission.requestVersion === state.receiptVersion) {
            state.receiptPending = false;
            receiptIdentityLock.finish();
            updateManualReceiptAvailability();
            updateAllocationAvailability();
            updateAllocationReversalAvailability();
            updateCreditNoteAvailability();
            updateRefundAvailability();
            updateIdentityControls();
        }
    }
}

async function loadSettlement(customerId) {
    if (!customerId || !canAccessCustomerSettlement(window.USER_ROLE)) return;
    state.snapshotVersion += 1;
    state.settlementLoading = true;
    state.settlement = null;
    state.suggestions = null;
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    const loaded = await controller.load(customerId, () => {
        // Never leave a previous customer's money evidence on screen while a
        // new customer identity is selected and its snapshot is pending.
        clearSettlement('Loading customer settlement evidence…');
        setMessage('Loading settlement evidence…');
    });
    if (loaded.stale || customerId !== state.selectedId) return;
    state.settlementLoading = false;
    if (loaded.error || !loaded.settlement || !loaded.suggestions) {
        updateAllocationAvailability();
        updateAllocationReversalAvailability();
        updateCreditNoteAvailability();
        updateRefundAvailability();
        clearSettlement('Customer settlement evidence could not be loaded.');
        setMessage('Customer settlement evidence could not be loaded.', 'error');
        return;
    }
    state.settlement = loaded.settlement;
    state.suggestions = loaded.suggestions;
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    renderSummary(loaded.settlement, loaded.suggestions);
    const timeline = $('customer-settlement-timeline');
    const suggestions = $('customer-settlement-suggestions');
    if (timeline) renderCustomerSettlementTimeline(timeline, loaded.settlement);
    if (suggestions) renderCustomerSettlementSuggestions(suggestions,
        loaded.settlement.status === 'exact' && loaded.suggestions.status === 'exact'
            ? loaded.suggestions
            : { status: 'reconciliation_required' });
    setMessage(loaded.settlement.status === 'exact' && loaded.suggestions.status === 'exact'
        ? ''
        : 'Settlement evidence requires reconciliation before any future action.', 'warning');
}

async function refreshCustomers() {
    if (!canAccessCustomerSettlement(window.USER_ROLE)) return;
    if (!identityCanChange()) return;
    const version = ++state.customerLoadVersion;
    state.customerLoading = true;
    updateIdentityControls();
    const loaded = await controller.loadCustomers(state.includeInactive);
    if (version !== state.customerLoadVersion || loaded.stale) return;
    state.customerLoading = false;
    updateIdentityControls();
    // A refresh that began before a receipt write must not replace the
    // selected identity while that write is still awaiting confirmation.
    if (!identityCanChange()) return;
    if (loaded.error || !Array.isArray(loaded.customers)) {
        setMessage('Customers could not be loaded.', 'error');
        return;
    }
    const previous = state.selectedId;
    state.customers = loaded.customers;
    const select = $('customer-settlement-customer');
    if (select) appendCustomerSettlementOptions(select, loaded.customers);
    const selectedExists = loaded.customers.some(customer => customer.id === previous);
    setSelectedCustomer(selectedExists ? previous : (loaded.customers.find(customer => customer.is_active === true || customer.is_active === 1)?.id || ''));
    if (select) select.value = state.selectedId;
    if (state.selectedId) await loadSettlement(state.selectedId);
    else clearSettlement('Select a stable customer to review recorded settlement evidence.');
}

export function initCustomerSettlementTimelineView() {
    const creditNoteCard = $('customer-credit-note-card');
    if (creditNoteCard) creditNoteCard.style.display = canIssueCustomerCreditNotes(window.USER_ROLE) ? '' : 'none';
    const refundCard = $('customer-refund-card');
    if (refundCard) refundCard.style.display = canIssueCustomerRefunds(window.USER_ROLE) ? '' : 'none';
    $('customer-settlement-customer')?.addEventListener('change', event => {
        if (!identityCanChange()) return;
        setSelectedCustomer(event.target.value);
        if (state.selectedId) void loadSettlement(state.selectedId);
        else clearSettlement('Select a stable customer to review recorded settlement evidence.');
    });
    $('customer-settlement-include-inactive')?.addEventListener('change', event => {
        if (!identityCanChange()) return;
        state.includeInactive = event.target.checked === true;
        void refreshCustomers();
    });
    $('customer-settlement-retry')?.addEventListener('click', () => {
        if (!identityCanChange()) return;
        if (state.selectedId) void loadSettlement(state.selectedId);
        else void refreshCustomers();
    });
    $('manual-customer-receipt-form')?.addEventListener('submit', event => { void submitManualReceipt(event); });
    $('manual-customer-receipt-method')?.addEventListener('change', () => {
        invalidateReceiptRetry();
        updateReceiptReferenceHelp();
    });
    ['manual-customer-receipt-amount', 'manual-customer-receipt-reference', 'manual-customer-receipt-confirm'].forEach(id => {
        $(id)?.addEventListener('input', invalidateReceiptRetry);
        $(id)?.addEventListener('change', invalidateReceiptRetry);
    });
    $('customer-allocation-form')?.addEventListener('submit', event => { void submitCustomerAllocation(event); });
    ['customer-allocation-credit', 'customer-allocation-invoice', 'customer-allocation-amount', 'customer-allocation-confirm'].forEach(id => {
        $(id)?.addEventListener('input', invalidateAllocationRetry);
        $(id)?.addEventListener('change', invalidateAllocationRetry);
    });
    $('customer-allocation-reversal-form')?.addEventListener('submit', event => { void submitCustomerAllocationReversal(event); });
    $('customer-credit-note-form')?.addEventListener('submit', event => { void submitCustomerCreditNote(event); });
    ['customer-credit-note-invoice', 'customer-credit-note-amount', 'customer-credit-note-reason', 'customer-credit-note-reference', 'customer-credit-note-confirm'].forEach(id => {
        $(id)?.addEventListener('input', () => {
            invalidateCreditNoteRetry();
            renderCreditNotePreview();
        });
        $(id)?.addEventListener('change', () => {
            invalidateCreditNoteRetry();
            renderCreditNotePreview();
        });
    });
    $('customer-refund-form')?.addEventListener('submit', event => { void submitCustomerRefund(event); });
    $('customer-refund-method')?.addEventListener('change', () => {
        invalidateRefundRetry();
        renderRefundPreview();
        const help = $('customer-refund-reference-help');
        if (help) help.textContent = $('customer-refund-method')?.value === 'cash' ? '(optional for cash)' : '(required)';
    });
    ['customer-refund-amount', 'customer-refund-reason', 'customer-refund-reference', 'customer-refund-mismatch-confirm', 'customer-refund-confirm'].forEach(id => {
        $(id)?.addEventListener('input', () => { invalidateRefundRetry(); renderRefundPreview(); });
        $(id)?.addEventListener('change', () => { invalidateRefundRetry(); renderRefundPreview(); });
    });
    $('customer-refund-sources')?.addEventListener('input', () => { invalidateRefundRetry(); renderRefundPreview(); });
    $('customer-refund-sources')?.addEventListener('change', () => { invalidateRefundRetry(); renderRefundPreview(); });
    updateReceiptReferenceHelp();
    updateManualReceiptAvailability();
    updateAllocationAvailability();
    updateAllocationReversalAvailability();
    updateCreditNoteAvailability();
    updateRefundAvailability();
    updateIdentityControls();
}

export function loadCustomerSettlementTimeline() {
    if (!canAccessCustomerSettlement(window.USER_ROLE)) return;
    void refreshCustomers();
}
