#!/usr/bin/env node
'use strict';

// Batch 18B1 owns a disposable copy, database and loopback server. It does not
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
const EVIDENCE_ROOT = path.resolve(APP_ROOT, '..', '..', 'evidence', 'playwright', 'batch18b1');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WORKFLOW_STATES = Object.freeze([
  Object.freeze({ key: 'default', filename: '01-default.png' }),
  Object.freeze({ key: 'filled', filename: '02-filled-not-submitted.png' }),
  Object.freeze({ key: 'submitted', filename: '03-submitted-confirmed.png' })
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
  if (argv.length) fail('Batch 18B1 accepts no command-line target or arguments');
  for (const key of ['BASE_URL', 'PLAYWRIGHT_BASE_URL', 'BATCH18A_ORIGIN', 'BATCH18B1_ORIGIN']) {
    const value = env[key];
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${key} must be a valid URL when set`); }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) fail(`Batch 18B1 refuses non-loopback ${key}`);
    fail(`Batch 18B1 owns a fresh copied app and does not accept ${key}`);
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
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
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
  return null;
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

async function runWorkflow(browser, runDir, origin, workflowName, body, results) {
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
  const started = Date.now();
  let status = 'passed';
  let error = null;
  let readback = null;
  const evidenceErrors = [];

  const capture = async (stateKey, target = null) => {
    const expectedState = WORKFLOW_STATES[captured.length];
    expect(expectedState && expectedState.key === stateKey,
      `Expected screenshot state ${expectedState?.key || 'none'}, received ${stateKey}`);
    const relative = expectedPaths[captured.length];
    await captureScreenshot(page, path.join(runDir, relative), target);
    captured.push(relative);
  };

  try {
    readback = await body({
      page,
      capture,
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

  const screenshotProblem = validateThreeStateScreenshots(runDir, workflowName, captured);
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
    screenshots: screenshotProblem ? [] : expectedPaths,
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
    batch: '18B1',
    scope: 'batch setup and daily farm records only',
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
    const trace = result.trace ? `<a href="${escapeHtml(result.trace)}">trace</a>` : 'trace: missing';
    const video = result.video ? `<a href="${escapeHtml(result.video)}">video</a>` : 'video: missing';
    return `<tr><td>${escapeHtml(result.name)}</td><td>${escapeHtml(result.status)}</td>`
      + `<td>${result.duration_ms}</td><td>${result.error ? escapeHtml(result.error) : ''}</td>`
      + `<td>${screenshots} · ${trace} · ${video}</td></tr>`;
  }).join('');
  fs.writeFileSync(path.join(runDir, 'report.html'), '<!doctype html><meta charset="utf-8">'
    + '<title>Batch 18B1</title><h1>Batch 18B1 isolated browser evidence</h1>'
    + `<p>Disposable loopback app: ${escapeHtml(origin)}</p>`
    + '<p>Each writable workflow has default, filled-not-submitted, and submitted-confirmed screenshots. '
    + 'Its video continues through reload and durable persistence readback.</p>'
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
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-b18b1-'));
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
  let server;
  let browser;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    copyIsolatedApp(appDir);
    const started = startDisposableServer(appDir, port, safeId('session'), owner.password);
    server = started.child;
    await waitForHealth(origin, server);
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
      const afterReload = (await callApi('/api/batches')).body;
      expect(afterReload.length === 1 && String(afterReload[0].id) === batchId,
        'Created batch did not persist through reload');
      return {
        pre_submit: { proposals: beforeSubmit.proposals.length, batches: beforeSubmit.batches.length },
        persisted_after_reload: { proposals: afterSubmit.proposals.length, batches: afterReload.length, batch_id: batchId },
        watering_strategy: afterSubmit.proposals[0].inputs['prop-water-strategy']
      };
    }, results);

    await runWorkflow(browser, runDir, origin, '02 daily operational log', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const initialSummary = (await callApi(`/api/staging/${batchId}/today`)).body;
      const initialCounts = stagingModuleCounts(initialSummary);
      assert.deepEqual(initialCounts, { eggs: 0, feed: 0, mortality: 0, sensors: 0, gases: 0, notes: 0 });
      await capture('default', page.locator('.log-form-card'));

      await page.locator('#log-feed').fill('12.5');
      await page.locator('#log-mortality-hens').fill('1');
      await page.locator('#log-mortality-roosters').fill('1');
      await page.locator('#toggle-advanced-air').click();
      await page.locator('#log-nh3').fill('8.2');
      await page.locator('#log-co2').fill('850');
      await page.locator('#log-temp').fill('24.6');
      await page.locator('#log-humidity').fill('67');
      await page.locator('#log-notes').fill('Disposable E2E observation: flock active and litter dry.');
      const beforeSubmit = stagingModuleCounts((await callApi(`/api/staging/${batchId}/today`)).body);
      assert.deepEqual(beforeSubmit, initialCounts, 'Filling the daily log must not create durable staging rows');
      await capture('filled', page.locator('.log-form-card'));

      const modules = ['feed', 'mortality', 'gases', 'sensors', 'notes'];
      const writes = modules.map(module => page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/staging/${batchId}/${module}`
          && response.request().method() === 'POST'));
      await page.locator('.btn-save-log').click();
      const writeResponses = await Promise.all(writes);
      expect(writeResponses.every(response => response.status() === 200),
        `Daily writes returned ${writeResponses.map(response => response.status()).join(', ')}`);
      await page.locator('.btn-save-log').filter({ hasText: 'Saved!' }).waitFor({ state: 'visible' });
      await page.locator('.toast-success').filter({ hasText: 'Log saved!' }).waitFor({ state: 'visible' });
      const stagedList = page.locator('#today-staged-non-eggs-list');
      await stagedList.getByText('12.5 kg feed', { exact: false }).waitFor({ state: 'visible' });
      await stagedList.getByText('2 bird(s) died', { exact: false }).waitFor({ state: 'visible' });
      await stagedList.getByText('NH3 8.2 ppm, CO2 850 ppm', { exact: false }).waitFor({ state: 'visible' });
      await stagedList.getByText('flock active and litter dry', { exact: false }).waitFor({ state: 'visible' });
      await capture('submitted', page.locator('.log-form-card'));

      const afterSubmit = stagingModuleCounts((await callApi(`/api/staging/${batchId}/today`)).body);
      assert.deepEqual(afterSubmit, { eggs: 0, feed: 1, mortality: 1, sensors: 1, gases: 1, notes: 1 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      await page.locator('#today-staged-non-eggs-list').getByText('12.5 kg feed', { exact: false }).waitFor({ state: 'visible' });
      const afterReloadSummary = (await callApi(`/api/staging/${batchId}/today`)).body;
      const afterReload = stagingModuleCounts(afterReloadSummary);
      assert.deepEqual(afterReload, afterSubmit, 'Daily operational events did not persist through reload');
      expect(afterReloadSummary.sensors.current.temperature === 24.6, 'Temperature readback mismatch');
      expect(afterReloadSummary.sensors.current.humidity === 67, 'Humidity readback mismatch');
      return {
        pre_submit: beforeSubmit,
        persisted_after_reload: afterReload,
        sensor_readback: afterReloadSummary.sensors.current
      };
    }, results);

    await runWorkflow(browser, runDir, origin, '03 egg collection', async ({ page, capture, callApi }) => {
      await login(page, origin, owner.username, owner.password);
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      const initialSummary = (await callApi(`/api/staging/${batchId}/today`)).body;
      expect(initialSummary.eggs.collections.length === 0, 'Egg workflow must start with no egg collection');
      await capture('default', page.locator('.log-form-card'));

      await page.locator('#btn-add-collection').click();
      await page.locator('#ecm-count').fill('37');
      await page.locator('#ecm-broken').fill('2');
      await page.locator('#ecm-time').fill('09:15');
      await page.locator('#ecm-label').fill('Disposable morning round');
      const beforeSubmit = (await callApi(`/api/staging/${batchId}/today`)).body;
      expect(beforeSubmit.eggs.collections.length === 0,
        'Filling the egg collection modal must not create a durable collection');
      await capture('filled');

      const write = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/staging/${batchId}/eggs`
          && response.request().method() === 'POST');
      await page.locator('#ecm-save').click();
      const response = await write;
      expect(response.status() === 200, `Egg collection save returned ${response.status()}`);
      await page.locator('.egg-collection-row').filter({ hasText: 'Disposable morning round' }).waitFor({ state: 'visible' });
      await page.locator('#egg-total-display').filter({ hasText: '37 eggs' }).waitFor({ state: 'visible' });
      await page.locator('#egg-total-display').filter({ hasText: '2 broken' }).waitFor({ state: 'visible' });
      await capture('submitted', page.locator('.log-form-card'));

      const afterSubmit = (await callApi(`/api/staging/${batchId}/today`)).body;
      expect(afterSubmit.eggs.collections.length === 1, 'Exactly one egg collection must be persisted');
      expect(afterSubmit.eggs.intact === 37 && afterSubmit.eggs.broken === 2 && afterSubmit.eggs.total === 39,
        'Egg totals did not match submitted intact and broken counts');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
      await openBatchThroughUi(page, `Batch: ${batchData.name}`);
      await page.locator('.egg-collection-row').filter({ hasText: 'Disposable morning round' }).waitFor({ state: 'visible' });
      const afterReload = (await callApi(`/api/staging/${batchId}/today`)).body;
      expect(afterReload.eggs.collections.length === 1 && afterReload.eggs.total === 39,
        'Egg collection did not persist through reload');
      return {
        pre_submit_collections: beforeSubmit.eggs.collections.length,
        persisted_after_reload: {
          collections: afterReload.eggs.collections.length,
          intact: afterReload.eggs.intact,
          broken: afterReload.eggs.broken,
          total: afterReload.eggs.total
        }
      };
    }, results);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server);
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    if (fs.existsSync(runDir)) {
      const payload = writeEvidence(runDir, results, startedAt, origin);
      process.stdout.write(`Batch 18B1: ${payload.totals.passed}/${payload.totals.total} passed. Evidence: ${runDir}\n`);
    }
  }
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
}

module.exports = {
  main,
  assertSafeConfiguredOrigins,
  copyTreeIsolated,
  expectedScreenshotRelativePaths,
  validateThreeStateScreenshots,
  stagingModuleCounts,
  WORKFLOW_STATES
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Batch 18B1 failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
