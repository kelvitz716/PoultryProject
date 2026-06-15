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
    sackBackfill, parseEggTrackerCSV, computeKPIs, computeEggInventoryAging, computeTHI, getHeatStressStatus
} from './engine.js';
import { $, showToast, showConfirmModal, updateGlobalNotifications } from './ui.js';

let farmProfile = { ...DEFAULT_FARM_PROFILE }; // Global farm profile, loaded at startup
let currentBatchId = null;
let _cockpitChartInstance = null;
let allBatches = []; // Cache for batches

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

    window.switchView = function(viewId) {
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
        const stored = await api.getEntity('poultryFarmProfile', null);
        if (stored) {
            return { ...DEFAULT_FARM_PROFILE, ...stored, alertThresholds: { ...DEFAULT_FARM_PROFILE.alertThresholds, ...(stored.alertThresholds || {}) } };
        }
        return { ...DEFAULT_FARM_PROFILE };
    }

    async function saveFarmProfile(profile) {
        await api.setEntity('poultryFarmProfile', profile);
    }

    window.syncBatches = async function() {
        allBatches = await api.getBatches();
    }

    // Load initial data asynchronously in the background so we don't block DOM binding execution flow
    const initDataPromise = (async () => {
        try {
            farmProfile = await loadFarmProfile();
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
                        <div class="snapshot-item" onclick="applySnapshot(${s.id})">
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
            status: 'active',
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
        const batches = getBatches().filter(b => b.status === 'active');
        
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
            listEl.innerHTML += `<p style="text-align:center; color:var(--text-muted); padding:20px;">No unused models available. <br><br><a href="#" onclick="document.getElementById('modal-start-batch').style.display='none'; switchView('generator'); return false;" style="color:var(--primary); font-weight:500;">Run a New DSS Analysis instead.</a></p>`;
        } else {
            listEl.innerHTML += available.map(p => `
                <div class="project-item" style="cursor:pointer; border:1px solid var(--border-color); padding: 12px; border-radius: 8px; margin-bottom: 8px;" onclick="closeStartBatchModal(); instantiateBatch(${p.id});">
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

    /**
     * Refreshes the cockpit dashboard overview.
     * Fetches saved economic proposals and active cohorts, updating metrics widgets,
     * lists of saved project proposals, and summary panels.
     */
    async function refreshDashboard() {
        const proposals = await api.getProposals();
        const batches = getBatches().filter(b => b.status === 'active');
        
        const list = $('saved-proposals-list');
        const batchSummary = $('active-batches-summary');
        const empty = $('empty-proposals');
        
        const totalBirdsProposals = proposals.reduce((sum, p) => sum + (parseInt(p.size) || 0), 0);
        const totalBirdsBatches = batches.reduce((sum, b) => sum + (parseInt(b.stats?.birdsAlive) || 0), 0);

        if ($('dash-count')) $('dash-count').textContent = proposals.length;
        if ($('dash-birds')) $('dash-birds').textContent = (totalBirdsProposals + totalBirdsBatches).toLocaleString();
        if ($('dashboard-subtitle')) $('dashboard-subtitle').textContent = `Tracking ${proposals.length} models and ${batches.length} active operations.`;

        // Proposals List
        if (!list) return;
        if (proposals.length === 0) {
            list.innerHTML = '';
            if (empty) { list.appendChild(empty); empty.style.display = 'block'; }
        } else {
            list.innerHTML = proposals.map(p => `
                <div class="project-item" data-id="${p.id}" onclick="loadProposal(${p.id});">
                    <div class="project-icon ${p.type}"><i data-lucide="${p.type === 'layer' ? 'egg' : 'bird'}"></i></div>
                    <div class="project-info">
                        <h4>${p.name || 'Untitled'}</h4>
                        <p>${p.size ? p.size + ' birds' : '—'} &nbsp;·&nbsp; ${p.profit || 'KES 0'}</p>
                        <div style="margin-top:4px;">
                            <span class="pill" style="font-size:9px; background:${p.profit?.includes('-') ? 'rgba(239,83,80,0.1)' : 'rgba(91,191,79,0.1)'}; color:${p.profit?.includes('-') ? 'var(--danger)' : 'var(--primary)'}; border: 1px solid ${p.profit?.includes('-') ? 'rgba(239,83,80,0.2)' : 'rgba(91,191,79,0.2)'};">
                                ${p.profit?.includes('-') ? 'OPTIMIZABLE' : 'PROFITABLE'}
                            </span>
                        </div>
                    </div>
                    <div class="project-actions" style="display:flex; gap:4px;">
                        <button class="project-delete" onclick="event.stopPropagation(); window.cloneProposal(${p.id})" title="Clone Proposal">
                            <i data-lucide="copy" style="width:14px;height:14px;"></i>
                        </button>
                        <button class="project-delete" onclick="event.stopPropagation(); deleteProposal(${p.id})" title="Delete">
                            <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
                        </button>
                    </div>
                </div>
            `).join('');
        }

        // Active Batches Summary (guard against cached pages missing this element)
        if (batchSummary) {
            if (batches.length === 0) {
                batchSummary.innerHTML = `<div class="empty-state"><i data-lucide="activity"></i><p>No active operations.</p></div>`;
            } else {
                batchSummary.innerHTML = batches.map(b => `
                    <div class="project-item" onclick="openBatchCockpit(${b.id})">
                        <div class="project-icon" style="background:#E8F5E9; color:#2E7D32;"><i data-lucide="zap"></i></div>
                        <div class="project-info">
                            <h4>${b.name}</h4>
                            <p>${b.size} birds • Started ${new Date(b.startDate).toLocaleDateString()}</p>
                        </div>
                    </div>
                `).join('');
            }
        }

        // Accounts Receivable (Outstanding Credit Sales)
        const arListEl = $('ar-list');
        if (arListEl) {
            let allUnpaid = [];
            for (const b of batches) {
                const txs = await api.getTransactions(b.id);
                const unpaid = txs.filter(t => t.status === 'unpaid' && t.type === 'sale');
                unpaid.forEach(t => { t.batchName = b.name; t.batchId = b.id; });
                allUnpaid = allUnpaid.concat(unpaid);
            }
            
            if (allUnpaid.length === 0) {
                arListEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No outstanding credit invoices.</p>';
            } else {
                // Sort by date oldest first
                allUnpaid.sort((a, b) => new Date(a.date) - new Date(b.date));
                arListEl.innerHTML = allUnpaid.map(t => {
                    const txDate = new Date(t.date);
                    const termsDays = parseInt((t.buyerTerms || '').replace('Net ', '')) || 0;
                    const dueDate = new Date(txDate.getTime() + termsDays * 86400000);
                    const daysOverdue = Math.floor((new Date() - dueDate) / 86400000);
                    
                    const statusHtml = daysOverdue > 0 
                        ? `<span style="color:var(--danger); font-weight:bold;">${daysOverdue} days overdue</span>` 
                        : `<span style="color:var(--text-muted);">Due in ${Math.abs(daysOverdue)} days</span>`;
                        
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--border-color); font-size:13px;">
                        <div>
                            <strong>${t.buyerName || 'Unknown Buyer'}</strong> <span style="color:var(--text-muted); font-size:11px;">(${t.batchName})</span><br>
                            <span style="color:var(--text-muted);">${new Date(t.date).toLocaleDateString()} • ${t.qty} eggs</span>
                        </div>
                        <div style="text-align:right;">
                            <strong>KES ${t.amount.toLocaleString()}</strong><br>
                            ${statusHtml}
                            <button class="btn btn-sm" style="padding:2px 6px; margin-top:4px;" onclick="markInvoicePaid(${t.batchId}, ${t.id})">Mark Paid</button>
                        </div>
                    </div>
                `}).join('');
            }
        }

        lucide.createIcons();

    }

    window.markInvoicePaid = async function(batchId, txId) {
        if (!confirm('Mark this invoice as paid?')) return;
        const txs = await api.getTransactions(batchId);
        const idx = txs.findIndex(t => t.id === txId);
        if (idx >= 0) {
            txs[idx].status = 'paid';
            await api.saveTransaction(batchId, txs[idx]); // Wait, saveTransaction appends. 
            // We need a way to update an existing transaction.
            // Since we are using an append-only system or rewriting the whole array?
            // api.js uses `saveTransaction` which appends. We don't have `updateTransaction`.
            // Let's implement updateTransaction.
        }
    };

    window.deleteProposal = async function(id) {
        const proposals = await api.getProposals();
        const filtered = proposals.filter(p => p.id !== id);
        await api.deleteProposal(id);
        refreshDashboard();
        renderAnalytics();
    };


    window.refreshBatches = async function() {
        console.log('Refreshing batches view...');
        const batches = window.getBatches();
        const list = $('batches-list');
        
        let bannerHtml = '';
        const completedBatches = batches.filter(b => b.status === 'completed');
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
            
            const isCompleted = b.status === 'completed';
            let sopHtml = '';
            if (isCompleted) {
                if (b.cleanoutSOP) {
                    sopHtml = `<div style="margin-top:12px; font-size:12px; color:var(--success); font-weight:600; text-align:center;"><i data-lucide="check-circle" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Cleanout SOP Audited</div>`;
                } else {
                    sopHtml = `<button class="btn btn-primary btn-sm" style="margin-top:12px; width:100%;" onclick="event.stopPropagation(); window.openCleanoutSOP('${b.id}')"><i data-lucide="clipboard-list" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Run Cleanout SOP</button>`;
                }
            }
            return `
            <div class="batch-card" onclick="openBatchCockpit(${b.id})">
                <div class="batch-header">
                    <span class="batch-badge ${b.status}">${b.status === 'post_batch' ? 'WINDING DOWN' : b.status.toUpperCase()}</span>
                    <button class="project-delete" onclick="event.stopPropagation(); window.deleteBatchUI(${b.id})" title="Delete Batch">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
                <div style="margin-top: 8px;">
                    <h4 style="margin: 0;">${b.name}</h4>
                </div>
                <div class="batch-metrics">
                    <div class="m-item"><span>Birds</span><strong>${b.stats?.birdsAlive || b.size}</strong></div>
                    <div class="m-item"><span>Status</span><strong>${b.status === 'completed' ? 'Completed' : b.status === 'post_batch' ? 'Winding Down' : (hasEggs ? 'Laying' : 'Growing')}</strong></div>
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
    }

    async function updateBatchLearningUI() {
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
    function getActiveWithdrawal(healthLogs, logs) {
        const meds = healthLogs || [];
        const dailyLogs = logs || [];
        let maxEggDate = null;
        let maxMeatDate = null;
        let discardedEggs = 0;
        
        meds.forEach(m => {
            if (m.type !== 'meds') return;
            const date = new Date(m.date);
            const eggDays = m.offLabel ? 14 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.egg || 0);
            const meatDays = m.offLabel ? 28 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.meat || 0);
            
            const eggClear = new Date(date.getTime() + eggDays * 86400000);
            const meatClear = new Date(date.getTime() + meatDays * 86400000);
            
            if (!maxEggDate || eggClear > maxEggDate) maxEggDate = eggClear;
            if (!maxMeatDate || meatClear > maxMeatDate) maxMeatDate = meatClear;
        });
        
        const now = new Date();
        const eggsUnderWithdrawal = maxEggDate && maxEggDate > now;
        const meatUnderWithdrawal = maxMeatDate && maxMeatDate > now;
        
        if (eggsUnderWithdrawal && maxEggDate) {
            let earliestActiveStart = null;
            meds.forEach(m => {
                if (m.type !== 'meds') return;
                const date = new Date(m.date);
                const eggDays = m.offLabel ? 14 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.egg || 0);
                const eggClear = new Date(date.getTime() + eggDays * 86400000);
                if (eggClear > now) {
                    if (!earliestActiveStart || date < earliestActiveStart) earliestActiveStart = date;
                }
            });
            
            if (earliestActiveStart) {
                dailyLogs.forEach(l => {
                    const lDate = new Date(l.date);
                    if (lDate >= earliestActiveStart && lDate <= maxEggDate) {
                        discardedEggs += (parseInt(l.eggs) || 0);
                    }
                });
            }
        }
        

        return {
            eggsUnderWithdrawal,
            meatUnderWithdrawal,
            eggClearDate: maxEggDate,
            meatClearDate: maxMeatDate,
            discardedEggs
        };
    }

    window.markLitterChanged = function() {
        farmProfile.litterLastChanged = new Date().toISOString();
        saveFarmProfile(farmProfile);
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
        if (batch) refreshCockpitData(batch);
    };

    window.openBatchCockpit = async function(id) {
        const batch = getBatches().find(b => String(b.id) === String(id));
        if (!batch) return;
        currentBatchId = id;
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
                        <button class="btn btn-secondary btn-sm" onclick="switchView('batches')" style="height:36px; padding:0 12px; border-radius:8px;">
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
                        ${batch.status === 'completed' ? `
                        <span class="pill" style="background:var(--primary-soft); color:var(--primary); font-weight:bold; border:1px solid var(--primary);">Completed</span>
                        ` : batch.status === 'post_batch' ? `
                        <span class="pill" style="background:#fef3c7; color:#d97706; font-weight:bold; border:1px solid #fcd34d;">Winding Down</span>
                        ` : window.USER_ROLE === 'viewer' ? '' : `
                        <button class="btn btn-secondary btn-sm" onclick="window.openCSVImportModal(${batch.id})">
                            <i data-lucide="upload" style="width:14px; height:14px;"></i> Import
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="window.openBackfillModal(${batch.id})">
                            <i data-lucide="calendar-plus" style="width:14px; height:14px;"></i> Backfill
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="markLitterChanged()">
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
                    ${batch.status === 'post_batch' || batch.status === 'completed' || window.USER_ROLE === 'viewer' ? `
                    <div style="position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.4); backdrop-filter:blur(2px); z-index:10; display:flex; align-items:center; justify-content:center; border-radius:8px;">
                        <span style="background:#fef3c7; color:#d97706; font-weight:bold; border:1px solid #fcd34d; padding:8px 16px; border-radius:8px; display:flex; align-items:center;"><i data-lucide="lock" style="width:14px;height:14px;margin-right:6px;"></i>Daily Logging Disabled (${window.USER_ROLE === 'viewer' ? 'Read-Only Viewer' : batch.status === 'completed' ? 'Completed' : 'Winding Down'})</span>
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
                            <span class="field-hint">Each sack = ${farmProfile.sackWeightKg}kg. Entering sacks locks the kg field.</span>
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
                        <h3><i data-lucide="tag" style="width:16px;height:16px;"></i> Pricing Assistant</h3>
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
                             ${batch.status === 'completed' || window.USER_ROLE === 'viewer' ? '' : `
                            <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="openTxModal('sale')"><i data-lucide="plus-circle" style="width:14px;height:14px;"></i> Record a Sale</button>
                            <button class="btn btn-secondary btn-sm" style="width:100%; margin-top:8px; border-color:#f87171; color:#f87171;" onclick="openTxModal('write_off')"><i data-lucide="trash-2" style="width:14px;height:14px;"></i> Log Write-off</button>
                            `}
                        </div>
                    </div>
                </div>

                <!-- ROW 2 -->
                <div class="card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3>Lay Rate – Last 30 Days</h3>
                        <span style="font-size:11px; color:var(--text-muted);">Min threshold: ${farmProfile.alertThresholds.minLayRatePercent}%</span>
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
                         ${batch.status === 'post_batch' || batch.status === 'completed' || window.USER_ROLE === 'viewer' ? '' : `<button class="btn btn-secondary btn-sm" style="width:100%; margin-top:12px;" onclick="openTxModal('purchase')"><i data-lucide="shopping-cart" style="width:14px;height:14px;"></i> Buy Feed</button>`}
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
                        ${batch.status === 'completed' || window.USER_ROLE === 'viewer' ? '' : `
                        <div>
                            <button class="btn btn-primary btn-sm" onclick="openHealthModal('vaccine')"><i data-lucide="syringe" style="width:14px; height:14px;"></i> Log Vaccine</button>
                            <button class="btn btn-secondary btn-sm" onclick="openHealthModal('meds')"><i data-lucide="pill" style="width:14px; height:14px;"></i> Log Meds</button>
                        </div>
                        `}
                    </div>
                    <div id="health-log-table" style="flex:1; overflow-y:auto; overflow-x:auto; width:100%; min-height:150px;"></div>
                </div>
            </div>
        `;
        lucide.createIcons();

        // Inject sensor chip programmatically — always after template is set
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
            // Insert after Export button (first button in actionsBar)
            const exportBtn = actionsBar.querySelector('button');
            if (exportBtn && exportBtn.nextSibling) {
                actionsBar.insertBefore(chip, exportBtn.nextSibling);
            } else {
                actionsBar.appendChild(chip);
            }
            console.log('[SensorChip] Injected successfully into .cockpit-actions');
        })();

        switchView('batch-cockpit');
        refreshCockpitData(batch);
    };



    window.simulateLifecycle = async function(batchId) {
        const batch = getBatches().find(b => String(b.id) === String(batchId));
        if (!batch) return;

        // Custom in-app confirmation modal (replaces native browser confirm())
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

        // Wire up the confirm button
        document.getElementById('sim-confirm-btn').addEventListener('click', async () => {
            document.body.removeChild(confirmModal);

            let logs = [];

            // ── RESET: clear existing logs & transactions before writing fresh data ──
            await api.clearLogs(batchId);
            await api.clearTransactions(batchId);

            // Seed initial feed purchase
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

            // Save all logs
            for (const l of logs) await api.saveLog(batchId, l);
            // Save all sale transactions
            for (const t of saleTxsToSave) await api.saveTransaction(batchId, t);

            batch.stats.birdsAlive = birdCount;
            await updateBatch(batch);
            openBatchCockpit(batchId);
        });
    };

    // ── EGG COLLECTION CARD ────────────────────────────────────────────────────
    // In-memory list of pending egg collection events for today.
    // Each entry: { _tempId, time, count, label }
    // This list is synced to /api/staging/:batchId/eggs via addStagingEvent.
    let _eggCollections = []; // loaded from today's staging on cockpit open

    function _renderEggCollectionList() {
        const list = document.getElementById('egg-collection-list');
        const hint = document.getElementById('egg-empty-hint');
        const totalEl = document.getElementById('egg-total-display');
        if (!list) return;
        const total = _eggCollections.reduce((s, e) => s + (parseInt(e.count) || 0), 0);
        const totalBroken = _eggCollections.reduce((s, e) => s + (parseInt(e.broken) || 0), 0);
        const saleEggs = total - totalBroken;
        if (totalEl) {
            if (total === 0) {
                totalEl.innerHTML = `<span style="color:var(--text-muted);font-size:1rem;font-weight:400;">0 eggs</span>`;
            } else if (totalBroken > 0) {
                totalEl.innerHTML = `${saleEggs.toLocaleString()} eggs <span style="color:var(--danger);font-size:0.8rem;font-weight:600;">+ ${totalBroken} broken</span><span style="display:block;font-size:0.7rem;color:var(--text-muted);font-weight:400;margin-top:2px;">Broken excluded from sales</span>`;
            } else {
                totalEl.innerHTML = `${total.toLocaleString()} eggs`;
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
        const bid = currentBatchId;
        const res = await api.deleteStagingEvent(bid, id);
        if (res.success) {
            window.showToast('Staged item deleted.', 'success');
            const batch = getBatches().find(b => String(b.id) === String(bid));
            if (batch) refreshCockpitData(batch);
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
            await api.deleteStagingEvent(currentBatchId, ev._stagingId);
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
                    <input id="ecm-count" type="number" min="1" value="${data.count||''}" placeholder="e.g. 120" onfocus="this.select()">
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
            const count = parseInt(document.getElementById('ecm-count').value);
            const broken = parseInt(document.getElementById('ecm-broken').value) || 0;
            const time  = document.getElementById('ecm-time').value;
            const label = document.getElementById('ecm-label').value.trim();
            if (!count || count < 1) {
                document.getElementById('ecm-error').textContent = 'Enter a valid egg count.';
                document.getElementById('ecm-error').style.display = 'block';
                return;
            }
            document.getElementById('ecm-save').textContent = 'Saving…';
            const eventData = { count, broken, time, label };

            if (isEdit) {
                const existing = _eggCollections[editIdx];
                if (existing._stagingId) {
                    await api.editStagingEvent(currentBatchId, existing._stagingId, eventData);
                }
                _eggCollections[editIdx] = { ...existing, ...eventData };
            } else {
                const result = await api.addStagingEvent(currentBatchId, 'eggs', eventData);
                _eggCollections.push({ ...eventData, _stagingId: result?.id || null });
            }
            modal.remove();
            _renderEggCollectionList();
        };
        modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
    }

    // Legacy helpers preserved for any existing code that may still reference them
    window.autoSumEggs = function() {};
    window.distributeEggs = function() {};

    window.submitDailyLog = async function(event) {
        if (event) event.preventDefault();
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
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

        // ── Mortality sanity gate ─────────────────────────────────────────
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

        const promises = [];

        // Stage egg collections (today's are already staged individually via addEggCollection)
        // For backfill, emit each collection from _eggCollections as an amendment
        if (isBackfill && _eggCollections.length > 0) {
            for (const ev of _eggCollections) {
                promises.push(api.addStagingEvent(batch.id, 'eggs', { count: ev.count, time: ev.time, label: ev.label }, amendDate));
            }
        }

        // Feed
        if (feedGiven || sacks) {
            promises.push(api.addStagingEvent(batch.id, 'feed',
                { amount_kg: feedGiven || (sacks * (farmProfile.sackWeightKg || 50)), sacks_opened: sacks }, amendDate));
        }

        // Mortality
        if (mortality > 0) {
            promises.push(api.addStagingEvent(batch.id, 'mortality', { 
                count: mortality,
                hens: mortalityHens,
                roosters: mortalityRoosters
            }, amendDate));
        }

        // Gases
        if (nh3 || co2) {
            promises.push(api.addStagingEvent(batch.id, 'gases', { nh3, co2 }, amendDate));
        }

        // Manual sensor override
        if (temperature || humidity) {
            promises.push(api.addStagingEvent(batch.id, 'sensors', { temperature, humidity }, amendDate));
        }

        // Notes
        if (notesVal) {
            promises.push(api.addStagingEvent(batch.id, 'notes', {
                time: new Date(Date.now() + 3 * 3600 * 1000).toISOString().substring(11, 16),
                text: notesVal
            }, amendDate));
        }

        await Promise.all(promises);

        // Reset form fields
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

        // If today's log, clear collection card for fresh start (already saved to staging)
        if (!isBackfill) {
            _eggCollections = [];
            _renderEggCollectionList();
        }

        const btn = document.querySelector('.btn-save-log');
        if (btn) { btn.textContent = '✓ Saved!'; btn.disabled = true; setTimeout(() => { btn.innerHTML = '<i data-lucide="save"></i> Save Log'; btn.disabled = false; lucide.createIcons(); }, 1800); }

        refreshCockpitData(batch);
        window.showToast(isBackfill ? `Backfill for ${date} submitted.` : 'Log saved!', 'success');
    };

    // ── Sacks ↔ Feed-kg mutual exclusivity ─────────────────────────────────────
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
        
        const kpis = computeKPIs(logs, txs, batch, farmProfile, stagingToday);
        
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
        
        // Update KPIs
        if($('kpi-layrate')) $('kpi-layrate').innerText = (kpis.todayLayRate * 100).toFixed(1) + '%';
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
        const feedCostPerKg = farmProfile.defaultFeedPrice / farmProfile.sackWeightKg;
        // Correct break-even: feed cost per egg = (feedCostPerKg x dailyFeedPerBird) / layRate
        // +1 covers non-feed OPEX overhead per egg (labour, meds, etc.)
        const totalExpenses = txs.filter(t => t.type === 'purchase').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        const nonFeedOpexPerEgg = kpis.avg7LayRate > 0 ?
            ((totalExpenses - txs.filter(t=>t.type==='purchase'&&t.category.toLowerCase()==='feed').reduce((s,t)=>s+parseFloat(t.amount||0),0)) / Math.max(1, kpis.totalEggs)) : 1;
        const breakEvenPrice = kpis.avg7LayRate > 0 
            ? (kpis.avgDailyFeedPerBird * feedCostPerKg / kpis.avg7LayRate) + Math.max(0.5, nonFeedOpexPerEgg)
            : 12;
        if($('price-breakeven')) $('price-breakeven').innerText = 'KES ' + breakEvenPrice.toFixed(2);

        // Price to replace next bag: (bag cost) / (eggs expected per bag)
        const birdDaysPerBag = farmProfile.sackWeightKg / Math.max(0.01, kpis.avgDailyFeedPerBird);
        const eggsPerBag = birdDaysPerBag * kpis.avg7LayRate * kpis.currentBirds;
        const nextBagPrice = eggsPerBag > 0 ? farmProfile.defaultFeedPrice / eggsPerBag : 0;
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

        const withdrawal = getActiveWithdrawal(healthLogs, logs);
        const discardContainer = $('info-discard-container');
        if (withdrawal.eggsUnderWithdrawal && discardContainer) {
            discardContainer.style.display = 'inline-flex';
            const daysLeft = Math.ceil((withdrawal.eggClearDate - new Date()) / 86400000);
            $('info-discard').innerText = `${daysLeft} days (${withdrawal.discardedEggs.toLocaleString()} eggs)`;
        } else if (discardContainer) {
            discardContainer.style.display = 'none';
        }

        // Module 6a: Egg Inventory Aging
        const inventoryAging = computeEggInventoryAging(logs, txs, stagingToday);
        if($('info-unsoldeggs')) $('info-unsoldeggs').innerText = `(${inventoryAging.totalUnsold.toLocaleString()} in stock)`;
        
        const maxAgeDays = farmProfile.eggStorageType === 'refrigerated' ? 35 : 12;
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
        await renderHealthTable(batch.id);
        await window.updateLiveSensorWidget();
    }

    /**
     * Handles changes to the daily log date selector. When backdating a log to a past date
     * (e.g. entering data from paper notes for a missed day), fetches that day's Tuya sensor
     * history and prefills the temperature/humidity fields with the daily average, showing
     * the min/max range as a hint. For today's date, restores the live-sensor prefill.
     * Always clears the temp/humidity fields first so estimates from a previously-selected
     * date aren't carried over.
     * @returns {Promise<void>}
     */
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

        // Resolve local EAT today (UTC+3)
        const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];

        // Clear any estimate/value tied to the previously-selected date.
        tempInput.value = '';
        humInput.value = '';
        if (tempHint) tempHint.style.display = 'none';
        if (humHint) humHint.style.display = 'none';

        if (date === today) {
            // Restore live-sensor prefill for today.
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
    }

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
            // Update chip
            const chipTemp = $('sensor-chip-temp');
            if (chipTemp) chipTemp.innerText = res.temperature.toFixed(1) + '°C';
            // Clickable badge next to label
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
            // Update chip
            const chipHum = $('sensor-chip-hum');
            if (chipHum) chipHum.innerText = res.humidity.toFixed(0) + '%';
            // Clickable badge next to label
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
        
        // Live THI badge
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
        
        // Show status (last sync or error)
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
            
            // Format time ago
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
        // Refresh popover chart if it's open
        const popover = document.getElementById('sensor-popover');
        if (popover && popover.style.display !== 'none') {
            await window.renderSensorPopover();
        }
    };

    // ── Sensor Popover ─────────────────────────────────────────────────────────
    let _sensorPopoverChartInstance = null;

    window.toggleSensorPopover = async function(e) {
        e.stopPropagation();
        let popover = document.getElementById('sensor-popover');
        if (popover) {
            const isVisible = popover.style.display !== 'none';
            popover.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) await window.renderSensorPopover();
            return;
        }

        // Build the popover DOM once
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
        document.body.appendChild(popover);
        lucide.createIcons();

        // Position below the chip button
        window.positionSensorPopover();
        await window.renderSensorPopover();

        // Dismiss on outside click
        document.addEventListener('click', function outsideClick(ev) {
            const pop = document.getElementById('sensor-popover');
            const chip = document.getElementById('sensor-popover-chip');
            if (pop && !pop.contains(ev.target) && chip && !chip.contains(ev.target)) {
                pop.style.display = 'none';
                document.removeEventListener('click', outsideClick);
            }
        });
    };

    window.positionSensorPopover = function() {
        const chip = document.getElementById('sensor-popover-chip');
        const popover = document.getElementById('sensor-popover');
        if (!chip || !popover) return;
        const rect = chip.getBoundingClientRect();
        const scrollY = window.scrollY || document.documentElement.scrollTop;
        popover.style.top = (rect.bottom + scrollY + 8) + 'px';
        // Anchor to right edge of chip, shift left so popover doesn't overflow
        const popW = 320;
        let left = rect.right - popW;
        if (left < 8) left = 8;
        popover.style.left = left + 'px';
        popover.style.display = 'block';
    };

    window.renderSensorPopover = async function() {
        const res = await api.getLiveSensors();
        const history = await api.getSensorHistory();

        // Last sync label + error detail panel
        const syncLabel = document.getElementById('sp-last-sync');
        const existingErrBox = document.getElementById('sp-error-box');
        if (existingErrBox) existingErrBox.remove();

        if (syncLabel) {
            if (res && res.last_updated) {
                const diffMin = Math.round((Date.now() - new Date(res.last_updated).getTime()) / 60000);
                const timeStr = diffMin <= 0 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin/60)}h ago`;
                syncLabel.innerHTML = res.success
                    ? `<span style="color:#22c55e;">●</span> Live · synced ${timeStr}`
                    : `<span style="color:#ef4444;">●</span> Sync error · ${timeStr}`;
            } else {
                syncLabel.textContent = 'No data yet';
            }
        }

        // Error detail box
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
            // Insert below header
            const header = document.querySelector('#sensor-popover .sp-header');
            if (header) header.insertAdjacentElement('afterend', errBox);
            lucide.createIcons();
        }

        // Temperature gauge
        if (res && res.temperature != null) {
            const tv = document.getElementById('sp-temp-val');
            const tb = document.getElementById('sp-temp-bar');
            if (tv) tv.textContent = res.temperature.toFixed(1) + '°C';
            if (tb) {
                const pct = Math.min(100, Math.max(0, ((res.temperature - 10) / 30) * 100));
                tb.style.width = pct + '%';
                // Color coding: ideal 18-28°C
                tb.style.background = res.temperature < 15 || res.temperature > 32
                    ? 'linear-gradient(90deg,#ef4444,#f97316)'
                    : 'linear-gradient(90deg,#0ea5e9,#22d3ee)';
            }
        }

        // Humidity gauge
        if (res && res.humidity != null) {
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

        // Battery gauge
        if (res && res.battery != null) {
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

        // History chart
        const noHistory = document.getElementById('sp-no-history');
        const canvas = document.getElementById('sp-history-chart');
        if (!canvas) return;

        if (!history || history.length === 0) {
            if (noHistory) { noHistory.style.display = ''; canvas.style.display = 'none'; }
            return;
        }
        if (noHistory) { noHistory.style.display = 'none'; canvas.style.display = ''; }

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
        if (batch.status === 'completed') {
            updateGlobalNotifications([]);
            return;
        }

        const now = new Date();
        const alerts = [];
        const t = farmProfile.alertThresholds;

        // Feed Budget Guard
        if (txs && txs.length > 0) {
            const feedSpend = txs.filter(x => x.type === 'purchase' && x.category === 'feed').reduce((s, x) => s + parseFloat(x.amount || 0), 0);
            const totalOpex = txs.filter(x => x.type === 'purchase' && x.category !== 'infrastructure').reduce((s, x) => s + parseFloat(x.amount || 0), 0);
            if (totalOpex > 0 && (feedSpend / totalOpex) > 0.75) {
                alerts.push({ type: 'warning', icon: 'pie-chart', text: `Feed Budget Alert: Feed spend (${Math.round((feedSpend/totalOpex)*100)}%) exceeds 75% of total OPEX.` });
            }
        }

        const recent3 = kpis.recent7.slice(0, 3);
        const lowLayCount = recent3.filter(l => (l.eggs / (l.birds || batch.size)) < (t.minLayRatePercent/100)).length;
        // Suppress production crisis during ramp-up (first 42 days of laying)
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

        // --- NEW ALERTS ---
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
        const litterDate = new Date(farmProfile.litterLastChanged || now);
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

        // Use hatchDate for biological age (vaccine scheduling), fall back to startDate
        const ageOrigin = batch.hatchDate ? new Date(batch.hatchDate) : new Date(batch.startDate);
        const batchAgeDays = Math.floor((now - ageOrigin) / 86400000);
        const batchAgeWeeks = batchAgeDays / 7;

        // Module 1 Biological Alerts
        const initialSize = parseInt(batch.size) || 100;
        const currentLiveability = batch.stats.birdsAlive / initialSize;
        if (currentLiveability < (ISA_BROWN_CONSTANTS.targetLiveability / 100)) {
            const mortalityPercent = ((1 - currentLiveability) * 100).toFixed(1);
            alerts.push({ type: 'danger', icon: 'alert-octagon', text: `Liveability Crisis: Cumulative mortality at ${mortalityPercent}% (exceeds ISA Brown target of ${(100 - ISA_BROWN_CONSTANTS.targetLiveability).toFixed(1)}% limit).` });
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

    /**
     * Renders a line chart displaying lay rates over the last 14 days.
     * Utilizes Chart.js, updates scales depending on active dark/light visual theme,
     * and handles memory cleaning by destroying previous chart instances.
     * @param {Array<Object>} recentLogs - List of recent daily production logs.
     */
    async function renderCockpitChart(recentLogs) {
        const ctx = $('cockpit-layrate-chart')?.getContext('2d');
        if (!ctx) return;
        if (_cockpitChartInstance) _cockpitChartInstance.destroy();

        // Use the batch's current bird count as a safe fallback (avoid dividing by 1 for old logs)
        const activeBatch = getBatches().find(b => String(b.id) === String(currentBatchId));
        const fallbackBirds = activeBatch ? (activeBatch.size || activeBatch.stats?.birdsAlive || 100) : 100;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const lineColor = isDark ? '#5BBF4F' : '#2D5A27';
        const fillColor = isDark ? 'rgba(91,191,79,0.12)' : 'rgba(45,90,39,0.1)';
        const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
        const labelColor = isDark ? '#90A49A' : '#6B7280';

        const sorted = [...recentLogs].reverse();
        _cockpitChartInstance = new Chart(ctx, {
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
                        // Fix UTC date-shift: append noon time so local timezone renders correct day
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
        const net = revenue - expenses; // excludes working capital — true operational P&L
        const margin = revenue > 0 ? (net / revenue * 100).toFixed(1) + '%' : '—';

        // Category OPEX breakdown
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
                    const batch = getBatches().find(b => b.id === batchId);
                    refreshCockpitData(batch);
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
                    <div class="input-group"><label>Total Sacks</label><input type="number" id="bf-sacks" value="0"></div>
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
            const batch = getBatches().find(b => String(b.id) === String(batchId));
            if (batch) refreshCockpitData(batch);
        };
    };


    // Modal logic for transactions
    window.openTxModal = async function(type) {
        const title = type === 'purchase' ? 'Log Purchase' : type === 'return' ? 'Log Egg Return' : type === 'write_off' ? 'Log Write-off / Wastage' : 'Log Sale';
        const bid = currentBatchId;
        if (!bid) return;
        const logs = await api.getLogs(bid);
        const txs = await api.getTransactions(bid);
        const stagingToday = await api.getTodayStaging(bid).catch(() => null);
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'tx-modal';
        
        const saleOptions = `
            <option value="eggs">Eggs</option>
            <option value="spent">Spent Layers (Hens)</option>
            <option value="roosters">Roosters</option>
            <option value="manure">Manure</option>
        `;
        const returnOptions = `<option value="eggs">Rejected / Returned Eggs</option>`;
        const writeOffOptions = `
            <option value="eggs">Eggs (cracked / destroyed / self-consumed)</option>
            <option value="feed">Feed (spoiled / wet / expired)</option>
            <option value="meds">Medicine (expired / spilled)</option>
            <option value="other">Other</option>
        `;
        const purchaseOptions = `
            <option value="chicks">Chicks (Initial Stock)</option>
            <option value="feed">Feed</option>
            <option value="labour">Labour</option>
            <option value="utilities">Utilities (Electricity / Water)</option>
            <option value="health">Health &amp; Supplies (Meds, Infra, Other)</option>
        `;

        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:24px;">
                <h3>${title}</h3>
                <form id="tx-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                    <div class="input-group">
                        <label>${type === 'write_off' ? 'What are you writing off?' : 'Category'}</label>
                        <select id="tx-category">
                            ${type === 'purchase' ? purchaseOptions : type === 'return' ? returnOptions : type === 'write_off' ? writeOffOptions : saleOptions}
                        </select>
                    </div>
                    <div class="input-grid" id="tx-dynamic-inputs" style="display:flex; flex-direction:column; gap:12px;">
                        <!-- Dynamic fields injected here -->
                    </div>
                    <div class="input-group">
                        <label>Description / Notes (Optional)</label>
                        <textarea id="tx-notes" rows="2" placeholder="e.g., Newcastle Vaccine, Coop cleaning"></textarea>
                    </div>
                    <div style="display:flex; gap:12px; margin-top:8px;">
                        <button type="button" class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                        <button type="submit" class="btn btn-primary" style="flex:1;">Save Transaction</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(modal);

        const renderInputs = () => {
             const cat = $('tx-category').value;
             let html = '';
             if (type === 'sale') {
                  if (cat === 'eggs') {
                       const inventoryAging = computeEggInventoryAging(logs, txs, stagingToday);
                       const oldestBatch = inventoryAging.unsoldBatches.length > 0 ? inventoryAging.unsoldBatches[0].ageDays : 0;
                       
                       const buyers = farmProfile.buyers || [];
                       const buyerOptions = buyers.map(b => `<option value="${b.name}" data-terms="${b.terms}">${b.name} (${b.terms})</option>`).join('');
                       const buyerSelectHtml = buyers.length > 0 ? `
                            <div class="input-group">
                                <label>Buyer / Customer</label>
                                <select id="tx-buyer">
                                    <option value="Walk-in Customer" data-terms="COD">Walk-in Customer (COD)</option>
                                    ${buyerOptions}
                                </select>
                            </div>
                       ` : `<input type="hidden" id="tx-buyer" value="Walk-in Customer">`;
                       html += buyerSelectHtml;
                       
                       html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit" onchange="window.checkCapacity()"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
                       html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" required oninput="window.checkCapacity()"></div></div>`;
                       
                       html += `<div class="input-group"><label>Delivery Logistics</label><select id="tx-route" onchange="window.checkCapacity()"><option value="pickup">Farm Pickup</option><option value="keke">Keke / Tricycle Delivery</option><option value="saloon">Saloon Car Delivery</option></select></div>`;
                       
                       html += `<div id="tx-capacity-warning" style="display:none; font-size:12px; color:var(--text-muted); background:#fef3c7; padding:8px; border-radius:4px; border:1px solid #f59e0b; margin-bottom:16px;">
                                   <div style="display:flex; align-items:center; gap:8px; color:#d97706; font-weight:bold; margin-bottom:4px;">
                                       <i data-lucide="alert-triangle" style="width:14px; height:14px;"></i> Capacity Warning
                                   </div>
                                   <div id="tx-capacity-msg" style="color:#b45309;"></div>
                                </div>`;
                       
                       html += `
                        <script>
                            window.checkCapacity = function() {
                                const route = document.getElementById('tx-route');
                                const qty = document.getElementById('tx-qty');
                                const unit = document.getElementById('tx-unit');
                                const warningBox = document.getElementById('tx-capacity-warning');
                                const msgBox = document.getElementById('tx-capacity-msg');
                                
                                if (!route || !qty || !unit || !warningBox || !msgBox) return;
                                
                                const rVal = route.value;
                                const qVal = parseFloat(qty.value) || 0;
                                const uVal = unit.value;
                                
                                const totalUnsold = ${inventoryAging.totalUnsold};
                                if (qty) {
                                    if (uVal === 'trays') {
                                        qty.max = Math.floor(totalUnsold / 30);
                                    } else {
                                        qty.max = totalUnsold;
                                    }
                                }
                                
                                let trays = uVal === 'trays' ? qVal : qVal / 30;
                                
                                if (rVal === 'keke' && trays > 50) {
                                    msgBox.innerText = 'A Tricycle can safely carry a maximum of ~50 trays. ' + Math.ceil(trays) + ' trays exceeds safe limits and risks breakage.';
                                    warningBox.style.display = 'block';
                                } else if (rVal === 'saloon' && trays > 200) {
                                    msgBox.innerText = 'A Saloon Car can safely carry a maximum of ~200 trays. ' + Math.ceil(trays) + ' trays exceeds safe limits and risks breakage.';
                                    warningBox.style.display = 'block';
                                } else {
                                    warningBox.style.display = 'none';
                                }
                            };
                            setTimeout(window.checkCapacity, 50);
                        </script>`;
                       
                       html += `<div style="font-size:12px; color:var(--text-muted); background:var(--bg-main); padding:8px; border-radius:4px; border:1px solid var(--border-color); display:flex; align-items:center; gap:8px;">
                                   <i data-lucide="layers" style="width:14px; height:14px; color:var(--primary);"></i> 
                                   <div><strong>FIFO Dispatch Active:</strong> You have ${inventoryAging.totalUnsold.toLocaleString()} eggs in stock. Sales will automatically deduct from the oldest stock first (oldest is ${oldestBatch} days old).</div>
                                </div>`;
                  } else if (cat === 'manure') {
                       html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="bags">50kg Bags</option><option value="wb">Wheelbarrows</option></select></div>`;
                       html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" required></div></div>`;
                  } else if (cat === 'spent' || cat === 'roosters') {
                       html += `<div class="input-group"><label>Birds Sold</label><input type="number" id="tx-qty" value="1" required></div>`;
                  }
             } else if (type === 'return') {
                   html = `<div class="input-group"><label>Refund Amount (KES)</label><input type="number" id="tx-amount" value="0" required></div>`;
                   html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
                   html += `<div class="input-group"><label>Quantity Returned</label><input type="number" id="tx-qty" value="1" required></div></div>`;
                   
                   html += `<div class="input-group"><label>Defect Type</label><select id="tx-defect" onchange="
                      const val = this.value;
                      const r = document.getElementById('tx-root-cause');
                      if(!r) return;
                      if(val === 'pale') r.innerText = 'Infectious Bronchitis (IB) or older birds (>72 wks)';
                      else if(val === 'crack') r.innerText = 'Mechanical damage — rough handling or overcrowding';
                      else if(val === 'dirty') r.innerText = 'Wet litter, poor gut health, or infrequent collection';
                      else if(val === 'thin') r.innerText = 'Ca / Vitamin D3 deficiency or heat stress';
                      else r.innerText = 'Unknown';
                   ">
                       <option value="pale">Pale Shells</option>
                       <option value="crack">Hairline / Star Cracks</option>
                       <option value="dirty">Dirty / Stained Shells</option>
                       <option value="thin">Thin Shells</option>
                   </select></div>`;
                   
                   html += `<div style="font-size:12px; color:var(--text-muted); background:#fee2e2; padding:8px; border-radius:4px; border:1px solid #fca5a5; display:flex; align-items:center; gap:8px;">
                               <i data-lucide="microscope" style="width:14px; height:14px; color:#dc2626;"></i> 
                               <div><strong>Likely Root Cause:</strong> <span id="tx-root-cause">Infectious Bronchitis (IB) or older birds (>72 wks)</span></div>
                            </div>`;
             } else if (type === 'write_off') {
                   const unitLabel = cat === 'eggs' ? 'Quantity (eggs)' : cat === 'feed' ? 'Quantity (kg)' : 'Quantity (units)';
                   html += `
                       <div class="input-group"><label>Reason</label><select id="tx-reason">
                           <option value="spoiled">Spoiled / Contaminated</option>
                           <option value="cracked">Cracked / Physically Damaged</option>
                           <option value="self_consumed">Self-consumed (staff / household)</option>
                           <option value="destroyed">Destroyed (pest, theft, accident)</option>
                           <option value="expired">Expired (past safe use date)</option>
                           <option value="other">Other</option>
                       </select></div>
                       <div class="input-group"><label>${unitLabel}</label><input type="number" id="tx-qty" min="1" required></div>
                       <div class="input-group"><label>Est. Value Lost (KES — optional)</label><input type="number" id="tx-amount" value="0"></div>
                   `;
             } else {
                  if (cat === 'feed') {
                       html += `<div class="input-group"><label>Quantity (kg)</label><input type="number" id="tx-qty" required></div>`;
                  } else if (cat === 'labour') {
                       html += `<div class="input-group"><label>Farmhand Name</label><input type="text" id="tx-farmhand" placeholder="e.g. John Doe"></div>`;
                  } else if (cat === 'utilities') {
                        html += `<div class="input-group">
                            <label>Utility Type</label>
                            <select id="tx-sub-category">
                                <option value="electricity">Electricity</option>
                                <option value="water">Water</option>
                            </select>
                        </div>`;
                        html += `<div class="input-group"><label>Billing Month</label><input type="month" id="tx-billing-month"></div>`;
                  } else if (cat === 'health') {
                        html += `<div class="input-group">
                            <label>Supply Type</label>
                            <select id="tx-sub-category">
                                <option value="meds">Vaccines / Medication</option>
                                <option value="infrastructure">Infrastructure</option>
                                <option value="other">Other Supplies</option>
                            </select>
                        </div>`;
                  }
             }

             if (type !== 'return' && type !== 'write_off') {
                  if (cat === 'feed') {
                      html += `
                        <div class="input-group">
                            <label>Purchase Amount (KES)</label>
                            <input type="number" id="tx-amount" required>
                            <span style="font-size:11px; color:var(--text-muted);">Auto-calculated based on ${farmProfile.defaultFeedPrice} KES per ${farmProfile.sackWeightKg}kg bag. You can override this.</span>
                        </div>
                        <div class="input-group">
                            <label>Delivery Fee (Optional KES)</label>
                            <input type="number" id="tx-delivery" value="0">
                        </div>
                        <script>
                            document.getElementById('tx-qty').addEventListener('input', function() {
                                const amtEl = document.getElementById('tx-amount');
                                if (amtEl && this.value) {
                                    amtEl.value = Math.round((parseFloat(this.value) / ${farmProfile.sackWeightKg}) * ${farmProfile.defaultFeedPrice});
                                } else if (amtEl) {
                                    amtEl.value = '';
                                }
                            });
                        </script>`;
                  } else {
                      html += `<div class="input-group"><label>Total Amount (KES)</label><input type="number" id="tx-amount" required></div>`;
                  }
             }
             $('tx-dynamic-inputs').innerHTML = html;
             
             // Eval script tags if any were injected (for the feed qty listener)
             const scripts = $('tx-dynamic-inputs').getElementsByTagName('script');
             for (let i = 0; i < scripts.length; i++) {
                 eval(scripts[i].innerText);
             }
        };

        $('tx-category').addEventListener('change', renderInputs);
        renderInputs();

        $('tx-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const bid = currentBatchId;
            if (!bid) { window.showToast('Batch context missing.', 'danger'); return; }

            const txs = await api.getTransactions(bid);
            const amount = parseFloat($('tx-amount') ? $('tx-amount').value : 0) || 0;
            const deliveryFee = $('tx-delivery') ? parseFloat($('tx-delivery').value) || 0 : 0;
            let rawQty = parseFloat($('tx-qty') ? $('tx-qty').value : 0);
            let unit = $('tx-unit') ? $('tx-unit').value : null;
            let farmhandName = $('tx-farmhand') ? $('tx-farmhand').value : null;
            let billingMonth = $('tx-billing-month') ? $('tx-billing-month').value : null;
            let buyerName = $('tx-buyer') ? $('tx-buyer').value : null;
            let route = $('tx-route') ? $('tx-route').value : null;
            let defectType = $('tx-defect') ? $('tx-defect').value : null;
            let reason = $('tx-reason') ? $('tx-reason').value : null;
            let buyerTerms = 'COD';
            if ($('tx-buyer') && $('tx-buyer').options && $('tx-buyer').type === 'select-one') {
                const selectedOpt = $('tx-buyer').options[$('tx-buyer').selectedIndex];
                if (selectedOpt) buyerTerms = selectedOpt.getAttribute('data-terms');
            }
            
            let normalizedQty = rawQty;

            if ((type === 'sale' || type === 'return' || type === 'write_off') && $('tx-category').value === 'eggs' && unit === 'trays') {
                normalizedQty = rawQty * 30; // convert to individual eggs
            }

            // Resolve actual category: for grouped types, use the sub-category dropdown value
            const subCat = $('tx-sub-category') ? $('tx-sub-category').value : null;
            const resolvedCategory = subCat || $('tx-category').value;

            const newTx = {
                id: Date.now().toString(),
                type: type, // 'sale', 'purchase', 'return', 'write_off'
                category: resolvedCategory,
                amount: amount,
                deliveryFee: deliveryFee,
                qty: normalizedQty,
                rawUnit: unit,
                rawQty: rawQty,
                farmhandName,
                billingMonth,
                buyerName,
                buyerTerms,
                route,
                defectType,
                reason,
                status: (buyerTerms && buyerTerms !== 'COD' && type === 'sale') ? 'unpaid' : 'paid',
                unitPrice: normalizedQty > 0 && amount > 0 ? (amount / normalizedQty) : 0,
                notes: $('tx-notes') ? $('tx-notes').value.trim() : '',
                date: new Date().toISOString()
            };
            
            await api.saveTransaction(bid, newTx);
            
            const batch = getBatches().find(b => String(b.id) === String(bid));
            
            // Handle Spent Layers / Roosters reduction
            if (type === 'sale' && (resolvedCategory === 'spent' || resolvedCategory === 'roosters') && rawQty > 0 && batch) {
                batch.stats.birdsAlive = Math.max(0, batch.stats.birdsAlive - rawQty);
                batch.stats.totalSold = (batch.stats.totalSold || 0) + rawQty;
                await updateBatch(batch);
            }
            
            // Handle feed price learning
            if (type === 'purchase' && resolvedCategory === 'feed' && rawQty > 0 && amount > 0) {
                const impliedBagPrice = (amount / rawQty) * farmProfile.sackWeightKg;
                if (Math.abs(impliedBagPrice - farmProfile.defaultFeedPrice) > 1) {
                    farmProfile.defaultFeedPrice = Math.round(impliedBagPrice);
                    saveFarmProfile(farmProfile);
                    console.log("Farm profile default feed price updated to: " + farmProfile.defaultFeedPrice);
                }
            }
            
            document.body.removeChild(modal);
            if (batch) refreshCockpitData(batch);
        });
    }

    // Logic handled by window.submitDailyLog in cockpit view

    window.openHealthModal = function(type) {
        const bid = currentBatchId;
        if (!bid) return;
        
        const title = type === 'vaccine' ? 'Log Vaccination' : 'Log Medication / Treatment';
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'health-modal';
        
        let drugOptionsHtml = '';
        if (type === 'vaccine') {
            drugOptionsHtml = `
                <option value="Newcastle (HB1/La Sota)">Newcastle (HB1/La Sota)</option>
                <option value="Gumboro (IBD)">Gumboro (IBD)</option>
                <option value="Fowl Pox">Fowl Pox</option>
                <option value="Marek's Disease">Marek's Disease</option>
                <option value="Newcastle (Booster)">Newcastle (Booster)</option>
                <option value="Gumboro (Booster)">Gumboro (Booster)</option>
                <option value="Newcastle (Komarov)">Newcastle (Komarov)</option>
                <option value="Newcastle (La Sota)">Newcastle (La Sota)</option>
                <option value="Dewormer (Piperazine)">Dewormer (Piperazine)</option>
                <option value="Dewormer (Levamisole)">Dewormer (Levamisole)</option>
                <option value="other">Other (Custom Vaccine)</option>
            `;
        } else {
            drugOptionsHtml = `
                <option value="Aliseryl WS">Aliseryl WS</option>
                <option value="Oxytetracycline">Oxytetracycline</option>
                <option value="Amoxicillin">Amoxicillin</option>
                <option value="Tylosin">Tylosin</option>
                <option value="Levamisole">Levamisole</option>
                <option value="Perimin">Perimin</option>
                <option value="Norotraz">Norotraz</option>
                <option value="Piperazine">Piperazine</option>
                <option value="Fenbendazole">Fenbendazole</option>
                <option value="other">Other (Custom Medicine)</option>
            `;
        }
        
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:24px;">
                <h3>${title}</h3>
                <form id="health-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                    <div class="input-group">
                        <label>Date</label>
                        <input type="date" id="health-date" required value="${new Date().toISOString().split('T')[0]}">
                    </div>
                    
                    <div class="input-group">
                        <label>${type === 'vaccine' ? 'Vaccine Name' : 'Medicine / Drug Name'}</label>
                        <select id="health-drug-select" required>
                            ${drugOptionsHtml}
                        </select>
                    </div>
                    
                    <div class="input-group" id="health-custom-drug-group" style="display:none;">
                        <label>Specify Custom Name</label>
                        <input type="text" id="health-custom-drug" placeholder="e.g. Tylosin, Newcastle Booster">
                    </div>
                    
                    <div class="input-group">
                        <label>Dosage</label>
                        <input type="text" id="health-dosage" placeholder="e.g. 1.5 Tablespoon/20L, 1 vial/1000 birds" required>
                    </div>
                    
                    <div class="input-group">
                        <label>Route of Administration</label>
                        <select id="health-route">
                            <option value="Drinking Water">Drinking Water</option>
                            <option value="Wing-web">Wing-web Injection</option>
                            <option value="Intramuscular">Intramuscular Injection</option>
                            <option value="Eye Drop">Eye Drop</option>
                            <option value="Oral">Oral (Direct)</option>
                            <option value="Spray">Coop Spray / Aerosol</option>
                            <option value="Feed additive">In-feed Additive</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    
                    <div class="input-group">
                        <label>Administered By</label>
                        <input type="text" id="health-admin" placeholder="e.g. Kelvin, Vet" required value="${window.USER_NAME || ''}">
                    </div>
                    
                    <div class="input-group" style="display:flex; flex-direction:row; align-items:center; gap:8px; cursor:pointer;">
                        <input type="checkbox" id="health-off-label" style="width:auto; margin:0;">
                        <label for="health-off-label" style="margin:0; cursor:pointer;">Off-label use (forces 14d egg/28d meat withdrawal)</label>
                    </div>
                    
                    <div style="display:flex; gap:12px; margin-top:8px;">
                        <button type="button" class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                        <button type="submit" class="btn btn-primary" style="flex:1;">Log Event</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(modal);
        
        const drugSelect = document.getElementById('health-drug-select');
        const customDrugGroup = document.getElementById('health-custom-drug-group');
        const customDrugInput = document.getElementById('health-custom-drug');
        
        drugSelect.addEventListener('change', function() {
            if (this.value === 'other') {
                customDrugGroup.style.display = 'block';
                customDrugInput.required = true;
            } else {
                customDrugGroup.style.display = 'none';
                customDrugInput.required = false;
                customDrugInput.value = '';
            }
        });
        
        document.getElementById('health-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const selectedDrug = drugSelect.value;
            const drugName = selectedDrug === 'other' ? customDrugInput.value.trim() : selectedDrug;
            
            if (!drugName) {
                window.showToast('Please specify a drug or vaccine name.', 'danger');
                return;
            }
            
            const newLog = {
                id: `${bid}_h_${Date.now()}`,
                date: document.getElementById('health-date').value,
                type: type,
                drug: drugName,
                dosage: document.getElementById('health-dosage').value.trim(),
                route: document.getElementById('health-route').value,
                admin: document.getElementById('health-admin').value.trim() || 'Admin',
                offLabel: document.getElementById('health-off-label').checked
            };
            
            try {
                await api.saveHealthLog(bid, newLog);
                document.body.removeChild(modal);
                window.showToast(`${type === 'vaccine' ? 'Vaccination' : 'Medication'} logged successfully.`, 'success');
                
                await window.renderHealthTable(bid);
                
                const batch = getBatches().find(b => String(b.id) === String(bid));
                if (batch) refreshCockpitData(batch);
            } catch (err) {
                console.error('Error saving health log:', err);
                window.showToast('Failed to save health log.', 'danger');
            }
        });
    };

    // Logic handled by window.submitDailyLog in cockpit view

    window.finishBatch = async function(id) {
        const batches = getBatches();
        const batch = batches.find(b => String(b.id) === String(id));
        if (!batch) {
            console.error("Batch not found for id:", id);
            return;
        }
        
        const logs = await api.getLogs(id);
        const txs = await api.getTransactions(id);
        const stagingToday = await api.getTodayStaging(id).catch(() => null);
        const kpis = computeKPIs(logs, txs, batch, farmProfile, stagingToday);
        
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
            const avgFeedPrice = feedTxs.length > 0 ? (feedTxs.reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0) / feedTxs.reduce((sum, t) => sum + (parseFloat(t.qty)||0), 0)) : farmProfile.defaultFeedPrice / farmProfile.sackWeightKg;
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
                batch.status = 'completed';
                batch.closeDate = new Date().toISOString();
            } else {
                batch.status = 'post_batch';
            }

            await api.saveBatch(batch);
            document.body.removeChild(modal);
            switchView('batches');
            window.showToast(willSoftClose ? 'Batch moved to Winding Down. Only egg sales are permitted.' : 'Batch completed! Success snapshot and farm aggregates updated.');
        });
    };

    /**
     * Recalculates historical farm-wide aggregates upon the closure of a flock batch cohort.
     * Computes rolling feed conversions, seasonality multipliers (monthly average lay rates),
     * and mortality curves to improve subsequent proposal predictions.
     * @param {Object} batch - Completed cohort configuration properties.
     * @param {Array<Object>} logs - Collection of operational logs.
     * @param {Array<Object>} txs - Collection of transaction ledger records.
     * @param {Object} kpis - Final calculated cohort KPIs.
     */
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
    }

    // ===================== SETTINGS & CRM & BATCH LEARNING (§5.1/5.2) =====================
    function renderBuyersList() {
        const list = $('buyers-list');
        if (!list) return;
        const buyers = farmProfile.buyers || [];
        if (buyers.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No buyers added yet.</p>';
            return;
        }
        list.innerHTML = buyers.map((b, i) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border-color); font-size:13px;">
                <div>
                    <strong>${b.name}</strong> 
                    ${b.phone ? `<span style="color:var(--text-muted); margin-left:8px;">(${b.phone})</span>` : ''}
                    <span style="color:var(--text-muted); margin-left:8px;">(${b.terms})</span>
                </div>
                <button type="button" class="btn btn-sm" style="color:var(--danger); padding:2px 6px;" onclick="removeBuyer(${i})"><i data-lucide="trash-2" style="width:14px; height:14px;"></i></button>
            </div>
        `).join('');
        lucide.createIcons();
    }
    
    window.removeBuyer = function(idx) {
        if (!confirm('Remove this buyer?')) return;
        farmProfile.buyers.splice(idx, 1);
        saveFarmProfile(farmProfile);
        renderBuyersList();
        _renderReconciliationConsole();
    };
    
    $('add-buyer-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!farmProfile.buyers) farmProfile.buyers = [];
        farmProfile.buyers.push({
            name: $('buyer-name').value,
            phone: $('buyer-phone') ? $('buyer-phone').value.trim() : '',
            terms: $('buyer-terms').value
        });
        saveFarmProfile(farmProfile);
        renderBuyersList();
        _renderReconciliationConsole();
        $('add-buyer-form').reset();
    });

    async function _renderReconciliationConsole() {
        const card = $('reconciliation-console-card');
        const list = $('reconciliation-list');
        if (!card || !list) return;

        const userRole = window.USER_ROLE;
        if (!['super_admin', 'admin', 'farmer'].includes(userRole)) {
            card.style.display = 'none';
            return;
        }

        const items = await api.getLedgerReconciliation();
        if (items.length === 0) {
            card.style.display = 'block';
            list.innerHTML = '<p style="color:var(--text-muted); font-size:13px; text-align:center; padding:16px;">No pending payments in suspense account.</p>';
            return;
        }

        card.style.display = 'block';
        const buyers = farmProfile.buyers || [];
        const isViewerOrFarmer = ['farmer', 'viewer'].includes(userRole) && userRole !== 'super_admin' && userRole !== 'admin';

        list.innerHTML = items.map(item => {
            let optionsHtml = `<option value="">-- Select Destination Account --</option>`;
            optionsHtml += `<option value="4000|Egg Sales">Direct Sale: Egg Sales Revenue (4000)</option>`;
            buyers.forEach(buyer => {
                optionsHtml += `<option value="1200|${buyer.name}">Credit: ${buyer.name} (Accounts Receivable)</option>`;
            });

            const formattedDate = new Date(item.date).toLocaleDateString('en-KE', {
                year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            return `
                <div class="reconciliation-item" style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-main); font-size:13px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                        <div>
                            <strong style="color:var(--primary); font-size:14px;">KES ${item.amount.toLocaleString()}</strong>
                            <span style="color:var(--text-muted); margin-left:8px;">Ref: ${item.ref_id}</span>
                            <div style="margin-top:4px; font-weight:500;">${item.description}</div>
                            <div style="color:var(--text-muted); font-size:11px; margin-top:2px;">${formattedDate}</div>
                        </div>
                    </div>
                    ${isViewerOrFarmer ? `
                        <div style="color:var(--text-muted); font-style:italic; font-size:11px;">Reconciliation actions restricted to Administrators.</div>
                    ` : `
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            <select class="select-md" style="flex:1; min-width:200px;" id="rec-dest-${item.id}">
                                ${optionsHtml}
                            </select>
                            <button class="btn btn-primary btn-sm" onclick="window.reconcileTransaction('${item.id}')">Reconcile</button>
                        </div>
                    `}
                </div>
            `;
        }).join('');
    }

    window.reconcileTransaction = async function(txId) {
        const select = document.getElementById(`rec-dest-${txId}`);
        if (!select || !select.value) {
            window.showToast('Please select a destination account first.', 'danger');
            return;
        }

        const [targetAccountId, buyerName] = select.value.split('|');
        const activeBatch = getBatches().find(b => b.status === 'active');
        const batchId = activeBatch ? activeBatch.id : null;

        const res = await api.reconcileLedgerTransaction({
            transactionId: txId,
            targetAccountId,
            buyerName,
            batchId
        });

        if (res.success) {
            window.showToast('Transaction reconciled successfully!', 'success');
            await _renderReconciliationConsole();
            if (currentBatchId) {
                const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
                if (batch) refreshCockpitData(batch);
            }
        } else {
            window.showToast(res.error || 'Failed to reconcile transaction.', 'danger');
        }
    };

    function loadSettingsForm() {
        const p = farmProfile;
        $('set-flock-size').value = p.flockSize;
        $('set-feed-price').value = p.defaultFeedPrice;
        $('set-sack-weight').value = p.sackWeightKg;
        $('set-min-layrate').value = p.alertThresholds.minLayRatePercent;
        $('set-max-fc').value = p.alertThresholds.maxFeedConversion;
        $('set-low-inv').value = p.alertThresholds.lowInventoryDays;
        $('set-prod-drop').value = p.alertThresholds.productionDropPercent;
        if($('set-storage-type')) $('set-storage-type').value = p.eggStorageType || 'room';

        // Sensor alert threshold + Telegram Chat ID + Bot Token
        if ($('set-sensor-offline-mins')) $('set-sensor-offline-mins').value = p.sensorOfflineMinutes || 30;
        if ($('set-telegram-chat-id'))   $('set-telegram-chat-id').value   = p.telegramChatId || '';
        if ($('set-telegram-bot-token')) $('set-telegram-bot-token').value = p.telegramBotToken || '';

        // Load M-Pesa configuration keys
        api.getEntity('mpesa_consumer_key', '').then(val => {
            if ($('set-mpesa-consumer-key')) $('set-mpesa-consumer-key').value = val || '';
        });
        api.getEntity('mpesa_consumer_secret', '').then(val => {
            if ($('set-mpesa-consumer-secret')) $('set-mpesa-consumer-secret').value = val || '';
        });
        api.getEntity('mpesa_passkey', '').then(val => {
            if ($('set-mpesa-passkey')) $('set-mpesa-passkey').value = val || '';
        });
        api.getEntity('mpesa_shortcode', '').then(val => {
            if ($('set-mpesa-shortcode')) $('set-mpesa-shortcode').value = val || '';
        });

        // Account & Security panel
        if ($('settings-username-display')) {
            $('settings-username-display').textContent = window.CURRENT_USER?.username || '—';
        }
        if ($('settings-role-display')) {
            $('settings-role-display').textContent = window.USER_ROLE || '—';
        }

        // Logout button
        $('btn-logout')?.addEventListener('click', async () => {
            if (!confirm('Sign out?')) return;
            await api.logout();
            window.location.reload();
        });

        // Change own password
        $('btn-change-own-password')?.addEventListener('click', () => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active';
            overlay.innerHTML = `
                <div class="modal-content card" style="max-width:360px;padding:24px;position:relative;">
                    <button type="button" class="btn btn-secondary btn-sm" style="position:absolute;top:12px;right:12px;" onclick="this.closest('.modal-overlay').remove()">
                        <i data-lucide="x" style="width:14px;height:14px;"></i>
                    </button>
                    <h3 style="margin:0 0 16px;">Change Password</h3>
                    <div style="display:flex;flex-direction:column;gap:12px;">
                        <div class="input-group">
                            <label>Current Password</label>
                            <input type="password" id="pw-current" class="input-md">
                        </div>
                        <div class="input-group">
                            <label>New Password</label>
                            <input type="password" id="pw-new" class="input-md" placeholder="≥ 8 characters">
                        </div>
                        <div class="input-group">
                            <label>Confirm New Password</label>
                            <input type="password" id="pw-confirm" class="input-md">
                        </div>
                        <p id="pw-error" style="color:var(--danger);font-size:0.82rem;display:none;"></p>
                        <button id="pw-submit" class="btn btn-primary">Update Password</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            lucide.createIcons();
            document.getElementById('pw-submit').onclick = async () => {
                const cur = document.getElementById('pw-current').value;
                const nw  = document.getElementById('pw-new').value;
                const cnf = document.getElementById('pw-confirm').value;
                const err = document.getElementById('pw-error');
                if (nw.length < 8) { err.textContent = 'New password must be ≥ 8 characters.'; err.style.display = 'block'; return; }
                if (nw !== cnf) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
                const res = await api.changePassword(cur, nw);
                if (res.success) { overlay.remove(); window.showToast('Password updated.', 'success'); }
                else { err.textContent = res.error || 'Failed.'; err.style.display = 'block'; }
            };
        });

        renderBuyersList();
        _renderReconciliationConsole();

        // User Management panel (admin+ only)
        const umContainer = $('user-management-panel')?.querySelector('.card-body') || $('user-management-panel');
        const outerPanel  = $('user-management-panel');
        if (outerPanel && ['admin','super_admin'].includes(window.USER_ROLE)) {
            outerPanel.style.display = 'block';
            if (umContainer) _renderUserManagementPanel(umContainer);
        } else if (outerPanel) {
            outerPanel.style.display = 'none';
        }

        if (window.USER_ROLE === 'viewer') {
            const settingsView = document.getElementById('view-settings');
            const inputs = settingsView?.querySelectorAll('input, select, textarea, button:not(#btn-logout)');
            inputs?.forEach(inp => inp.disabled = true);
            const submitBtn = settingsView?.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.style.display = 'none';
        }
    }

    async function _renderUserManagementPanel(container) {
        container.innerHTML = '<p style="opacity:0.5;font-size:0.85rem;">Loading users…</p>';
        const users = await api.getUsers();
        const isSuperAdmin = window.USER_ROLE === 'super_admin';
        container.innerHTML = `
            <h4 style="margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;">
                <span><i data-lucide="users" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;"></i>User Accounts</span>
                ${isSuperAdmin ? '<button class="btn btn-secondary btn-sm" id="btn-add-user">+ Add User</button>' : ''}
            </h4>
            <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
                <thead><tr>
                    <th style="padding:6px 10px;text-align:left;opacity:0.55;">Username</th>
                    <th style="padding:6px 10px;text-align:left;opacity:0.55;">Role</th>
                    <th style="padding:6px 10px;text-align:right;opacity:0.55;">Actions</th>
                </tr></thead>
                <tbody>
                    ${users.map(u => `
                    <tr style="border-top:1px solid var(--border-color);">
                        <td style="padding:8px 10px;font-weight:600;">${u.username}${u.id === window.CURRENT_USER?.id ? ' <span style="font-size:0.7rem;opacity:0.5;">(you)</span>' : ''}</td>
                        <td style="padding:8px 10px;">
                            ${isSuperAdmin && u.id !== window.CURRENT_USER?.id ? `
                            <select data-uid="${u.id}" class="role-select input-sm" style="font-size:0.82rem;padding:3px 6px;">
                                ${['farmer','viewer','admin','super_admin'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
                            </select>
                            ` : `<span class="pill">${u.role}</span>`}
                        </td>
                        <td style="padding:8px 10px;text-align:right;">
                            <button class="btn btn-ghost btn-sm" onclick="window._changeUserPassword('${u.id}','${u.username}')">Reset PW</button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
            <div id="guest-token-section" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-color);">
                <label style="font-size:0.82rem;opacity:0.65;">Guest Share Link</label>
                <div style="display:flex;gap:8px;margin-top:6px;">
                    <input id="guest-token-display" readonly style="flex:1;padding:7px 10px;border-radius:7px;border:1px solid var(--border-color);background:rgba(255,255,255,0.04);color:inherit;font-size:0.8rem;font-family:monospace;" placeholder="Regenerate to create a link">
                    <button class="btn btn-secondary btn-sm" onclick="window._regenGuestToken()">Regenerate</button>
                </div>
                <p style="font-size:0.75rem;opacity:0.45;margin:6px 0 0;">Share this URL with read-only viewers. Regenerating invalidates the old link.</p>
            </div>`;
        lucide.createIcons();

        // Role change handler
        container.querySelectorAll('.role-select').forEach(sel => {
            sel.addEventListener('change', async (e) => {
                const uid = e.target.dataset.uid;
                const res = await api.updateUserRole(uid, e.target.value);
                if (!res.success) { showToast('Role update failed.', 'error'); e.target.value = users.find(u => u.id == uid)?.role; }
                else showToast('Role updated.', 'success');
            });
        });

        document.getElementById('btn-add-user')?.addEventListener('click', () => _showAddUserModal(() => _renderUserManagementPanel(container)));
    }

    window._changeUserPassword = function(uid, username) {
        const pw = prompt(`New password for "${username}" (min 8 chars):`);
        if (!pw || pw.length < 8) { showToast('Password too short (min 8).', 'warning'); return; }
        api.changePassword(uid, pw).then(r => showToast(r.success ? 'Password changed.' : (r.error || 'Failed.'), r.success ? 'success' : 'error'));
    };

    window._regenGuestToken = async function() {
        const res = await api.regenerateGuestToken();
        if (res.token) {
            const url = `${window.location.origin}/?guest=${res.token}`;
            const inp = document.getElementById('guest-token-display');
            if (inp) inp.value = url;
            showToast('Guest link regenerated! Copy it above.', 'success');
        } else {
            showToast(res.error || 'Failed to regenerate.', 'error');
        }
    };

    function _showAddUserModal(onSuccess) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:8000;';
        overlay.innerHTML = `
            <div style="background:var(--card-bg,#1e2535);border-radius:14px;padding:28px 24px;min-width:320px;max-width:94vw;">
                <h3 style="margin:0 0 18px;">Add User</h3>
                <div style="margin-bottom:11px;"><label style="font-size:0.8rem;opacity:0.65;display:block;margin-bottom:5px;">Username</label>
                    <input id="nu-username" type="text" style="width:100%;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;box-sizing:border-box;"></div>
                <div style="margin-bottom:11px;"><label style="font-size:0.8rem;opacity:0.65;display:block;margin-bottom:5px;">Password (min 8)</label>
                    <input id="nu-password" type="password" style="width:100%;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;box-sizing:border-box;"></div>
                <div style="margin-bottom:18px;"><label style="font-size:0.8rem;opacity:0.65;display:block;margin-bottom:5px;">Role</label>
                    <select id="nu-role" style="width:100%;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;box-sizing:border-box;">
                        <option value="farmer">Farmer</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
                    </select></div>
                <div id="nu-error" style="display:none;color:#ef4444;font-size:0.82rem;margin-bottom:10px;"></div>
                <div style="display:flex;gap:10px;">
                    <button id="nu-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;cursor:pointer;">Cancel</button>
                    <button id="nu-save" style="flex:2;padding:10px;border-radius:8px;border:none;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:600;cursor:pointer;">Create User</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        document.getElementById('nu-cancel').onclick = () => overlay.remove();
        document.getElementById('nu-save').onclick = async () => {
            const username = document.getElementById('nu-username').value.trim();
            const password = document.getElementById('nu-password').value;
            const role = document.getElementById('nu-role').value;
            const errEl = document.getElementById('nu-error');
            if (!username || password.length < 8) { errEl.textContent = 'Username required and password ≥ 8 chars.'; errEl.style.display = 'block'; return; }
            const res = await api.createUser(username, password, role);
            if (res.success) { overlay.remove(); showToast('User created.', 'success'); if (onSuccess) onSuccess(); }
            else { errEl.textContent = res.error || 'Failed.'; errEl.style.display = 'block'; }
        };
    }


    $('settings-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        farmProfile.flockSize = parseInt($('set-flock-size').value);
        farmProfile.defaultFeedPrice = parseInt($('set-feed-price').value);
        farmProfile.sackWeightKg = parseInt($('set-sack-weight').value);
        farmProfile.alertThresholds.minLayRatePercent = parseInt($('set-min-layrate').value);
        farmProfile.alertThresholds.maxFeedConversion = parseFloat($('set-max-fc').value);
        farmProfile.alertThresholds.lowInventoryDays = parseInt($('set-low-inv').value);
        farmProfile.alertThresholds.productionDropPercent = parseInt($('set-prod-drop').value);
        if ($('set-storage-type')) farmProfile.eggStorageType = $('set-storage-type').value;
        if ($('set-sensor-offline-mins')) farmProfile.sensorOfflineMinutes = parseInt($('set-sensor-offline-mins').value);
        if ($('set-telegram-chat-id')) farmProfile.telegramChatId = $('set-telegram-chat-id').value.trim();
        if ($('set-telegram-bot-token')) farmProfile.telegramBotToken = $('set-telegram-bot-token').value.trim();
        saveFarmProfile(farmProfile);

        // Save M-Pesa credentials
        if ($('set-mpesa-consumer-key')) api.setEntity('mpesa_consumer_key', $('set-mpesa-consumer-key').value.trim());
        if ($('set-mpesa-consumer-secret')) api.setEntity('mpesa_consumer_secret', $('set-mpesa-consumer-secret').value.trim());
        if ($('set-mpesa-passkey')) api.setEntity('mpesa_passkey', $('set-mpesa-passkey').value.trim());
        if ($('set-mpesa-shortcode')) api.setEntity('mpesa_shortcode', $('set-mpesa-shortcode').value.trim());

        window.showToast('Farm profile saved successfully!');
    });

    $('btn-export-data')?.addEventListener('click', async () => {
        const data = {
            poultryFarmProfile: await api.getEntity('poultryFarmProfile', null),
            poultryAggregates: await api.getEntity('poultryAggregates', null),
            poultryProposals: await api.getProposals(),
            poultryBatches: await api.getBatches(),
            poultrySnapshots: await api.getSnapshots()
        };
        
        // Find all logs and transactions
        const batches = data.poultryBatches || [];
        for (const b of batches) {
            data[`poultryLogs_${b.id}`] = await api.getLogs(b.id);
            data[`poultryTx_${b.id}`] = await api.getTransactions(b.id);
            data[`poultryHealth_${b.id}`] = await api.getHealthLogs(b.id);
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `poultry_dss_backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
    });

    async function renderBatchLearning(snapshots) {
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

    window.renderHealthTable = async function(batchId) {
        const container = $('health-log-table');
        if (!container) return;
        const logs = await api.getHealthLogs(batchId);
        
        container.innerHTML = logs.length === 0 ? '<p style="text-align:center; padding:20px; color:var(--text-muted);">No health records yet.</p>' : `
            <table style="width:100%; border-collapse:collapse;">
                <thead><tr>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Date</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Event</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Dosage</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Admin</th>
                </tr></thead>
                <tbody>
                    ${logs.map(l => {
                        const icon = l.type === 'vaccine' ? 'syringe' : 'pill';
                        const color = l.type === 'vaccine' ? 'var(--primary)' : 'var(--accent)';
                        const bg = l.type === 'vaccine' ? 'var(--primary-soft)' : '#fef3c7'; // amber-100
                        return `
                        <tr style="border-bottom:1px solid var(--border-color); font-size:13px;">
                            <td style="padding:8px 12px; color:var(--text-muted);">${l.date}</td>
                            <td style="padding:8px 12px;">
                                <span class="pill" style="background:${bg}; color:${color}; margin-right:6px;"><i data-lucide="${icon}" style="width:12px;height:12px;vertical-align:middle;margin-right:2px;"></i>${l.type.toUpperCase()}</span>
                                <strong>${l.drug}</strong>
                                ${l.offLabel ? '<span style="color:#dc2626; font-size:10px; margin-left:4px;">(Off-label)</span>' : ''}
                            </td>
                            <td style="padding:8px 12px;">
                                <div style="margin-bottom:4px;">${l.dosage}</div>
                                <span class="pill" style="background:var(--border-color); color:var(--text-muted); font-size:10px;">${l.route || 'Unknown'}</span>
                            </td>
                            <td style="padding:8px 12px; color:var(--text-muted);">${l.admin}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
        lucide.createIcons();
    };

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
            const batch = getBatches().find(b => String(b.id) === String(batchId));
            if (!batch) return;
            
            batch.cleanoutSOP = {
                date: new Date().toISOString(),
                disposalDate: $('sop-disp-date').value,
                disposalSite: $('sop-disp-site').value,
                productsUsed: $('sop-products').value,
                litterType: $('sop-litter-type').value,
                litterSource: $('sop-litter-src').value
            };
            
            await updateBatch(batch);
            document.body.removeChild(modal);
            refreshBatches();
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
                allBatches = []; // Clear cache
                await window.syncBatches();
                await window.refreshBatches();
                refreshDashboard();
                window.showToast('All batches cleared successfully.', 'info');
            } catch (err) {
                console.error('Error clearing batches:', err);
                window.showToast('Failed to clear batches.', 'danger');
            }
        });
    };

    window.showAdjustFlockModal = async function() {
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
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
            
            await api.saveBatch(batch);
            document.body.removeChild(modal);
            refreshCockpitData(batch);
            window.showToast('Flock baseline updated!', 'success');
        });
    };

    window.showEggLossModal = async function() {
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
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

    $('btn-clear-all-batches')?.addEventListener('click', () => { window.clearAllBatchesUI(); });

    // ===================== INIT =====================
    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.addEventListener('focus', function() { this.select(); });
    });
    toggleRevenueFields();
    calculateFinancials();

    // Await database values and sync cache before initial dashboard render
    initDataPromise.then(() => {
        refreshDashboard();
    }).catch(err => {
        console.error('Error during data init:', err);
        refreshDashboard();
    });
} // end _initApp
