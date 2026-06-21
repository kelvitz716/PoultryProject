/**
 * @file cockpit.js
 * @description Cockpit view module for PoultryDSS.
 * Manages the live batch cockpit dashboard view, environment sensors sync,
 * daily logs entries, manual transactions recording, and dev simulation flows.
 * Note: Analytics rendering is managed by the main app shell (js/app.js) via the global window.renderAnalytics function.
 */

import { api } from './api.js';
import { store } from './store.js';
import {
    ISA_BROWN_CONSTANTS,
    KENCHIC_SCHEDULE,
    getKitaleSeason,
    parseEggTrackerCSV,
    computeKPIs,
    computeEggInventoryAging,
    computeTHI,
    getHeatStressStatus,
    BATCH_STATUS
} from './engine.js';
import { $, showToast, updateGlobalNotifications } from './ui.js';
import { getActiveWithdrawal } from './health.js';

let _eggCollections = [];
let _sensorPopoverChartInstance = null;

export function initCockpitView() {
    console.log('Initializing Cockpit View...');
    // Register global event listener for positioning the sensor popover on resize
    window.addEventListener('resize', () => {
        if (document.getElementById('sensor-popover')?.style.display === 'block') {
            window.positionSensorPopover();
        }
    });
}

// Bind to window for global compatibility
window.markLitterChanged = function() {
    store.farmProfile.litterLastChanged = new Date().toISOString();
    store.saveFarmProfile(store.farmProfile);
    const batch = window.getBatches().find(b => String(b.id) === String(store.currentBatchId));
    if (batch) window.refreshCockpitData(batch);
};

window.openBatchCockpit = async function(id) {
    const batch = window.getBatches().find(b => String(b.id) === String(id));
    if (!batch) return;
    store.currentBatchId = id;
    window.currentHistoryLimit = 10;
    
    const logs = await api.getLogs(id);
    const dayCount = logs.length;
    const targetDays = batch.type === 'layer' ? 504 : 42;
    const progressPercent = Math.min(100, (dayCount / targetDays) * 100);
    const hens = batch.stats?.birdsAlive || batch.size;

    const cockpit = $('view-batch-cockpit');
    cockpit.innerHTML = `
        <div class="cockpit-header" style="display:flex; flex-direction:column; gap:16px; margin-bottom:24px;">
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px;">
                <div style="display:flex; align-items:center; gap:16px;">
                    <button class="btn btn-secondary btn-sm" onclick="window.switchView('batches')" style="height:36px; padding:0 12px; border-radius:8px;">
                        <i data-lucide="arrow-left"></i>
                    </button>
                    <div>
                        <h2 style="margin:0; font-size:22px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                            ${batch.name} 
                            <span class="pill" style="font-size:12px; font-weight:600; padding:4px 10px; background:var(--primary-soft); color:var(--primary); line-height:1;">
                                <i data-lucide="bird" style="width:12px; height:12px; margin-right:4px; display:inline-block; vertical-align:text-top;"></i>${hens}
                            </span>
                        </h2>
                        <p style="margin:6px 0 0; font-size:13px; color:var(--text-muted); display:flex; align-items:center; gap:8px;">
                            <strong style="color:var(--text-dark);">Day ${dayCount} / ${targetDays}</strong>
                            <span style="color:#d1d5db;">|</span>
                            <span style="text-transform:uppercase; letter-spacing:0.5px; font-size:11px; font-weight:600;">${batch.type}</span>
                            <span style="color:#d1d5db;">|</span>
                            <span>${Math.round(progressPercent)}% of cycle</span>
                        </p>
                    </div>
                </div>
                
                <div class="cockpit-actions" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                    <button class="btn btn-secondary btn-sm" onclick="window.open('/api/export/${batch.id}', '_blank')">
                        <i data-lucide="download" style="width:14px; height:14px;"></i> Export
                    </button>
                    ${batch.status === BATCH_STATUS.COMPLETED ? `
                    <span class="pill" style="background:var(--primary-soft); color:var(--primary); font-weight:bold; border:1px solid var(--primary);">Completed</span>
                    ` : batch.status === BATCH_STATUS.POST_BATCH ? `
                    <span class="pill" style="background:#fef3c7; color:#d97706; font-weight:bold; border:1px solid #fcd34d;">Winding Down</span>
                    ` : window.USER_ROLE === 'viewer' ? '' : `
                    <button class="btn btn-secondary btn-sm" onclick="window.openCSVImportModal(${batch.id})">
                        <i data-lucide="upload" style="width:14px; height:14px;"></i> Import
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="window.openBackfillModal(${batch.id})">
                        <i data-lucide="calendar-plus" style="width:14px; height:14px;"></i> Backfill
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="window.markLitterChanged()">
                        <i data-lucide="leaf" style="width:14px; height:14px;"></i> Litter Done
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="window.finishBatch(${batch.id})" style="margin-left:8px;">
                        <i data-lucide="flag" style="width:14px; height:14px;"></i> Snapshot
                    </button>
                    `}
                </div>
            </div>
            
            <div style="background:var(--bg-main); border-radius:8px; height:8px; overflow:hidden; border:1px solid var(--border-color); width:100%;">
                <div style="height:100%; background:var(--primary); width:${progressPercent}%; transition:width 0.5s ease-out; border-radius:8px;"></div>
            </div>
        </div>

        <!-- KPI Row: Spec §4.2 -->
        <div class="kpi-row">
            <div class="kpi-card">
                <span class="label">Today's Lay Rate</span>
                <span class="value" id="kpi-layrate">—</span>
                <div class="trend-row" id="trend-layrate"></div>
            </div>
            <div class="kpi-card">
                <span class="label">7-Day Avg Lay Rate</span>
                <span class="value" id="kpi-avg7">—</span>
                <div class="trend-row" id="trend-avg7"></div>
            </div>
            <div class="kpi-card">
                <span class="label">Feed Conversion (7d)</span>
                <span class="value" id="kpi-fc">—</span>
                <div class="trend-row" id="trend-fc">kg per dozen eggs</div>
            </div>
            <div class="kpi-card">
                <span class="label">Projected This Month</span>
                <span class="value" id="kpi-projected">—</span>
                <div class="trend-row" id="trend-projected">eggs remaining</div>
            </div>
        </div>

        <!-- Secondary Info Bar -->
        <div class="info-bar" id="info-bar">
            <div class="info-chip" id="info-birds-chip" style="cursor:pointer;" onclick="window.showAdjustFlockModal()" title="Click to adjust flock composition">
                <i data-lucide="bird" style="width:14px;height:14px;"></i> 
                <strong id="info-birds">${hens}</strong> birds alive 
                <span id="info-birds-breakdown" style="font-size:11px; margin-left:4px; opacity:0.85;">(Hens: 0, Roosters: 0)</span>
                <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:4px;opacity:0.6;"></i>
            </div>
            <div class="info-chip"><i data-lucide="package" style="width:14px;height:14px;"></i> Feed: <strong id="info-feed">0 kg</strong></div>
            <div class="info-chip"><i data-lucide="wallet" style="width:14px;height:14px;"></i> Cash: <strong id="info-cash">KES 0</strong></div>
            <div class="info-chip"><i data-lucide="wallet" style="width:14px;height:14px;"></i> Credit: <strong id="info-credit">KES 0</strong></div>
            <div class="info-chip"><i data-lucide="egg" style="width:14px;height:14px;"></i> Total: <strong id="info-totaleggs">0</strong> <span id="info-unsoldeggs" style="font-size:11px; margin-left:4px;">(0 in stock)</span></div>
            <div class="info-chip" style="cursor:pointer;" onclick="window.showEggLossModal()" title="Click to view Egg Loss & Reconciliation details">
                <i data-lucide="alert-triangle" style="width:14px;height:14px;color:var(--danger, #ef4444);"></i> 
                Losses: <strong id="info-egg-losses">0</strong> 
                <span id="info-egg-losses-breakdown" style="font-size:11px; margin-left:4px; opacity:0.85;">(0 harvest, 0 storage)</span>
            </div>
            <div class="info-chip" id="info-sensor-container" style="display:none; cursor:pointer;" onclick="window.triggerSensorSync()">
                <i data-lucide="thermometer" style="width:14px;height:14px;"></i> 
                Coop: <strong id="info-sensor-temp">— °C</strong> / <strong id="info-sensor-hum">—% RH</strong> 
                <span id="info-sensor-battery" style="font-size:10px; margin-left:6px; color:var(--text-muted);"></span>
                <span id="info-sensor-sync" style="font-size:9px; margin-left:6px; color:var(--text-muted);"></span>
            </div>
            <div class="info-chip" id="info-discard-container" style="display:none; background:#fee2e2; color:#dc2626; border:1px solid #fca5a5;">
                <i data-lucide="trash-2" style="width:14px;height:14px;"></i> Discard: <strong id="info-discard">0 days</strong>
            </div>
            <div class="info-chip" id="info-shelflife-container" style="display:none; border:1px solid var(--accent); color:var(--text-dark);">
                <i data-lucide="clock" style="width:14px;height:14px;color:var(--accent);"></i> Expiring: <strong id="info-shelflife">0 eggs</strong>
            </div>
        </div>

        <!-- Main Cockpit Grid: matches spec §5.1, perfectly symmetric rows -->
        <div class="cockpit-grid-spec">
            <!-- ROW 1 -->
            <div class="card log-form-card" style="height:100%; display:flex; flex-direction:column; position:relative;">
                ${batch.status === BATCH_STATUS.POST_BATCH || batch.status === BATCH_STATUS.COMPLETED || window.USER_ROLE === 'viewer' ? `
                <div style="position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.4); backdrop-filter:blur(2px); z-index:10; display:flex; align-items:center; justify-content:center; border-radius:8px;">
                    <span style="background:#fef3c7; color:#d97706; font-weight:bold; border:1px solid #fcd34d; padding:8px 16px; border-radius:8px; display:flex; align-items:center;"><i data-lucide="lock" style="width:14px;height:14px;margin-right:6px;"></i>Daily Logging Disabled (${window.USER_ROLE === 'viewer' ? 'Read-Only Viewer' : batch.status === BATCH_STATUS.COMPLETED ? 'Completed' : 'Winding Down'})</span>
                </div>
                ` : ''}
                <div class="card-header">
                    <h3><i data-lucide="clipboard-check" style="width:18px;height:18px;"></i> Today's Log</h3>
                    <input type="date" id="log-date" value="${new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0]}" max="${new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0]}" class="input-sm" style="width:auto;" onchange="window.handleLogDateChange()">
                </div>
                <div class="log-form-grid" style="flex:1;">
                    <div class="log-field" style="grid-column:1/-1;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <label style="margin:0;">🥚 Egg Collections</label>
                            <div style="display:flex;align-items:center;gap:10px;">
                                <span id="egg-total-display" style="font-size:1.4rem;font-weight:800;color:var(--primary);">0 eggs</span>
                                <button type="button" id="btn-add-collection" onclick="window.addEggCollection()" class="btn btn-secondary btn-sm" style="padding:4px 12px;">
                                    <i data-lucide="plus" style="width:13px;height:13px;"></i> Add Collection
                                </button>
                            </div>
                        </div>
                        <div id="egg-collection-list" style="display:flex;flex-direction:column;gap:6px;min-height:32px;">
                            <div id="egg-empty-hint" style="opacity:0.45;font-size:0.82rem;margin:0;font-style:italic;">
                                No collections yet — tap Add Collection to log your first round.
                                <span style="display:block; margin-top:4px; font-size:11px; color:var(--primary); font-weight:500; font-style:normal;">Logging for a past date? Change the date above ↑</span>
                            </div>
                        </div>
                    </div>

                    <div class="log-field">
                        <label>Sacks Opened Today <span style="font-size:10px;color:var(--text-muted);font-weight:400;">(full bags consumed)</span></label>
                        <input type="number" id="log-sacks" value="0" min="0" class="input-md" onfocus="this.select()" oninput="window._onSacksInput(this)">
                        <span class="field-hint">Each sack = ${store.farmProfile.sackWeightKg}kg. Entering sacks locks the kg field.</span>
                    </div>
                    <div class="log-field">
                        <label>Feed Given (kg) <span style="font-size:10px;color:var(--text-muted);font-weight:400;" id="feed-kg-hint">— or enter sacks above</span></label>
                        <input type="number" id="log-feed" step="0.1" placeholder="Leave blank if entering sacks" class="input-md" onfocus="this.select()" oninput="window._onFeedKgInput(this)">
                    </div>
                    <div class="log-field" style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
                        <div style="display:flex; flex-direction:column;">
                            <label>Hen Deaths</label>
                            <input type="number" id="log-mortality-hens" value="0" min="0" class="input-md" style="color:var(--danger); font-weight:bold;" onfocus="this.select()" oninput="document.getElementById('log-mortality').value = parseInt(this.value || 0) + parseInt(document.getElementById('log-mortality-roosters').value || 0)">
                        </div>
                        <div style="display:flex; flex-direction:column;">
                            <label>Rooster Deaths</label>
                            <input type="number" id="log-mortality-roosters" value="0" min="0" class="input-md" style="color:var(--danger); font-weight:bold;" onfocus="this.select()" oninput="document.getElementById('log-mortality').value = parseInt(document.getElementById('log-mortality-hens').value || 0) + parseInt(this.value || 0)">
                        </div>
                        <input type="number" id="log-mortality" value="0" style="opacity:0.01; position:absolute; width:1px; height:1px; pointer-events:none; padding:0; margin:0; border:0;" oninput="document.getElementById('log-mortality-hens').value = this.value">
                        <input type="hidden" id="log-birds" value="${hens}">
                    </div>
                    <div class="log-field" style="grid-column: 1 / -1; margin-top: 4px; border-top: 1px dashed var(--border-color); padding-top: 8px;">
                        <div id="toggle-advanced-air" onclick="const f = document.getElementById('advanced-air-fields'); const c = document.getElementById('advanced-air-chevron'); const isCollapsed = f.style.display === 'none'; f.style.display = isCollapsed ? 'grid' : 'none'; c.style.transform = isCollapsed ? 'rotate(90deg)' : 'rotate(0deg)';" style="cursor:pointer; display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--primary); user-select:none;">
                            <span id="advanced-air-chevron" style="display:inline-flex; align-items:center; justify-content:center; transition: transform 0.2s;"><i data-lucide="chevron-right" style="width:14px; height:14px;"></i></span>
                            Advanced Air Quality (NH₃, CO₂)
                        </div>
                        <div id="advanced-air-fields" style="display:none; margin-top:12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:16px;">
                            <div class="log-field" style="margin:0;">
                                <label>NH₃ Morning Peak (ppm – pre-ventilation)</label>
                                <input type="number" id="log-nh3" placeholder="Optional" class="input-md" onfocus="this.select()">
                            </div>
                            <div class="log-field" style="margin:0;">
                                <label>CO₂ Morning Peak (ppm – pre-ventilation)</label>
                                <input type="number" id="log-co2" placeholder="Optional" class="input-md" onfocus="this.select()">
                            </div>
                        </div>
                    </div>
                    <div class="log-field">
                        <label>Temp (°C) <span id="sensor-badge-temp" style="font-size:10px; color:var(--primary); cursor:pointer; margin-left:4px; font-weight:normal; border-bottom:1px dashed var(--primary); display:none;"></span></label>
                        <input type="number" id="log-temp" step="0.1" placeholder="Optional" class="input-md" onfocus="this.select()">
                        <span id="log-temp-hint" class="field-hint" style="display:none;"></span>
                    </div>
                    <div class="log-field">
                        <label>Humidity (%) <span id="sensor-badge-hum" style="font-size:10px; color:var(--primary); cursor:pointer; margin-left:4px; font-weight:normal; border-bottom:1px dashed var(--primary); display:none;"></span></label>
                        <input type="number" id="log-humidity" placeholder="Optional" class="input-md" min="0" max="100" onfocus="this.select()">
                        <span id="log-humidity-hint" class="field-hint" style="display:none;"></span>
                    </div>
                </div>
                <div id="today-staged-non-eggs-container" style="margin-top: 16px; border-top: 1px solid var(--border-color); padding-top: 12px; display:none;">
                    <h4 style="margin:0 0 8px 0; font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px;">Staged Today</h4>
                    <div id="today-staged-non-eggs-list" style="display:flex; flex-direction:column; gap:6px;"></div>
                </div>
                <div class="log-notes-row" style="margin-top: 16px; display: flex; flex-direction: column; gap: 12px; width: 100%;">
                    <textarea id="log-notes" placeholder="Any observations (health, weather, customer walk-in)..." rows="2" style="min-height: 60px; width: 100%; box-sizing: border-box;"></textarea>
                    <button class="btn btn-primary btn-save-log" onclick="window.submitDailyLog(event)" style="width: 100%; justify-content: center; display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="save"></i> Save Log
                    </button>
                    <div id="save-log-staged-feedback" style="display:none; font-size:12px; color:var(--accent); font-weight:600; text-align:center; margin-top:4px;">
                        📋 Staged — commits at midnight
                    </div>
                </div>
            </div>

            <div class="card pricing-card" style="height:100%; display:flex; flex-direction:column;">
                <div class="card-header">
                    <h3><i data-lucide="tag" style="width:16px;height:16px;"></i> Pricing &amp; Flock Assistant</h3>
                </div>
                <div class="pricing-body" id="pricing-body" style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
                    <div>
                        <div class="price-row"><span>Break-even / egg</span><strong id="price-breakeven" class="price-value danger">KES —</strong></div>
                        <div class="price-row"><span>Price to replace bag</span><strong id="price-next-bag" class="price-value">KES —</strong></div>
                        <div class="price-divider"></div>
                        <div class="price-row"><span>Last sale price</span><strong id="price-last-sale" class="price-value primary">KES —</strong></div>
                        <div class="price-row"><span>7-day avg sale</span><strong id="price-avg7-sale" class="price-value">KES —</strong></div>
                        <div class="price-row highlight-price"><span>Profit / egg</span><strong id="price-profit" class="price-value">KES —</strong></div>
                    </div>
                    <div>
                        <div class="price-advisory" id="price-advisory" style="margin-bottom:12px;">Enter logs to see pricing recommendations.</div>
                        <div id="flock-ratio-advisory" style="display:none; margin-bottom:12px; padding:12px; border-radius:8px; font-size:12px; border:1px solid var(--border-color);"></div>
                         ${batch.status === BATCH_STATUS.COMPLETED || window.USER_ROLE === 'viewer' ? '' : `
                        <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="window.openTxModal('sale')"><i data-lucide="plus-circle" style="width:14px;height:14px;"></i> Record a Sale</button>
                        <button class="btn btn-secondary btn-sm" style="width:100%; margin-top:8px; border-color:#f87171; color:#f87171;" onclick="window.openTxModal('write_off')"><i data-lucide="trash-2" style="width:14px;height:14px;"></i> Log Write-off</button>
                        `}
                    </div>
                </div>
            </div>

            <!-- ROW 2 -->
            <div class="card" style="height:100%; display:flex; flex-direction:column;">
                <div class="card-header">
                    <h3>Lay Rate – Last 30 Days</h3>
                    <span style="font-size:11px; color:var(--text-muted);">Min threshold: ${store.farmProfile.alertThresholds.minLayRatePercent}%</span>
                </div>
                <div style="position: relative; flex:1; min-height: 220px; width: 100%;">
                    <canvas id="cockpit-layrate-chart"></canvas>
                </div>
            </div>

            <div class="card feed-card" style="height:100%; display:flex; flex-direction:column;">
                <div class="card-header">
                    <h3><i data-lucide="package" style="width:16px;height:16px;"></i> Feed & Inventory</h3>
                </div>
                <div class="feed-body" style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
                    <div>
                        <div class="feed-metric"><span>Feed Stock</span><strong id="feed-stock">0 kg</strong></div>
                        <div class="feed-metric"><span>Days Left</span><strong id="feed-days-left">—</strong></div>
                        <div class="feed-metric"><span>Daily Consumption</span><strong id="feed-daily">—</strong></div>
                    </div>
                     ${batch.status === BATCH_STATUS.POST_BATCH || batch.status === BATCH_STATUS.COMPLETED || window.USER_ROLE === 'viewer' ? '' : `<button class="btn btn-secondary btn-sm" style="width:100%; margin-top:12px;" onclick="window.openTxModal('purchase')"><i data-lucide="shopping-cart" style="width:14px;height:14px;"></i> Buy Feed</button>`}
                </div>
            </div>

            <!-- ROW 3 -->
            <div class="card" style="height:100%; display:flex; flex-direction:column;">
                <div class="card-header">
                    <h3>Recent Logs</h3>
                </div>
                <div id="history-table" style="flex:1; overflow-y:auto; overflow-x:auto; width:100%;"></div>
            </div>

            <div class="card" style="height:100%; display:flex; flex-direction:column;">
                <div class="card-header">
                    <h3>Financial Pulse</h3>
                </div>
                <div class="tx-list" id="cockpit-tx-list" style="flex:1; display:flex; flex-direction:column;">
                    <p style="text-align:center; padding:20px; color:var(--text-muted);">Syncing transactions...</p>
                </div>
            </div>

            <!-- ROW 4 -->
            <div class="card" style="height:100%; display:flex; flex-direction:column; grid-column: 1 / -1;">
                <div class="card-header">
                    <h3><i data-lucide="activity" style="width:16px;height:16px;"></i> Health & Immunization Log</h3>
                    ${batch.status === BATCH_STATUS.COMPLETED || window.USER_ROLE === 'viewer' ? '' : `
                    <div>
                        <button class="btn btn-primary btn-sm" onclick="window.openHealthModal('vaccine')"><i data-lucide="syringe" style="width:14px; height:14px;"></i> Log Vaccine</button>
                        <button class="btn btn-secondary btn-sm" onclick="window.openHealthModal('meds')"><i data-lucide="pill" style="width:14px; height:14px;"></i> Log Meds</button>
                    </div>
                    `}
                </div>
                <div id="health-log-table" style="flex:1; overflow-y:auto; overflow-x:auto; width:100%; min-height:150px;"></div>
            </div>
        </div>
    `;
    lucide.createIcons();

    // Inject sensor chip programmatically
    (function injectSensorChip() {
        const actionsBar = document.querySelector('#view-batch-cockpit .cockpit-actions');
        if (!actionsBar) { console.warn('[SensorChip] .cockpit-actions not found'); return; }
        const existing = document.getElementById('sensor-popover-chip');
        if (existing) existing.remove();
        const chip = document.createElement('button');
        chip.id = 'sensor-popover-chip';
        chip.title = 'Coop Live Environment';
        chip.setAttribute('style', 'padding:0 10px;height:32px;border-radius:30px;background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;border:none;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;box-shadow:0 0 0 2px rgba(99,102,241,0.25);cursor:pointer;flex-shrink:0;');
        chip.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg><span id="sensor-chip-temp">—°C</span><span style="opacity:0.6">|</span><span id="sensor-chip-hum">—%</span>';
        chip.addEventListener('click', function(e) { window.toggleSensorPopover(e); });
        const exportBtn = actionsBar.querySelector('button');
        if (exportBtn && exportBtn.nextSibling) {
            actionsBar.insertBefore(chip, exportBtn.nextSibling);
        } else {
            actionsBar.appendChild(chip);
        }
        console.log('[SensorChip] Injected successfully into .cockpit-actions');
    })();

    window.switchView('batch-cockpit');
    window.refreshCockpitData(batch);
};

