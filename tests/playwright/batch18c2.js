#!/usr/bin/env node
'use strict';

// Batch 18C.2 is finance evidence only.  It always owns a copied app, fresh
// database and loopback listener; it deliberately has no configurable target.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { classifyConsoleErrors, requiredArtifactProblem } = require('./batch18a');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_ROOT = path.resolve(APP_ROOT, '..', '..', 'evidence', 'playwright', 'batch18c2');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WORKFLOW_STATES = Object.freeze([
  Object.freeze({ key: 'default', filename: '01-default.png' }),
  Object.freeze({ key: 'filled', filename: '02-filled-not-submitted.png' }),
  Object.freeze({ key: 'submitted', filename: '03-submitted-confirmed.png' })
]);

function fail(message) { throw new Error(message); }
function expect(condition, message) { if (!condition) fail(message); }
function safeId(prefix) { return `${prefix}-${crypto.randomBytes(8).toString('hex')}`; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha256(file) { return sha256(fs.readFileSync(file)); }
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function assertSafeConfiguredOrigins(env = process.env, argv = process.argv.slice(2)) {
  if (argv.length) fail('Batch 18C.2 accepts no command-line target or arguments');
  for (const key of ['BASE_URL', 'PLAYWRIGHT_BASE_URL', 'BATCH18A_ORIGIN', 'BATCH18B1_ORIGIN', 'BATCH18B2_ORIGIN', 'BATCH18C1_ORIGIN', 'BATCH18C2_ORIGIN']) {
    const value = env[key];
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${key} must be a valid URL when set`); }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) fail(`Batch 18C.2 refuses non-loopback ${key}`);
    fail(`Batch 18C.2 owns a fresh copied app and does not accept ${key}`);
  }
}

function excludedCopyPath(source) {
  return ['.git', '.env', 'data', 'evidence'].includes(path.basename(source));
}

function excludedDigestPath(source) {
  // Dependencies are copied only so the disposable server can run; they are
  // not app source and would make the source-attestation report needlessly
  // enormous. Runtime state is excluded by the same rule as the app copy.
  return excludedCopyPath(source) || path.basename(source) === 'node_modules';
}

function copyIsolatedApp(targetRoot) {
  fs.cpSync(APP_ROOT, targetRoot, { recursive: true, filter: source => !excludedCopyPath(source) });
}

// Hash paths and content in bytewise lexical order.  This is recorded before
// the server starts, before a copied app can create its disposable database.
function sourceTreeDigest(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (excludedDigestPath(absolute)) continue;
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ path: relative, sha256: fileSha256(absolute), bytes: fs.statSync(absolute).size });
      else if (entry.isSymbolicLink()) files.push({ path: relative, sha256: sha256(`symlink:${fs.readlinkSync(absolute)}`), bytes: 0, symlink: true });
      else fail(`Copied app contains unsupported source-tree entry: ${relative}`);
    }
  };
  visit(root);
  const digest = sha256(files.map(file => `${file.path}\u0000${file.bytes}\u0000${file.sha256}\n`).join(''));
  return { algorithm: 'sha256', digest, file_count: files.length };
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startDisposableServer(appDir, port, sessionSecret, setupPassword) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1',
      SESSION_SECRET: sessionSecret, E2E_TEST_PASSWORD: setupPassword,
      DATABASE_PATH: path.join(appDir, 'data', 'poultry_dss.db')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = `${output}${chunk}`.slice(-12000); });
  return { child, getOutput: () => output };
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail('Disposable app exited before its health check');
    try {
      const response = await fetch(`${origin}/api/healthz`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch (_) { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail('Timed out waiting for disposable app health');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function api(page, pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      method: options.method || 'GET', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { non_json: true, text }; }
    return { status: response.status, body };
  }, { pathname, options });
}

function attachGuards(page, origin) {
  const state = { pageErrors: [], consoleErrors: [], unexpectedResponses: [] };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() < 400 || response.status() >= 600) return;
    try {
      const url = new URL(response.url());
      if (url.origin === origin) state.unexpectedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    } catch (_) { /* non-URL responses are irrelevant */ }
  });
  return state;
}

async function setupFirstRun(page, origin, username, password) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#setup-username').fill(username);
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(password);
  await page.locator('#setup-submit').click();
  await page.locator('#auth-overlay').waitFor({ state: 'detached' });
  await page.locator('#nav-dashboard').waitFor({ state: 'visible' });
}

async function login(page, origin, username, password) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-username').waitFor({ state: 'visible' });
  await page.locator('#auth-username').fill(username);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await page.locator('#auth-overlay').waitFor({ state: 'detached' });
  await page.locator('#nav-dashboard').waitFor({ state: 'visible' });
}

async function selectNav(page, navId, viewId) {
  await page.locator(`#nav-${navId}`).click();
  const view = page.locator(`#view-${viewId}`);
  await view.waitFor({ state: 'visible' });
  expect(await view.evaluate(element => element.classList.contains('active')), `Expected ${viewId} view to be active`);
}

function workflowSlug(name) { return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(); }
function expectedScreenshotRelativePaths(workflowName) {
  const slug = workflowSlug(workflowName);
  return WORKFLOW_STATES.map(state => path.join('screenshots', slug, state.filename));
}

async function captureScreenshot(page, file, target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await (target || page).screenshot({ path: file, ...(target ? { animations: 'disabled' } : { fullPage: true, animations: 'disabled' }) });
}

function validateScreenshots(runDir, workflowName, captured) {
  const expected = expectedScreenshotRelativePaths(workflowName);
  if (JSON.stringify(captured) !== JSON.stringify(expected)) return `expected ordered screenshots ${JSON.stringify(expected)}, got ${JSON.stringify(captured)}`;
  for (const relative of expected) {
    const problem = requiredArtifactProblem('screenshot', path.join(runDir, relative));
    if (problem) return problem;
  }
  if (new Set(expected.map(relative => fileSha256(path.join(runDir, relative)))).size !== expected.length) {
    return 'default, filled, and submitted screenshots must not share a SHA-256 hash';
  }
  return null;
}

async function runWorkflow(browser, runDir, origin, workflowName, body, results) {
  const slug = workflowSlug(workflowName);
  const mediaDir = path.join(runDir, 'media', slug);
  fs.mkdirSync(mediaDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: mediaDir, size: { width: 1280, height: 720 } } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const video = page.video();
  const guard = attachGuards(page, origin);
  const expected = expectedScreenshotRelativePaths(workflowName);
  const captured = [];
  const started = Date.now();
  let status = 'passed'; let error = null; let readback = null;
  const capture = async (stateKey, target = null) => {
    const next = WORKFLOW_STATES[captured.length];
    expect(next?.key === stateKey, `Expected ${next?.key || 'no'} screenshot state, got ${stateKey}`);
    await captureScreenshot(page, path.join(runDir, expected[captured.length]), target);
    captured.push(expected[captured.length]);
  };
  try {
    readback = await body({ page, capture, callApi: (pathname, options) => api(page, pathname, options) });
    expect(guard.pageErrors.length === 0, `Uncaught page errors: ${guard.pageErrors.join(' | ')}`);
    expect(guard.unexpectedResponses.length === 0, `Unexpected same-origin HTTP errors: ${guard.unexpectedResponses.join(' | ')}`);
    const consoleClassification = classifyConsoleErrors(guard.consoleErrors, []);
    expect(consoleClassification.unexpected.length === 0, `Unexpected console errors: ${consoleClassification.unexpected.join(' | ')}`);
  } catch (caught) { status = 'failed'; error = caught?.message || String(caught); }
  const evidenceErrors = [];
  if (readback === null || readback === undefined) evidenceErrors.push('workflow did not return durable readback evidence');
  const screenshotProblem = validateScreenshots(runDir, workflowName, captured);
  if (screenshotProblem) evidenceErrors.push(screenshotProblem);
  const trace = path.join(runDir, 'traces', `${slug}.zip`);
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  try { await context.tracing.stop({ path: trace }); } catch (caught) { evidenceErrors.push(`trace capture failed: ${caught.message || String(caught)}`); }
  try { await context.close(); } catch (caught) { evidenceErrors.push(`browser context/video finalization failed: ${caught.message || String(caught)}`); }
  let videoPath = null;
  try {
    videoPath = path.join(runDir, 'videos', `${slug}.webm`);
    fs.mkdirSync(path.dirname(videoPath), { recursive: true });
    fs.renameSync(await video.path(), videoPath);
  } catch (caught) { evidenceErrors.push(`video capture/path failed: ${caught.message || String(caught)}`); }
  for (const [label, file] of [['trace', trace], ['video', videoPath]]) {
    const problem = requiredArtifactProblem(label, file); if (problem) evidenceErrors.push(problem);
  }
  if (evidenceErrors.length) { status = 'failed'; error = [error, `Evidence gate failed: ${evidenceErrors.join(' | ')}`].filter(Boolean).join(' | '); }
  const result = {
    name: workflowName, status, duration_ms: Date.now() - started, error, screenshots: screenshotProblem ? [] : expected,
    writable: true, trace: requiredArtifactProblem('trace', trace) ? null : path.relative(runDir, trace),
    video: requiredArtifactProblem('video', videoPath) ? null : path.relative(runDir, videoPath), readback,
    page_errors: guard.pageErrors, console_errors: guard.consoleErrors, unexpected_responses: guard.unexpectedResponses
  };
  results.push(result);
  if (status !== 'passed') fail(`${workflowName}: ${error}`);
}

function rejectionAssertion(paymentImport, reviewNote, reviewerUserId) {
  assert.deepEqual(
    [paymentImport.status, paymentImport.review_notes, paymentImport.reviewer_user_id, paymentImport.customer_id, paymentImport.created_account_event_id],
    ['rejected', reviewNote, reviewerUserId, null, null],
    'Rejected evidence must retain its reviewer attribution and must not create a customer-account event'
  );
}

function writeEvidence(runDir, results, startedAt, origin, copiedAppDigest) {
  const completedAt = new Date().toISOString();
  const payload = {
    batch: '18C.2', scope: 'disposable finance evidence: manual clean M-Pesa import and explicit admin rejection with no accounting side effects',
    started_at: startedAt, completed_at: completedAt, origin, disposable: true,
    copied_app_source_tree: copiedAppDigest, screenshot_contract: WORKFLOW_STATES, cases: results,
    totals: { total: results.length, passed: results.filter(row => row.status === 'passed').length, failed: results.filter(row => row.status !== 'passed').length }
  };
  fs.writeFileSync(path.join(runDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  const rows = results.map(result => `<tr><td>${escapeHtml(result.name)}</td><td>${escapeHtml(result.status)}</td><td>${result.duration_ms}</td><td>${result.error ? escapeHtml(result.error) : ''}</td><td>${result.screenshots.map((file, index) => `<a href="${escapeHtml(file)}">${WORKFLOW_STATES[index].key}</a>`).join(' · ')} · <a href="${escapeHtml(result.trace)}">trace</a> · <a href="${escapeHtml(result.video)}">video</a></td></tr>`).join('');
  fs.writeFileSync(path.join(runDir, 'report.html'), '<!doctype html><meta charset="utf-8"><title>Batch 18C.2</title><h1>Batch 18C.2 isolated finance evidence</h1>'
    + `<p>Disposable loopback app: ${escapeHtml(origin)}</p><p>Copied-app source-tree SHA-256: <code>${escapeHtml(copiedAppDigest.digest)}</code> (${copiedAppDigest.file_count} files), captured before server start.</p>`
    + '<p>Each workflow records default, filled, and submitted UI states; exact pre-submit API state; expected POST status; immediate readback; and readback after reload. Rejection retains its reviewer attribution and creates no customer-account event or ledger accounting.</p>'
    + '<table border="1"><thead><tr><th>Workflow</th><th>Status</th><th>ms</th><th>Error</th><th>Evidence</th></tr></thead><tbody>' + rows + '</tbody></table>');
  const files = [];
  const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const item = path.join(directory, entry.name); if (entry.isDirectory()) visit(item); else if (entry.name !== 'evidence-manifest.json') files.push(item); } };
  visit(runDir);
  const manifest = { generated_at: completedAt, copied_app_source_tree: copiedAppDigest, files: files.sort().map(file => ({ path: path.relative(runDir, file), bytes: fs.statSync(file).size, sha256: fileSha256(file) })) };
  fs.writeFileSync(path.join(runDir, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return payload;
}

async function main() {
  assertSafeConfiguredOrigins();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeId('run')}`;
  const runDir = path.join(EVIDENCE_ROOT, runId);
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-b18c2-'));
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const owner = { username: safeId('owner'), password: `${safeId('Pw')}Aa9!` };
  const receiptCode = `C2R${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const amountMinor = 125050;
  const sms = `${receiptCode} Confirmed. You have received Ksh1,250.50 from C2 REVIEW TEST 0712345678 on 6/9/26 at 10:30 AM. New M-PESA balance is Ksh9,999.`;
  const reviewNote = 'No matching farm order.';
  const results = [];
  const startedAt = new Date().toISOString();
  let serverProc; let serverChild; let browser; let copiedAppDigest;
  let paymentImport = null; let ownerUser = null;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    copyIsolatedApp(appDir);
    copiedAppDigest = sourceTreeDigest(appDir);
    fs.writeFileSync(path.join(runDir, 'copied-app-source-tree.json'), `${JSON.stringify(copiedAppDigest, null, 2)}\n`);
    serverProc = startDisposableServer(appDir, port, safeId('session'), owner.password);
    serverChild = serverProc.child;
    await waitForHealth(origin, serverChild);
    browser = await chromium.launch({ headless: true });
    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    await setupFirstRun(setupPage, origin, owner.username, owner.password);
    await setupContext.close();

    await runWorkflow(browser, runDir, origin, '01 payment inbox manual import', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await selectNav(page, 'payment-inbox', 'payment-inbox');
      const form = page.locator('#payment-inbox-manual-form');
      await form.waitFor({ state: 'visible' });
      const before = await callApi('/api/payment-imports?limit=25&offset=0');
      expect(before.status === 200 && Array.isArray(before.body?.items) && before.body.items.length === 0, 'Manual import must start with an empty inbox');
      await capture('default', form);
      await page.locator('#payment-inbox-manual-text').fill(sms);
      await page.locator('#payment-inbox-manual-sender').fill('M-PESA');
      await capture('filled', form);
      const write = page.waitForResponse(response => new URL(response.url()).pathname === '/api/payment-imports/manual' && response.request().method() === 'POST');
      await page.locator('#payment-inbox-manual-submit').click();
      const response = await write;
      expect(response.status() === 201, `Manual payment import POST returned ${response.status()}`);
      const writeBody = await response.json();
      paymentImport = writeBody?.payment_import;
      expect(paymentImport?.id, 'Manual import response must identify the durable import');
      await page.locator('.payment-inbox-row').filter({ hasText: receiptCode }).waitFor({ state: 'visible' });
      await capture('submitted', page.locator('#view-payment-inbox'));
      const afterSubmit = await callApi(`/api/payment-imports/${encodeURIComponent(paymentImport.id)}`);
      expect(afterSubmit.status === 200, 'Manual import immediate durable readback must succeed');
      assert.deepEqual([afterSubmit.body.status, afterSubmit.body.receipt_code, afterSubmit.body.amount_minor, afterSubmit.body.direction, afterSubmit.body.event_kind, afterSubmit.body.customer_id], ['received', receiptCode, amountMinor, 'received', 'customer_receipt', null], 'Manual import must remain clean received evidence without financial assignment');
      paymentImport = afterSubmit.body;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await selectNav(page, 'payment-inbox', 'payment-inbox');
      const afterReload = await callApi(`/api/payment-imports/${encodeURIComponent(paymentImport.id)}`);
      assert.deepEqual(afterReload.body, afterSubmit.body, 'Manual import must survive reload unchanged');
      return { pre_submit_get: before.body, expected_post: { path: '/api/payment-imports/manual', status: response.status() }, durable_after_submit: afterSubmit.body, durable_after_reload: afterReload.body };
    }, results);

    await runWorkflow(browser, runDir, origin, '02 payment inbox rejection', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await selectNav(page, 'payment-inbox', 'payment-inbox');
      const beforeImport = await callApi(`/api/payment-imports/${encodeURIComponent(paymentImport.id)}`);
      const beforeCustomers = await callApi('/api/customers');
      const beforeLedger = await callApi('/api/ledger/accounts');
      expect(beforeImport.status === 200 && beforeImport.body.status === 'received', 'Rejection pre-submit import must be received');
      expect(beforeCustomers.status === 200 && Array.isArray(beforeCustomers.body) && beforeCustomers.body.length === 0, 'Rejection must begin with no customer-account candidates');
      expect(beforeLedger.status === 200 && Array.isArray(beforeLedger.body), 'Rejection pre-submit ledger readback must succeed');
      ownerUser = (await callApi('/api/auth/me')).body?.user;
      expect(ownerUser?.id, 'Authenticated reviewer identity must be available before rejection');
      const row = page.locator('.payment-inbox-row').filter({ hasText: receiptCode });
      await row.waitFor({ state: 'visible' });
      await row.click();
      const rejectionForm = page.locator('.payment-inbox-decision-form').filter({ hasText: 'Reject evidence' });
      await rejectionForm.waitFor({ state: 'visible' });
      await capture('default', rejectionForm);
      await rejectionForm.locator('textarea').fill(reviewNote);
      const rejectionConfirmation = rejectionForm.getByRole('checkbox', { name: /I confirm this evidence should be rejected/i });
      await rejectionConfirmation.check();
      await capture('filled', rejectionForm);
      const rejectionSubmit = rejectionForm.getByRole('button', { name: /^Reject evidence$/i });
      expect(await rejectionSubmit.isEnabled(), 'Rejection submit must be enabled after explicit confirmation');
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === `/api/payment-imports/${encodeURIComponent(paymentImport.id)}/reject` && response.request().method() === 'POST'),
        rejectionSubmit.click({ timeout: 5000 })
      ]);
      expect(response.status() === 200, `Payment rejection POST returned ${response.status()}`);
      await page.locator('.payment-inbox-row').filter({ hasText: receiptCode }).waitFor({ state: 'visible' });
      await capture('submitted', page.locator('#view-payment-inbox'));
      const afterImport = await callApi(`/api/payment-imports/${encodeURIComponent(paymentImport.id)}`);
      const afterCustomers = await callApi('/api/customers');
      const afterLedger = await callApi('/api/ledger/accounts');
      expect(afterImport.status === 200 && afterCustomers.status === 200 && afterLedger.status === 200, 'Rejection immediate durable readbacks must succeed');
      rejectionAssertion(afterImport.body, reviewNote, ownerUser.id);
      assert.deepEqual(afterCustomers.body, beforeCustomers.body, 'Rejection must not create a customer account');
      assert.deepEqual(afterLedger.body, beforeLedger.body, 'Rejection must not create ledger accounting');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      const reloadImport = await callApi(`/api/payment-imports/${encodeURIComponent(paymentImport.id)}`);
      const reloadCustomers = await callApi('/api/customers');
      const reloadLedger = await callApi('/api/ledger/accounts');
      assert.deepEqual(reloadImport.body, afterImport.body, 'Rejected import must survive reload unchanged');
      assert.deepEqual(reloadCustomers.body, afterCustomers.body, 'No customer account must remain true after reload');
      assert.deepEqual(reloadLedger.body, afterLedger.body, 'No ledger accounting must remain true after reload');
      return {
        pre_submit_get: { payment_import: beforeImport.body, customers: beforeCustomers.body, ledger_accounts: beforeLedger.body },
        expected_post: { path: `/api/payment-imports/${paymentImport.id}/reject`, status: response.status() },
        durable_after_submit: { payment_import: afterImport.body, customers: afterCustomers.body, ledger_accounts: afterLedger.body },
        durable_after_reload: { payment_import: reloadImport.body, customers: reloadCustomers.body, ledger_accounts: reloadLedger.body }
      };
    }, results);
  } finally {
    if (browser) await browser.close();
    if (serverProc) { if (results.some(result => result.status !== 'passed')) process.stderr.write(`SERVER LOGS:\n${serverProc.getOutput()}\n`); await stopServer(serverChild); }
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    if (fs.existsSync(runDir)) {
      const payload = writeEvidence(runDir, results, startedAt, origin, copiedAppDigest || { algorithm: 'sha256', digest: null, file_count: 0 });
      process.stdout.write(`Batch 18C.2: ${payload.totals.passed}/${payload.totals.total} passed. Evidence: ${runDir}\n`);
    }
  }
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
}

module.exports = { main, assertSafeConfiguredOrigins, sourceTreeDigest, expectedScreenshotRelativePaths, writeEvidence, WORKFLOW_STATES, EVIDENCE_ROOT };

if (require.main === module) main().catch(error => { process.stderr.write(`Batch 18C.2 failed: ${error.message}\n`); process.exitCode = 1; });
