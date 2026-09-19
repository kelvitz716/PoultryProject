export const BATCH_CLOSURE_UNAVAILABLE_MESSAGE =
    'Batch closure is unavailable pending an explicit disposal and reconciliation contract. No records were changed.';

export function blockBatchClosure(notify = () => {}) {
    notify(BATCH_CLOSURE_UNAVAILABLE_MESSAGE, 'warning');
    return Object.freeze({
        ok: false,
        reason: 'closure_contract_required',
        recordsChanged: false
    });
}