window.simulateLifecycle = async function(batchId) {
    const batch = window.getBatches().find(b => String(b.id) === String(batchId));
    if (!batch) return;

    const existingModal = document.getElementById('sim-confirm-modal');
    if (existingModal) document.body.removeChild(existingModal);

    const confirmModal = document.createElement('div');
    confirmModal.className = 'modal-overlay';
    confirmModal.id = 'sim-confirm-modal';
    confirmModal.innerHTML = `
        <div class="modal-content card" style="max-width:400px; padding:28px;">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                <div style="background:rgba(250,204,21,0.15); border-radius:50%; padding:10px; flex-shrink:0;">
                    <i data-lucide="zap" style="width:22px; height:22px; color:var(--accent);"></i>
                </div>
                <div>
                    <h3 style="margin:0; font-size:16px;">Run Lifecycle Simulation</h3>
                    <p style="margin:4px 0 0 0; font-size:12px; color:var(--text-muted);">[Dev Tool]</p>
                </div>
            </div>
            <p style="font-size:14px; color:var(--text-secondary); line-height:1.6; margin:0 0 8px 0;">
                This will generate <strong>60 days</strong> of synthetic historical data for this batch:
            </p>
            <ul style="font-size:13px; color:var(--text-muted); margin:0 0 20px 0; padding-left:20px; line-height:1.8;">
                <li>Days 1–30: Rearing phase (no egg production)</li>
                <li>Days 31–60: Laying phase (~85–95% lay rate)</li>
                <li>Random mortality simulation (~5% daily chance)</li>
                <li>Feed sack consumption every 5 days</li>
            </ul>
            <div style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:6px; padding:10px 12px; margin-bottom:20px; font-size:12px; color:#f87171; display:flex; gap:8px; align-items:flex-start;">
                <i data-lucide="alert-triangle" style="width:14px; height:14px; flex-shrink:0; margin-top:1px;"></i>
                <span>For demonstration only. Do not run this on a live production batch.</span>
            </div>
            <div style="display:flex; gap:12px;">
                <button type="button" class="btn btn-secondary" style="flex:1;" 
                    onclick="document.body.removeChild(document.getElementById('sim-confirm-modal'))">
                    Cancel
                </button>
                <button type="button" class="btn btn-primary" style="flex:1; background:var(--accent); border-color:var(--accent); color:#111;" 
                    id="sim-confirm-btn">
                    <i data-lucide="zap" style="width:14px; height:14px;"></i> Run Simulation
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(confirmModal);
    if (window.lucide) lucide.createIcons();

    document.getElementById('sim-confirm-btn').addEventListener('click', async () => {
        document.body.removeChild(confirmModal);

        let logs = [];

        await api.clearLogs(batchId);
        await api.clearTransactions(batchId);

        await api.saveTransaction(batchId, {
            id: Date.now(), date: new Date(Date.now() - 65 * 86400000).toISOString(),
            type: 'purchase', category: 'feed', qty: 1000, unitPrice: 70,
            amount: 70000, notes: 'Initial Simulation Feed Stock'
        });

        const now = new Date();
        let birdCount = batch.size;
        const saleTxsToSave = [];

        for (let i = 60; i >= 1; i--) {
            const date = new Date(now.getTime() - i * 86400000);
            const isLayingPhase = i < 30;
            
            if (Math.random() < 0.05) birdCount = Math.max(0, birdCount - 1);

            const eggs = isLayingPhase ? Math.round(birdCount * (0.85 + Math.random() * 0.1)) : 0;
            const morning = Math.floor(eggs * 0.6);
            const evening = Math.floor(eggs * 0.3);
            const other = eggs - morning - evening;
            const sacks = (i % 5 === 0) ? 2 : 0;

            logs.push({
                date: date.toISOString().split('T')[0],
                birds: birdCount, morning, evening, other,
                eggs, sacks, feedGiven: 0,
                notes: isLayingPhase ? 'Peak production activity' : 'Rearing phase'
            });
            
            if (isLayingPhase && eggs > 0) {
                saleTxsToSave.push({
                    id: Date.now() + i + Math.random(),
                    date: date.toISOString(),
                    type: 'sale', category: 'eggs',
                    qty: eggs, rawQty: Math.floor(eggs / 30), rawUnit: 'trays',
                    amount: eggs * 15,
                    notes: 'Simulated Daily Sale'
                });
            }
        }

        for (const l of logs) await api.saveLog(batchId, l);
        for (const t of saleTxsToSave) await api.saveTransaction(batchId, t);

        batch.stats.birdsAlive = birdCount;
        await window.updateBatch(batch);
        window.openBatchCockpit(batchId);
    });
};

function _renderEggCollectionList() {
    const list = document.getElementById('egg-collection-list');
    const totalEl = document.getElementById('egg-total-display');
    if (!list) return;

    const totalIntact = _eggCollections.reduce((s, e) => s + (parseInt(e.count) || 0), 0);
    const totalBroken = _eggCollections.reduce((s, e) => s + (parseInt(e.broken) || 0), 0);
    if (totalEl) {
        if (totalIntact === 0 && totalBroken === 0) {
            totalEl.innerHTML = `<span style="color:var(--text-muted);font-size:1rem;font-weight:400;">0 eggs</span>`;
        } else if (totalBroken > 0) {
            totalEl.innerHTML = `${totalIntact.toLocaleString()} eggs <span style="color:var(--danger);font-size:0.8rem;font-weight:600;">+ ${totalBroken} broken</span><span style="display:block;font-size:0.7rem;color:var(--text-muted);font-weight:400;margin-top:2px;">Broken excluded from sales</span>`;
        } else {
            totalEl.innerHTML = `${totalIntact.toLocaleString()} eggs`;
        }
    }
    if (_eggCollections.length === 0) {
        list.innerHTML = '<div id="egg-empty-hint" style="opacity:0.45;font-size:0.82rem;margin:0;font-style:italic;">No collections yet — tap Add Collection to log your first round.<span style="display:block; margin-top:4px; font-size:11px; color:var(--primary); font-weight:500; font-style:normal;">Logging for a past date? Change the date above ↑</span></div>';
        return;
    }
    list.innerHTML = _eggCollections.map((ev, idx) => {
        const brokenCount = parseInt(ev.broken) || 0;
        const brokenStr = brokenCount > 0 ? ` <span style="color:var(--danger);font-size:0.82rem;margin-left:4px;white-space:nowrap;">(${brokenCount} broken)</span>` : '';
        return `
        <div class="egg-collection-row" style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 12px;">
            <span style="font-size:1.1rem;font-weight:700;min-width:54px;display:inline-flex;align-items:center;">${parseInt(ev.count)||0} 🥚${brokenStr}</span>
            <span style="opacity:0.55;font-size:0.82rem;min-width:42px;">${ev.time || '—'}</span>
            <span style="flex:1;display:flex;align-items:center;gap:4px;">${ev.label ? `<span class="pill" style="font-size:10px; font-weight:600; padding:2px 8px; border-radius:12px; background:var(--primary-soft); color:var(--primary); text-transform:capitalize; border:1px solid rgba(99,102,241,0.15); line-height:1; display:inline-block; font-style:normal;">${ev.label}</span>` : ''}</span>
            <button type="button" onclick="window.editEggCollection(${idx})" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:0.75rem;">Edit</button>
            <button type="button" onclick="window.deleteEggCollection(${idx})" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:0.75rem;color:var(--danger);">✕</button>
        </div>`;
    }).join('');
}

function _renderTodayStagedNonEggsList(stagingToday) {
    const container = document.getElementById('today-staged-non-eggs-container');
    const listEl = document.getElementById('today-staged-non-eggs-list');
    if (!listEl || !container) return;

    if (!stagingToday) {
        container.style.display = 'none';
        return;
    }

    const list = [];
    if (stagingToday.feed && stagingToday.feed.events) {
        stagingToday.feed.events.forEach(e => list.push({ ...e, type: 'feed', text: `${e.sacks_opened || 0} sacks finished / ${e.amount_kg || 0} kg feed` }));
    }
    if (stagingToday.mortality && stagingToday.mortality.events) {
        stagingToday.mortality.events.forEach(e => list.push({ ...e, type: 'mortality', text: `${e.count} bird(s) died` }));
    }
    if (stagingToday.gases) {
        stagingToday.gases.forEach(e => list.push({ ...e, type: 'gases', text: `Gases: NH3 ${e.nh3 || '—'} ppm, CO2 ${e.co2 || '—'} ppm` }));
    }
    if (stagingToday.notes) {
        stagingToday.notes.forEach(e => list.push({ ...e, type: 'notes', text: `Note: "${e.text}"` }));
    }
    if (stagingToday.health) {
        stagingToday.health.forEach(e => list.push({ ...e, type: 'health', text: `Meds: ${e.drug || ''} (${e.medicine_type || ''})` }));
    }

    if (list.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    listEl.innerHTML = list.map(e => {
        const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return `
        <div class="egg-collection-row" style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.04); padding:8px 12px; border-radius:8px; font-size:12px;">
            <div style="color:var(--text-secondary); display:flex; align-items:center; gap:8px;">
                <span style="font-weight:700; color:var(--primary);">[${time}]</span>
                <span>${e.text}</span>
            </div>
            <button type="button" onclick="window.deleteStagingItem('${e.id}', '${e.type}')" class="btn btn-ghost btn-sm" style="padding:2px 8px; font-size:0.75rem; color:var(--danger);">✕</button>
        </div>
        `;
    }).join('');
}

window.deleteStagingItem = async function(id, type) {
    if (!confirm('Are you sure you want to delete this staged record?')) return;
    const bid = store.currentBatchId;
    const res = await api.deleteStagingEvent(bid, id);
    if (res.success) {
        window.showToast('Staged item deleted.', 'success');
        const batch = window.getBatches().find(b => String(b.id) === String(bid));
        if (batch) window.refreshCockpitData(batch);
    } else {
        window.showToast(res.error || 'Failed to delete staged item.', 'danger');
    }
};

window.addEggCollection = function() {
    const now = new Date(Date.now() + 3 * 3600 * 1000);
    const defaultTime = now.toISOString().substring(11, 16);
    _showEggCollectionModal({ time: defaultTime, count: '', broken: 0, label: '' }, null);
};

window.editEggCollection = function(idx) {
    _showEggCollectionModal({ ..._eggCollections[idx] }, idx);
};

window.deleteEggCollection = async function(idx) {
    const ev = _eggCollections[idx];
    if (ev._stagingId) {
        await api.deleteStagingEvent(store.currentBatchId, ev._stagingId);
    }
    _eggCollections.splice(idx, 1);
    _renderEggCollectionList();
};

function _showEggCollectionModal(data, editIdx) {
    const isEdit = editIdx !== null && editIdx !== undefined;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:340px; padding:24px;">
            <h3>${isEdit ? 'Edit' : 'Add'} Egg Collection</h3>
            <div class="input-group">
                <label>Intact Eggs Count</label>
                <input id="ecm-count" type="number" min="0" value="${(data.count !== undefined && data.count !== null && data.count !== '') ? data.count : ''}" placeholder="e.g. 120" onfocus="this.select()">
            </div>
            <div class="input-group">
                <label>Broken Eggs Count</label>
                <input id="ecm-broken" type="number" min="0" value="${data.broken||0}" placeholder="e.g. 0" onfocus="this.select()">
            </div>
            <div class="input-group">
                <label>${(() => {
                    const dateVal = $('log-date') ? $('log-date').value : '';
                    const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];
                    return (dateVal && dateVal < todayStr) ? 'Collection Round' : 'Time Collected';
                })()}</label>
                ${(() => {
                    const dateVal = $('log-date') ? $('log-date').value : '';
                    const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];
                    if (dateVal && dateVal < todayStr) {
                        return `
                        <select id="ecm-time" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                            <option value="09:00" ${data.time === '09:00' ? 'selected' : ''}>Morning (~09:00)</option>
                            <option value="13:00" ${data.time === '13:00' ? 'selected' : ''}>Mid-day (~13:00)</option>
                            <option value="17:00" ${data.time === '17:00' ? 'selected' : ''}>Evening (~17:00)</option>
                        </select>`;
                    } else {
                        return `<input id="ecm-time" type="time" value="${data.time||''}">`;
                    }
                })()}
            </div>
            <div class="input-group">
                <label>Label / Notes (optional)</label>
                <input id="ecm-label" type="text" value="${data.label||''}" placeholder="e.g. Morning, After rain…">
            </div>
            <div id="ecm-error" style="display:none; color:var(--danger); font-size:0.82rem; margin-bottom:10px;"></div>
            <div style="display:flex; gap:12px; margin-top:20px;">
                <button class="btn btn-secondary" id="ecm-cancel" style="flex:1;">Cancel</button>
                <button class="btn btn-primary" id="ecm-save" style="flex:1.5;">${isEdit ? 'Update' : 'Add Collection'}</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('ecm-count')?.focus(), 80);

    document.getElementById('ecm-cancel').onclick = () => modal.remove();
    document.getElementById('ecm-save').onclick = async () => {
        const countVal = document.getElementById('ecm-count').value.trim();
        const count = countVal === '' ? NaN : parseInt(countVal);
        const broken = parseInt(document.getElementById('ecm-broken').value) || 0;
        const time  = document.getElementById('ecm-time').value;
        const label = document.getElementById('ecm-label').value.trim();
        
        if (isNaN(count) || count < 0 || broken < 0 || (count === 0 && broken === 0)) {
            document.getElementById('ecm-error').textContent = 'Enter a valid intact egg count or log at least 1 broken egg.';
            document.getElementById('ecm-error').style.display = 'block';
            return;
        }
        document.getElementById('ecm-save').textContent = 'Saving…';
        const eventData = { count, broken, time, label };

        if (isEdit) {
            const existing = _eggCollections[editIdx];
            if (existing._stagingId) {
                await api.editStagingEvent(store.currentBatchId, existing._stagingId, eventData);
            }
            _eggCollections[editIdx] = { ...existing, ...eventData };
        } else {
            const result = await api.addStagingEvent(store.currentBatchId, 'eggs', eventData);
            _eggCollections.push({ ...eventData, _stagingId: result?.id || null });
        }
        modal.remove();
        _renderEggCollectionList();
    };
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
}

window.submitDailyLog = async function(event) {
    if (event) event.preventDefault();
    const batch = window.getBatches().find(b => String(b.id) === String(store.currentBatchId));
    if (!batch) return;

    $('log-date').blur();
    const date = $('log-date').value;
    const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];
    const isBackfill = date && date < today;
    const amendDate = isBackfill ? date : null;

    const sacks     = parseInt($('log-sacks').value) || 0;
    const feedGiven = parseFloat($('log-feed').value) || null;
    const mortalityHens = parseInt($('log-mortality-hens')?.value) || 0;
    const mortalityRoosters = parseInt($('log-mortality-roosters')?.value) || 0;
    const mortality = mortalityHens + mortalityRoosters;
    const nh3       = parseFloat($('log-nh3').value) || null;
    const co2       = parseFloat($('log-co2').value) || null;
    const temperature = parseFloat($('log-temp').value) || null;
    const humidity    = parseFloat($('log-humidity').value) || null;
    const notesVal    = $('log-notes').value.trim();

    if (!date) { window.showToast('Please select a date.', 'warning'); return; }

    if (mortality > 0) {
        const currentBirds = parseInt($('log-birds')?.value) || batch.size || 1;
        const mortalityPct = (mortality / currentBirds) * 100;
        if (mortalityPct > 10) {
            const pctStr = mortalityPct.toFixed(0);
            const confirmed = confirm(
                `⚠️ High Mortality Warning\n\nYou are recording ${mortality} death${mortality > 1 ? 's' : ''} — ` +
                `that is ${pctStr}% of your flock (${currentBirds} birds).\n\n` +
                `Is this correct?`
            );
            if (!confirmed) return;
        }
    }

    if (!feedGiven && !sacks && !isBackfill) {
        showToast('Saved without feed data — enter sacks or kg if feed was given.', 'warning');
    }

    const promises = [];

    if (isBackfill && _eggCollections.length > 0) {
        for (const ev of _eggCollections) {
            promises.push(api.addStagingEvent(batch.id, 'eggs', { count: ev.count, time: ev.time, label: ev.label }, amendDate));
        }
    }

    if (feedGiven || sacks) {
        promises.push(api.addStagingEvent(batch.id, 'feed',
            { amount_kg: feedGiven || (sacks * (store.farmProfile.sackWeightKg || 50)), sacks_opened: sacks }, amendDate));
    }

    if (mortality > 0) {
        promises.push(api.addStagingEvent(batch.id, 'mortality', { 
            count: mortality,
            hens: mortalityHens,
            roosters: mortalityRoosters
        }, amendDate));
    }

    if (nh3 || co2) {
        promises.push(api.addStagingEvent(batch.id, 'gases', { nh3, co2 }, amendDate));
    }

    if (temperature || humidity) {
        promises.push(api.addStagingEvent(batch.id, 'sensors', { temperature, humidity }, amendDate));
    }

    if (notesVal) {
        promises.push(api.addStagingEvent(batch.id, 'notes', {
            time: new Date(Date.now() + 3 * 3600 * 1000).toISOString().substring(11, 16),
            text: notesVal
        }, amendDate));
    }

    await Promise.all(promises);

    ['log-feed', 'log-notes', 'log-nh3', 'log-co2', 'log-temp', 'log-humidity'].forEach(id => {
        const el = $(id); if (el) el.value = '';
    });
    $('log-sacks').value = '0';
    $('log-mortality').value = '0';
    if ($('log-mortality-hens')) $('log-mortality-hens').value = '0';
    if ($('log-mortality-roosters')) $('log-mortality-roosters').value = '0';
    const tempHint = $('log-temp-hint'); const humHint = $('log-humidity-hint');
    if (tempHint) tempHint.style.display = 'none';
    if (humHint) humHint.style.display = 'none';

    if (!isBackfill) {
        _eggCollections = [];
        _renderEggCollectionList();
    }

    const btn = document.querySelector('.btn-save-log');
    if (btn) { btn.textContent = '✓ Saved!'; btn.disabled = true; setTimeout(() => { btn.innerHTML = '<i data-lucide="save"></i> Save Log'; btn.disabled = false; lucide.createIcons(); }, 1800); }

    window.refreshCockpitData(batch);
    window.showToast(isBackfill ? `Backfill for ${date} submitted.` : 'Log saved!', 'success');
};

window._onSacksInput = function(el) {
    const sacks = parseInt(el.value) || 0;
    const feedEl = document.getElementById('log-feed');
    const hint = document.getElementById('feed-kg-hint');
    if (sacks > 0) {
        if (feedEl) { feedEl.value = ''; feedEl.disabled = true; feedEl.style.opacity = '0.4'; feedEl.placeholder = 'Locked — using sacks'; }
        if (hint) { hint.textContent = '🔒 Locked (sacks mode)'; hint.style.color = 'var(--accent)'; }
    } else {
        if (feedEl) { feedEl.disabled = false; feedEl.style.opacity = '1'; feedEl.placeholder = 'Leave blank if entering sacks'; }
        if (hint) { hint.textContent = '— or enter sacks above'; hint.style.color = ''; }
    }
};

window._onFeedKgInput = function(el) {
    const kg = parseFloat(el.value) || 0;
    const sacksEl = document.getElementById('log-sacks');
    const hint = document.getElementById('feed-kg-hint');
    if (kg > 0) {
        if (sacksEl) { sacksEl.value = '0'; sacksEl.disabled = true; sacksEl.style.opacity = '0.4'; }
        if (hint) { hint.textContent = '🔒 Locked (kg mode)'; hint.style.color = 'var(--accent)'; }
    } else {
        if (sacksEl) { sacksEl.disabled = false; sacksEl.style.opacity = '1'; }
        if (hint) { hint.textContent = '— or enter sacks above'; hint.style.color = ''; }
    }
};

window.refreshCockpitData = async function(batch) {
    if (!batch) return;
    const [logs, txs, healthLogs, stagingToday] = await Promise.all([
        api.getLogs(batch.id),
        api.getTransactions(batch.id),
        api.getHealthLogs(batch.id),
        api.getTodayStaging(batch.id).catch(() => null)
    ]);
    
    const kpis = computeKPIs(logs, txs, batch, store.farmProfile, stagingToday);
    
    if (stagingToday && stagingToday.eggs && stagingToday.eggs.collections) {
        _eggCollections = stagingToday.eggs.collections.map(c => ({
            count: c.count,
            broken: c.broken || 0,
            time: c.time,
            label: c.label || c.note || '',
            _stagingId: c.id
        }));
        _renderEggCollectionList();
    } else {
        _eggCollections = [];
        _renderEggCollectionList();
    }
    _renderTodayStagedNonEggsList(stagingToday);

    const hasStagedEvents = stagingToday && (
        (stagingToday.eggs && stagingToday.eggs.collections && stagingToday.eggs.collections.length > 0) ||
        (stagingToday.feed && stagingToday.feed.events && stagingToday.feed.events.length > 0) ||
        (stagingToday.mortality && stagingToday.mortality.events && stagingToday.mortality.events.length > 0) ||
        (stagingToday.gases && stagingToday.gases.length > 0) ||
        (stagingToday.notes && stagingToday.notes.length > 0) ||
        (stagingToday.health && stagingToday.health.length > 0)
    );
    const feedbackEl = document.getElementById('save-log-staged-feedback');
    if (feedbackEl) {
        feedbackEl.style.display = hasStagedEvents ? 'block' : 'none';
    }
    
    if ($('kpi-layrate')) {
        if (stagingToday?.eggs?.total == null) {
            $('kpi-layrate').innerText = '—';
        } else {
            $('kpi-layrate').innerText = (kpis.todayLayRate * 100).toFixed(1) + '%';
        }
    }
    if($('kpi-avg7')) $('kpi-avg7').innerText = (kpis.avg7LayRate * 100).toFixed(1) + '%';
    if($('kpi-fc')) $('kpi-fc').innerText = kpis.feedConversion.toFixed(2);
    if($('kpi-projected')) $('kpi-projected').innerText = kpis.projectedEggs.toLocaleString();

    const renderTrendBadge = (elId, value, isPct = true) => {
        const el = $(elId);
        if (!el) return;
        const sym = value >= 0 ? '+' : '';
        const displayVal = isPct ? (value*100).toFixed(1) + '%' : value.toFixed(2);
        el.innerHTML = `<span class="trend-badge ${value >= 0 ? 'up' : 'down'}">${sym}${displayVal}</span> vs last week`;
    };
    renderTrendBadge('trend-layrate', kpis.layRateTrend);
    renderTrendBadge('trend-avg7', kpis.layRateTrend);

    // Info Bar
    if($('info-birds')) {
        $('info-birds').innerText = kpis.currentBirds;
        const breakdown = $('info-birds-breakdown');
        if (breakdown) {
            breakdown.innerText = `(Hens: ${kpis.currentHens}, Roosters: ${kpis.currentRoosters})`;
        }
    }
    
    // Reconcile Egg losses
    const totalHarvestLoss = logs.reduce((sum, l) => sum + (parseInt(l.eggs_broken) || 0), 0) + 
        (stagingToday?.eggs?.broken || 0);
        
    const totalStorageLoss = txs.filter(t => t.type === 'write_off' && t.category === 'eggs')
        .reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
        
    const totalLoss = totalHarvestLoss + totalStorageLoss;
    
    if ($('info-egg-losses')) {
        $('info-egg-losses').innerText = totalLoss.toLocaleString();
    }
    
    const lossBreakdown = $('info-egg-losses-breakdown');
    if (lossBreakdown) {
        lossBreakdown.innerText = `(${totalHarvestLoss} harvest, ${totalStorageLoss} storage)`;
    }

    if($('info-totaleggs')) $('info-totaleggs').innerText = kpis.totalEggs.toLocaleString();

    const initialCash = (batch.assumptions && batch.assumptions.workingCapital) ? batch.assumptions.workingCapital : 0;
    const accounts = await api.getLedgerAccounts();
    const cashAcc = accounts.find(a => a.code === '1000') || { balance: 0, debit: 0, credit: 0 };
    const mpesaAcc = accounts.find(a => a.code === '1010') || { balance: 0, debit: 0, credit: 0 };
    const recAcc = accounts.find(a => a.code === '1200') || { balance: 0, debit: 0, credit: 0 };
    
    const totalEntries = accounts.reduce((s, a) => s + (a.debit || 0) + (a.credit || 0), 0);
    const liquidCash = (cashAcc.balance || 0) + (mpesaAcc.balance || 0) + (totalEntries === 0 ? initialCash : 0);
    const outstandingCredit = recAcc.balance || 0;

    if($('info-cash')) $('info-cash').innerText = 'KES ' + liquidCash.toLocaleString();
    if($('info-credit')) $('info-credit').innerText = 'KES ' + outstandingCredit.toLocaleString();
    
    let avg7SalePrice = 15;
    const now = Date.now();
    const last7DaysSales = txs.filter(t => t.type === 'sale' && t.category === 'eggs' && (now - new Date(t.date).getTime()) < 7*86400000);
    if (last7DaysSales.length > 0) {
         const totVal = last7DaysSales.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
         const totQty = last7DaysSales.reduce((s, t) => s + parseFloat(t.qty || 1), 0);
         avg7SalePrice = totQty > 0 ? (totVal / totQty) : 15;
    } else {
         const lastEggSale = txs.find(t => t.type === 'sale' && t.category === 'eggs');
         if(lastEggSale) avg7SalePrice = lastEggSale.amount / (parseFloat(lastEggSale.qty) || 1);
    }
    if($('price-avg7-sale')) $('price-avg7-sale').innerText = 'KES ' + avg7SalePrice.toFixed(1);

    let lastSalePrice = avg7SalePrice;
    if($('price-last-sale')) {
         const lastSale = txs.find(t => t.type === 'sale' && t.category === 'eggs');
         if (lastSale && lastSale.qty > 0) {
             lastSalePrice = lastSale.amount / lastSale.qty;
             $('price-last-sale').innerText = 'KES ' + lastSalePrice.toFixed(2);
         } else {
             $('price-last-sale').innerText = 'KES —';
         }
    }

    // Feed & Inventory
    const totalFeedPurchased = txs
        .filter(t => t.type === 'purchase' && t.category.toLowerCase() === 'feed')
        .reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
    const feedWrittenOff = txs
        .filter(t => t.type === 'write_off' && t.category === 'feed')
        .reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
    const currentInventory = Math.max(0, totalFeedPurchased - kpis.totalFeed - feedWrittenOff);
    const feedDeficit = totalFeedPurchased - kpis.totalFeed - feedWrittenOff < 0;
    if($('info-feed')) $('info-feed').innerText = currentInventory.toFixed(1) + ' kg';
    if($('feed-stock')) {
        $('feed-stock').innerText = feedDeficit ? 'Feed deficit!' : currentInventory.toFixed(1) + ' kg';
        if (feedDeficit) $('feed-stock').style.color = 'var(--danger)';
    }

    const dailyNeed = kpis.avgDailyFeedPerBird > 0 
        ? kpis.avgDailyFeedPerBird * kpis.currentBirds : null;
    if($('feed-days-left')) {
        if (!dailyNeed) {
            $('feed-days-left').innerText = 'Log feed data';
            $('feed-days-left').style.color = 'var(--text-muted)';
        } else {
            const inventoryDays = currentInventory / dailyNeed;
            $('feed-days-left').innerText = inventoryDays > 100 ? '>100 days' : (inventoryDays > 0 ? Math.floor(inventoryDays) + ' days' : 'Out of feed!');
            $('feed-days-left').style.color = inventoryDays < 3 ? 'var(--danger)' : inventoryDays < 7 ? 'var(--accent)' : 'var(--text-dark)';
        }
    }
    if($('feed-daily')) $('feed-daily').innerText = dailyNeed ? dailyNeed.toFixed(1) + ' kg/day' : '—';

    // Pricing Assistant
    const feedCostPerKg = store.farmProfile.defaultFeedPrice / store.farmProfile.sackWeightKg;
    const totalExpenses = txs.filter(t => t.type === 'purchase').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
    const nonFeedOpexPerEgg = kpis.avg7LayRate > 0 ?
        ((totalExpenses - txs.filter(t=>t.type==='purchase'&&t.category.toLowerCase()==='feed').reduce((s,t)=>s+parseFloat(t.amount||0),0)) / Math.max(1, kpis.totalEggs)) : 1;
    const breakEvenPrice = kpis.avg7LayRate > 0 
        ? (kpis.avgDailyFeedPerBird * feedCostPerKg / kpis.avg7LayRate) + Math.max(0.5, nonFeedOpexPerEgg)
        : 12;
    if($('price-breakeven')) $('price-breakeven').innerText = 'KES ' + breakEvenPrice.toFixed(2);

    // Price to replace next bag
    const birdDaysPerBag = store.farmProfile.sackWeightKg / Math.max(0.01, kpis.avgDailyFeedPerBird);
    const eggsPerBag = birdDaysPerBag * kpis.avg7LayRate * kpis.currentBirds;
    const nextBagPrice = eggsPerBag > 0 ? store.farmProfile.defaultFeedPrice / eggsPerBag : 0;
    if($('price-next-bag')) $('price-next-bag').innerText = nextBagPrice > 0 ? 'KES ' + nextBagPrice.toFixed(2) : 'KES —';

    // Profit per egg vs last sale price
    const hasRealSaleData = last7DaysSales.length > 0 || txs.some(t => t.type === 'sale' && t.category === 'eggs');
    const profitPerEgg = lastSalePrice - breakEvenPrice;
    if($('price-profit')) {
        if (!hasRealSaleData) {
            $('price-profit').innerText = 'KES —';
        } else {
            $('price-profit').innerText = 'KES ' + profitPerEgg.toFixed(2);
            $('price-profit').style.color = profitPerEgg >= 0 ? 'var(--primary)' : 'var(--danger)';
        }
    }

    // Dynamic price advisory
    const advisory = $('price-advisory');
    if (advisory) {
        if (!hasRealSaleData) {
            advisory.textContent = 'Record a sale to see live pricing recommendations.';
        } else if (profitPerEgg < 0) {
            advisory.innerHTML = `⚠️ Selling below break-even by KES ${Math.abs(profitPerEgg).toFixed(2)}/egg. Minimum price: <strong>KES ${breakEvenPrice.toFixed(2)}</strong>.`;
            advisory.style.background = '#fee2e2'; advisory.style.color = '#dc2626';
        } else if (profitPerEgg < 2) {
            advisory.innerHTML = `Thin margin — KES ${profitPerEgg.toFixed(2)}/egg. Consider pricing above KES ${(breakEvenPrice + 2).toFixed(0)}.`;
            advisory.style.background = '#fef9c3'; advisory.style.color = '#92400e';
        } else {
            advisory.innerHTML = `Healthy margin! KES ${profitPerEgg.toFixed(2)} profit per egg.`;
            advisory.style.background = 'var(--primary-soft)'; advisory.style.color = 'var(--primary)';
        }
    }

    // Flock Ratio Advisory
    const ratioAdvisory = $('flock-ratio-advisory');
    if (ratioAdvisory) {
        const hensCount = kpis.currentHens;
        const roostersCount = kpis.currentRoosters;
        if (hensCount > 0 && roostersCount > 0) {
            const ratio = hensCount / roostersCount;
            if (ratio < 7) {
                const target = Math.max(1, Math.floor(hensCount / 7.5));
                const surplus = roostersCount - target;
                if (surplus > 0) {
                    ratioAdvisory.style.display = 'block';
                    ratioAdvisory.style.background = '#fef3c7';
                    ratioAdvisory.style.color = '#b45309';
                    ratioAdvisory.style.borderColor = '#f59e0b';
                    ratioAdvisory.innerHTML = `
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <div style="display:flex; align-items:center; gap:6px; font-weight:bold;">
                                <i data-lucide="alert-triangle" style="width:14px; height:14px; color:#d97706;"></i>
                                Ratio Alert: Surplus Roosters
                            </div>
                            <div>Ratio is <strong>1:${ratio.toFixed(1)}</strong> (1 rooster per ${ratio.toFixed(1)} hens). Ideal ratio is 1:7-8. Target is ${target} roosters.</div>
                            ${batch.status === BATCH_STATUS.COMPLETED || window.USER_ROLE === 'viewer' ? '' : `
                            <button class="btn btn-primary btn-xs" onclick="window.openSurplusRoostersSaleModal(${surplus})" style="margin-top:4px; background:#d97706; border-color:#d97706; color:#fff; width:100%; justify-content:center; display:flex; align-items:center; gap:4px; font-size:11px;">
                                <i data-lucide="trending-up" style="width:12px; height:12px;"></i> Sell ${surplus} surplus roosters
                            </button>
                            `}
                        </div>
                    `;
                } else {
                    ratioAdvisory.style.display = 'none';
                }
            } else if (ratio > 8) {
                ratioAdvisory.style.display = 'block';
                ratioAdvisory.style.background = '#eff6ff';
                ratioAdvisory.style.color = '#1e40af';
                ratioAdvisory.style.borderColor = '#bfdbfe';
                ratioAdvisory.innerHTML = `
                    <div style="display:flex; align-items:center; gap:6px; font-weight:bold;">
                        <i data-lucide="info" style="width:14px; height:14px; color:#2563eb;"></i>
                        Rooster Deficit: 1:${ratio.toFixed(1)} hens (ideal is 1:7-8).
                    </div>
                `;
            } else {
                ratioAdvisory.style.display = 'block';
                ratioAdvisory.style.background = 'var(--primary-soft)';
                ratioAdvisory.style.color = 'var(--primary)';
                ratioAdvisory.style.borderColor = 'var(--primary-soft)';
                ratioAdvisory.innerHTML = `
                    <div style="display:flex; align-items:center; gap:6px; font-weight:bold;">
                        <i data-lucide="check-circle" style="width:14px; height:14px; color:var(--primary);"></i>
                        Ideal Flock Ratio: 1:${ratio.toFixed(1)} (ideal is 1:7-8).
                    </div>
                `;
            }
            if (window.lucide) window.lucide.createIcons();
        } else {
            ratioAdvisory.style.display = 'none';
        }
    }

    const withdrawal = getActiveWithdrawal(healthLogs, logs);
    const discardContainer = $('info-discard-container');
    if (withdrawal.eggsUnderWithdrawal && discardContainer) {
        discardContainer.style.display = 'inline-flex';
        const daysLeft = Math.ceil((withdrawal.eggClearDate - new Date()) / 86400000);
        $('info-discard').innerText = `${daysLeft} days (⚠️ ${withdrawal.discardedEggs.toLocaleString()} eggs discarded (withdrawal))`;
    } else if (discardContainer) {
        discardContainer.style.display = 'none';
    }

    const inventoryAging = computeEggInventoryAging(logs, txs, stagingToday);
    if($('info-unsoldeggs')) $('info-unsoldeggs').innerText = `(${inventoryAging.totalUnsold.toLocaleString()} in stock)`;
    
    const maxAgeDays = store.farmProfile.eggStorageType === 'refrigerated' ? 35 : 12;
    const warningThreshold = maxAgeDays - 3;
    const expiringEggs = inventoryAging.unsoldBatches
        .filter(b => b.ageDays >= warningThreshold)
        .reduce((sum, b) => sum + b.qty, 0);
        
    if($('info-shelflife-container')) {
        if (expiringEggs > 0) {
            $('info-shelflife-container').style.display = 'inline-flex';
            $('info-shelflife-container').style.background = '#fef08a';
            $('info-shelflife-container').style.borderColor = '#facc15';
            $('info-shelflife').innerText = expiringEggs.toLocaleString() + ' eggs';
            $('info-shelflife').style.color = '#854d0e';
        } else {
            $('info-shelflife-container').style.display = 'none';
        }
    }

    updateCockpitAlerts(batch, kpis, currentInventory, breakEvenPrice, liquidCash, txs, healthLogs);
    renderCockpitChart(kpis.recent30);
    renderHistoryTable(logs, txs);
    renderCockpitTransactions(txs, initialCash);
    if (window.renderHealthTable) await window.renderHealthTable(batch.id);
    await window.updateLiveSensorWidget();
};

window.handleLogDateChange = async function() {
    const dateInput = $('log-date');
    const tempInput = $('log-temp');
    const humInput = $('log-humidity');
    const tempHint = $('log-temp-hint');
    const humHint = $('log-humidity-hint');
    if (!dateInput || !tempInput || !humInput) return;

    const date = dateInput.value;
    if (!date) {
        tempInput.value = '';
        humInput.value = '';
        if (tempHint) tempHint.style.display = 'none';
        if (humHint) humHint.style.display = 'none';
        return;
    }

    const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];

    tempInput.value = '';
    humInput.value = '';
    if (tempHint) tempHint.style.display = 'none';
    if (humHint) humHint.style.display = 'none';

    if (date === today) {
        await window.updateLiveSensorWidget();
        return;
    }

    const res = await api.getTuyaHistory(date);

    if (!res || !res.success) {
        const msg = (res && res.error) || 'No sensor history available';
        if (tempHint) { tempHint.innerText = msg; tempHint.style.display = 'block'; }
        if (humHint) { humHint.innerText = msg; humHint.style.display = 'block'; }
        return;
    }

    if (res.temperature) {
        tempInput.value = res.temperature.avg;
        if (tempHint) {
            tempHint.innerText = `Sensor avg (${res.temperature.min}–${res.temperature.max}°C, n=${res.temperature.count})`;
            tempHint.style.display = 'block';
        }
    } else if (tempHint) {
        tempHint.innerText = 'No sensor readings for this date';
        tempHint.style.display = 'block';
    }

    if (res.humidity) {
        humInput.value = res.humidity.avg;
        if (humHint) {
            humHint.innerText = `Sensor avg (${res.humidity.min}–${res.humidity.max}%, n=${res.humidity.count})`;
            humHint.style.display = 'block';
        }
    } else if (humHint) {
        humHint.innerText = 'No sensor readings for this date';
        humHint.style.display = 'block';
    }
};

window.updateLiveSensorWidget = async function() {
    const container = $('info-sensor-container');
    if (!container) return;
    
    const res = await api.getLiveSensors();
    if (!res) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'inline-flex';
    
    if (res.temperature !== null) {
        $('info-sensor-temp').innerText = res.temperature.toFixed(1) + ' °C';
        const chipTemp = $('sensor-chip-temp');
        if (chipTemp) chipTemp.innerText = res.temperature.toFixed(1) + '°C';
        const badgeTemp = $('sensor-badge-temp');
        if (badgeTemp) {
            badgeTemp.innerHTML = `[Sensor: ${res.temperature.toFixed(1)}°C ▼]`;
            badgeTemp.title = "Click to fill this value";
            badgeTemp.style.display = 'inline';
            badgeTemp.onclick = () => {
                const tempInput = $('log-temp');
                if (tempInput) tempInput.value = res.temperature.toFixed(1);
            };
        }
    } else {
        $('info-sensor-temp').innerText = '— °C';
        const badgeTemp = $('sensor-badge-temp');
        if (badgeTemp) badgeTemp.style.display = 'none';
    }
    
    if (res.humidity !== null) {
        $('info-sensor-hum').innerText = res.humidity.toFixed(0) + '% RH';
        const chipHum = $('sensor-chip-hum');
        if (chipHum) chipHum.innerText = res.humidity.toFixed(0) + '%';
        const badgeHum = $('sensor-badge-hum');
        if (badgeHum) {
            badgeHum.innerHTML = `[Sensor: ${res.humidity.toFixed(0)}% ▼]`;
            badgeHum.title = "Click to fill this value";
            badgeHum.style.display = 'inline';
            badgeHum.onclick = () => {
                const humInput = $('log-humidity');
                if (humInput) humInput.value = res.humidity.toFixed(0);
            };
        }
    } else {
        $('info-sensor-hum').innerText = '—% RH';
        const badgeHum = $('sensor-badge-hum');
        if (badgeHum) badgeHum.style.display = 'none';
    }
    
    if (res.temperature != null && res.humidity != null) {
        const thi = computeTHI(res.temperature, res.humidity);
        const status = getHeatStressStatus(thi);
        const thiEl = $('info-sensor-thi');
        if (thiEl) {
            thiEl.innerHTML = `<span style="color:${status.color};font-weight:600;" title="THI: ${thi.toFixed(1)}">${status.emoji} ${status.label}</span>`;
        }
    }
    
    if (res.battery !== null) {
        $('info-sensor-battery').innerHTML = `<i data-lucide="battery" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:2px;"></i>${res.battery}%`;
    } else {
        $('info-sensor-battery').innerHTML = '';
    }
    
    const syncEl = $('info-sensor-sync');
    if (!res.success) {
        container.style.borderColor = '#fca5a5';
        container.style.background = '#fee2e2';
        container.style.color = '#dc2626';
        syncEl.innerText = `⚠️ ${res.error || 'Sync error'}`;
        syncEl.style.color = '#dc2626';
        container.title = `Sync error: ${res.error || 'unknown'}. Click to retry.`;
    } else {
        container.style.borderColor = 'var(--border-color)';
        container.style.background = 'var(--bg-white)';
        container.style.color = 'var(--text-dark)';
        
        const diffMin = Math.round((Date.now() - new Date(res.last_updated).getTime()) / 60000);
        let timeStr = 'just now';
        if (diffMin > 0) {
            timeStr = diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin/60)}h ago`;
        }
        syncEl.innerText = `(${timeStr})`;
        syncEl.style.color = 'var(--text-muted)';
        container.title = 'Sensor online. Click to sync now.';
    }
    
    lucide.createIcons();
};

window.triggerSensorSync = async function() {
    const container = $('info-sensor-container');
    if (container) {
        container.style.opacity = '0.6';
        const syncEl = $('info-sensor-sync');
        if (syncEl) syncEl.innerText = '(syncing...)';
    }
    await api.forceSyncSensors();
    await window.updateLiveSensorWidget();
    if (container) {
        container.style.opacity = '1';
    }
    const popover = document.getElementById('sensor-popover');
    if (popover && popover.style.display !== 'none') {
        await window.renderSensorPopover();
    }
};

/**
 * Toggles the visibility of the sensor popover.
 * If the popover does not exist, it is created and appended to document.body,
 * then populated with live sensor data and historical charts.
 * 
 * BUG 1 Fix: Ensure the popover DOM element (#sensor-popover) is fully appended to
 * document.body and Lucide icons are initialized before calling renderSensorPopover().
 * This prevents getElementById queries inside the render function from returning null
 * and failing to update the UI gauges.
 * 
 * @param {Event} e - The click event triggering the toggle.
 */
window.toggleSensorPopover = async function(e) {
    e.stopPropagation();
    let popover = document.getElementById('sensor-popover');
    if (popover) {
        const isVisible = popover.style.display !== 'none';
        popover.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) {
            // Re-render and position the popover when opening it again
            await window.renderSensorPopover();
            window.positionSensorPopover();
        }
        return;
    }

    popover = document.createElement('div');
    popover.id = 'sensor-popover';
    popover.className = 'sensor-popover';
    popover.innerHTML = `
        <div class="sp-header">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="sp-icon-wrap"><i data-lucide="thermometer" style="width:16px;height:16px;color:#0ea5e9;"></i></span>
                <div>
                    <div class="sp-title">Coop Live Environment</div>
                    <div class="sp-subtitle" id="sp-last-sync">Loading…</div>
                </div>
            </div>
            <button onclick="window.triggerSensorSync()" class="sp-sync-btn" title="Sync now">
                <i data-lucide="refresh-cw" style="width:14px;height:14px;"></i>
            </button>
        </div>

        <div class="sp-gauges">
            <div class="sp-gauge" id="sp-gauge-temp">
                <div class="sp-gauge-icon">🌡️</div>
                <div class="sp-gauge-value" id="sp-temp-val">—</div>
                <div class="sp-gauge-label">Temperature</div>
                <div class="sp-gauge-bar-wrap"><div class="sp-gauge-bar" id="sp-temp-bar" style="width:0%; background:linear-gradient(90deg,#0ea5e9,#f97316);"></div></div>
                <div class="sp-gauge-range"><span>10°C</span><span>40°C</span></div>
            </div>
            <div class="sp-gauge" id="sp-gauge-hum">
                <div class="sp-gauge-icon">💧</div>
                <div class="sp-gauge-value" id="sp-hum-val">—</div>
                <div class="sp-gauge-label">Humidity</div>
                <div class="sp-gauge-bar-wrap"><div class="sp-gauge-bar" id="sp-hum-bar" style="width:0%; background:linear-gradient(90deg,#38bdf8,#818cf8);"></div></div>
                <div class="sp-gauge-range"><span>0%</span><span>100%</span></div>
            </div>
            <div class="sp-gauge sp-gauge-battery" id="sp-gauge-bat">
                <div class="sp-gauge-icon">🔋</div>
                <div class="sp-gauge-value" id="sp-bat-val">—</div>
                <div class="sp-gauge-label">Battery</div>
                <div class="sp-gauge-bar-wrap"><div class="sp-gauge-bar" id="sp-bat-bar" style="width:0%; background:linear-gradient(90deg,#22c55e,#a3e635);"></div></div>
                <div class="sp-gauge-range"><span>0%</span><span>100%</span></div>
            </div>
        </div>

        <div class="sp-chart-section">
            <div class="sp-chart-title">7-Day History</div>
            <div style="position:relative; height:120px;">
                <canvas id="sp-history-chart"></canvas>
            </div>
            <div class="sp-chart-legend">
                <span><span class="sp-legend-dot" style="background:#0ea5e9;"></span>Temp (°C)</span>
                <span><span class="sp-legend-dot" style="background:#818cf8;"></span>Humidity (%)</span>
            </div>
            <div id="sp-no-history" style="display:none; text-align:center; color:var(--text-muted); font-size:12px; padding:20px 0;">No historical data yet. Log some days with the sensor connected.</div>
        </div>
    `;
    // Strictly append the popover to the DOM first to ensure elements are present.
    document.body.appendChild(popover);
    
    // Initialize Lucide icons on the newly inserted DOM fragment.
    if (window.lucide) {
        lucide.createIcons();
    }

    // Await rendering sensor data strictly after DOM insertion to prevent null query errors.
    await window.renderSensorPopover();
    window.positionSensorPopover();

    document.addEventListener('click', function outsideClick(ev) {
        const pop = document.getElementById('sensor-popover');
        const chip = document.getElementById('sensor-popover-chip');
        if (pop && !pop.contains(ev.target) && chip && !chip.contains(ev.target)) {
            pop.style.display = 'none';
            document.removeEventListener('click', outsideClick);
        }
    });
};

/**
 * Dynamically positions the environment popover relative to the sensor chip trigger.
 * Applies safety margins (clamping bounds) to ensure the 320px popover stays
 * entirely within the user's viewport on mobile/narrow screens.
 */
window.positionSensorPopover = function() {
    const chip = document.getElementById('sensor-popover-chip');
    const popover = document.getElementById('sensor-popover');
    if (!chip || !popover) return;
    const rect = chip.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    popover.style.top = (rect.bottom + scrollY + 8) + 'px';
    const popW = 320;
    let left = rect.right - popW;

    // Mobile Viewport Clamping:
    // If the left boundary goes off-screen, clamp it to 8px padding.
    // If the right boundary goes off-screen, shift it leftwards to retain 8px padding.
    if (left < 8) {
        left = 8;
    }
    if (left + 320 > window.innerWidth - 8) {
        left = window.innerWidth - 328;
    }
    popover.style.left = left + 'px';
    popover.style.display = 'block';
};

/**
 * Renders the sensor readings and historical chart inside the popover.
 * Fetches the live sensor values and 7-day environmental history from the API.
 * 
 * BUG 1 Fix Note: Assumes the popover DOM element (#sensor-popover) is already
 * appended to the document body to prevent getElementById returning null.
 * 
 * BUG 2 Fix Note: If history is empty, unconditionally hides the canvas and
 * dynamically creates a fallback message element if it isn't found in the DOM.
 */
window.renderSensorPopover = async function() {
    const res = await api.getLiveSensors();
    const history = await api.getSensorHistory();

    const syncLabel = document.getElementById('sp-last-sync');
    const existingErrBox = document.getElementById('sp-error-box');
    if (existingErrBox) existingErrBox.remove();

    if (syncLabel) {
        if (res && res.success && res.last_updated) {
            const diffMin = Math.round((Date.now() - new Date(res.last_updated).getTime()) / 60000);
            const timeStr = diffMin <= 0 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin/60)}h ago`;
            syncLabel.innerHTML = `<span style="color:#22c55e;">●</span> Live · synced ${timeStr}`;
        } else {
            syncLabel.textContent = 'No data yet';
        }
    }

    if (res && !res.success) {
        const errBox = document.createElement('div');
        errBox.id = 'sp-error-box';
        errBox.style.cssText = 'margin:0; padding:10px 14px 12px; background:#fff1f2; border-bottom:1px solid #fecdd3;';
        const errorText   = res.error      || 'Unknown error';
        const errorCode   = res.error_code  != null ? String(res.error_code) : null;
        const errorRaw    = res.error_raw    ? JSON.stringify(res.error_raw, null, 2) : null;

        errBox.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                <i data-lucide="alert-triangle" style="width:13px;height:13px;color:#ef4444;flex-shrink:0;"></i>
                <span style="font-size:11px;font-weight:700;color:#dc2626;">Cloud API Error</span>
                ${errorCode ? `<span style="margin-left:auto;font-size:10px;font-family:monospace;background:#fecdd3;color:#9f1239;padding:1px 6px;border-radius:4px;">code&nbsp;${errorCode}</span>` : ''}
            </div>
            <div style="font-size:11px;color:#be123c;margin-bottom:${errorRaw ? '8px' : '0'};word-break:break-word;">${errorText}</div>
            ${errorRaw ? `
            <details style="margin-top:4px;">
                <summary style="font-size:10px;color:#9f1239;cursor:pointer;user-select:none;font-weight:600;">Raw API response ▾</summary>
                <pre style="margin:6px 0 0;font-size:9px;color:#7f1d1d;background:#ffe4e6;border-radius:6px;padding:8px;overflow:auto;max-height:120px;white-space:pre-wrap;word-break:break-all;">${errorRaw.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
            </details>` : ''}
        `;
        const header = document.querySelector('#sensor-popover .sp-header');
        if (header) header.insertAdjacentElement('afterend', errBox);
        lucide.createIcons();
    }

    if (res && res.temperature !== undefined && res.temperature !== null) {
        const tv = document.getElementById('sp-temp-val');
        const tb = document.getElementById('sp-temp-bar');
        if (tv) tv.textContent = res.temperature.toFixed(1) + '°C';
        if (tb) {
            const pct = Math.min(100, Math.max(0, ((res.temperature - 10) / 30) * 100));
            tb.style.width = pct + '%';
            tb.style.background = res.temperature < 15 || res.temperature > 32
                ? 'linear-gradient(90deg,#ef4444,#f97316)'
                : 'linear-gradient(90deg,#0ea5e9,#22d3ee)';
        }
    }

    if (res && res.humidity !== undefined && res.humidity !== null) {
        const hv = document.getElementById('sp-hum-val');
        const hb = document.getElementById('sp-hum-bar');
        if (hv) hv.textContent = res.humidity.toFixed(0) + '%';
        if (hb) {
            hb.style.width = Math.min(100, res.humidity) + '%';
            hb.style.background = res.humidity > 80 || res.humidity < 40
                ? 'linear-gradient(90deg,#f97316,#ef4444)'
                : 'linear-gradient(90deg,#38bdf8,#818cf8)';
        }
    }

    if (res && res.battery !== undefined && res.battery !== null) {
        const bv = document.getElementById('sp-bat-val');
        const bb = document.getElementById('sp-bat-bar');
        const bg = document.getElementById('sp-gauge-bat');
        if (bv) bv.textContent = res.battery + '%';
        if (bb) {
            bb.style.width = res.battery + '%';
            bb.style.background = res.battery < 20
                ? 'linear-gradient(90deg,#ef4444,#f97316)'
                : 'linear-gradient(90deg,#22c55e,#a3e635)';
        }
        if (bg) bg.style.display = '';
    } else {
        const bg = document.getElementById('sp-gauge-bat');
        if (bg) bg.style.display = 'none';
    }

    const noHistory = document.getElementById('sp-no-history');
    const canvas = document.getElementById('sp-history-chart');
    if (!canvas) return;

    // BUG 2 Fix: When history is empty, unconditionally hide the canvas element.
    // If the '#sp-no-history' container is not found in the DOM (e.g. if the popover
    // is re-opened and it is missing), dynamically create and insert a visible
    // "No sensor history yet" fallback message instead of silently doing nothing.
    if (!history || history.length === 0) {
        canvas.style.display = 'none';
        if (noHistory) {
            noHistory.style.display = '';
        } else {
            const parent = canvas.parentElement;
            if (parent) {
                const msg = document.createElement('div');
                msg.id = 'sp-no-history';
                msg.style.cssText = 'text-align:center; color:var(--text-muted); font-size:12px; padding:20px 0;';
                const textNode = document.createTextNode('No sensor history yet');
                msg.appendChild(textNode);
                parent.appendChild(msg);
            }
        }
        return;
    }
    if (noHistory) {
        noHistory.style.display = 'none';
    }
    canvas.style.display = '';

    const labels = history.map(h => {
        const d = new Date(h.date + 'T00:00:00');
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const temps = history.map(h => h.temperature);
    const hums  = history.map(h => h.humidity);

    if (_sensorPopoverChartInstance) {
        _sensorPopoverChartInstance.data.labels = labels;
        _sensorPopoverChartInstance.data.datasets[0].data = temps;
        _sensorPopoverChartInstance.data.datasets[1].data = hums;
        _sensorPopoverChartInstance.update();
        return;
    }

    _sensorPopoverChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Temp (°C)',
                    data: temps,
                    borderColor: '#0ea5e9',
                    backgroundColor: 'rgba(14,165,233,0.1)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#0ea5e9',
                    tension: 0.4,
                    fill: true,
                    yAxisID: 'yTemp'
                },
                {
                    label: 'Humidity (%)',
                    data: hums,
                    borderColor: '#818cf8',
                    backgroundColor: 'rgba(129,140,248,0.08)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#818cf8',
                    tension: 0.4,
                    fill: true,
                    yAxisID: 'yHum'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false }, tooltip: { callbacks: {
                label: ctx => ctx.datasetIndex === 0
                    ? `🌡️ ${ctx.parsed.y?.toFixed(1) ?? '—'}°C`
                    : `💧 ${ctx.parsed.y?.toFixed(0) ?? '—'}%`
            }}},
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#94a3b8' } },
                yTemp: {
                    position: 'left',
                    ticks: { font: { size: 10 }, color: '#0ea5e9', callback: v => v + '°' },
                    grid: { color: 'rgba(148,163,184,0.1)' }
                },
                yHum: {
                    position: 'right',
                    ticks: { font: { size: 10 }, color: '#818cf8', callback: v => v + '%' },
                    grid: { display: false }
                }
            }
        }
    });
};

function updateCockpitAlerts(batch, kpis, inventory, breakEven, cash, txs, healthLogs) {
    if (batch.status === BATCH_STATUS.COMPLETED) {
        updateGlobalNotifications([]);
        return;
    }

    const now = new Date();
    const alerts = [];
    const t = store.farmProfile.alertThresholds;

    if (txs && txs.length > 0) {
        const feedSpend = txs.filter(x => x.type === 'purchase' && x.category === 'feed').reduce((s, x) => s + parseFloat(x.amount || 0), 0);
        const totalOpex = txs.filter(x => x.type === 'purchase' && x.category !== 'infrastructure').reduce((s, x) => s + parseFloat(x.amount || 0), 0);
        if (totalOpex > 0 && (feedSpend / totalOpex) > 0.75) {
            alerts.push({ type: 'warning', icon: 'pie-chart', text: `Feed Budget Alert: Feed spend (${Math.round((feedSpend/totalOpex)*100)}%) exceeds 75% of total OPEX.` });
        }
    }

    const recent3 = kpis.recent7.slice(0, 3);
    const lowLayCount = recent3.filter(l => (l.eggs / (l.birds || batch.size)) < (t.minLayRatePercent/100)).length;
    const layStartDate = batch.layStartDate ? new Date(batch.layStartDate) : null;
    const daysSinceLaying = layStartDate ? Math.floor((now - layStartDate) / 86400000) : 999;
    if (lowLayCount >= t.consecutiveLowDays && daysSinceLaying > 42) {
        alerts.push({ type: 'danger', icon: 'alert-circle', text: `Production Crisis: Lay rate below ${t.minLayRatePercent}%!` });
    } else if (lowLayCount >= t.consecutiveLowDays && daysSinceLaying <= 42) {
        alerts.push({ type: 'info', icon: 'trending-up', text: `Ramp-up phase: Lay rate is expected to be low in the first 6 weeks of production. Currently Day ${daysSinceLaying} since first egg.` });
    }
    if (kpis.feedConversion > t.maxFeedConversion) alerts.push({ type: 'warning', icon: 'trending-up', text: `High conversion: ${kpis.feedConversion.toFixed(2)}kg/doz` });
    
    const dailyNeed = kpis.avgDailyFeedPerBird * kpis.currentBirds;
    if (dailyNeed > 0 && (inventory / dailyNeed) < t.lowInventoryDays) alerts.push({ type: 'danger', icon: 'package', text: `Low Feed: < ${t.lowInventoryDays} days left!` });
    if (cash < 5000) alerts.push({ type: 'warning', icon: 'wallet', text: `Low Cash: KES ${cash.toLocaleString()}` });

    const seasonInfo = getKitaleSeason(now);
    const latestLog = kpis.recent7[0] || {};
    const currentHumidity = latestLog.humidity || 0;

    if (currentHumidity > 75 || seasonInfo.season === 'rains') {
        alerts.push({ type: 'warning', icon: 'cloud-rain', text: `Disease Risk: ${currentHumidity > 75 ? 'High humidity (>75%)' : 'Long Rains season'} detected. Elevated coccidiosis & respiratory (CRD/IB) risk. Check litter.` });
    }
    const hour = now.getHours();
    if (hour >= 17 && hour <= 19) {
        alerts.push({ type: 'info', icon: 'moon', text: 'Evening check: Close house curtains / verify brooder heating. Kitale nights drop to 12–14 °C.' });
    }
    const litterDate = new Date(store.farmProfile.litterLastChanged || now);
    const litterDays = (now - litterDate) / 86400000;
    if (litterDays > 28 || currentHumidity > 70) {
        alerts.push({ type: 'warning', icon: 'leaf', text: `Litter Risk: ${currentHumidity > 70 ? 'Humidity > 70%.' : `Rotation due (>${Math.floor(litterDays)} days).`} Replace or mix to prevent mucosal irritation.` });
    }

    if (latestLog) {
        if (latestLog.nh3 > 20) alerts.push({ type: 'danger', icon: 'wind', text: `High NH₃ detected (${latestLog.nh3} ppm). Limit is 20 ppm!` });
        if (latestLog.co2 > 3000) alerts.push({ type: 'danger', icon: 'wind', text: `High CO₂ detected (${latestLog.co2} ppm). Limit is 3000 ppm!` });
    }

    const withdrawal = getActiveWithdrawal(healthLogs);
    if (withdrawal.eggsUnderWithdrawal) {
        alerts.push({ type: 'danger', icon: 'alert-triangle', text: `⚠️ Eggs under withdrawal — discard until ${withdrawal.eggClearDate.toLocaleDateString()}` });
    }

    const ageOrigin = batch.hatchDate ? new Date(batch.hatchDate) : new Date(batch.startDate);
    const batchAgeDays = Math.floor((now - ageOrigin) / 86400000);
    const batchAgeWeeks = batchAgeDays / 7;

    const initialSize = parseInt(batch.size) || 100;
    const currentLiveability = batch.stats.birdsAlive / initialSize;
    if (currentLiveability < (ISA_BROWN_CONSTANTS.targetLiveability / 100)) {
        const mortalityPercent = ((1 - currentLiveability) * 100).toFixed(1);
        alerts.push({ type: 'danger', icon: 'alert-octagon', text: `Liveability Crisis: Cumulative mortality at ${mortalityPercent}% (exceeds ISA Brown target of ${(100 - ISA_BROWN_CONSTANTS.targetLiveability).toFixed(1)}% limit).` });
    }

    if (kpis.currentHens > 0 && kpis.currentRoosters > 0) {
        const ratio = kpis.currentHens / kpis.currentRoosters;
        if (ratio < 7) {
            const target = Math.max(1, Math.floor(kpis.currentHens / 7.5));
            const surplus = kpis.currentRoosters - target;
            if (surplus > 0) {
                alerts.push({
                    type: 'warning',
                    icon: 'bird',
                    text: `Surplus Roosters: Ratio is 1:${ratio.toFixed(1)} (ideal 1:7-8). Consider selling ${surplus} roosters.`
                });
            }
        }
    }

    if (batch.type !== 'broiler') {
        if (batchAgeWeeks >= 4 && batchAgeWeeks <= 5 && kpis.avgDailyFeedPerBird < 0.035) {
            alerts.push({ type: 'warning', icon: 'scale', text: `Growth-delay risk (Week ${Math.floor(batchAgeWeeks)}): Feed intake low (${(kpis.avgDailyFeedPerBird*1000).toFixed(0)}g/bird). Target >35g.`});
        }
        if (batchAgeWeeks >= 16.5 && batchAgeWeeks < 18) {
            alerts.push({ type: 'info', icon: 'bone', text: `Skeletal check required: Monitor 'squat response' prior to Point of Lay.`});
        }
    }
    KENCHIC_SCHEDULE.forEach(vax => {
        const lastAdmin = healthLogs.filter(h => h.type === 'vaccine' && h.drug === vax.name)
            .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
            
        let nextDue = null;
        if (!lastAdmin && vax.dayRange[0] <= batchAgeDays + 7) {
            nextDue = new Date(batch.startDate);
            nextDue.setDate(nextDue.getDate() + vax.dayRange[1]);
        } else if (lastAdmin && vax.boosterDays) {
            nextDue = new Date(lastAdmin.date);
            nextDue.setDate(nextDue.getDate() + vax.boosterDays);
        }
        
        if (nextDue) {
            const daysToDue = Math.floor((nextDue - now) / 86400000);
            if (daysToDue <= 7 && daysToDue > 0) {
                alerts.push({ type: 'warning', icon: 'syringe', text: `Upcoming: ${vax.name} vaccine due in ${daysToDue} days.` });
            } else if (daysToDue <= 0) {
                alerts.push({ type: 'danger', icon: 'syringe', text: `Overdue: ${vax.name} vaccine was due ${Math.abs(daysToDue)} days ago!` });
            }
        }
    });

    updateGlobalNotifications(alerts);
}

function renderCockpitChart(recentLogs) {
    const ctx = $('cockpit-layrate-chart')?.getContext('2d');
    if (!ctx) return;
    if (store._cockpitChartInstance) store._cockpitChartInstance.destroy();

    const activeBatch = window.getBatches().find(b => String(b.id) === String(store.currentBatchId));
    const fallbackBirds = activeBatch ? (activeBatch.size || activeBatch.stats?.birdsAlive || 100) : 100;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const lineColor = isDark ? '#5BBF4F' : '#2D5A27';
    const fillColor = isDark ? 'rgba(91,191,79,0.12)' : 'rgba(45,90,39,0.1)';
    const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    const labelColor = isDark ? '#90A49A' : '#6B7280';

    const sorted = [...recentLogs].reverse();
    store._cockpitChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sorted.map(l => new Date(l.date + 'T12:00:00').toLocaleDateString(undefined, {month:'numeric', day:'numeric'})),
            datasets: [{
                label: 'Lay Rate %',
                data: sorted.map(l => {
                    const birds = (l.birds && l.birds > 1) ? l.birds : fallbackBirds;
                    return ((l.eggs / birds) * 100).toFixed(1);
                }),
                borderColor: lineColor,
                backgroundColor: fillColor,
                fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 3,
                pointBackgroundColor: lineColor
            }, {
                label: 'Target Peak',
                data: sorted.map(() => ISA_BROWN_CONSTANTS.targetPeakProduction),
                borderColor: 'rgba(255, 165, 0, 0.5)',
                borderDash: [5, 5],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    beginAtZero: true, max: 100,
                    ticks: { callback: v => v + '%', color: labelColor, font: { size: 11 } },
                    grid: { color: gridColor }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: labelColor, font: { size: 11 }, maxRotation: 0 }
                }
            }
        }
    });
}

function renderHistoryTable(logs, txs = []) {
    const container = $('history-table');
    if (!container) return;
    
    let events = [...logs.map(l => ({...l, isTx: false}))];
    txs.forEach(t => events.push({
        date: t.date.split('T')[0],
        isTx: true,
        type: t.type,
        desc: t.notes ? `<strong style="color:var(--text-dark);">${t.notes}</strong> (${t.category})` : `${t.type === 'sale' ? 'Sold' : 'Purchased'} ${t.category}`,
        amount: t.amount,
        qty: t.qty
    }));
    events.sort((a,b) => new Date(b.date) - new Date(a.date));
    
    window.currentHistoryLimit = window.currentHistoryLimit || 10;
    const slicedEvents = events.slice(0, window.currentHistoryLimit);

    container.innerHTML = events.length === 0 ? '<p style="text-align:center; padding:20px; color:var(--text-muted);">No logs yet.</p>' : `
        <table style="width:100%; border-collapse:collapse;">
            <thead><tr>
                <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Date</th>
                <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Event Details</th>
            </tr></thead>
            <tbody>
                ${slicedEvents.map(e => {
                    const displayDate = new Date(e.date + 'T12:00:00').toLocaleDateString(undefined, {month:'short', day:'numeric'});
                    const amountStr = (typeof e.amount === 'number' && !isNaN(e.amount)) ? e.amount.toLocaleString() : '0';
                    return `
                    <tr style="transition: background 0.15s;" onmouseover="this.style.background='var(--primary-soft)'" onmouseout="this.style.background=''">
                        <td style="padding:8px 12px; border-bottom:1px solid var(--border-color); font-size:12px; white-space:nowrap; color:var(--text-muted);">${displayDate}</td>
                        ${e.isTx ? `
                            <td style="padding:8px 12px; border-bottom:1px solid var(--border-color); font-size:13px;">
                                <span class="pill" style="margin-right:6px; background:${e.type==='sale'?'var(--primary-soft)':'#fee2e2'}; color:${e.type==='sale'?'var(--primary)':'#dc2626'};">${e.type.toUpperCase()}</span>
                                ${e.desc} &mdash; <strong>KES ${amountStr}</strong>
                            </td>
                        ` : `
                            <td style="padding:8px 12px; border-bottom:1px solid var(--border-color); font-size:13px;">
                                <strong>${e.eggs || 0}</strong> eggs
                                ${parseFloat(e.feed)>0 ? `<span style="color:var(--text-muted);"> &bull; ${(parseFloat(e.feed)).toFixed(1)}kg feed</span>` : ''}
                                ${e.mortality>0 ? `<strong class="text-danger"> &bull; ${e.mortality} died</strong>` : ''}
                                ${e.temperature ? `<span style="color:var(--text-muted);"> &bull; ${e.temperature}°C</span>` : ''}
                                ${e.humidity ? `<span style="color:var(--text-muted);"> &bull; ${e.humidity}% RH</span>` : ''}
                            </td>
                        `}
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    `;
    
    if (events.length > window.currentHistoryLimit) {
        const remaining = events.length - window.currentHistoryLimit;
        container.innerHTML += `<div style="padding:12px; text-align:center;"><button class="btn btn-secondary btn-sm" onclick="window.currentHistoryLimit += 10; const b = getBatches().find(x => x.id === currentBatchId); if(b) refreshCockpitData(b);">Load More (${remaining} remaining)</button></div>`;
    }
}

function renderCockpitTransactions(txs, initialCash = 0) {
    const container = $('cockpit-tx-list');
    if (!container) return;
    const revenue = txs.filter(t => t.type === 'sale').reduce((s,t) => s + parseFloat(t.amount||0), 0);
    const expenses = txs.filter(t => t.type === 'purchase').reduce((s,t) => s + parseFloat(t.amount||0), 0);
    const net = revenue - expenses;
    const margin = revenue > 0 ? (net / revenue * 100).toFixed(1) + '%' : '—';

    const opexByCategory = {};
    txs.filter(t => t.type === 'purchase').forEach(t => {
        const cat = t.category || 'other';
        opexByCategory[cat] = (opexByCategory[cat] || 0) + parseFloat(t.amount || 0);
    });
    const opexRows = Object.entries(opexByCategory).map(([cat, val]) =>
        `<div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); padding:2px 0;">
            <span style="text-transform:capitalize;">• ${cat}</span>
            <span>KES ${val.toLocaleString()}</span>
         </div>`
    ).join('');

    const profitColor = net >= 0 ? 'var(--primary)' : 'var(--danger)';
    let statusBadge = '';
    if (txs.length === 0) {
        statusBadge = '<div class="price-advisory" style="text-align:center; margin-top:12px;">No transactions yet.</div>';
    } else if (net < 0) {
        statusBadge = '<div class="price-advisory" style="text-align:center; margin-top:12px; background:#fee2e2; color:#dc2626;">Below break-even — track sales to recover.</div>';
    } else {
        const marginPct = revenue > 0 ? (net / revenue) * 100 : 0;
        if (marginPct < 25) {
            statusBadge = `<div class="price-advisory" style="text-align:center; margin-top:12px; background:#fef9c3; color:#92400e;">Margin at ${marginPct.toFixed(1)}%. Target is 25-35%.</div>`;
        } else if (marginPct > 35) {
            statusBadge = `<div class="price-advisory" style="text-align:center; margin-top:12px; background:var(--primary-soft); color:var(--primary);">Exceptional Margin (${marginPct.toFixed(1)}%)!</div>`;
        } else {
            statusBadge = `<div class="price-advisory" style="text-align:center; margin-top:12px; background:var(--primary-soft); color:var(--primary);">On Target! Margin at ${marginPct.toFixed(1)}%.</div>`;
        }
    }

    container.innerHTML = `
        <div style="padding:16px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:13px;">
                <span style="color:var(--text-muted);">Total Revenue</span>
                <strong style="color:var(--primary);">KES ${revenue.toLocaleString()}</strong>
            </div>
            <div style="margin-bottom:4px; font-size:13px; display:flex; justify-content:space-between; border-bottom:1px dashed var(--border-color); padding-bottom:8px;">
                <span style="color:var(--text-muted);">Total OPEX</span>
                <strong style="color:var(--danger);">KES ${expenses.toLocaleString()}</strong>
            </div>
            ${opexRows ? `<div style="padding:6px 0 8px; border-bottom:1px solid var(--border-color); margin-bottom:8px;">${opexRows}</div>` : ''}
            <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:15px; font-weight:700;">
                <span>Net P&amp;L</span>
                <span style="color:${profitColor};">KES ${net.toLocaleString()}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); margin-bottom:4px;">
                <span>Gross Margin</span>
                <span>${margin}</span>
            </div>
            ${statusBadge}
        </div>
        <div style="border-top:1px solid var(--border-color); overflow-y:auto; padding:8px 12px; max-height:180px;">
            ${txs.length === 0 ? '' : txs.slice(0, 3).map(t => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border-color);">
                <div>
                    <span style="font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; background:${t.type==='sale'?'var(--primary-soft)':'#fee2e2'}; color:${t.type==='sale'?'var(--primary)':'#dc2626'};">${t.type.toUpperCase()}</span>
                    <span style="font-size:12px; margin-left:6px; color:var(--text-dark); text-transform:capitalize;">${t.category}</span>
                    ${t.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${t.notes}</div>` : ''}
                </div>
                <span style="font-size:12px; font-weight:700;">KES ${parseFloat(t.amount||0).toLocaleString()}</span>
            </div>`).join('')}
        </div>
    `;
}

window.openCSVImportModal = async function(batchId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:500px; padding:24px;">
            <h3>Import 2025 Egg Tracker CSV</h3>
            <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">Select your 2025 Egg Tracker CSV file. Data will be merged into current logs.</p>
            <div class="input-group">
                <label>CSV File</label>
                <input type="file" id="csv-file" accept=".csv">
            </div>
            <div id="csv-preview" style="max-height:200px; overflow-y:auto; margin-top:12px; font-size:11px; border:1px solid var(--border-color); border-radius:4px; padding:8px; display:none;"></div>
            <div style="display:flex; gap:12px; margin-top:20px;">
                <button class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                <button class="btn btn-primary" id="btn-confirm-import" style="flex:1;" disabled>Confirm Import</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    $('csv-file').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(re) {
            const text = re.target.result;
            const records = parseEggTrackerCSV(text);
            const preview = $('csv-preview');
            preview.style.display = 'block';
            preview.innerHTML = `<strong>Found ${records.length} days of data.</strong><br>First date: ${records[0].date}<br>Last date: ${records[records.length-1].date}`;
            $('btn-confirm-import').disabled = false;
            $('btn-confirm-import').onclick = async function() {
                for (const l of records) {
                    await api.saveLog(batchId, l);
                }
                document.body.removeChild(modal);
                const batch = window.getBatches().find(b => b.id === batchId);
                window.refreshCockpitData(batch);
            };
        };
        reader.readAsText(file);
    });
};

