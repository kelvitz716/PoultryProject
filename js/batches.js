/**
 * @file batches.js
 * @description Batches view module for PoultryDSS.
 * Manages active/completed batch lists, sanitization downtime tracking, cleanout SOPs, and the Batch Closure Wizard.
 */

import { api } from './api.js';
import { store } from './store.js';
import { BATCH_STATUS } from './engine.js';
import { $, showToast } from './ui.js';

const BATCH_CLOSURE_EXCEPTION_CODES = Object.freeze([
    ['inventory_variance', 'Inventory variance'],
    ['ledger_ambiguity', 'Ledger ambiguity'],
    ['documentation_gap', 'Documentation gap'],
    ['external_system_delay', 'External system delay'],
    ['other', 'Other reviewed issue']
]);

function mayCloseBatch() {
    return ['super_admin', 'admin'].includes(window.USER_ROLE);
}

function removeBatchClosureModal(modal) {
    if (modal?.parentNode) modal.parentNode.removeChild(modal);
}

export function initBatchesView() {
    $('btn-clear-all-batches')?.addEventListener('click', () => { window.clearAllBatchesUI(); });
}

async function loadAggregates() {
    return await api.getEntity('poultryAggregates', null) || {};
}

window.refreshBatches = async function() {
    console.log('Refreshing batches view...');
    const batches = store.allBatches;
    const list = $('batches-list');
    if (!list) return;
    
    const clearAllBtn = $('btn-clear-all-batches');
    if (clearAllBtn) {
        clearAllBtn.style.display = window.USER_ROLE === 'farmer' ? 'none' : 'inline-flex';
    }

    let bannerHtml = '';
    const completedBatches = batches.filter(b => b.status === BATCH_STATUS.COMPLETED);
    let latestCloseDate = null;
    for (const b of completedBatches) {
        if (b.closeDate) {
            const d = new Date(b.closeDate);
            if (!latestCloseDate || d > latestCloseDate) {
                latestCloseDate = d;
            }
        }
    }
    if (latestCloseDate) {
        const diffMs = Date.now() - latestCloseDate.getTime();
        const diffDays = diffMs / 86400000;
        if (diffDays < 14) {
            const remainingDays = Math.ceil(14 - diffDays);
            const safeDate = new Date(latestCloseDate.getTime() + 14 * 86400000).toLocaleDateString();
            bannerHtml = `
            <div style="grid-column: 1 / -1; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; background: rgba(245, 158, 11, 0.1); border: 1px solid var(--accent); padding: 12px 16px; border-radius: 8px; color: var(--accent); font-size: 13px; line-height: 1.5; width: 100%; box-sizing: border-box;">
                <i data-lucide="shield-alert" style="width: 18px; height: 18px; flex-shrink: 0; color: var(--accent);"></i>
                <div>
                    <strong>Sanitization Downtime:</strong> ${remainingDays} day(s) remaining of the mandatory 14-day biosecurity cycle. 
                    Safe to start your next cohort on <strong>${safeDate}</strong>.
                </div>
            </div>`;
        }
    }

    const activeBatches = batches.filter(b => b.status === BATCH_STATUS.ACTIVE);
    if (window.USER_ROLE === 'farmer') {
        if (activeBatches.length === 0) {
            list.innerHTML = bannerHtml + `<div class="empty-state"><i data-lucide="shield-alert"></i><p>No active batch — contact your farm manager.</p></div>`;
            lucide.createIcons();
            return;
        }
    }

    if (batches.length === 0) {
        list.innerHTML = bannerHtml + `<div class="empty-state"><i data-lucide="clipboard-list"></i><p>No active batches. Start one from an analysis report.</p></div>`;
        lucide.createIcons();
        return;
    }

    const cardsHtml = await Promise.all(batches.map(async b => {
        const [logs, stagingToday] = await Promise.all([
            api.getLogs(b.id),
            api.getTodayStaging(b.id).catch(() => null)
        ]);
        const stagedEggs = (stagingToday && stagingToday.eggs && stagingToday.eggs.collections && stagingToday.eggs.collections.length > 0);
        const hasEggs = stagedEggs || logs.some(l => (parseInt(l.eggs) || 0) > 0);
        
        const isCompleted = b.status === BATCH_STATUS.COMPLETED;
        let sopHtml = '';
        if (isCompleted) {
            if (b.cleanoutSOP) {
                sopHtml = `<div style="margin-top:12px; font-size:12px; color:var(--success); font-weight:600; text-align:center;"><i data-lucide="check-circle" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Cleanout SOP Audited</div>`;
            } else {
                sopHtml = `<button class="btn btn-primary btn-sm" style="margin-top:12px; width:100%;" onclick="event.stopPropagation(); window.openCleanoutSOP('${b.id}')"><i data-lucide="clipboard-list" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Run Cleanout SOP</button>`;
            }
        }
        return `
        <div class="batch-card" onclick="window.openBatchCockpit(${b.id})">
            <div class="batch-header">
                <span class="batch-badge ${b.status}">${b.status === BATCH_STATUS.POST_BATCH ? 'WINDING DOWN' : b.status.toUpperCase()}</span>
                ${window.USER_ROLE === 'farmer' ? '' : `
                <button class="project-delete" onclick="event.stopPropagation(); window.deleteBatchUI(${b.id})" title="Delete Batch">
                    <i data-lucide="trash-2"></i>
                </button>
                `}
            </div>
            <div style="margin-top: 8px;">
                <h4 style="margin: 0;">${b.name}</h4>
            </div>
            <div class="batch-metrics">
                <div class="m-item"><span>Birds</span><strong>${b.stats?.birdsAlive || b.size}</strong></div>
                <div class="m-item"><span>Status</span><strong>${b.status === BATCH_STATUS.COMPLETED ? 'Completed' : b.status === BATCH_STATUS.POST_BATCH ? 'Winding Down' : (hasEggs ? 'Laying' : 'Growing')}</strong></div>
            </div>
            ${sopHtml}
            <div class="batch-footer">
                <span>Started: ${new Date(b.startDate).toLocaleDateString()}</span>
                <i data-lucide="chevron-right"></i>
            </div>
        </div>
        `;
    }));
    list.innerHTML = bannerHtml + cardsHtml.join('');
    lucide.createIcons();
    await updateBatchLearningUI();
};

