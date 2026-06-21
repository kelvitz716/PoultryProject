/**
 * @file app.js
 * @description Main frontend application controller orchestrating the Single Page Application (SPA).
 * Binds page navigation elements, manages the multi-step project proposal generator wizard,
 * controls the live batch cockpit dashboard, maps historical database data to analytics,
 * and maintains reactive UI bindings (Lucide icons, Chart.js datasets, modals, and tables).
 */

import { api } from './api.js';
import {
    ISA_BROWN_CONSTANTS, KITALE_CLIMATE_BASELINE, KENCHIC_SCHEDULE,
    DRUG_WITHDRAWAL_TABLE, getKitaleSeason, FEED_SCHEDULE,
    VACCINATION_SCHEDULE, KB_CONTENT, DEFAULT_FARM_PROFILE,
    sackBackfill, parseEggTrackerCSV, computeKPIs, computeEggInventoryAging, computeTHI, getHeatStressStatus,
    BATCH_STATUS, STAGING_STATUS
} from './engine.js';
import { $, showToast, showConfirmModal, updateGlobalNotifications } from './ui.js';

import { store } from './store.js';
import { initSettingsView } from './settings.js';
import { initBatchesView } from './batches.js';
import { getActiveWithdrawal } from './health.js';
import './sales.js';
import { initDashboardView } from './dashboard.js';
import { initCockpitView } from './cockpit.js';

window.addEventListener('unhandledrejection', e => {
    console.error('[unhandled rejection]', e.reason);
});

// Register Service Worker for offline PWA capabilities
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .then(reg => console.log('[PWA] Service Worker registered successfully on scope:', reg.scope))
            .catch(err => console.error('[PWA] Service Worker registration failed:', err));
    });
}

(async () => {
    lucide.createIcons();

    // ── Offline status & Background Sync Fallback ────────────────────────────────
    const updateOfflineStatus = () => {
        const banner = document.getElementById('offline-banner');
        if (banner) {
            banner.style.display = navigator.onLine ? 'none' : 'block';
        }
        if (navigator.onLine) {
            api.replayOfflineQueue();
        }
    };
    window.addEventListener('online', updateOfflineStatus);
    window.addEventListener('offline', updateOfflineStatus);
    updateOfflineStatus(); // run initial check

    // Request Persistent Storage to prevent mobile OS from clearing cache
    if (navigator.storage && navigator.storage.persist) {
        const isPersisted = await navigator.storage.persisted();
        console.log(`[PWA] Storage is persisted: ${isPersisted}`);
        if (!isPersisted) {
            const granted = await navigator.storage.persist();
            console.log(`[PWA] Persistent storage request status: ${granted}`);
        }
    }

    // ── Toast + modal helpers ───────────────────────────────────────────────
    window.showToast = showToast;
    window.showConfirmModal = showConfirmModal;
    window.updateGlobalNotifications = updateGlobalNotifications;

    // ── AUTH GATE ─────────────────────────────────────────────────────────────
    // Determine user identity before rendering anything else.
    // USER_ROLE is referenced throughout the UI to hide/disable write controls.
    window.USER_ROLE = 'viewer'; // safe default until confirmed
    window.CURRENT_USER = null;

    const authState = await api.getMe();

    if (authState.setupRequired) {
        // First launch — no users exist — show setup wizard
        _showSetupWizard();
        return; // halt remaining init until setup completes
    }

    if (!authState.user) {
        // Check for guest token in URL (?guest=TOKEN)
        const guestToken = new URLSearchParams(window.location.search).get('guest');
        if (guestToken) {
            const guestResult = await api.loginGuest(guestToken);
            if (guestResult.success) {
                window.USER_ROLE = 'viewer';
                window.CURRENT_USER = guestResult.user;
            } else {
                _showLoginModal('Invalid or expired guest link.');
                return;
            }
        } else {
            _showLoginModal();
            return;
        }
    } else {
        window.USER_ROLE = authState.user.role;
        window.CURRENT_USER = authState.user;
        if (authState.user.mustChangePassword) {
            showToast('⚠️ Please change your password in Settings.', 'warning');
        }
    }

    _initApp(); // proceed with full app initialization
})();

// ── AUTH MODAL HELPERS ─────────────────────────────────────────────────────────

function _showLoginModal(errorMsg = '') {
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
        <div style="background:var(--card-bg,#1e2535);border-radius:16px;padding:36px 32px;min-width:340px;max-width:94vw;box-shadow:0 24px 64px rgba(0,0,0,0.5);">
            <div style="text-align:center;margin-bottom:24px;">
                <div style="font-size:2rem;margin-bottom:8px;">🐔</div>
                <h2 style="margin:0;font-size:1.4rem;">PoultryDSS</h2>
                <p style="margin:6px 0 0;opacity:0.6;font-size:0.85rem;">Sign in to continue</p>
            </div>
            ${errorMsg ? `<div style="background:#fef2f2;color:#dc2626;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:0.85rem;">${errorMsg}</div>` : ''}
            <div style="margin-bottom:14px;">
                <label style="display:block;font-size:0.8rem;opacity:0.7;margin-bottom:6px;">Username</label>
                <input id="auth-username" type="text" autocomplete="username" placeholder="Enter username"
                    style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;font-size:1rem;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:20px;">
                <label style="display:block;font-size:0.8rem;opacity:0.7;margin-bottom:6px;">Password</label>
                <input id="auth-password" type="password" autocomplete="current-password" placeholder="Enter password"
                    style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;font-size:1rem;box-sizing:border-box;">
            </div>
            <div id="auth-error" style="display:none;color:#ef4444;font-size:0.82rem;margin-bottom:12px;"></div>
            <button id="auth-submit" style="width:100%;padding:12px;border-radius:8px;border:none;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;">
                Sign In
            </button>
        </div>`;
    document.body.appendChild(overlay);

    const doLogin = async () => {
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;
        document.getElementById('auth-error').style.display = 'none';
        document.getElementById('auth-submit').textContent = 'Signing in…';
        const result = await api.login(username, password);
        if (result.success) {
            window.USER_ROLE = result.user.role;
            window.CURRENT_USER = result.user;
            overlay.remove();
            _initApp();
        } else {
            document.getElementById('auth-error').textContent = result.error || 'Login failed.';
            document.getElementById('auth-error').style.display = 'block';
            document.getElementById('auth-submit').textContent = 'Sign In';
        }
    };
    document.getElementById('auth-submit').addEventListener('click', doLogin);
    overlay.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    setTimeout(() => document.getElementById('auth-username')?.focus(), 100);
}

function _showSetupWizard() {
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
        <div style="background:var(--card-bg,#1e2535);border-radius:16px;padding:36px 32px;min-width:360px;max-width:94vw;box-shadow:0 24px 64px rgba(0,0,0,0.5);">
            <div style="text-align:center;margin-bottom:24px;">
                <div style="font-size:2.5rem;margin-bottom:8px;">🐔</div>
                <h2 style="margin:0;font-size:1.5rem;">Welcome to PoultryDSS</h2>
                <p style="margin:8px 0 0;opacity:0.65;font-size:0.88rem;">First launch detected — create your super-admin account</p>
            </div>
            <div style="margin-bottom:14px;">
                <label style="display:block;font-size:0.8rem;opacity:0.7;margin-bottom:6px;">Choose a username</label>
                <input id="setup-username" type="text" autocomplete="username" placeholder="e.g. admin"
                    style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;font-size:1rem;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:14px;">
                <label style="display:block;font-size:0.8rem;opacity:0.7;margin-bottom:6px;">Password (min 8 characters)</label>
                <input id="setup-password" type="password" autocomplete="new-password" placeholder="Strong password"
                    style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;font-size:1rem;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:20px;">
                <label style="display:block;font-size:0.8rem;opacity:0.7;margin-bottom:6px;">Confirm password</label>
                <input id="setup-confirm" type="password" autocomplete="new-password" placeholder="Repeat password"
                    style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;font-size:1rem;box-sizing:border-box;">
            </div>
            <div id="setup-error" style="display:none;color:#ef4444;font-size:0.82rem;margin-bottom:12px;"></div>
            <button id="setup-submit" style="width:100%;padding:12px;border-radius:8px;border:none;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;">
                Create Account &amp; Continue
            </button>
            <p style="margin:14px 0 0;text-align:center;font-size:0.78rem;opacity:0.5;">You can add more users and adjust roles in Settings after setup.</p>
        </div>`;
    document.body.appendChild(overlay);

    document.getElementById('setup-submit').addEventListener('click', async () => {
        const username = document.getElementById('setup-username').value.trim();
        const password = document.getElementById('setup-password').value;
        const confirm  = document.getElementById('setup-confirm').value;
        const errEl = document.getElementById('setup-error');
        errEl.style.display = 'none';

        if (!username) { errEl.textContent = 'Username is required.'; errEl.style.display = 'block'; return; }
        if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; return; }
        if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return; }

        document.getElementById('setup-submit').textContent = 'Creating account…';
        const result = await api.setupAccount(username, password);
        if (result.success) {
            window.USER_ROLE = 'super_admin';
            window.CURRENT_USER = result.user;
            overlay.remove();
            _initApp();
        } else {
            errEl.textContent = result.error || 'Setup failed — try again.';
            errEl.style.display = 'block';
            document.getElementById('setup-submit').textContent = 'Create Account & Continue';
        }
    });
    setTimeout(() => document.getElementById('setup-username')?.focus(), 100);
}