window.openBackfillModal = async function(batchId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:400px; padding:24px;">
            <h3>Backfill Missing Days</h3>
            <p style="font-size:12px; color:var(--text-muted); margin-bottom:16px;">Distribute eggs and sacks evenly over a date range.</p>
            <div class="input-grid">
                <div class="input-group"><label>Start Date</label><input type="date" id="bf-start"></div>
                <div class="input-group"><label>End Date</label><input type="date" id="bf-end"></div>
            </div>
            <div class="input-grid">
                <div class="input-group"><label>Total Eggs</label><input type="number" id="bf-eggs"></div>
                <div class="input-grid"><label>Total Sacks</label><input type="number" id="bf-sacks" value="0"></div>
            </div>
            <div style="display:flex; gap:12px; margin-top:20px;">
                <button class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                <button class="btn btn-primary" id="btn-do-backfill" style="flex:1;">Run Backfill</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    $('btn-do-backfill').onclick = async function() {
        const start = new Date($('bf-start').value);
        const end = new Date($('bf-end').value);
        const totalEggs = parseInt($('bf-eggs').value) || 0;
        const totalSacks = parseInt($('bf-sacks').value) || 0;

        if (isNaN(start) || isNaN(end) || end < start) { window.showToast('Invalid date range.', 'danger'); return; }

        const days = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            days.push(new Date(d).toISOString().split('T')[0]);
        }

        const eggsPerDay = Math.floor(totalEggs / days.length);
        for (const d of days) {
            const i = days.indexOf(d);
            const entry = { date: d, eggs: eggsPerDay, sacks: (i === days.length - 1 ? totalSacks : 0), feedGiven: 0 };
            await api.saveLog(batchId, entry);
        }
        try { document.body.removeChild(modal); } catch(e){}
        const batch = window.getBatches().find(b => String(b.id) === String(batchId));
        if (batch) window.refreshCockpitData(batch);
    };
};

