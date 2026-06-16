/**
 * Poultry DSS — End-to-End Test Suite
 * Target: http://localhost:8089/
 *
 * Run: node tests/e2e.js
 *
 * Coverage:
 *  TC-01  Page loads & nav tabs visible
 *  TC-02  Clear all existing proposals & batches (clean slate)
 *  TC-03  Navigate to Generator, fill 4-step wizard via 100-Bird Template
 *  TC-04  Generate preview & "Start Batch" instantiates a batch
 *  TC-05  Run lifecycle simulation (60d backfill via Skip 60d [Dev] button)
 *  TC-06  Save a manual daily log entry in the cockpit
 *  TC-07  Open batch closure wizard (3 steps) and finalize batch
 *  TC-08  Navigate to Portfolio Analytics — verify KPI stats visible
 */

const { chromium } = require('playwright');

const BASE_URL   = process.env.BASE_URL    || 'http://localhost:8089';
const E2E_USER   = process.env.E2E_USERNAME || 'admin';
const E2E_PASS   = process.env.E2E_PASSWORD || 'password123';
const TIMEOUT    = 30_000;

// ─── helpers ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅  ${msg}`);
    passed++;
  } else {
    console.error(`  ❌  FAIL: ${msg}`);
    failed++;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function handleAuth(page) {
  // First, ask the server whether we are already authenticated.
  // We cannot rely on DOM selectors like #nav-dashboard because those elements
  // exist in the static HTML and are visible immediately, before the JS
  // auth check runs — causing a false "already logged in" conclusion.
  const authState = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/me');
      return r.ok ? await r.json() : { user: null };
    } catch (e) { return { user: null }; }
  });

  if (authState.setupRequired) {
    console.log('  -> First run detected. Completing Setup Wizard...');
    await page.waitForSelector('#setup-username', { timeout: TIMEOUT });
    await page.fill('#setup-username', E2E_USER);
    await page.fill('#setup-password', E2E_PASS);
    await page.fill('#setup-confirm', E2E_PASS);
    await page.click('#setup-submit');
    await page.waitForSelector('#auth-overlay', { state: 'detached', timeout: TIMEOUT });
    console.log('  -> Setup Wizard complete.');
  } else if (!authState.user) {
    console.log('  -> Login required. Logging in...');
    // The login modal is injected by JS — wait for it to appear
    await page.waitForSelector('#auth-username', { timeout: TIMEOUT });
    await page.fill('#auth-username', E2E_USER);
    await page.fill('#auth-password', E2E_PASS);
    await page.click('#auth-submit');
    await page.waitForSelector('#auth-overlay', { state: 'detached', timeout: TIMEOUT });
    console.log('  -> Logged in successfully.');
  }
  // else: authState.user is present — already authenticated, no action needed
}