export async function updateBatchLearningUI() {
    const snapshots = await api.getSnapshots();
    const content = $('batch-learning-content');
    if (!content) return;
    
    if (snapshots.length === 0) {
        content.innerHTML = `<div class="empty-state"><i data-lucide="brain-circuit"></i><p>Finish your first batch to unlock data-driven recommendations.</p></div>`;
        return;
    }

    const avgFeedArray = snapshots.filter(s => s.avgDailyFeedPerBird > 0).map(s => s.avgDailyFeedPerBird);
    const overallAvgFeed = avgFeedArray.length > 0 ? (avgFeedArray.reduce((a, b) => a + b, 0) / avgFeedArray.length) : 0.12;
    
    const peakWeeks = snapshots.filter(s => s.peakMortalityWeek).map(s => parseInt(s.peakMortalityWeek));
    let commonPeakWeek = 'N/A';
    if (peakWeeks.length > 0) {
        const counts = {};
        let maxCount = 0;
        for (const w of peakWeeks) {
            counts[w] = (counts[w] || 0) + 1;
            if (counts[w] > maxCount) { maxCount = counts[w]; commonPeakWeek = w; }
        }
    }

    // Store global learnings for use in proposal generation
    window.farmLearnings = window.farmLearnings || {};
    window.farmLearnings.layerFeedC = overallAvgFeed * 7;

    content.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:12px; padding: 12px 0;">
            <div style="background:var(--bg-main); padding:16px; border-radius:8px; border-left:4px solid var(--primary);">
                <h4 style="margin:0 0 8px 0; display:flex; align-items:center; gap:6px; color:var(--text-dark);"><i data-lucide="scale" style="width:16px; height:16px; color:var(--primary);"></i> Feed Optimization</h4>
                <p style="margin:0; font-size:13px; color:var(--text-muted);">Your historical feed intake is <strong>${(overallAvgFeed * 1000).toFixed(0)}g</strong>/bird/day (Standard is 120g). We will use this to auto-adjust future financial models.</p>
            </div>
            <div style="background:var(--bg-main); padding:16px; border-radius:8px; border-left:4px solid var(--danger);">
                <h4 style="margin:0 0 8px 0; display:flex; align-items:center; gap:6px; color:var(--text-dark);"><i data-lucide="activity" style="width:16px; height:16px; color:var(--danger);"></i> Health & Mortality Risk</h4>
                <p style="margin:0; font-size:13px; color:var(--text-muted);">Past data shows peak mortality occurs around <strong>Week ${commonPeakWeek}</strong>. Be extra vigilant with brooder heat and coccidiosis checks during this period.</p>
            </div>
        </div>
    `;
    lucide.createIcons();
}

window.updateBatchLearningUI = updateBatchLearningUI;

window.openCleanoutSOP = function(batchId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:500px; padding:24px; position:relative;">
            <button type="button" class="btn btn-secondary btn-sm" style="position:absolute; top:16px; right:16px;" onclick="document.body.removeChild(this.closest('.modal-overlay'))"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
            <h3>House Cleanout SOP</h3>
            <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">Complete this biosecurity checklist before starting a new flock in this house.</p>
            <form id="sop-form" style="display:flex; flex-direction:column; gap:16px;">
                <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                    <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 1: Preparation</h4>
                    <label style="display:flex; gap:8px; font-size:13px; margin-bottom:4px; cursor:pointer;">
                        <input type="checkbox" required> Removed all equipment (feeders, drinkers)
                    </label>
                    <label style="display:flex; gap:8px; font-size:13px; cursor:pointer;">
                        <input type="checkbox" required> Dampened surfaces to minimize airborne dust
                    </label>
                </div>
                <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                    <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 2: Litter Disposal</h4>
                    <label style="display:flex; gap:8px; font-size:13px; margin-bottom:8px; cursor:pointer;">
                        <input type="checkbox" required> Old litter disposed ≥ 1.5 km from house
                    </label>
                    <div class="input-grid">
                        <div class="input-group">
                            <label>Disposal Date</label>
                            <input type="date" id="sop-disp-date" required class="input-md" value="${new Date().toISOString().split('T')[0]}">
                        </div>
                        <div class="input-group">
                            <label>Disposal Site</label>
                            <input type="text" id="sop-disp-site" required class="input-md" placeholder="e.g. Farm edge field">
                        </div>
                    </div>
                </div>
                <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                    <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 3: Wash & Disinfect</h4>
                    <label style="display:flex; gap:8px; font-size:13px; margin-bottom:8px; cursor:pointer;">
                        <input type="checkbox" required> Top-down wash with soap, dried, then disinfected
                    </label>
                    <div class="input-group">
                        <label>Products Used</label>
                        <input type="text" id="sop-products" required class="input-md" placeholder="e.g. Omo, Virocid">
                    </div>
                </div>
                <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                    <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 4: Fresh Litter</h4>
                    <label style="display:flex; gap:8px; font-size:13px; margin-bottom:8px; cursor:pointer;">
                        <input type="checkbox" required> Laid 4 inches (10cm) of fresh, dry litter
                    </label>
                    <div class="input-grid">
                        <div class="input-group">
                            <label>Litter Type</label>
                            <select id="sop-litter-type" class="input-md" required>
                                <option value="Wood Shavings">Wood Shavings</option>
                                <option value="Rice Hulls">Rice Hulls</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label>Litter Source</label>
                            <input type="text" id="sop-litter-src" required class="input-md" placeholder="e.g. Kitale Timber Mill">
                        </div>
                    </div>
                </div>
                
                <button type="submit" class="btn btn-primary" style="margin-top:8px;">Submit Audit Log</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    lucide.createIcons();
    
    $('sop-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const batch = store.allBatches.find(b => String(b.id) === String(batchId));
        if (!batch) return;
        
        batch.cleanoutSOP = {
            date: new Date().toISOString(),
            disposalDate: $('sop-disp-date').value,
            disposalSite: $('sop-disp-site').value,
            productsUsed: $('sop-products').value,
            litterType: $('sop-litter-type').value,
            litterSource: $('sop-litter-src').value
        };
        
        await window.updateBatch(batch);
        document.body.removeChild(modal);
        window.refreshBatches();
    });
};

window.deleteBatchUI = async function(id) {
    console.log('Attempting to delete batch:', id);
    window.showConfirmModal('Are you sure you want to delete this batch and all its records? This cannot be undone.', async () => {
        try {
            await api.deleteBatch(id);
            console.log('Batch deleted from API');
            await window.syncBatches();
            await window.refreshBatches();
        } catch (err) {
            console.error('Error deleting batch:', err);
        }
    });
};

window.clearAllBatchesUI = async function() {
    const batches = await api.getBatches();
    if (batches.length === 0) {
        window.showToast('No active batches to clear.', 'info');
        return;
    }
    
    window.showConfirmModal(`Are you sure you want to delete ALL ${batches.length} active batches and all their records? This cannot be undone.`, async () => {
        try {
            await api.clearAllBatches();
            store.allBatches = []; // Clear cache
            await window.syncBatches();
            await window.refreshBatches();
            if (window.refreshDashboard) window.refreshDashboard();
            window.showToast('All batches cleared successfully.', 'info');
        } catch (err) {
            console.error('Error clearing batches:', err);
            window.showToast('Failed to clear batches.', 'danger');
        }
    });
};

window.finishBatch = async function(batchId) {
    if (!mayCloseBatch()) {
        showToast('Access denied: batch closure requires an administrator.', 'danger');
        return { ok: false, reason: 'access_denied' };
    }
    const batch = store.allBatches.find(item => String(item.id) === String(batchId));
    if (!batch || batch.status === BATCH_STATUS.COMPLETED || batch.closure_review) {
        showToast('This batch is already closed or no longer available for closure.', 'warning');
        return { ok: false, reason: 'batch_unavailable' };
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Close batch review');
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:540px; padding:24px; position:relative;">
            <button type="button" class="btn btn-secondary btn-sm" data-close-dialog style="position:absolute; top:16px; right:16px;">Close</button>
            <h3>Close batch</h3>
            <p style="font-size:13px; color:var(--text-muted); line-height:1.55; margin:8px 0 16px;">This records the final cohort and house identity, then locks the batch from further lifecycle changes. The closure reviewer is recorded from your signed-in account.</p>
            <div style="padding:12px; border-radius:8px; background:var(--bg-main); border:1px solid var(--border-color); margin-bottom:16px; font-size:13px; line-height:1.5;">
                <strong>Before closing:</strong> confirm the batch records are complete. If the ledger has an unresolved item, the system will require a permanent exception reason and review note before it can close.
            </div>
            <p id="batch-closure-error" role="alert" style="display:none; color:var(--danger); font-size:13px; margin:0 0 12px;"></p>
            <form id="batch-closure-form" style="display:flex; flex-direction:column; gap:14px;">
                <label style="display:flex; align-items:flex-start; gap:8px; font-size:13px; line-height:1.45; cursor:pointer;">
                    <input id="batch-closure-confirm" type="checkbox" required style="margin-top:3px;">
                    <span>I have reviewed this batch and understand that closing it creates a permanent review record.</span>
                </label>
                <label style="display:flex; align-items:flex-start; gap:8px; font-size:13px; line-height:1.45; cursor:pointer;">
                    <input id="batch-closure-exception-toggle" type="checkbox" style="margin-top:3px;">
                    <span>Record a reviewed reconciliation exception.</span>
                </label>
                <div id="batch-closure-exception-fields" hidden style="padding:12px; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-main);">
                    <div class="input-group" style="margin-bottom:12px;">
                        <label for="batch-closure-exception-code">Exception reason</label>
                        <select id="batch-closure-exception-code" class="input-md">
                            ${BATCH_CLOSURE_EXCEPTION_CODES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="input-group">
                        <label for="batch-closure-exception-note">Review note</label>
                        <textarea id="batch-closure-exception-note" class="input-md" maxlength="500" rows="3" placeholder="State what remains to be reviewed and why closure is permitted."></textarea>
                    </div>
                </div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
                    <button type="button" class="btn btn-secondary" data-close-dialog>Cancel</button>
                    <button id="batch-closure-submit" type="submit" class="btn btn-primary">Close batch</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    lucide.createIcons();

    const form = modal.querySelector('#batch-closure-form');
    const error = modal.querySelector('#batch-closure-error');
    const exceptionToggle = modal.querySelector('#batch-closure-exception-toggle');
    const exceptionFields = modal.querySelector('#batch-closure-exception-fields');
    const exceptionCode = modal.querySelector('#batch-closure-exception-code');
    const exceptionNote = modal.querySelector('#batch-closure-exception-note');
    const submit = modal.querySelector('#batch-closure-submit');
    modal.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => removeBatchClosureModal(modal)));
    exceptionToggle.addEventListener('change', () => {
        exceptionFields.hidden = !exceptionToggle.checked;
        exceptionNote.required = exceptionToggle.checked;
        if (exceptionToggle.checked) exceptionNote.focus();
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const reconciliationException = exceptionToggle.checked ? {
            code: exceptionCode.value,
            note: exceptionNote.value.trim()
        } : null;
        error.style.display = 'none';
        submit.disabled = true;
        submit.textContent = 'Closing…';
        const result = await api.closeBatch(batchId, reconciliationException);
        if (result.ok) {
            removeBatchClosureModal(modal);
            try {
                await window.syncBatches();
                await window.refreshBatches();
                if (window.refreshDashboard) await window.refreshDashboard();
                if (window.openBatchCockpit) await window.openBatchCockpit(batchId);
            } catch (refreshError) {
                console.error('Batch was closed but the local view could not refresh:', refreshError);
            }
            showToast(result.body?.unresolved_count > 0
                ? 'Batch closed with a permanent reconciliation exception review.'
                : 'Batch closed and its review record was saved.', 'success');
            return;
        }
        if (result.status === 409 && !exceptionToggle.checked) {
            exceptionToggle.checked = true;
            exceptionFields.hidden = false;
            exceptionNote.required = true;
            exceptionNote.focus();
            error.textContent = 'An unresolved reconciliation item needs a reviewed exception reason and note before this batch can close.';
        } else if (result.status === 403) {
            error.textContent = 'Your account is not authorised to close batches.';
        } else if (result.status === 409) {
            error.textContent = 'The batch could not be closed. It may already be closed or require a refreshed review.';
        } else {
            error.textContent = 'Batch closure was not completed. Check the batch identity and try again.';
        }
        error.style.display = 'block';
        submit.disabled = false;
        submit.textContent = exceptionToggle.checked ? 'Close with reviewed exception' : 'Close batch';
    });
    modal.querySelector('#batch-closure-confirm').focus();
    return { ok: true, reason: 'review_opened' };
};
export async function renderBatchLearning(snapshots) {
    const container = $('batch-learning-content');
    if (!container || snapshots.length === 0) return;

    const agg = await loadAggregates();
    const avgPeak = snapshots.reduce((sum, s) => sum + (s.avgLayRate || 0), 0) / snapshots.length;
    const avgFC = snapshots.reduce((sum, s) => sum + (s.feedConversion || 0), 0) / snapshots.length;

    // Seasonality detection logic
    let seasonalityHtml = '';
    if (agg.avgLayRateByMonth) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const sortedMonths = Object.keys(agg.avgLayRateByMonth).sort((a,b) => (agg.avgLayRateByMonth[a].sum/agg.avgLayRateByMonth[a].count) - (agg.avgLayRateByMonth[b].sum/agg.avgLayRateByMonth[b].count));
        if (sortedMonths.length > 3) {
            const worst = sortedMonths[0];
            const worstMonth = months[worst];
            const avgWorst = (agg.avgLayRateByMonth[worst].sum / agg.avgLayRateByMonth[worst].count * 100).toFixed(0);
            seasonalityHtml = `<li><i data-lucide="thermometer-sun" class="text-danger"></i> <strong>Seasonal Pattern:</strong> Production typically drops in <strong>${worstMonth}</strong> (${avgWorst}% lay rate). Avoid starting new batches in this month.</li>`;
        }
    }

    container.innerHTML = `
        <ul class="learning-list">
            <li><i data-lucide="award" class="text-success"></i> <strong>Peak Performance:</strong> Based on ${snapshots.length} batches, your expected peak lay rate is <strong>${(avgPeak * 100).toFixed(1)}%</strong>.</li>
            <li><i data-lucide="trending-down" class="text-primary"></i> <strong>Efficiency Baseline:</strong> Your optimal Feed Conversion is <strong>${avgFC.toFixed(2)}kg/doz</strong>. Aim for this in new flocks.</li>
            ${seasonalityHtml}
            <li><i data-lucide="clock" class="text-accent"></i> <strong>Replacement Strategy:</strong> Your highest profitability occurs between months 4 and 10 of laying.</li>
        </ul>
    `;
    lucide.createIcons();
}

window.renderBatchLearning = renderBatchLearning;