window.showAdjustFlockModal = async function() {
    const batch = window.getBatches().find(b => String(b.id) === String(store.currentBatchId));
    if (!batch) return;
    
    const initialHens = batch.stats?.initialHens !== undefined ? batch.stats.initialHens : (batch.size || 0);
    const initialRoosters = batch.stats?.initialRoosters || 0;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'adjust-flock-modal';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:350px; padding:24px;">
            <h3>Adjust Flock Baseline</h3>
            <p style="font-size:12px; color:var(--text-muted); margin-top:8px;">Set the baseline (initial) number of Hens and Roosters for this flock. The system will subtract mortalities and sales from these baselines to compute the current count.</p>
            <form id="adjust-flock-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                <div class="input-group">
                    <label>Initial Hens (egg-producers)</label>
                    <input type="number" id="adj-initial-hens" value="${initialHens}" min="0" required>
                </div>
                <div class="input-group">
                    <label>Initial Roosters (non-producers)</label>
                    <input type="number" id="adj-initial-roosters" value="${initialRoosters}" min="0" required>
                </div>
                <div style="display:flex; gap:12px; margin-top:8px;">
                    <button type="button" class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                    <button type="submit" class="btn btn-primary" style="flex:1;">Save Baselines</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    
    document.getElementById('adjust-flock-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newHens = parseInt(document.getElementById('adj-initial-hens').value) || 0;
        const newRoosters = parseInt(document.getElementById('adj-initial-roosters').value) || 0;
        
        batch.stats = batch.stats || {};
        batch.stats.initialHens = newHens;
        batch.stats.initialRoosters = newRoosters;
        batch.size = newHens + newRoosters;
        batch.stats.birdsAlive = newHens + newRoosters;
        
        await window.updateBatch(batch);
        document.body.removeChild(modal);
        window.refreshCockpitData(batch);
        window.showToast('Flock baseline updated!', 'success');
    });
};