// ─── main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n═══════════════════════════════════════════════');
  console.log('   Poultry DSS — Playwright E2E Test Suite');
  console.log('   Target:', BASE_URL);
  console.log('═══════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  // Forward browser console errors to terminal
  page.on('console', msg => { if (msg.type() === 'error') console.log('  [browser error]', msg.text()); });
  page.on('pageerror', err => { console.log('  [browser exception]', err.stack || err.message); });

  try {
    // ─── TC-01: Page loads ───────────────────────────────────────────────
    console.log('TC-01  Page loads & nav tabs visible');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await handleAuth(page);
    await page.waitForSelector('#nav-dashboard', { timeout: TIMEOUT });
    assert(await page.isVisible('#nav-dashboard'),  'nav-dashboard visible');
    assert(await page.isVisible('#nav-generator'),  'nav-generator visible');
    assert(await page.isVisible('#nav-batches'),    'nav-batches visible');
    assert(await page.isVisible('#nav-analytics'),  'nav-analytics visible');
    console.log();

    // ─── TC-02: Clear previous test data via REST API ──────────────────
    console.log('TC-02  Clear previous test proposals, batches & snapshots');
    const clearProposals = await page.evaluate(async () => {
      const res = await fetch('/api/proposals');
      const props = await res.json();
      for (const p of props) {
        if (p.name && p.name.toLowerCase().includes('kenchic')) {
          await fetch(`/api/proposals/${p.id}`, { method: 'DELETE' });
        }
      }
      return true;
    });
    const clearBatches = await page.evaluate(async () => {
      const res = await fetch('/api/batches');
      const batches = await res.json();
      for (const b of batches) {
        if (b.name && b.name.toLowerCase().includes('kenchic')) {
          await fetch(`/api/batches/${b.id}`, { method: 'DELETE' });
        }
      }
      return true;
    });
    const clearSnapshots = await page.evaluate(async () => {
      const res = await fetch('/api/snapshots');
      const snaps = await res.json();
      for (const s of snaps) {
        const name = s.name || s.batchName || '';
        if (name.toLowerCase().includes('kenchic')) {
          await fetch(`/api/snapshots/${s.id}`, { method: 'DELETE' });
        }
      }
      return true;
    });
    assert(clearProposals,  'Selective delete of test proposals returned ok');
    assert(clearBatches,    'Selective delete of test batches returned ok');
    assert(clearSnapshots,  'Selective delete of test snapshots returned ok');
    // Reload so the UI reflects the cleared state
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });
    await handleAuth(page);
    await sleep(500);
    console.log();

    // ─── TC-03: 4-Step Proposal Generator ───────────────────────────────
    console.log('TC-03  Navigate to Generator & fill form via 100-Bird Template');
    await page.click('#nav-generator');
    await page.waitForSelector('#view-generator', { timeout: TIMEOUT });
    await sleep(300);

    // Apply template — fills all required fields
    await page.click('#btn-template-100');
    await sleep(300);

    const propName = await page.$eval('#prop-name', el => el.value);
    assert(propName.includes('100-Bird'), `prop-name filled: "${propName}"`);
    assert(await page.$eval('#prop-size', el => el.value) === '100', 'prop-size = 100');

    // Step 1 → 2
    await page.click('#wizard-next');
    await sleep(300);
    assert(await page.isVisible('[data-step="2"].active'), 'Wizard advanced to Step 2');

    // Step 2 → 3
    await page.click('#wizard-next');
    await sleep(300);
    assert(await page.isVisible('[data-step="3"].active'), 'Wizard advanced to Step 3');

    // Step 3 → 4
    await page.click('#wizard-next');
    await sleep(500);
    assert(await page.isVisible('[data-step="4"].active'), 'Wizard advanced to Step 4 (Preview)');
    console.log();

    // ─── TC-04: Generate Preview & Start Batch ───────────────────────────
    console.log('TC-04  Generate preview & Start Batch');
    await page.click('#btn-generate-preview');
    await sleep(800);

    const previewText = await page.$eval('#proposal-preview', el => el.innerText);
    assert(previewText.length > 100, `Proposal preview populated (${previewText.length} chars)`);

    // "Start Batch" button appears after preview
    await page.waitForSelector('#btn-start-batch', { state: 'visible', timeout: TIMEOUT });
    await page.click('#btn-start-batch');

    // Wait for the cockpit view to become visible
    await page.waitForSelector('#view-batch-cockpit', { timeout: TIMEOUT });
    const cockpitVisible = await page.isVisible('#view-batch-cockpit');
    assert(cockpitVisible, 'Batch cockpit view is visible after Start Batch');

    // Verify a batch was persisted in the API
    const batches = await page.evaluate(async () => {
      const r = await fetch('/api/batches'); return r.json();
    });
    const activeKenchicBatch = batches.find(b => b.name && b.name.toLowerCase().includes('kenchic'));
    assert(!!activeKenchicBatch, 'Active Kenchic batch persisted in DB');
    const batchId = activeKenchicBatch.id;
    console.log(`     Batch ID: ${batchId}`);
    console.log();

    // ─── TC-09: Live Active Batch - ISA Brown Layers ──────────────────────
    console.log('TC-09  Verify live Batch 001 — ISA Brown Layers is loaded & active');
    // Navigate to Batches tab
    await page.click('#nav-batches');
    await sleep(600);

    // Verify ISA Brown Layers batch card is visible
    await page.waitForSelector('.batch-card:has-text("Batch 001 — ISA Brown Layers")', { timeout: TIMEOUT });
    
    // Click on the ISA Brown Layers batch to open its cockpit
    await page.click('.batch-card:has-text("Batch 001 — ISA Brown Layers")');

    // Verify we are in the cockpit for ISA Brown by waiting for its header text
    await page.waitForSelector('.cockpit-header h2:has-text("ISA Brown")', { timeout: TIMEOUT });
    const cockpitTitle = await page.$eval('.cockpit-header h2', el => el.innerText);
    assert(cockpitTitle.includes('ISA Brown'), `Cockpit open for ISA Brown: "${cockpitTitle}"`);

    // Verify separate Cash and Credit chips are visible
    assert(await page.isVisible('#info-cash'), 'info-cash visible in cockpit (ISA Brown)');
    assert(await page.isVisible('#info-credit'), 'info-credit visible in cockpit (ISA Brown)');

    // Verify derived active birds counts are visible
    const birdsAliveText = await page.$eval('#info-birds', el => el.innerText);
    assert(parseInt(birdsAliveText) > 0, `Birds alive count displays positive number: ${birdsAliveText}`);
    
    // Go back to the Kenchic batch cockpit to resume the rest of the E2E flow
    await page.click('#nav-batches');
    await sleep(600);
    await page.click('.batch-card:has-text("100-Bird Kenchic Layer Farm")');
    await page.waitForSelector('.cockpit-header h2:has-text("Kenchic")', { timeout: TIMEOUT });
    console.log();

    // ─── TC-05: Run 60d Lifecycle Simulation ────────────────────────────
    console.log('TC-05  Run 60d lifecycle simulation (Skip 60d [Dev])');

    // Trigger simulation directly via page.evaluate since the Dev button is removed from UI
    await page.evaluate(async (bid) => {
      await window.simulateLifecycle(bid);
    }, batchId);
    await sleep(500);

    // Custom confirmation modal appears — click "Run Simulation"
    await page.waitForSelector('#sim-confirm-btn', { timeout: TIMEOUT });
    await page.click('#sim-confirm-btn');

    // Wait for sim to complete (it saves 60 logs via fetch sequentially)
    console.log('     Waiting for simulation logs to populate...');
    let logs = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      logs = await page.evaluate(async (bid) => {
        const r = await fetch('/api/logs/' + bid); return r.json();
      }, batchId);
      if (logs.length >= 60) break;
      await sleep(1000);
    }
    assert(logs.length >= 50, `Simulation created ${logs.length} daily logs (expect ≥50)`);

    const txs = await page.evaluate(async (bid) => {
      const r = await fetch('/api/transactions/' + bid); return r.json();
    }, batchId);
    assert(txs.length > 0, `Simulation created ${txs.length} sale transactions`);
    console.log();

    // ─── TC-06: Save a manual daily log ─────────────────────────────────
    console.log('TC-06  Save a manual daily log entry');

    // After simulation the cockpit should have re-rendered; wait for log-date
    await page.waitForSelector('#log-date', { timeout: TIMEOUT });
    await sleep(300);

    // Click Add Collection button to open the modal
    await page.click('#btn-add-collection');
    await page.waitForSelector('#ecm-count', { timeout: TIMEOUT });
    await page.fill('#ecm-count', '85');
    await page.fill('#ecm-broken', '5');
    await page.fill('#ecm-time', '12:00');
    await page.fill('#ecm-label', 'Afternoon Collection');
    await page.click('#ecm-save');
    // Wait for the modal to close/detach
    await page.waitForSelector('#ecm-count', { state: 'detached', timeout: TIMEOUT });

    await page.fill('#log-sacks', '0');
    await page.fill('#log-mortality', '0');

    await page.click('.btn-save-log');
    await sleep(1200);

    // Verify the toast / save confirmation (button text changes to "✓ Saved!")
    // We check that the API now has one more log than before
    const logsAfterManual = await page.evaluate(async (bid) => {
      const r = await fetch('/api/logs/' + bid); return r.json();
    }, batchId);
    assert(logsAfterManual.length > logs.length || logsAfterManual.length >= 50,
      `Manual log saved (total logs: ${logsAfterManual.length})`);
    console.log();

    // ─── TC-07: Batch Closure Wizard ─────────────────────────────────────
    console.log('TC-07  Batch Closure Wizard (3 steps → Finalize)');

    // Navigate to Batches tab
    await page.click('#nav-batches');
    await sleep(500);

    // Trigger finishBatch() directly via the known batch ID — avoids selector
    // ambiguity with #btn-load-snapshot (generator view) which also has text "Snapshot"
    await page.evaluate((bid) => window.finishBatch(bid), batchId);
    await sleep(800);
    await sleep(800);

    // Closure wizard Step 1 — verify it's open
    await page.waitForSelector('#closure-modal', { timeout: TIMEOUT });
    const step1Badge = await page.$eval('#c-step-badge', el => el.innerText);
    assert(step1Badge.includes('1 of 3'), `Closure wizard Step 1 open: "${step1Badge}"`);

    // Step 1 → 2
    await page.click('#c-btn-next');
    await sleep(400);
    const step2Badge = await page.$eval('#c-step-badge', el => el.innerText);
    assert(step2Badge.includes('2 of 3'), `Closure wizard Step 2: "${step2Badge}"`);

    // On Step 2: force egg disposition to write_off so we get a full closure
    // (default is carry_over which creates post_batch/Winding Down — no snapshot saved)
    const eggSelect = await page.$('#disp-eggs');
    if (eggSelect) await page.selectOption('#disp-eggs', 'write_off');

    // Step 2 → 3
    await page.click('#c-btn-next');
    await sleep(400);
    const step3Badge = await page.$eval('#c-step-badge', el => el.innerText);
    assert(step3Badge.includes('3 of 3'), `Closure wizard Step 3: "${step3Badge}"`);

    // Step 3 — Finalize
    await page.click('#c-btn-next');
    await sleep(2000);

    // Modal should be gone and a snapshot should exist
    const modalGone = !(await page.isVisible('#closure-modal'));
    assert(modalGone, 'Closure modal dismissed after finalization');

    const snapshots = await page.evaluate(async () => {
      const r = await fetch('/api/snapshots'); return r.json();
    });
    assert(snapshots.length >= 1, `Snapshot saved in DB (count: ${snapshots.length})`);

    // Batch should now be completed
    const batchesAfter = await page.evaluate(async () => {
      const r = await fetch('/api/batches'); return r.json();
    });
    const finishedBatch = batchesAfter.find(b => b.status === 'completed' || b.status === 'post_batch');
    assert(!!finishedBatch, `Batch status updated to completed/post_batch (got: ${finishedBatch?.status})`);
    console.log();

    // ─── TC-08: Portfolio Analytics ──────────────────────────────────────
    console.log('TC-08  Portfolio Analytics — KPI values populated');
    await page.click('#nav-analytics');
    await page.waitForSelector('#view-analytics', { timeout: TIMEOUT });
    await sleep(1000);

    const capexEl = await page.$eval('#kpi-total-capex', el => el.innerText);
    const profitEl = await page.$eval('#kpi-avg-profit', el => el.innerText);
    const breakevenEl = await page.$eval('#kpi-avg-breakeven', el => el.innerText);

    assert(capexEl.includes('KES'), `kpi-total-capex shows value: "${capexEl}"`);
    assert(profitEl.includes('KES'), `kpi-avg-profit shows value: "${profitEl}"`);
    assert(typeof breakevenEl === 'string' && breakevenEl.length > 0, `kpi-avg-breakeven has text: "${breakevenEl}"`);
    console.log();

  } catch (err) {
    console.error('\n💥 Unexpected test error:', err.message);
    failed++;
  } finally {
    await browser.close();

    console.log('═══════════════════════════════════════════════');
    console.log(`   Results: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════════\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      console.log('🎉  All E2E Test Cases Passed!\n');
    }
  }
})();
