#!/usr/bin/env node
'use strict';

// Batch 18B2 owns a disposable copy, database and loopback server. It does not
// accept a target URL or reuse configured farm data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const {
  classifyConsoleErrors,
  requiredArtifactProblem
} = require('./batch18a');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_ROOT = path.resolve(APP_ROOT, '..', '..', 'evidence', 'playwright', 'batch18b2');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WORKFLOW_STATES = Object.freeze([
  Object.freeze({ key: 'default', filename: '01-loaded.png' }),
  Object.freeze({ key: 'filled', filename: '02-draft.png' }),
  Object.freeze({ key: 'submitted', filename: '03-submitted.png' })
]);

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function safeId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function assertSafeConfiguredOrigins(env = process.env, argv = process.argv.slice(2)) {
  if (argv.length) fail('Batch 18B2 accepts no command-line target or arguments');
  for (const key of ['BASE_URL', 'PLAYWRIGHT_BASE_URL', 'BATCH18A_ORIGIN', 'BATCH18B2_ORIGIN']) {
    const value = env[key];
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${key} must be a valid URL when set`); }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) fail(`Batch 18B2 refuses non-loopback ${key}`);
    fail(`Batch 18B2 owns a fresh copied app and does not accept ${key}`);
  }
}

function copyTreeIsolated(sourceRoot, targetRoot) {
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      return !['.git', '.env', 'data', 'evidence'].includes(name);
    }
  });
}

function copyIsolatedApp(targetRoot) {
  copyTreeIsolated(APP_ROOT, targetRoot);
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
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      SESSION_SECRET: sessionSecret,
      E2E_TEST_PASSWORD: setupPassword,
      DATABASE_PATH: path.join(appDir, 'data', 'poultry_dss.db')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output = `${output}${chunk}`.slice(-12_000); });
  }
  return { child, getOutput: () => output };
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail('Disposable app exited before its health check');
    try {
      const response = await fetch(`${origin}/api/healthz`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* listener is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail('Timed out waiting for disposable app health');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function api(page, pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { nonJson: true, text }; }
    return { status: response.status, body };
  }, { pathname, options });
}

function attachGuards(page, origin) {
  const state = { pageErrors: [], consoleErrors: [], unexpectedResponses: [] };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() < 400 || response.status() >= 600) return;
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin === origin) {
      state.unexpectedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    }
  });
  return state;
}

async function collectApiRequestsDuring(page, origin, action) {
  const requests = [];
  const record = request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin === origin && url.pathname.startsWith('/api/')) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  };

  page.on('request', record);
  try {
    const result = await action();
    await page.waitForLoadState('networkidle');
    return { result, requests };
  } finally {
    page.off('request', record);
  }
}

async function setupFirstRun(page, origin, username, password) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#setup-username').waitFor({ state: 'visible' });
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

async function openBatchThroughUi(page, batchName) {
  await selectNav(page, 'batches', 'batches');
  const card = page.locator('.batch-card').filter({ hasText: batchName });
  await card.waitFor({ state: 'visible' });
  await card.click();
  await page.locator('#view-batch-cockpit').waitFor({ state: 'visible' });
  await page.locator('.log-form-card').waitFor({ state: 'visible' });
}

function workflowSlug(name) {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function expectedScreenshotRelativePaths(workflowName) {
  const slug = workflowSlug(workflowName);
  return WORKFLOW_STATES.map(state => path.join('screenshots', slug, state.filename));
}

function expectedSafetyScreenshotRelativePath(workflowName) {
  return path.join('screenshots', workflowSlug(workflowName), '01-safety-guard.png');
}

function validateThreeStateScreenshots(runDir, workflowName, captured = null) {
  const expectedPaths = expectedScreenshotRelativePaths(workflowName);
  const screenshotDir = path.join(runDir, 'screenshots', workflowSlug(workflowName));
  let actualPaths = [];
  if (fs.existsSync(screenshotDir)) {
    actualPaths = fs.readdirSync(screenshotDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join('screenshots', workflowSlug(workflowName), entry.name))
      .sort();
  }
  if (captured && JSON.stringify(captured) !== JSON.stringify(expectedPaths)) {
    return `screenshot states were captured out of order or more than once: ${JSON.stringify(captured)}`;
  }
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    return `expected exactly three primary screenshots ${JSON.stringify(expectedPaths)}, found ${JSON.stringify(actualPaths)}`;
  }
  for (const relative of expectedPaths) {
    const problem = requiredArtifactProblem('screenshot', path.join(runDir, relative));
    if (problem) return problem;
  }
  const hashes = expectedPaths.map(relative => sha256(path.join(runDir, relative)));
  if (new Set(hashes).size !== hashes.length) {
    return 'writable workflow primary screenshots must not share a SHA-256 hash';
  }
  return null;
}

function validateWorkflowEvidence({ runDir, workflowName, captured, readback, writable }) {
  if (!writable) {
    if (readback === null || readback === undefined) {
      return 'non-writable safety case must return its safety observation';
    }
    const expected = expectedSafetyScreenshotRelativePath(workflowName);
    if (JSON.stringify(captured) !== JSON.stringify([expected])) {
      return `non-writable safety case must capture exactly one truthful safety screenshot: ${JSON.stringify(captured)}`;
    }
    return requiredArtifactProblem('screenshot', path.join(runDir, expected));
  }
  if (readback === null || readback === undefined) {
    return 'writable workflow must return durable API readback evidence';
  }
  return validateThreeStateScreenshots(runDir, workflowName, captured);
}

function capturedEvidenceForWorkflow({ writable, captured, safetyScreenshots }) {
  return writable ? captured : safetyScreenshots;
}

function stagingModuleCounts(summary) {
  return {
    eggs: summary?.eggs?.collections?.length || 0,
    feed: summary?.feed?.events?.length || 0,
    mortality: summary?.mortality?.events?.length || 0,
    sensors: summary?.sensors?.sample_count || 0,
    gases: summary?.gases?.length || 0,
    notes: summary?.notes?.length || 0
  };
}

async function captureScreenshot(page, file, target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (target) {
    await target.screenshot({ path: file, animations: 'disabled' });
  } else {
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  }
}

async function runWorkflow(browser, runDir, origin, workflowName, body, results, { writable = true } = {}) {
  const slug = workflowSlug(workflowName);
  const mediaDir = path.join(runDir, 'media', slug);
  fs.mkdirSync(mediaDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: mediaDir, size: { width: 1280, height: 720 } }
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const video = page.video();
  const guard = attachGuards(page, origin);
  const expectedPaths = expectedScreenshotRelativePaths(workflowName);
  const captured = [];
  const safetyScreenshots = [];
  const started = Date.now();
  let status = 'passed';
  let error = null;
  let readback = null;
  const evidenceErrors = [];

  const capture = async (stateKey, target = null) => {
    expect(writable, 'Non-writable safety cases cannot capture writable workflow screenshot states');
    const expectedState = WORKFLOW_STATES[captured.length];
    expect(expectedState && expectedState.key === stateKey,
      `Expected screenshot state ${expectedState?.key || 'none'}, received ${stateKey}`);
    const relative = expectedPaths[captured.length];
    await captureScreenshot(page, path.join(runDir, relative), target);
    captured.push(relative);
  };

  const captureSafety = async (target = null) => {
    expect(!writable, 'Writable workflows must use the three-state screenshot contract');
    expect(safetyScreenshots.length === 0, 'Safety case may capture only one truthful safety screenshot');
    const relative = expectedSafetyScreenshotRelativePath(workflowName);
    await captureScreenshot(page, path.join(runDir, relative), target);
    const problem = requiredArtifactProblem('screenshot', path.join(runDir, relative));
    expect(!problem, problem);
    safetyScreenshots.push(relative);
  };

  try {
    readback = await body({
      page,
      capture,
      captureSafety,
      callApi: (pathname, options) => api(page, pathname, options)
    });
    expect(guard.pageErrors.length === 0, `Uncaught page errors: ${guard.pageErrors.join(' | ')}`);
    expect(guard.unexpectedResponses.length === 0,
      `Unexpected same-origin HTTP errors: ${guard.unexpectedResponses.join(' | ')}`);
    const consoleClassification = classifyConsoleErrors(guard.consoleErrors, []);
    expect(consoleClassification.unexpected.length === 0,
      `Unexpected console errors: ${consoleClassification.unexpected.join(' | ')}`);
  } catch (caught) {
    status = 'failed';
    error = caught?.message || String(caught);
  }

  const screenshotProblem = validateWorkflowEvidence({
    runDir,
    workflowName,
    captured: capturedEvidenceForWorkflow({ writable, captured, safetyScreenshots }),
    readback,
    writable
  });
  if (screenshotProblem) evidenceErrors.push(screenshotProblem);

  const trace = path.join(runDir, 'traces', `${slug}.zip`);
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  try {
    await context.tracing.stop({ path: trace });
  } catch (caught) {
    evidenceErrors.push(`trace capture failed: ${caught.message || String(caught)}`);
  }
  try {
    await context.close();
  } catch (caught) {
    evidenceErrors.push(`browser context/video finalization failed: ${caught.message || String(caught)}`);
  }

  let videoPath = null;
  if (video) {
    try {
      const temporaryVideo = await video.path();
      videoPath = path.join(runDir, 'videos', `${slug}.webm`);
      fs.mkdirSync(path.dirname(videoPath), { recursive: true });
      fs.renameSync(temporaryVideo, videoPath);
    } catch (caught) {
      evidenceErrors.push(`video capture/path failed: ${caught.message || String(caught)}`);
    }
  } else {
    evidenceErrors.push('video capture was not initialized');
  }

  for (const [label, file] of [['trace', trace], ['video', videoPath]]) {
    const problem = requiredArtifactProblem(label, file);
    if (problem) evidenceErrors.push(problem);
  }
  if (evidenceErrors.length) {
    status = 'failed';
    error = [error, `Evidence gate failed: ${evidenceErrors.join(' | ')}`].filter(Boolean).join(' | ');
  }

  const result = {
    name: workflowName,
    status,
    duration_ms: Date.now() - started,
    error,
    screenshots: writable && !screenshotProblem ? expectedPaths : [],
    safety_screenshots: safetyScreenshots,
    writable,
    trace: requiredArtifactProblem('trace', trace) ? null : path.relative(runDir, trace),
    video: requiredArtifactProblem('video', videoPath) ? null : path.relative(runDir, videoPath),
    readback,
    page_errors: guard.pageErrors,
    console_errors: guard.consoleErrors,
    unexpected_responses: guard.unexpectedResponses
  };
  results.push(result);
  if (status !== 'passed') fail(`${workflowName}: ${error}`);
}

function writeEvidence(runDir, results, startedAt, origin) {
  const completedAt = new Date().toISOString();
  const payload = {
    batch: '18B2',
    scope: 'disposable operational evidence: batch setup, inventory adjustment, purchase, sale, and reviewed batch closure',
    started_at: startedAt,
    completed_at: completedAt,
    origin,
    disposable: true,
    screenshot_contract: WORKFLOW_STATES,
    cases: results,
    totals: {
      total: results.length,
      passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status !== 'passed').length
    }
  };
  fs.writeFileSync(path.join(runDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  const rows = results.map(result => {
    const screenshots = result.screenshots.map((file, index) =>
      `<a href="${escapeHtml(file)}">${escapeHtml(WORKFLOW_STATES[index].key)}</a>`).join(' · ');
    const safety = result.safety_screenshots.map(file =>
      `<a href="${escapeHtml(file)}">safety guard</a>`).join(' · ');
    const trace = result.trace ? `<a href="${escapeHtml(result.trace)}">trace</a>` : 'trace: missing';
    const video = result.video ? `<a href="${escapeHtml(result.video)}">video</a>` : 'video: missing';
    return `<tr><td>${escapeHtml(result.name)}</td><td>${escapeHtml(result.status)}</td>`
      + `<td>${result.duration_ms}</td><td>${result.error ? escapeHtml(result.error) : ''}</td>`
      + `<td>${screenshots || safety} · ${trace} · ${video}</td></tr>`;
  }).join('');
  fs.writeFileSync(path.join(runDir, 'report.html'), '<!doctype html><meta charset="utf-8">'
    + '<title>Batch 18B2</title><h1>Batch 18B2 isolated browser evidence</h1>'
    + `<p>Disposable loopback app: ${escapeHtml(origin)}</p>`
    + '<p>Each writable workflow has default, filled-not-submitted, and submitted-confirmed screenshots, '
    + 'an exact pre-submit API state, expected POST status, and durable API readback before and after reload. '
    + 'The reviewed closure flow is a writable workflow with server-owned reviewer provenance and durable batch readback.</p>'
    + '<table border="1"><thead><tr><th>Workflow</th><th>Status</th><th>ms</th><th>Error</th><th>Evidence</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`);

  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.name !== 'evidence-manifest.json') files.push(item);
    }
  };
  visit(runDir);
  const manifest = files.sort().map(file => ({
    path: path.relative(runDir, file),
    bytes: fs.statSync(file).size,
    sha256: sha256(file)
  }));
  fs.writeFileSync(path.join(runDir, 'evidence-manifest.json'),
    `${JSON.stringify({ generated_at: completedAt, files: manifest }, null, 2)}\n`);
  return payload;
}