// ── MAIN APP INIT ──────────────────────────────────────────────────────────────
async function _initApp() {
    initSettingsView();
    initBatchesView();
    initDashboardView();
    initCockpitView();

    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.view');

    if (window.USER_ROLE === 'viewer') {
        const genNav = document.getElementById('nav-generator');
        if (genNav) genNav.style.display = 'none';
        const newProjBtn = document.getElementById('btn-new-project');
        if (newProjBtn) newProjBtn.style.display = 'none';
        const firstPropBtn = document.getElementById('btn-first-proposal');
        if (firstPropBtn) firstPropBtn.style.display = 'none';
        const gotoGenBtn = document.getElementById('btn-goto-generator');
        if (gotoGenBtn) gotoGenBtn.style.display = 'none';
    }

    if (window.USER_ROLE === 'farmer') {
        const toHide = ['analytics', 'sales', 'settings'];
        toHide.forEach(id => {
            const el = document.getElementById(`nav-${id}`);
            if (el) el.style.display = 'none';
        });
        const newProjBtn = document.getElementById('btn-new-project');
        if (newProjBtn) newProjBtn.style.display = 'none';
        const firstPropBtn = document.getElementById('btn-first-proposal');
        if (firstPropBtn) firstPropBtn.style.display = 'none';
        const gotoGenBtn = document.getElementById('btn-goto-generator');
        if (gotoGenBtn) gotoGenBtn.style.display = 'none';
    }

    window.switchView = function(viewId) {
        if (window.USER_ROLE === 'farmer') {
            if (viewId === 'dashboard' || viewId === 'generator' || viewId === 'analytics') {
                const activeBatch = store.allBatches.find(b => b.status === BATCH_STATUS.ACTIVE);
                if (activeBatch) {
                    window.openBatchCockpit(activeBatch.id);
                    return;
                } else {
                    viewId = 'batches';
                }
            } else if (viewId === 'batches') {
                const activeBatch = store.allBatches.find(b => b.status === BATCH_STATUS.ACTIVE);
                if (activeBatch) {
                    window.openBatchCockpit(activeBatch.id);
                    return;
                }
            }
        }
        navItems.forEach(item => item.classList.toggle('active', item.id === `nav-${viewId}`));
        views.forEach(view => view.classList.toggle('active', view.id === `view-${viewId}`));
        if (viewId === 'dashboard') refreshDashboard();
        if (viewId === 'analytics') renderAnalytics();
        if (viewId === 'docs') resetDocsPanel();
        if (viewId === 'batches') refreshBatches();
        if (viewId === 'settings') loadSettingsForm();
    }

    navItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            switchView(item.id.replace('nav-', ''));
        });
    });

    document.getElementById('btn-new-project')?.addEventListener('click', async () => { resetWizard(); switchView('generator'); });
    document.getElementById('btn-first-proposal')?.addEventListener('click', async () => { resetWizard(); switchView('generator'); });
    
    // Model New Batch triggers the bridge modal instead of blindly starting from scratch
    document.getElementById('btn-goto-generator')?.addEventListener('click', async () => { showStartBatchModal(); });

    async function loadFarmProfile() {
        return await store.loadFarmProfile();
    }

    async function saveFarmProfile(profile) {
        await store.saveFarmProfile(profile);
    }

    // Load initial data asynchronously in the background so we don't block DOM binding execution flow
    const initDataPromise = (async () => {
        try {
            await loadFarmProfile();
            await syncBatches();
        } catch (e) {
            console.error('Failed to load initial data:', e);
        }
    })();


    async function loadAggregates() {
        const stored = await api.getEntity('poultryAggregates', null);
        if (stored) return stored;
        return { avgLayRateByMonth: {}, avgFeedConversion: 0, avgMortalityCurve: [], seasonalFactor: {}, batchCount: 0 };
    }

    async function saveAggregates(agg) {
        await api.setEntity('poultryAggregates', agg);
    }

    // Functions extracted to engine.js

    // ===================== WIZARD & PROPOSAL STATE =====================
    const formSteps = document.querySelectorAll('.form-step');
    const wizardStepsHeader = document.querySelectorAll('.wizard-steps .step');
    const btnNext = document.getElementById('wizard-next');
    const btnPrev = document.getElementById('wizard-prev');
    const btnSave = document.getElementById('wizard-save');
    let currentWizardStep = 1;
    let currentProposalId = null; // Prevents duplicating the same proposal on multiple saves

    function updateWizard() {
        formSteps.forEach(step => step.classList.toggle('active', parseInt(step.dataset.step) === currentWizardStep));
        wizardStepsHeader.forEach((step, i) => {
            step.classList.toggle('active', (i + 1) === currentWizardStep);
            step.classList.toggle('completed', (i + 1) < currentWizardStep);
        });

        // Update Slim Stepper nodes & ribbon
        const nodes = document.querySelectorAll('.slim-stepper .node');
        nodes.forEach((node, i) => {
            node.classList.toggle('active', (i + 1) === currentWizardStep);
            node.classList.toggle('completed', (i + 1) < currentWizardStep);
        });
        const ribbon = document.querySelector('.progress-ribbon');
        if (ribbon) ribbon.style.width = ((currentWizardStep / 4) * 100) + '%';
        btnPrev.disabled = currentWizardStep === 1;
        btnPrev.style.display = currentWizardStep === 1 ? 'none' : 'inline-flex';
        btnNext.textContent = currentWizardStep === 4 ? 'Save & Finish' : 'Continue';
        btnSave.style.display = currentWizardStep > 1 ? 'inline-flex' : 'none';
        if (currentWizardStep === 3) calculateFinancials();
        if (currentWizardStep === 4) lucide.createIcons();
        toggleRevenueFields();
    }

    btnNext.addEventListener('click', async () => {
        if (currentWizardStep < 4) {
            // --- Step-level validation before advancing ---
            if (currentWizardStep === 1) {
                const name = $('prop-name').value.trim();
                const size = parseInt($('prop-size').value);
                if (!name) {
                    $('prop-name').focus();
                    window.showToast('Please enter a project name before continuing.', 'warning');
                    return;
                }
                if (!size || size < 1) {
                    $('prop-size').focus();
                    window.showToast('Please enter a valid flock size (≥ 1 bird).', 'warning');
                    return;
                }
            }
            if (currentWizardStep === 3) {
                const size = parseInt($('prop-size').value);
                if (!size || size < 1) {
                    window.showToast('Flock size is missing — go back to Step 1 and fill it in.', 'danger');
                    return;
                }
            }
            currentWizardStep++;
            updateWizard();
        } else {
            // Await save before resetting so the form isn't cleared mid-read
            await saveProposal();
            switchView('dashboard');
            resetWizard();
        }
    });
    btnPrev.addEventListener('click', () => { if (currentWizardStep > 1) { currentWizardStep--; updateWizard(); } });
    btnSave.addEventListener('click', () => { saveProposal(); });

    function resetWizard() { 
        currentWizardStep = 1; 
        currentProposalId = null;
        updateWizard();
        document.getElementById('proposal-form').reset();
        // Clear any stale snapshot note
        const noteEl = $('snapshot-note');
        if (noteEl) { noteEl.style.display = 'none'; noteEl.innerHTML = ''; }
        calculateFinancials(); // reset financial spans
    }

    // ===================== REVENUE FIELD TOGGLE =====================
    function toggleRevenueFields() {
        const type = document.getElementById('prop-type').value;
        const isLayer = type === 'layer' || type === 'dual';
        
        document.getElementById('revenue-layer-fields').style.display = isLayer ? 'grid' : 'none';
        document.getElementById('revenue-broiler-fields').style.display = type === 'broiler' ? 'grid' : 'none';
        
        // Feed price bags toggle
        document.getElementById('feed-chick').style.display = isLayer ? 'flex' : 'none';
        document.getElementById('feed-layer-bags').style.display = isLayer ? 'grid' : 'none';
        document.getElementById('feed-broiler-bags').style.display = type === 'broiler' ? 'grid' : 'none';
    }
    document.getElementById('prop-type').addEventListener('change', () => { toggleRevenueFields(); calculateFinancials(); });

    // ===================== FINANCIAL CALCULATIONS =====================

    // Dynamic Financial Inputs Listeners
    ['prop-size', 'prop-type', 'prop-time-horizon', 'prop-mortality', 'prop-cost-bird', 'prop-price-chickmash', 'prop-price-growermash', 'prop-price-layermash', 'prop-price-broilerstarter', 'prop-price-broilerfinisher', 'prop-cost-housing', 'prop-cost-equipment', 'prop-egg-price', 'prop-eggs-month', 'prop-broiler-price'].forEach(id => {
        $(id)?.addEventListener('input', calculateFinancials);
    });

    /**
     * Calculates the estimated project financials (CAPEX, OPEX, expected revenues, profit margins, 
     * and payback period) based on wizard form inputs and displays the results in real-time.
     */
    function calculateFinancials() {
        const size = parseInt($('prop-size').value) || 100;
        const type = $('prop-type').value;
        const horizonRaw = parseInt($('prop-time-horizon').value);
        const horizon = horizonRaw || (type === 'broiler' ? 6 : 72);
        const mortalityRate = parseFloat($('prop-mortality').value) / 100 || 0.05;

        const batchMode = $('prop-batch-mode')?.value || 'setup';
        const isRepeat = batchMode === 'repeat';

        const housingCost = isRepeat ? 0 : (parseFloat($('prop-cost-housing').value) || 0);
        const equipmentCost = isRepeat ? 0 : (parseFloat($('prop-cost-equipment').value) || 0);
        let capex = housingCost + equipmentCost;

        const chickCost = parseFloat($('prop-cost-bird').value) || 130;
        let cumulativeOpex = size * chickCost; // initial stock
        let cumulativeRevenue = 0;
        
        const initialStockCost = cumulativeOpex;
        
        // Feed Prices per KG
        const pChick = (parseFloat($('prop-price-chickmash').value) || 3800) / 50;
        const pGrower = (parseFloat($('prop-price-growermash').value) || 3400) / 50;
        const pLayer = (parseFloat($('prop-price-layermash').value) || 3600) / 50;
        const pBStarter = (parseFloat($('prop-price-broilerstarter').value) || 4000) / 50;
        const pBFinisher = (parseFloat($('prop-price-broilerfinisher').value) || 3800) / 50;

        const weeklyVaxBroodPerBird = type === 'broiler' ? 5 : 2;
        let currentFlock = size;
        const weeklyMortality = mortalityRate / horizon; 

        let exactBreakevenWeek = -1;

        if (type === 'broiler') {
            for (let week = 1; week <= Math.min(horizon, 8); week++) {
                currentFlock -= (currentFlock * weeklyMortality);
                // Broiler curve: ~180g day week 6 -> ~1.26kg/wk
                let kgPerBird = week <= 3 ? 0.35 : 0.95; 
                let feedPrice = week <= 3 ? pBStarter : pBFinisher;
                cumulativeOpex += (currentFlock * kgPerBird * feedPrice) + (currentFlock * weeklyVaxBroodPerBird);
                
                if (week === Math.min(horizon, 6)) { // target harvest
                    const broilerP = parseFloat($('prop-broiler-price').value) || 500;
                    cumulativeRevenue += currentFlock * broilerP;
                }
                
                if (exactBreakevenWeek === -1 && cumulativeRevenue >= (cumulativeOpex + capex)) {
                    exactBreakevenWeek = week;
                }
            }
        } else { // Layer / Dual
            const eggPrice = parseFloat($('prop-egg-price').value) || 15;
            for (let week = 1; week <= horizon; week++) {
                currentFlock -= (currentFlock * weeklyMortality);
                let feedC = 0, feedPrice = 0, layRate = 0;
                
                // Biological rules for layers
                if (week <= 8) { feedC = 0.25; feedPrice = pChick; }
                else if (week <= 18) { feedC = 0.55; feedPrice = pGrower; }
                else {
                    feedC = window.farmLearnings?.layerFeedC || 0.84; feedPrice = pLayer; // ~120g per day or learned value
                    if (week <= 22) layRate = 0.50; // Coming into lay
                    else if (week <= 40) layRate = 0.92; // Peak production
                    else if (week <= 60) layRate = 0.85; // Standard decay
                    else layRate = 0.70; // Late stage decay
                }
                
                cumulativeOpex += (currentFlock * feedC * feedPrice) + (currentFlock * weeklyVaxBroodPerBird);
                cumulativeRevenue += (currentFlock * layRate * 7) * eggPrice;
                
                if (exactBreakevenWeek === -1 && cumulativeRevenue >= (cumulativeOpex + capex)) {
                    exactBreakevenWeek = week;
                }
            }
        }

        const profit = cumulativeRevenue - cumulativeOpex - capex;

        const fmt = v => `KES ${Math.round(v).toLocaleString()}`;
        
        $('calc-birds').textContent = size;
        $('calc-doc-cost').textContent = fmt(initialStockCost);
        $('calc-infra-cost').textContent = fmt(capex);
        $('calc-capex').textContent = fmt(capex);
        
        $('calc-weekly-opex').textContent = fmt(cumulativeOpex / horizon);
        $('calc-6m-opex').textContent = fmt(cumulativeOpex);
        $('calc-6m-rev').textContent = fmt(cumulativeRevenue);
        $('calc-profit').textContent = fmt(profit);
        
        const isProfitable = profit > 0;
        $('calc-profit').className = isProfitable ? 'stat-value positive' : 'stat-value negative';
        $('calc-profit').style.color = isProfitable ? 'var(--primary)' : 'var(--danger)';
        
        // Exact Breakeven logic
        if (!isProfitable) {
            $('calc-breakeven').textContent = 'Never breaks even';
        } else {
            if (type === 'broiler') {
                $('calc-breakeven').textContent = '1 Batch Cycle';
            } else {
                $('calc-breakeven').textContent = exactBreakevenWeek !== -1 ? `Week ${exactBreakevenWeek}` : 'Beyond Horizon';
            }
        }

        $('calc-weekly-opex-label').textContent = `Avg Weekly OPEX (${horizon}wks):`;
        $('calc-6m-rev-label').textContent = isRepeat ? 'Lifecycle Revenue:' : (type === 'broiler' ? 'Batch Harvest Revenue:' : `Est. ${horizon}-Week Revenue:`);
        $('calc-6m-opex-label').textContent = type === 'broiler' ? 'Lifecycle OPEX:' : `Cumulative ${horizon}-Week OPEX:`;
        $('calc-profit-label').textContent = isRepeat ? 'Margin (Excl. CAPEX):' : 'Net Lifetime Profit:';
    }


    // ===================== TEMPLATE =====================
    $('btn-template-100')?.addEventListener('click', async () => {
        $('prop-name').value = '100-Bird Kenchic Layer Farm';
        $('prop-type').value = 'layer';
        $('prop-size').value = '100';
        $('prop-owner').value = 'Kelvitz';
        $('prop-location').value = '';
        $('prop-cost-bird').value = '130';
        $('prop-price-chickmash').value = '3800';
        $('prop-price-growermash').value = '3400';
        $('prop-price-layermash').value = '3600';
        $('prop-time-horizon').value = '72';
        $('prop-mortality').value = '5';
        $('prop-housing').value = 'split-floor';
        $('prop-nesting').value = 'rollaway';
        $('prop-cost-equipment').value = '15000';
        $('prop-feed-strategy').value = '100% commercial feeds. Budget: KES 85,000 to Point of Lay.';
        $('prop-water-strategy').value = 'External jerrycan waterers. Zero spill design.';
        toggleRevenueFields();
        calculateFinancials();
        lucide.createIcons();
    });

    // ===================== SNAPSHOT LOADING =====================
    $('btn-load-snapshot')?.addEventListener('click', async () => {
        const snapshots = await api.getSnapshots();
        if (snapshots.length === 0) {
            const noteEl = $('snapshot-note');
            if (noteEl) {
                noteEl.style.display = 'block';
                noteEl.style.color = 'var(--danger)';
                noteEl.style.borderColor = 'var(--danger)';
                noteEl.innerHTML = `<i data-lucide="alert-circle" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;"></i> No completed batches found. Finish a batch first to create a success snapshot.`;
                lucide.createIcons();
            } else {
                window.showToast('No completed batches found. Finish a batch first to create a success snapshot.', 'danger');
            }
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:500px; padding:24px;">
                <div class="card-header" style="margin-bottom:20px;">
                    <h3>Load Success Snapshot</h3>
                    <button class="btn-icon" onclick="document.body.removeChild(this.closest('.modal-overlay'))"><i data-lucide="x"></i></button>
                </div>
                <div class="snapshot-list">
                    ${snapshots.map(s => `
                        <div class="snapshot-item" onclick="window.applySnapshot(${s.id})">
                            <div class="snapshot-info">
                                <h5>${s.batchName}</h5>
                                <p>${s.birds} birds • ${s.type} • Profit: KES ${s.totalProfit.toLocaleString()}</p>
                            </div>
                            <span class="pill">Load Data</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();

        window.applySnapshot = (id) => {
            const s = snapshots.find(sn => sn.id === id);
            if (!s) return;
            
            $('prop-name').value = `New ${s.batchName.replace('Batch: ', '')} (Optimised)`;
            $('prop-type').value = s.type;
            $('prop-size').value = s.birds;
            $('prop-time-horizon').value = s.type === 'layer' ? '72' : '6';
            $('prop-egg-price').value = Math.round(s.avgEggPrice);
            $('prop-eggs-month').value = Math.round(s.avgLayRate * 30);
            
            const noteEl = $('snapshot-note');
            if (noteEl) {
                noteEl.style.display = 'block';
                noteEl.innerHTML = `<i data-lucide="info" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;"></i> Based on your batch <strong>'${s.batchName}'</strong>, expected lay rate at peak is <strong>${(s.avgLayRate * 100).toFixed(1)}%</strong>.`;
                lucide.createIcons();
            }

            document.body.removeChild(modal);
            toggleRevenueFields();
            calculateFinancials();
            window.showToast('Model pre-filled with real farm performance data!', 'primary');
        };
    });

    // ===================== PROPOSAL PREVIEW =====================
    $('btn-generate-preview')?.addEventListener('click', generateProposal);

    function generateProposal() {
        const name = $('prop-name').value || 'Untitled Project';
        const owner = $('prop-owner').value || 'SME Farmer';
        const typeEl = $('prop-type');
        const type = typeEl.value;
        const typeName = typeEl.options[typeEl.selectedIndex].text;
        const size = $('prop-size').value || 0;
        const location = $('prop-location').value || 'Not specified';
        const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        const isRepeat = $('prop-batch-mode')?.value === 'repeat';
        const housingEl = $('prop-housing');
        const housingName = housingEl?.options[housingEl.selectedIndex]?.text || 'Standard Housing';
        const waterStrategy = $('prop-water-strategy').value || 'Standard watering';

        const html = `
        <div class="proposal">
            <div class="report-header" style="margin-bottom: 40px; border-bottom: 2px solid var(--primary); padding-bottom: 20px;">
                <h1 style="margin:0; font-size: 28px;">${name.toUpperCase()}</h1>
                <p class="proposal-subtitle" style="margin:8px 0 0; color: var(--text-muted); font-weight: 500;">
                    Knowledge-Based Decision Support Analysis • Generated ${today}
                </p>
            </div>

            <div style="margin-bottom: 32px;">
                <span class="dss-badge" style="background:var(--primary-soft); color:var(--primary); padding:8px 16px; border-radius:20px; font-size:12px; font-weight:700; border: 1px solid var(--primary);">
                    ${isRepeat ? 'RECURRING CYCLE ANALYSIS' : 'INITIAL ESTABLISHMENT ANALYSIS'}
                </span>
            </div>

            <h2>1. Strategic Overview</h2>
            <p>This decision support analysis models the <strong>${isRepeat ? 'subsequent operational cycle' : 'initial establishment'}</strong> of a <strong>${typeName}</strong> operation with a target flock of <strong>${size} birds</strong> located in <strong>${location}</strong>.</p>
            
            <div style="background: var(--bg-main); padding: 20px; border-radius: var(--radius-md); border-left: 4px solid var(--primary); margin: 20px 0;">
                <p style="margin:0;"><strong>Primary Objective:</strong> ${isRepeat ? 'Maximize operating margins by leveraging existing assets.' : 'Establish secure infrastructure and manage birds to Point of Lay (POL).'}</p>
                <p style="margin:10px 0 0;"><strong>Estimated Payback:</strong> Expected in <strong>${$('calc-breakeven').textContent}</strong> based on current market assumptions.</p>
            </div>

            <h2>2. Financial Projections</h2>
            <div class="fin-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 20px 0;">
                <div class="fin-card" style="background: var(--bg-main); padding: 20px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                    <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 1px;">Total CAPEX</span>
                    <div style="font-size: 24px; font-weight: 800; margin-top: 4px;">${$('calc-capex').textContent}</div>
                </div>
                <div style="background: var(--bg-main); padding: 20px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                    <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 1px;">${$('calc-6m-rev-label').textContent}</span>
                    <div style="font-size: 24px; font-weight: 800; margin-top: 4px; color: var(--primary);">${$('calc-6m-rev').textContent}</div>
                </div>
                <div style="background: var(--bg-main); padding: 20px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                    <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 1px;">${$('calc-6m-opex-label').textContent}</span>
                    <div style="font-size: 24px; font-weight: 800; margin-top: 4px; color: var(--danger);">${$('calc-6m-opex').textContent}</div>
                </div>
                <div style="background: var(--bg-main); padding: 20px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                    <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 1px;">Projected Margin</span>
                    <div style="font-size: 24px; font-weight: 800; margin-top: 4px; color: ${$('calc-profit').textContent.includes('-') ? 'var(--danger)' : 'var(--primary)'};">
                        ${$('calc-profit').textContent}
                    </div>
                </div>
            </div>

            <h2>3. Infrastructure & Technical Plan</h2>
            <div style="display:flex; gap:20px; align-items:flex-start; margin: 20px 0;">
                <div style="flex:1;">
                    <p><strong>Housing System:</strong> ${housingName}</p>
                    <p><strong>Management Strategy:</strong> High-hygiene operations utilizing slatted floor isolation for waste management.</p>
                    <p><strong>Watering:</strong> ${waterStrategy}</p>
                </div>
                <div style="width: 200px; height: 130px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color);">
                    <img src="assets/Coop Media/20260322_174218.jpg" style="width:100%; height:100%; object-fit:cover;">
                </div>
            </div>

            <h2>4. Risk Management & Mitigation</h2>
            <table style="width:100%; border-collapse: collapse; margin: 20px 0; font-size: 13px;">
                <thead>
                    <tr style="background: var(--primary-soft);">
                        <th style="padding:12px; text-align:left; border-bottom: 2px solid var(--primary);">Risk Factor</th>
                        <th style="padding:12px; text-align:left; border-bottom: 2px solid var(--primary);">Mitigation Strategy</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td style="padding:10px; border-bottom:1px solid var(--border-color);"><strong>Disease Outbreak</strong></td><td style="padding:10px; border-bottom:1px solid var(--border-color);">Strict vaccination schedule and mandatory footbaths.</td></tr>
                    <tr><td style="padding:10px; border-bottom:1px solid var(--border-color);"><strong>Feed Price Volatility</strong></td><td style="padding:10px; border-bottom:1px solid var(--border-color);">Bulk procurement and inventory management.</td></tr>
                    <tr><td style="padding:10px; border-bottom:1px solid var(--border-color);"><strong>Mortality Losses</strong></td><td style="padding:10px; border-bottom:1px solid var(--border-color);">Budgeted 5% buffer with strict brooding controls.</td></tr>
                </tbody>
            </table>

            <h2>5. Strategic Recommendation</h2>
            <p style="font-style: italic; color: var(--text-muted);">
                ${parseFloat($('calc-profit').textContent.replace(/[^0-9.-]/g, '')) > 0 
                    ? 'This model demonstrates positive operational viability. We recommend proceeding with the procurement phase focusing on high-quality DOC sources.' 
                    : 'The current model shows tight or negative margins. We recommend reviewing revenue assumptions or exploring bulk feed procurement to improve the break-even window.'}
            </p>

            <div class="footer-note" style="margin-top: 60px; padding-top: 20px; border-top: 1px solid var(--border-color); text-align: center; font-size: 11px; color: var(--text-muted);">
                PoultryDSS • Automated Decision Support Output • ${owner} • Confidential
            </div>
        </div>`;

        $('proposal-preview').innerHTML = html;
        $('btn-export-pdf').style.display = 'inline-flex';
        
        const btnStartBatch = document.getElementById('btn-start-batch');
        if (btnStartBatch) {
            btnStartBatch.style.display = 'inline-flex';
            btnStartBatch.onclick = async () => {
                await saveProposal();
                instantiateBatch(currentProposalId);
            };
        }
        
        lucide.createIcons();
    }

    // ===================== PDF EXPORT =====================
    $('btn-export-pdf')?.addEventListener('click', async () => {
        const proposalHTML = $('proposal-preview').innerHTML;
        // Load inlined CSS from all stylesheets
        let inlinedStyles = '';
        try {
            inlinedStyles = Array.from(document.styleSheets)
                .map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch(e) { return ''; } })
                .join('\n');
        } catch(e) {}
        const printWindow = window.open('', '_blank');
        if (!printWindow) { window.showToast('Pop-up blocked — please allow pop-ups and try again.', 'warning'); return; }
        printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Poultry Project Proposal</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Outfit', sans-serif; margin: 0; padding: 0; }
    ${inlinedStyles}
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>${proposalHTML}</body>
</html>`);
        printWindow.document.close();
        printWindow.addEventListener('load', () => { printWindow.focus(); printWindow.print(); });
    });

    // ===================== LOCAL STORAGE =====================


    function parseValue(id) {
        const el = $(id);
        if (!el) return 0;
        const val = el.textContent.replace(/[^0-9.-]/g, '');
        const num = parseFloat(val);
        return isNaN(num) ? 0 : num;
    }

    window.getBatches = function() {
        return allBatches;
    }

    window.updateBatch = async function(batch) {
        const index = allBatches.findIndex(b => String(b.id) === String(batch.id));
        if (index >= 0) {
            allBatches[index] = batch;
            await api.saveBatch(batch);
        }
    };

    window.saveBatch = async function(batch) {
        allBatches.push(batch);
        await api.saveBatch(batch);
    };

    async function saveProposal() {
        // Ensure financials are always fresh before reading DOM spans
        calculateFinancials();

        const proposals = await api.getProposals();
        
        let targetId = currentProposalId;
        if (!targetId) {
            targetId = Date.now();
            currentProposalId = targetId;
        }

        const formInputs = {};
        const elements = document.getElementById('proposal-form').elements;
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.id) {
                formInputs[el.id] = el.type === 'checkbox' ? el.checked : el.value;
            }
        }

        const proposal = {
            id: targetId,
            name: $('prop-name').value.trim() || 'Untitled',
            type: $('prop-type').value || 'layer',
            size: parseInt($('prop-size').value) || 0,
            owner: $('prop-owner').value.trim() || '',
            location: $('prop-location').value.trim() || '',
            capex: $('calc-capex').textContent || 'KES 0',
            profit: $('calc-profit').textContent || 'KES 0',
            date: new Date().toISOString(),
            raw: {
                birds: parseValue('calc-birds'),
                docCost: parseValue('calc-doc-cost'),
                infraCost: parseValue('calc-infra-cost'),
                totalCapex: parseValue('calc-capex'),
                weeklyAvgOpex: parseValue('calc-weekly-opex'),
                cumulativeOpex: parseValue('calc-6m-opex'),
                cumulativeRev: parseValue('calc-6m-rev'),
                netProfit: parseValue('calc-profit'),
                // Extract numeric week from "Week 45" or "Beyond Horizon" etc.
                breakeven: parseInt(($('calc-breakeven').textContent || '').replace(/[^0-9]/g, '')) || 0
            },
            inputs: formInputs
        };

        const existingIndex = proposals.findIndex(p => p.id === targetId);
        if (existingIndex >= 0) {
            proposals[existingIndex] = proposal; // Update existing
        } else {
            proposals.unshift(proposal); // Insert new
        }

        await api.saveProposal(proposal);
        refreshDashboard();
        renderAnalytics();
    }

    window.instantiateBatch = async function(proposalId) {
        const proposals = await api.getProposals();
        const proposal = proposals.find(p => p.id === proposalId);
        
        if (!proposal) {
            window.showToast('Cannot find proposal!', 'danger');
            return;
        }

        const batches = getBatches();
        
        const batch = {
            id: Date.now(),
            proposalId: proposal.id,
            name: 'Batch: ' + proposal.name,
            type: proposal.type,
            size: parseInt(proposal.size) || 0,
            startDate: new Date().toISOString(),
            status: BATCH_STATUS.ACTIVE,
            stats: { birdsAlive: parseInt(proposal.size) || 0, totalEggs: 0, mortality: 0 },
            assumptions: {
                eggPrice: proposal.inputs && proposal.inputs['prop-egg-price'] ? parseFloat(proposal.inputs['prop-egg-price']) : 15,
                feedPrice: proposal.type === 'layer' ? (parseFloat(proposal.inputs['prop-price-layermash']) || 3600) : (parseFloat(proposal.inputs['prop-price-broilerfinisher']) || 3800)
            }
        };

        // Update farm profile default feed price based on proposal
        if (batch.assumptions.feedPrice) {
            farmProfile.defaultFeedPrice = batch.assumptions.feedPrice;
            saveFarmProfile(farmProfile);
        }

        allBatches.unshift(batch);
        await api.saveBatch(batch);
        refreshBatches();
        refreshDashboard();
        openBatchCockpit(batch.id);
    };

    window.showStartBatchModal = async function() {
        const proposals = await api.getProposals();
        const batches = getBatches().filter(b => b.status === BATCH_STATUS.ACTIVE);
        
        // 14-Day Downtime Enforcer
        const snapshots = await api.getSnapshots();
        let downtimeWarning = '';
        if (snapshots.length > 0) {
            const mostRecent = snapshots.sort((a,b) => new Date(b.date) - new Date(a.date))[0];
            const daysSinceClose = Math.floor((new Date() - new Date(mostRecent.date)) / 86400000);
            if (daysSinceClose < 14) {
                downtimeWarning = `
                    <div style="background:#fee2e2; border:1px solid #fca5a5; color:#dc2626; padding:12px; border-radius:8px; margin-bottom:16px; font-size:13px;">
                        <i data-lucide="shield-alert" style="vertical-align:middle; width:16px; height:16px; margin-right:4px;"></i>
                        <strong>Biosecurity Alert:</strong> A flock was closed ${daysSinceClose} days ago. Mandatory 14-day downtime is recommended to prevent disease carryover. Proceed only if using a separate house.
                    </div>
                `;
            }
        }
        
        const listEl = $('modal-start-batch-list');
        listEl.innerHTML = downtimeWarning;
        
        const available = proposals.filter(p => !batches.some(b => b.proposalId === p.id));
        
        if (available.length === 0) {
            listEl.innerHTML += `<p style="text-align:center; color:var(--text-muted); padding:20px;">No unused models available. <br><br><a href="#" onclick="document.getElementById('modal-start-batch').style.display='none'; window.switchView('generator'); return false;" style="color:var(--primary); font-weight:500;">Run a New DSS Analysis instead.</a></p>`;
        } else {
            listEl.innerHTML += available.map(p => `
                <div class="project-item" style="cursor:pointer; border:1px solid var(--border-color); padding: 12px; border-radius: 8px; margin-bottom: 8px;" onclick="window.closeStartBatchModal(); window.instantiateBatch(${p.id});">
                    <div class="project-icon ${p.type}"><i data-lucide="${p.type === 'layer' ? 'egg' : 'bird'}"></i></div>
                    <div class="project-info">
                        <h4 style="margin:0; font-size:14px; font-weight:600;">${p.name}</h4>
                        <p style="margin:0; font-size:12px; color:var(--text-muted);">${p.size} birds • ${p.type.toUpperCase()}</p>
                    </div>
                    <i data-lucide="play" style="color:var(--primary); width:18px;"></i>
                </div>
            `).join('');
        }
        lucide.createIcons();
        $('modal-start-batch').style.display = 'flex';
    };
    
    window.closeStartBatchModal = function() {
        $('modal-start-batch').style.display = 'none';
    };

    window.loadProposal = async function(id) {
        const proposals = await api.getProposals();
        const p = proposals.find(p => p.id === id);
        if (!p) return;

        currentProposalId = p.id;
        
        if (p.inputs) {
            Object.keys(p.inputs).forEach(key => {
                const el = document.getElementById(key);
                if (el) {
                    if (el.type === 'checkbox') el.checked = p.inputs[key];
                    else el.value = p.inputs[key];
                }
            });
        }

        toggleRevenueFields();
        calculateFinancials();
        
        // Jump to preview step
        currentWizardStep = 4;
        updateWizard();
        generateProposal();
        switchView('generator');
    };

    window.cloneProposal = async function(id) {
        await window.loadProposal(id);
        currentProposalId = null; // Clear ID so it saves as new
        const nameEl = document.getElementById('prop-name');
        if (nameEl) nameEl.value = nameEl.value + ' (Copy)';
    };

    // (Dashboard, cockpit, and sensor popover logic moved to dashboard.js)


    /**
     * Opens the transaction modal for logging financial entries (purchases, sales, write-offs, or returns).
     * Automatically pre-fills inputs if provided.
     * 
     * @param {string} type - The transaction type ('purchase', 'sale', 'write_off', 'return').
     * @param {string|null} prefilledCategory - A preselected category for the transaction (e.g. 'roosters').
     * @param {number|null} prefilledQty - A pre-filled quantity value.
     */
    // (window.openTxModal and openSurplusRoostersSaleModal moved to sales.js)

    // Logic handled by window.submitDailyLog in cockpit view

    // (window.openHealthModal moved to health.js)

    // Logic handled by window.submitDailyLog in cockpit view

    // (window.finishBatch and updateAggregates moved to batches.js)


    window.clearAllProposals = function() {
        // In-page confirm modal — no browser popup
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:28px; text-align:center;">
                <i data-lucide="trash-2" style="width:40px;height:40px;color:var(--danger);margin-bottom:12px;"></i>
                <h3 style="margin:0 0 8px;">Delete All Proposals?</h3>
                <p style="color:var(--text-muted);font-size:14px;margin:0 0 24px;">This will permanently remove all saved scenarios. This cannot be undone.</p>
                <div style="display:flex;gap:12px;justify-content:center;">
                    <button class="btn btn-secondary" id="confirm-cancel-clear">Cancel</button>
                    <button class="btn" id="confirm-do-clear" style="background:var(--danger);color:#fff;">Yes, Delete All</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();

        document.getElementById('confirm-cancel-clear').onclick = () => document.body.removeChild(modal);
        document.getElementById('confirm-do-clear').onclick = async () => {
            document.body.removeChild(modal);
            try {
                await api.clearAllProposals();
                await refreshDashboard();
                renderAnalytics();
                window.showToast('All proposals deleted.', 'info');
            } catch(e) {
                window.showToast('Failed to clear proposals. Please try again.', 'danger');
            }
        };
    };

    // ===================== KNOWLEDGE BASE =====================
    const docsGrid = document.querySelector('.docs-grid');
    const docDetail = $('doc-detail');
    const docContent = $('doc-detail-content');

    function resetDocsPanel() {
        if (docsGrid) docsGrid.style.display = 'grid';
        if (docDetail) docDetail.style.display = 'none';
    }

    docsGrid?.querySelectorAll('.doc-card').forEach(card => {
        card.addEventListener('click', async () => {
            const key = card.dataset.doc;
            if (KB_CONTENT[key]) {
                docContent.innerHTML = KB_CONTENT[key].html;
                docsGrid.style.display = 'none';
                docDetail.style.display = 'block';
                lucide.createIcons();
            }
        });
    });

    $('btn-back-to-docs')?.addEventListener('click', async () => {
        docsGrid.style.display = 'grid';
        docDetail.style.display = 'none';
    });

    // ===================== THEME TOGGLE =====================
    const themeToggle = $('btn-theme-toggle');
    const themeIcon = $('theme-icon');

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('poultryTheme', theme);
        if (themeIcon) {
            themeIcon.setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
            lucide.createIcons();
        }
    }

    // Load saved theme or use system preference
    const savedTheme = localStorage.getItem('poultryTheme');
    if (savedTheme) {
        setTheme(savedTheme);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        setTheme('dark');
    }

    themeToggle?.addEventListener('click', async () => {
        const current = document.documentElement.getAttribute('data-theme');
        setTheme(current === 'dark' ? 'light' : 'dark');
    });

    // ===================== MOBILE MENU =====================
    const sidebar = document.querySelector('.sidebar');
    const overlay = $('sidebar-overlay');
    const hamburger = $('btn-hamburger');

    function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('active');
    }

    function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    }

    hamburger?.addEventListener('click', async () => {
        if (sidebar.classList.contains('open')) closeSidebar();
        else openSidebar();
    });

    overlay?.addEventListener('click', closeSidebar);

    // Close sidebar on nav click (mobile)
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) closeSidebar();
        });
    });

    // ===================== NOTIFICATIONS =====================
    const btnNotifications = $('btn-notifications');
    const dropNotifications = $('notifications-dropdown');
    
    btnNotifications?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropNotifications) {
            dropNotifications.style.display = dropNotifications.style.display === 'none' ? 'block' : 'none';
        }
    });

    // Close notifications dropdown when clicking outside
    document.addEventListener('click', () => {
        if (dropNotifications && dropNotifications.style.display === 'block') {
            dropNotifications.style.display = 'none';
        }
    });


    // ===================== ANALYTICS =====================
    let _capexChartInstance = null;
    let _revenueChartInstance = null;
    
    async function renderAnalytics() {
        const proposals = await api.getProposals();
        const snapshots = await api.getSnapshots();
        
        if (proposals.length === 0 && snapshots.length === 0) {
            $('analytics-content').style.display = 'none';
            $('analytics-empty').style.display = 'block';
            return;
        }

        $('analytics-content').style.display = 'block';
        $('analytics-empty').style.display = 'none';

        await renderBatchLearning(snapshots); // New: §5.1 / §5.3

        if (proposals.length === 0) return; // Only process proposals below

        const style = getComputedStyle(document.body);
        const primary = style.getPropertyValue('--primary').trim();
        const primaryLight = style.getPropertyValue('--primary-light').trim();
        const accent = style.getPropertyValue('--accent').trim();
        const danger = style.getPropertyValue('--danger').trim();
        const textDark = style.getPropertyValue('--text-dark').trim();
        const textMuted = style.getPropertyValue('--text-muted').trim();

        // 1. Calculate KPI Averages & Totals
        let totalCapexAll = 0;
        let sumProfit = 0;
        let sumPostBE = 0;
        let sumBE = 0;
        let beCount = 0;

        let avgRaw = { birds: 0, feed: 0, vaccines: 0, brooding: 0, housing: 0, equipment: 0, capex: 0, rev: 0 };

        proposals.forEach(p => {
            if (!p.raw) return; // Ignore legacy proposals without raw data
            totalCapexAll += p.raw.totalCapex;
            sumProfit += p.raw.sixMonProfit;
            if (p.raw.breakeven > 0) { sumBE += p.raw.breakeven; beCount++; }
            
            let postBE = 0;
            if (p.type === 'layer' || p.type === 'dual') {
                postBE = (p.raw.sixMonRev || 0) - (p.raw.sixMonOpex || 0); // 6-month margin after capex is paid
            } else {
                // Broiler: recurring cost is birds+feed+vaccines+brooding. Ignore fixed housing/equipment capex.
                const flockCapex = (p.raw.totalCapex || 0) - (p.raw.housing || 0) - (p.raw.equipment || 0);
                postBE = (p.raw.sixMonRev || 0) - flockCapex; // Batch margin after capex is paid
            }
            sumPostBE += isNaN(postBE) ? 0 : postBE;
            
            avgRaw.birds += p.raw.birds || 0;
            avgRaw.feed += p.raw.feed || 0;
            avgRaw.vaccines += p.raw.vaccines || 0;
            avgRaw.brooding += p.raw.brooding || 0;
            avgRaw.housing += p.raw.housing || 0;
            avgRaw.equipment += p.raw.equipment || 0;
            avgRaw.capex += p.raw.totalCapex || 0;
            avgRaw.rev += p.raw.sixMonRev || 0;
        });

        let validNum = proposals.filter(p => p.raw).length;
        const num = validNum > 0 ? validNum : 1;
        const avgBE = beCount > 0 ? (sumBE / beCount) : 0;
        const avgPostBEProfit = (sumPostBE || 0) / num;
        const avgInitialProfit = (sumProfit || 0) / num;

        $('kpi-total-capex').textContent = `KES ${totalCapexAll.toLocaleString()}`;
        $('kpi-avg-profit').textContent = `KES ${Math.round(avgPostBEProfit).toLocaleString()}`;
        $('kpi-avg-profit').className = avgPostBEProfit >= 0 ? `stat-value` : `stat-value text-danger`;
        $('kpi-avg-profit').style.color = avgPostBEProfit >= 0 ? primary : '';
        $('kpi-avg-breakeven').textContent = avgBE > 0 ? `${Math.round(avgBE * 10) / 10} Months` : '—';

        // Destroy previous charts if any
        if (_capexChartInstance) _capexChartInstance.destroy();
        if (_revenueChartInstance) _revenueChartInstance.destroy();

        if (typeof Chart === 'undefined') return;
        Chart.defaults.color = textMuted;
        Chart.defaults.font.family = "'Outfit', sans-serif";

        // 2. Render CAPEX Doughnut Chart
        const ctxCap = document.getElementById('capexChart').getContext('2d');
        const dssPalette = ['#10B981', '#6366F1', '#F59E0B', '#F43F5E', '#06B6D4', '#8B5CF6'];
        
        _capexChartInstance = new Chart(ctxCap, {
            type: 'doughnut',
            data: {
                labels: ['Birds', 'Feed', 'Housing', 'Equip', 'Vaccines', 'Brooding'],
                datasets: [{
                    data: [
                        Math.round(avgRaw.birds/num), Math.round(avgRaw.feed/num), 
                        Math.round(avgRaw.housing/num), Math.round(avgRaw.equipment/num), 
                        Math.round(avgRaw.vaccines/num), Math.round(avgRaw.brooding/num)
                    ],
                    backgroundColor: dssPalette,
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { padding: 15, color: textDark, font: { size: 11 }, usePointStyle: true } },
                    tooltip: { callbacks: { label: function(context) { return ' KES ' + context.raw.toLocaleString(); } } }
                },
                cutout: '70%'
            }
        });

        // 3. Render Revenue Bar Chart
        const ctxRev = document.getElementById('revenueChart').getContext('2d');
        _revenueChartInstance = new Chart(ctxRev, {
            type: 'bar',
            data: {
                labels: ['Avg Setup Capital', 'Post Break-Even Profit', 'First-Cycle P&L'],
                datasets: [{
                    label: 'Amount (KES)',
                    data: [
                        Math.round(avgRaw.capex/num), 
                        Math.round(avgPostBEProfit), 
                        Math.round(avgInitialProfit)
                    ],
                    backgroundColor: ['#94A3B8', '#10B981', avgInitialProfit >= 0 ? '#6366F1' : '#F43F5E' ],
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: function(context) { return ' KES ' + context.raw.toLocaleString(); } } }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { callback: function(val) { return 'K ' + (val/1000) + 'k'; } } },
                    x: { grid: { display: false }, ticks: { color: textDark } }
                }
            }
        });
        // NOTE: renderAnalytics is defined inside the _initApp closure because it captures
        // local chart instances (_capexChartInstance, _revenueChartInstance).
        // It is exposed on window so other view modules (e.g. dashboard.js) can refresh the analytics view.
        window.renderAnalytics = renderAnalytics;
    }

    // ===================== SETTINGS & CRM & BATCH LEARNING (§5.1/5.2) =====================
    // (Settings, CRM, and User Management moved to settings.js)

    // (renderBatchLearning moved to batches.js)

    // (window.renderHealthTable moved to health.js)

    // (window.openCleanoutSOP, deleteBatchUI, and clearAllBatchesUI moved to batches.js)

    // (Flock adjustment, sensor, and egg loss modals moved to cockpit.js)

    $('btn-clear-all-batches')?.addEventListener('click', () => { window.clearAllBatchesUI(); });

    // ===================== INIT =====================
    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.addEventListener('focus', function() { this.select(); });
    });
    toggleRevenueFields();
    calculateFinancials();

    // Await database values and sync cache before initial dashboard render
    initDataPromise.then(() => {
        if (window.USER_ROLE === 'farmer') {
            const activeBatch = store.allBatches.find(b => b.status === BATCH_STATUS.ACTIVE);
            if (activeBatch) {
                window.openBatchCockpit(activeBatch.id);
            } else {
                window.switchView('batches');
            }
        } else {
            refreshDashboard();
        }
    }).catch(err => {
        console.error('Error during data init:', err);
        if (window.USER_ROLE === 'farmer') {
            window.switchView('batches');
        } else {
            refreshDashboard();
        }
    });
} // end _initApp
