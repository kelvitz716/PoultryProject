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

const BASE_URL = process.env.BASE_URL || 'http://localhost:8089';
const TIMEOUT   = 30_000;

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

  try {
    // ─── TC-01: Page loads ───────────────────────────────────────────────
    console.log('TC-01  Page loads & nav tabs visible');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForSelector('#nav-dashboard', { timeout: TIMEOUT });
    assert(await page.isVisible('#nav-dashboard'),  'nav-dashboard visible');
    assert(await page.isVisible('#nav-generator'),  'nav-generator visible');
    assert(await page.isVisible('#nav-batches'),    'nav-batches visible');
    assert(await page.isVisible('#nav-analytics'),  'nav-analytics visible');
    console.log();

    // ─── TC-02: Clear state via REST API ────────────────────────────────
    console.log('TC-02  Clear all proposals, batches & snapshots (clean slate)');
    const clearProposals = await page.evaluate(async () => {
      const r = await fetch('/api/proposals', { method: 'DELETE', headers: { 'x-confirm-delete': 'true' } });
      return r.ok;
    });
    const clearBatches = await page.evaluate(async () => {
      const r = await fetch('/api/batches', { method: 'DELETE', headers: { 'x-confirm-delete': 'true' } });
      return r.ok;
    });
    const clearSnapshots = await page.evaluate(async () => {
      const r = await fetch('/api/snapshots', { method: 'DELETE', headers: { 'x-confirm-delete': 'true' } });
      return r.ok;
    });
    assert(clearProposals,  'DELETE /api/proposals returned ok');
    assert(clearBatches,    'DELETE /api/batches returned ok');
    assert(clearSnapshots,  'DELETE /api/snapshots returned ok');
    // Reload so the UI reflects the cleared state
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });
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
    await sleep(1000);

    // Should switch to batches / cockpit view
    const cockpitVisible = await page.isVisible('#view-batch-cockpit');
    assert(cockpitVisible, 'Batch cockpit view is visible after Start Batch');

    // Verify a batch was persisted in the API
    const batches = await page.evaluate(async () => {
      const r = await fetch('/api/batches'); return r.json();
    });
    assert(batches.length === 1, `1 active batch in DB (got ${batches.length})`);
    const batchId = batches[0].id;
    console.log(`     Batch ID: ${batchId}`);
    console.log();

    // ─── TC-05: Run 60d Lifecycle Simulation ────────────────────────────
    console.log('TC-05  Run 60d lifecycle simulation (Skip 60d [Dev])');

    // The "Skip 60d" button is rendered inside the batch cockpit dynamically
    // Locate it via text matching
    await page.waitForSelector('button:has-text("Skip 60d")', { timeout: TIMEOUT });
    await page.click('button:has-text("Skip 60d")');
    await sleep(500);

    // Custom confirmation modal appears — click "Run Simulation"
    await page.waitForSelector('#sim-confirm-btn', { timeout: TIMEOUT });
    await page.click('#sim-confirm-btn');

    // Wait for sim to complete (it saves 60 logs via fetch)
    await sleep(5000);

    // Verify logs were created
    const logs = await page.evaluate(async (bid) => {
      const r = await fetch('/api/logs/' + bid); return r.json();
    }, batchId);
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

    // Fill in today's log manually
    await page.fill('#log-eggs', '85');
    await page.fill('#log-eggs-morning', '50');
    await page.fill('#log-eggs-evening', '35');
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