async function main() {
  assertSafeConfiguredOrigins();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeId('run')}`;
  const runDir = path.join(EVIDENCE_ROOT, runId);
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-b18b2-'));
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const owner = { username: safeId('owner'), password: `${safeId('Pw')}Aa9!` };
  const batchData = {
    name: `E2E Layer ${crypto.randomBytes(4).toString('hex')}`,
    owner: 'Disposable Test Owner',
    location: 'Loopback Test Farm, Kenya',
    size: '120',
    feedStrategy: 'Measured commercial layer ration with daily weigh-back.',
    waterStrategy: 'Nipple line with twice-daily leak and flow inspection.',
    housingCost: '125000',
    equipmentCost: '36000',
    eggPrice: '18',
    eggsMonth: '26'
  };
  const results = [];
  const startedAt = new Date().toISOString();
  let serverProc;
  let serverChild;
  let browser;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    copyIsolatedApp(appDir);
    serverProc = startDisposableServer(appDir, port, safeId('session'), owner.password);
    serverChild = serverProc.child;
    await waitForHealth(origin, serverChild);
    browser = await chromium.launch({ headless: true });

    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    await setupFirstRun(setupPage, origin, owner.username, owner.password);
    await setupContext.close();

    let batchId = null;
    await runWorkflow(browser, runDir, origin, '01 batch setup', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await selectNav(page, 'generator', 'generator');
      await page.locator('.form-step[data-step="1"]').waitFor({ state: 'visible' });
      const before = {
        proposals: (await callApi('/api/proposals')).body,
        batches: (await callApi('/api/batches')).body
      };
      expect(before.proposals.length === 0 && before.batches.length === 0,
        'Disposable batch setup must start with no proposals or batches');
      await capture('default', page.locator('#view-generator .wizard-body'));

      await page.locator('#prop-name').fill(batchData.name);
      await page.locator('#prop-type').selectOption('layer');
      await page.locator('#prop-batch-mode').selectOption('setup');
      await page.locator('#prop-size').fill(batchData.size);
      await page.locator('#prop-owner').fill(batchData.owner);
      await page.locator('#prop-location').fill(batchData.location);
      await page.locator('#wizard-next').click();
      await page.locator('.form-step[data-step="2"]').waitFor({ state: 'visible' });
      await page.locator('#prop-housing').selectOption('deep-litter');
      await page.locator('#prop-nesting').selectOption('rollaway');
      await page.locator('#prop-feed-strategy').fill(batchData.feedStrategy);
      await page.locator('#prop-water-strategy').fill(batchData.waterStrategy);
      await page.locator('#chk-concrete').check();
      await page.locator('#wizard-next').click();
      await page.locator('.form-step[data-step="3"]').waitFor({ state: 'visible' });
      await page.locator('#prop-cost-housing').fill(batchData.housingCost);
      await page.locator('#prop-cost-equipment').fill(batchData.equipmentCost);
      await page.locator('#prop-egg-price').fill(batchData.eggPrice);
      await page.locator('#prop-eggs-month').fill(batchData.eggsMonth);
      await page.locator('#wizard-next').click();
      await page.locator('.form-step[data-step="4"]').waitFor({ state: 'visible' });
      await page.locator('#btn-generate-preview').click();
      await page.locator('#btn-start-batch').waitFor({ state: 'visible' });
      await page.getByText(batchData.waterStrategy, { exact: false }).waitFor({ state: 'visible' });

      const filledValues = await page.evaluate(() => ({
        name: document.getElementById('prop-name').value,
        size: document.getElementById('prop-size').value,
        owner: document.getElementById('prop-owner').value,
        location: document.getElementById('prop-location').value,
        feedStrategy: document.getElementById('prop-feed-strategy').value,
        waterStrategy: document.getElementById('prop-water-strategy').value,
        housingCost: document.getElementById('prop-cost-housing').value,
        equipmentCost: document.getElementById('prop-cost-equipment').value,
        eggPrice: document.getElementById('prop-egg-price').value,
        eggsMonth: document.getElementById('prop-eggs-month').value
      }));
      assert.deepEqual(filledValues, batchData, 'All configured batch fields must retain their filled values');
      const beforeSubmit = {
        proposals: (await callApi('/api/proposals')).body,
        batches: (await callApi('/api/batches')).body
      };
      expect(beforeSubmit.proposals.length === 0 && beforeSubmit.batches.length === 0,
        'Generating and reviewing the filled proposal must not durably save it or create a batch');
      await capture('filled', page.locator('.form-step[data-step="4"]'));

      const proposalWrite = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/proposals' && response.request().method() === 'POST');
      const batchWrite = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/batches' && response.request().method() === 'POST');
      await page.locator('#btn-start-batch').click();
      const [proposalResponse, batchResponse] = await Promise.all([proposalWrite, batchWrite]);
      expect(proposalResponse.status() === 200, `Proposal save returned ${proposalResponse.status()}`);
      expect(batchResponse.status() === 200, `Batch creation returned ${batchResponse.status()}`);
      await page.locator('#view-batch-cockpit').waitFor({ state: 'visible' });
      const createdCockpitHeader = page.locator('.cockpit-header').filter({ hasText: `Batch: ${batchData.name}` });
      await createdCockpitHeader.waitFor({ state: 'visible' });
      await page.locator('.main-content').evaluate(element => { element.scrollTop = 0; });
      expect(await page.locator('.main-content').evaluate(element => element.scrollTop) === 0,
        'Created cockpit must be positioned at its identity header for submitted evidence');
      await createdCockpitHeader.locator('h2').filter({ hasText: `Batch: ${batchData.name}` }).waitFor({ state: 'visible' });
      await createdCockpitHeader.getByText('Day 0 / 504', { exact: true }).waitFor({ state: 'visible' });
      await page.locator('#info-birds').filter({ hasText: batchData.size }).waitFor({ state: 'visible' });
      await capture('submitted', page.locator('.main-content'));

      const afterSubmit = {
        proposals: (await callApi('/api/proposals')).body,
        batches: (await callApi('/api/batches')).body
      };
      expect(afterSubmit.proposals.length === 1, 'Exactly one proposal must be persisted');
      expect(afterSubmit.batches.length === 1, 'Exactly one batch must be persisted');
      expect(afterSubmit.proposals[0].inputs['prop-water-strategy'] === batchData.waterStrategy,
        'Watering Strategy must persist with the proposal');
      expect(afterSubmit.batches[0].name === `Batch: ${batchData.name}`, 'Persisted batch identity mismatch');
      batchId = String(afterSubmit.batches[0].id);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const afterReload = {
        proposals: (await callApi('/api/proposals')).body,
        batches: (await callApi('/api/batches')).body
      };
      expect(afterReload.batches.length === 1 && String(afterReload.batches[0].id) === batchId,
        'Created batch did not persist through reload');
      assert.deepEqual(afterReload.proposals[0], afterSubmit.proposals[0],
        'Created proposal must survive reload unchanged');
      assert.deepEqual(afterReload.batches[0], afterSubmit.batches[0],
        'Created batch must survive reload unchanged');
      return {
        pre_submit_get: beforeSubmit,
        expected_posts: {
          proposal: { path: '/api/proposals', status: proposalResponse.status() },
          batch: { path: '/api/batches', status: batchResponse.status() }
        },
        durable_after_submit: {
          proposal: afterSubmit.proposals[0],
          batch: afterSubmit.batches[0]
        },
        durable_after_reload: {
          proposal: afterReload.proposals[0],
          batch: afterReload.batches[0]
        }
      };
    }, results);

    await runWorkflow(browser, runDir, origin, '02 inventory adjustment', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const before = await callApi(`/api/transactions/${batchId}`);
      expect(before.status === 200 && Array.isArray(before.body), 'Inventory pre-submit GET must succeed');
      await page.locator('button', { hasText: 'Log Write-off' }).click();
      await page.locator('#tx-modal').waitFor({ state: 'visible' });
      await capture('default', page.locator('#tx-modal .modal-content'));
      await page.locator('#tx-qty').fill('10');
      await page.locator('#tx-amount').fill('150');
      await page.locator('#tx-reason').selectOption('cracked');
      await capture('filled', page.locator('#tx-modal .modal-content'));

      const write = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/transactions/${batchId}` && response.request().method() === 'POST');
      await page.locator('#tx-form button[type="submit"]').click();
      const writeResponse = await write;
      expect(writeResponse.status() === 200, `Inventory adjustment POST returned ${writeResponse.status()}`);
      await page.locator('#tx-modal').waitFor({ state: 'detached' });
      await capture('submitted', page.locator('#view-batch-cockpit'));
      const afterSubmit = await callApi(`/api/transactions/${batchId}`);
      expect(afterSubmit.status === 200 && afterSubmit.body.length === before.body.length + 1,
        'Inventory adjustment must produce one durable transaction');
      const transaction = afterSubmit.body.find(item => !before.body.some(previous => previous.id === item.id));
      expect(transaction?.type === 'write_off' && transaction.category === 'eggs'
        && transaction.qty === 10 && transaction.amount === 150 && transaction.reason === 'cracked',
      'Inventory adjustment durable transaction mismatch');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const afterReload = await callApi(`/api/transactions/${batchId}`);
      const reloaded = afterReload.body.find(item => item.id === transaction.id);
      assert.deepEqual(reloaded, transaction, 'Inventory adjustment must survive reload unchanged');
      return {
        pre_submit_get: before.body,
        expected_post: { path: `/api/transactions/${batchId}`, status: 200 },
        durable_after_submit: transaction,
        durable_after_reload: reloaded
      };
    }, results);

    await runWorkflow(browser, runDir, origin, '03 feed purchase', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const before = await callApi(`/api/transactions/${batchId}`);
      expect(before.status === 200 && Array.isArray(before.body), 'Purchase pre-submit GET must succeed');
      await page.locator('button', { hasText: 'Buy Feed' }).click();
      await page.locator('#tx-modal').waitFor({ state: 'visible' });
      await capture('default', page.locator('#tx-modal .modal-content'));
      await page.locator('#tx-qty').fill('500');
      await page.locator('#tx-amount').fill('25000');
      await capture('filled', page.locator('#tx-modal .modal-content'));
      const write = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/transactions/${batchId}` && response.request().method() === 'POST');
      await page.locator('#tx-form button[type="submit"]').click();
      const writeResponse = await write;
      expect(writeResponse.status() === 200, `Feed purchase POST returned ${writeResponse.status()}`);
      await page.locator('#tx-modal').waitFor({ state: 'detached' });
      await capture('submitted', page.locator('#view-batch-cockpit'));
      const afterSubmit = await callApi(`/api/transactions/${batchId}`);
      expect(afterSubmit.status === 200 && afterSubmit.body.length === before.body.length + 1,
        'Feed purchase must produce one durable transaction');
      const transaction = afterSubmit.body.find(item => !before.body.some(previous => previous.id === item.id));
      expect(transaction?.type === 'purchase' && transaction.category === 'feed'
        && transaction.qty === 500 && transaction.amount === 25000,
      'Feed purchase durable transaction mismatch');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const afterReload = await callApi(`/api/transactions/${batchId}`);
      const reloaded = afterReload.body.find(item => item.id === transaction.id);
      assert.deepEqual(reloaded, transaction, 'Feed purchase must survive reload unchanged');
      return {
        pre_submit_get: before.body,
        expected_post: { path: `/api/transactions/${batchId}`, status: 200 },
        durable_after_submit: transaction,
        durable_after_reload: reloaded
      };
    }, results);

    await runWorkflow(browser, runDir, origin, '04 walk-in manure sale', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const before = await callApi(`/api/transactions/${batchId}`);
      expect(before.status === 200 && Array.isArray(before.body), 'Sale pre-submit GET must succeed');
      await page.locator('button', { hasText: 'Record a Sale' }).click();
      await page.locator('#tx-modal').waitFor({ state: 'visible' });
      await capture('default', page.locator('#tx-modal .modal-content'));
      await page.locator('#tx-category').selectOption('manure');
      await page.locator('#tx-qty').waitFor({ state: 'visible' });
      await page.locator('#tx-qty').fill('1');
      await page.locator('#tx-unit').selectOption('bags');
      await page.locator('#tx-amount').fill('18');
      await capture('filled', page.locator('#tx-modal .modal-content'));
      const write = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/transactions/${batchId}` && response.request().method() === 'POST');
      await page.locator('#tx-form button[type="submit"]').click();
      const writeResponse = await write;
      expect(writeResponse.status() === 200, `Walk-in sale POST returned ${writeResponse.status()}`);
      await page.locator('#tx-modal').waitFor({ state: 'detached' });
      await capture('submitted', page.locator('#view-batch-cockpit'));
      const afterSubmit = await callApi(`/api/transactions/${batchId}`);
      expect(afterSubmit.status === 200 && afterSubmit.body.length === before.body.length + 1,
        'Walk-in sale must produce one durable transaction');
      const transaction = afterSubmit.body.find(item => !before.body.some(previous => previous.id === item.id));
      expect(transaction?.type === 'sale' && transaction.category === 'manure'
        && transaction.qty === 1 && transaction.amount === 18 && transaction.buyerName === 'Walk-in Customer'
        && transaction.buyerTerms === 'COD', 'Walk-in sale durable transaction mismatch');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const afterReload = await callApi(`/api/transactions/${batchId}`);
      const reloaded = afterReload.body.find(item => item.id === transaction.id);
      assert.deepEqual(reloaded, transaction, 'Walk-in sale must survive reload unchanged');
      return {
        pre_submit_get: before.body,
        expected_post: { path: `/api/transactions/${batchId}`, status: 200 },
        durable_after_submit: transaction,
        durable_after_reload: reloaded
      };
    }, results);

    await runWorkflow(browser, runDir, origin, '05 reviewed batch closure', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const before = await callApi('/api/batches');
      expect(before.status === 200 && Array.isArray(before.body), 'Batch closure pre-submit GET must succeed');
      await page.locator('button', { hasText: 'Close batch' }).click();
      const modal = page.locator('.modal-overlay').filter({ hasText: 'Close batch' });
      await modal.waitFor({ state: 'visible' });
      await capture('default', modal.locator('.modal-content'));
      await modal.locator('#batch-closure-confirm').check();
      await capture('filled', modal.locator('.modal-content'));
      const write = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/batches/${batchId}/close` && response.request().method() === 'POST');
      await modal.locator('#batch-closure-submit').click();
      const writeResponse = await write;
      expect(writeResponse.status() === 201, `Batch closure POST returned ${writeResponse.status()}`);
      await modal.waitFor({ state: 'detached' });
      await capture('submitted', page.locator('#view-batch-cockpit'));
      const afterSubmit = await callApi('/api/batches');
      const closed = afterSubmit.body.find(item => String(item.id) === batchId);
      expect(closed?.status === 'completed' && closed?.closure_review?.status === 'exact',
        'Batch closure must persist an exact reviewed closure record');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await selectNav(page, 'batches', 'batches');
      const afterReload = await callApi('/api/batches');
      const reloaded = afterReload.body.find(item => String(item.id) === batchId);
      assert.deepEqual(reloaded, closed, 'Reviewed batch closure must survive reload unchanged');
      return {
        pre_submit_get: before.body,
        expected_post: { path: `/api/batches/${batchId}/close`, status: 201 },
        durable_after_submit: closed,
        durable_after_reload: reloaded
      };
    }, results);
  } finally {
    if (browser) await browser.close();
    if (serverProc) {
      if (results.some(result => result.status !== 'passed')) {
        process.stderr.write('SERVER LOGS:\n' + serverProc.getOutput() + '\n');
      }
      await stopServer(serverChild);
    }
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    if (fs.existsSync(runDir)) {
      const payload = writeEvidence(runDir, results, startedAt, origin);
      process.stdout.write(`Batch 18B2: ${payload.totals.passed}/${payload.totals.total} passed. Evidence: ${runDir}\n`);
    }
  }
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
}

module.exports = {
  main,
  assertSafeConfiguredOrigins,
  copyTreeIsolated,
  expectedScreenshotRelativePaths,
  expectedSafetyScreenshotRelativePath,
  validateThreeStateScreenshots,
  validateWorkflowEvidence,
  capturedEvidenceForWorkflow,
  writeEvidence,
  stagingModuleCounts,
  WORKFLOW_STATES,
  EVIDENCE_ROOT
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Batch 18B2 failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