window.showEggLossModal = async function() {
    const batch = window.getBatches().find(b => String(b.id) === String(store.currentBatchId));
    if (!batch) return;
    
    const logs = await api.getLogs(batch.id);
    const txs = await api.getTransactions(batch.id);
    const stagingToday = await api.getTodayStaging(batch.id).catch(() => null);
    
    const totalHarvestLoss = logs.reduce((sum, l) => sum + (parseInt(l.eggs_broken) || 0), 0) + 
        (stagingToday?.eggs?.broken || 0);
        
    const totalStorageLoss = txs.filter(t => t.type === 'write_off' && t.category === 'eggs')
        .reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
        
    const totalIntactCollected = logs.reduce((sum, l) => sum + ((parseInt(l.eggs) || 0) - (parseInt(l.eggs_broken) || 0)), 0) + 
        ((stagingToday?.eggs?.total || 0) - (stagingToday?.eggs?.broken || 0));
        
    const totalSales = txs.filter(t => t.type === 'sale' && t.category === 'eggs')
        .reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
        
    const inventoryAging = computeEggInventoryAging(logs, txs, stagingToday);
    const currentStock = inventoryAging.totalUnsold;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'egg-loss-modal';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:400px; padding:24px;">
            <h3>Egg Inventory & Loss Reconciliation</h3>
            <div style="display:flex; flex-direction:column; gap:12px; margin-top:16px; font-size:14px; color:var(--text-dark);">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--border-color); padding-bottom:8px;">
                    <span>Total Eggs Collected (Gross)</span>
                    <strong>${(totalIntactCollected + totalHarvestLoss).toLocaleString()}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; color:var(--danger); padding-left:12px;">
                    <span>- Harvest Loss (Broken at Coop)</span>
                    <strong>-${totalHarvestLoss.toLocaleString()}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--border-color); padding-bottom:8px; font-weight:600;">
                    <span>= Placed in Storage (Net Collected)</span>
                    <strong>${totalIntactCollected.toLocaleString()}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; color:var(--primary); padding-left:12px;">
                    <span>- Total Eggs Sold</span>
                    <strong>-${totalSales.toLocaleString()}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; color:var(--danger); padding-left:12px; border-bottom:1px solid var(--border-color); padding-bottom:8px;">
                    <span>- Storage Loss (Write-offs/Spoiled)</span>
                    <strong>-${totalStorageLoss.toLocaleString()}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:16px; padding-top:4px;">
                    <span>Current Stock (Unsold)</span>
                    <span style="color:var(--primary);">${currentStock.toLocaleString()} eggs</span>
                </div>
            </div>
            <div style="display:flex; margin-top:24px;">
                <button type="button" class="btn btn-primary" style="width:100%;" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};
