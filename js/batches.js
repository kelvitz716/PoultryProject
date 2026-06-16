/**
 * @file batches.js
 * @description Batches view module for PoultryDSS.
 * Manages active/completed batch lists, sanitization downtime tracking, cleanout SOPs, and the Batch Closure Wizard.
 */

import { api } from './api.js';
import { store } from './store.js';
import { BATCH_STATUS, computeKPIs, computeEggInventoryAging } from './engine.js';
import { $, showToast, showConfirmModal } from './ui.js';

export function initBatchesView() {
    $('btn-clear-all-batches')?.addEventListener('click', () => { window.clearAllBatchesUI(); });
}

async function loadAggregates() {
    return await api.getEntity('poultryAggregates', null) || {};
}

async function saveAggregates(agg) {
    await api.setEntity('poultryAggregates', agg);
}

window.refreshBatches = async function() {
    console.log('Refreshing batches view...');
    const batches = store.allBatches;
    const list = $('batches-list');
    if (!list) return;
    
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
                <button class="project-delete" onclick="event.stopPropagation(); window.deleteBatchUI(${b.id})" title="Delete Batch">
                    <i data-lucide="trash-2"></i>
                </button>
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

window.finishBatch = async function(id) {
    const batches = store.allBatches;
    const batch = batches.find(b => String(b.id) === String(id));
    if (!batch) {
        console.error("Batch not found for id:", id);
        return;
    }
    
    const logs = await api.getLogs(id);
    const txs = await api.getTransactions(id);
    const stagingToday = await api.getTodayStaging(id).catch(() => null);
    const kpis = computeKPIs(logs, txs, batch, store.farmProfile, stagingToday);
    
    // 1. Inventory Math
    const birdsAlive = kpis.currentBirds;
    const inventoryAging = computeEggInventoryAging(logs, txs, stagingToday);
    const unsoldEggs = inventoryAging.totalUnsold;
    
    const totalFeedPurchased = txs.filter(t => t.type === 'purchase' && t.category.toLowerCase() === 'feed').reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
    const feedWrittenOff = txs.filter(t => t.type === 'write_off' && t.category === 'feed').reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
    const feedRemaining = Math.max(0, totalFeedPurchased - kpis.totalFeed - feedWrittenOff);
    
    const revenue = txs.filter(t => t.type === 'sale').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
    const expenses = txs.filter(t => t.type === 'purchase').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
    const unpaidAR = txs.filter(t => t.status === 'unpaid' && t.type === 'sale').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
    
    const durationDays = Math.floor((new Date() - new Date(batch.startDate)) / 86400000);
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'closure-modal';
    
    let step1Html = `
        <div class="closure-step active" id="c-step-1">
            <p style="margin-bottom:16px; color:var(--text-muted);">Review the final state of this batch before closing.</p>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Birds Alive</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${birdsAlive}</div></div>
                <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Unsold Eggs</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${unsoldEggs.toLocaleString()}</div></div>
                <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Feed Remaining</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${feedRemaining.toFixed(1)} kg</div></div>
                <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Cash Balance</div><div style="font-weight:700; font-size:18px; color:${revenue-expenses >= 0 ? 'var(--primary)' : 'var(--danger)'};">KES ${(revenue-expenses).toLocaleString()}</div></div>
                <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Unpaid AR</div><div style="font-weight:700; font-size:18px; color:var(--accent);">KES ${unpaidAR.toLocaleString()}</div></div>
                <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Duration</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${durationDays} days</div></div>
            </div>
        </div>
    `;
    
    let step2Html = `
        <div class="closure-step" id="c-step-2" style="display:none;">
            <p style="margin-bottom:16px; color:var(--text-muted);">How do you want to handle remaining inventory?</p>
            
            ${birdsAlive > 0 ? `
            <div class="card" style="padding:16px; margin-bottom:12px;">
                <h4 style="margin-top:0; margin-bottom:8px; color:var(--text-dark);"><i data-lucide="bird" style="width:14px;height:14px; color:var(--text-muted);"></i> Birds (${birdsAlive})</h4>
                <select id="disp-birds" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark); margin-bottom:8px;" onchange="document.getElementById('disp-birds-price').style.display = this.value === 'sell' ? 'block' : 'none';">
                    <option value="sell">Sell as Spent Layers (Log sale)</option>
                    <option value="cull">Cull / Dispose (Log mortality)</option>
                    <option value="transfer">Transfer to another batch</option>
                </select>
                <div id="disp-birds-price" style="display:block;">
                    <label style="font-size:11px; color:var(--text-muted);">Total Sale Amount (KES)</label>
                    <input type="number" id="disp-birds-amt" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                </div>
            </div>` : ''}

            ${unsoldEggs > 0 ? `
            <div class="card" style="padding:16px; margin-bottom:12px;">
                <h4 style="margin-top:0; margin-bottom:8px; color:var(--text-dark);"><i data-lucide="egg" style="width:14px;height:14px; color:var(--text-muted);"></i> Unsold Eggs (${unsoldEggs})</h4>
                <select id="disp-eggs" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                    <option value="carry_over">Keep batch in 'Winding Down' mode to sell later</option>
                    <option value="sell_now">All sold now (I will log a sale before closing)</option>
                    <option value="write_off">Write off as waste / expired</option>
                </select>
            </div>` : ''}

            ${feedRemaining > 5 ? `
            <div class="card" style="padding:16px;">
                <h4 style="margin-top:0; margin-bottom:8px; color:var(--text-dark);"><i data-lucide="package" style="width:14px;height:14px; color:var(--text-muted);"></i> Feed Remaining (${feedRemaining.toFixed(1)} kg)</h4>
                <select id="disp-feed" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                    <option value="transfer">Transfer to next batch (No accounting change)</option>
                    <option value="sell">Sold / Given away</option>
                    <option value="write_off">Write off / Spoiled</option>
                </select>
            </div>` : ''}
            
            ${(birdsAlive === 0 && unsoldEggs === 0 && feedRemaining <= 5) ? '<div class="empty-state">No remaining inventory to disposition.</div>' : ''}
        </div>
    `;
    
    let step3Html = `
        <div class="closure-step" id="c-step-3" style="display:none;">
            <div class="card" style="padding:16px; background:var(--primary-soft); border:1px solid var(--primary); text-align:center; margin-bottom:16px;">
                <h3 style="color:var(--primary); margin-top:0;">Ready to Close Batch</h3>
                <p style="font-size:12px; margin-bottom:0;">This will lock the batch records, generate a Success Snapshot, and update farm aggregates.</p>
            </div>
        </div>
    `;

    modal.innerHTML = `
        <div class="modal-content" style="max-width:500px; padding:24px; border-radius:12px; background:var(--bg-white); border:1px solid var(--border-color); box-shadow:var(--shadow-lg);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="margin:0; color:var(--text-dark);">Batch Closure Wizard</h3>
                <span id="c-step-badge" style="font-size:12px; font-weight:700; background:var(--bg-main); color:var(--text-muted); padding:4px 8px; border-radius:12px; border:1px solid var(--border-color);">Step 1 of 3</span>
            </div>
            
            <div id="c-steps-container">
                ${step1Html}
                ${step2Html}
                ${step3Html}
            </div>
            
            <div style="display:flex; gap:12px; margin-top:24px;">
                <button type="button" class="btn btn-secondary" id="c-btn-cancel" style="flex:1;">Cancel</button>
                <button type="button" class="btn btn-primary" id="c-btn-next" style="flex:1;">Next Step</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    lucide.createIcons();

    let currentStep = 1;
    
    const updateStepView = () => {
        document.getElementById('c-step-1').style.display = currentStep === 1 ? 'block' : 'none';
        document.getElementById('c-step-2').style.display = currentStep === 2 ? 'block' : 'none';
        document.getElementById('c-step-3').style.display = currentStep === 3 ? 'block' : 'none';
        document.getElementById('c-step-badge').innerText = `Step ${currentStep} of 3`;
        document.getElementById('c-btn-next').innerText = currentStep === 3 ? 'Finalize Batch' : 'Next Step';
        document.getElementById('c-btn-cancel').innerText = currentStep === 1 ? 'Cancel' : 'Back';
    };

    document.getElementById('c-btn-cancel').addEventListener('click', () => {
        if (currentStep > 1) {
            currentStep--;
            updateStepView();
        } else {
            document.body.removeChild(modal);
        }
    });

    document.getElementById('c-btn-next').addEventListener('click', async () => {
        if (currentStep < 3) {
            currentStep++;
            updateStepView();
            return;
        }
        
        // EXECUTE FINALIZATION
        document.getElementById('c-btn-next').disabled = true;
        document.getElementById('c-btn-next').innerText = 'Processing...';
        
        // 1. Process Bird Disposition
        if (birdsAlive > 0) {
            const bDisp = document.getElementById('disp-birds').value;
            if (bDisp === 'sell') {
                const amt = parseFloat(document.getElementById('disp-birds-amt').value) || 0;
                await api.saveTransaction(batch.id, {
                    id: Date.now().toString() + 'b', date: new Date().toISOString(),
                    type: 'sale', category: 'spent', qty: birdsAlive, amount: amt, status: 'paid',
                    notes: 'Final batch spent layer clearance'
                });
            } else if (bDisp === 'cull') {
                await api.saveLog(batch.id, {
                    id: Date.now().toString() + 'l', date: new Date().toISOString().split('T')[0],
                    birds: 0, morning:0, evening:0, other:0, eggs:0, feedGiven:0,
                    notes: `End of batch culling: ${birdsAlive} birds`
                });
            }
            batch.stats.birdsAlive = 0;
        }

        // 2. Process Egg Disposition
        let willSoftClose = false;
        if (unsoldEggs > 0) {
            const eDisp = document.getElementById('disp-eggs').value;
            if (eDisp === 'carry_over') {
                willSoftClose = true;
            } else if (eDisp === 'write_off') {
                await api.saveTransaction(batch.id, {
                    id: Date.now().toString() + 'e', date: new Date().toISOString(),
                    type: 'write_off', category: 'eggs', qty: unsoldEggs, amount: 0, status: 'paid',
                    reason: 'expired', notes: 'End of batch write-off'
                });
            }
        }

        // 3. Process Feed Disposition
        if (feedRemaining > 5) {
            const fDisp = document.getElementById('disp-feed').value;
            if (fDisp === 'write_off') {
                await api.saveTransaction(batch.id, {
                    id: Date.now().toString() + 'f', date: new Date().toISOString(),
                    type: 'write_off', category: 'feed', qty: feedRemaining, amount: 0, status: 'paid',
                    reason: 'spoiled', notes: 'End of batch feed disposal'
                });
            }
        }
        
        // Finalize Snapshot and Update DB
        const finalTxs = await api.getTransactions(batch.id);
        const feedTxs = finalTxs.filter(t => t.category.toLowerCase() === 'feed');
        const avgFeedPrice = feedTxs.length > 0 ? (feedTxs.reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0) / feedTxs.reduce((sum, t) => sum + (parseFloat(t.qty)||0), 0)) : store.farmProfile.defaultFeedPrice / store.farmProfile.sackWeightKg;
        const eggSales = finalTxs.filter(t => t.category.toLowerCase() === 'eggs' && t.type === 'sale');
        const avgEggPrice = eggSales.length > 0 ? (eggSales.reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0) / eggSales.reduce((sum, t) => sum + (parseFloat(t.qty)||0), 0)) : 15;
        const finalRev = finalTxs.filter(t => t.type === 'sale').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
        const finalExp = finalTxs.filter(t => t.type === 'purchase').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
        
        if (!willSoftClose) {
            // Calculate Learning Metrics
            const totalBirdDays = logs.reduce((s, l) => s + (l.birds || batch.size), 0);
            const batchTotalFeed = logs.reduce((s, l) => s + (parseFloat(l.feed) || 0), 0);
            const avgDailyFeedPerBird = totalBirdDays > 0 ? (batchTotalFeed / totalBirdDays) : 0.12;

            const weeklyMortality = {};
            logs.forEach(l => {
                if (l.mortality > 0) {
                    const daysDiff = Math.floor((new Date(l.date) - new Date(batch.startDate)) / 86400000);
                    const week = Math.floor(daysDiff / 7) + 1;
                    weeklyMortality[week] = (weeklyMortality[week] || 0) + l.mortality;
                }
            });
            let peakMortalityWeek = null;
            let maxMortality = 0;
            for (const [w, m] of Object.entries(weeklyMortality)) {
                if (m > maxMortality) { maxMortality = m; peakMortalityWeek = w; }
            }

            const snapshot = {
                id: Date.now(), batchId: batch.id, batchName: batch.name, type: batch.type, birds: batch.size,
                avgFeedPrice, avgEggPrice, avgLayRate: kpis.avg7LayRate, feedConversion: kpis.feedConversion,
                totalProfit: finalRev - finalExp, date: new Date().toISOString(),
                avgDailyFeedPerBird, peakMortalityWeek
            };
            await updateAggregates(batch, logs, finalTxs, kpis);
            await api.saveSnapshot(snapshot);
            batch.status = BATCH_STATUS.COMPLETED;
            batch.closeDate = new Date().toISOString();
        } else {
            batch.status = BATCH_STATUS.POST_BATCH;
        }

        await api.saveBatch(batch);
        document.body.removeChild(modal);
        window.switchView('batches');
        window.showToast(willSoftClose ? 'Batch moved to Winding Down. Only egg sales are permitted.' : 'Batch completed! Success snapshot and farm aggregates updated.');
    });
};

async function updateAggregates(batch, logs, txs, kpis) {
    const agg = await loadAggregates();
    agg.batchCount = (agg.batchCount || 0) + 1;
    if (!agg.avgLayRateByMonth) agg.avgLayRateByMonth = {};
    
    // 1. Avg Feed Conversion (Rolling)
    agg.avgFeedConversion = (agg.avgFeedConversion * (agg.batchCount-1) + kpis.feedConversion) / agg.batchCount;
    
    // 2. Lay Rate by Month (Seasonality)
    logs.forEach(l => {
        const month = new Date(l.date).getMonth(); // 0-11
        if (!agg.avgLayRateByMonth[month]) agg.avgLayRateByMonth[month] = { sum: 0, count: 0 };
        agg.avgLayRateByMonth[month].sum += (l.eggs / (l.birds || 1));
        agg.avgLayRateByMonth[month].count += 1;
    });

    await saveAggregates(agg);
}

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
