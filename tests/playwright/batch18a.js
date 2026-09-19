#!/usr/bin/env node
'use strict';

// Batch 18A deliberately owns both the application copy and its loopback
// server. It never accepts a target URL, so it cannot exercise farm data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_ROOT = path.resolve(APP_ROOT, '..', '..', 'evidence', 'playwright', 'batch18a');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function fail(message) {
  throw new Error(message);
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

function assertSafeConfiguredOrigins() {
  for (const key of ['BASE_URL', 'PLAYWRIGHT_BASE_URL', 'BATCH18A_ORIGIN']) {
    const value = process.env[key];
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${key} must be a valid URL when set`); }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      fail(`Batch 18A refuses non-loopback ${key}`);
    }
    fail(`Batch 18A owns a fresh copied app and does not accept ${key}`);
  }
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

function copyIsolatedApp(target) {
  fs.cpSync(APP_ROOT, target, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      return !['.git', '.env', 'data', 'evidence'].includes(name);
    }
  });
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail('Disposable app exited before its health check');
    try {
      const response = await fetch(`${origin}/api/healthz`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* The listener is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail('Timed out waiting for disposable app health');
}

function startDisposableServer(appDir, port, sessionSecret, setupPassword) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    SESSION_SECRET: sessionSecret,
    E2E_TEST_PASSWORD: setupPassword,
    DATABASE_PATH: path.join(appDir, 'data', 'poultry_dss.db')
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output = `${output}${chunk}`.slice(-8_000); });
  }
  return { child, getOutput: () => output };
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

function expectationError(message) {
  const error = new Error(message);
  error.isExpectation = true;
  return error;
}

function expect(condition, message) {
  if (!condition) throw expectationError(message);
}

const GENERIC_FORBIDDEN_CONSOLE_ERROR =
  'Failed to load resource: the server responded with a status of 403 (Forbidden)';

function classifyConsoleErrors(consoleErrors, matchedExpectedDenials) {
  let remainingForbiddenAllowances = matchedExpectedDenials
    .filter(denial => denial.status === 403).length;
  const allowed = [];
  const unexpected = [];
  for (const message of consoleErrors) {
    if (message === GENERIC_FORBIDDEN_CONSOLE_ERROR && remainingForbiddenAllowances > 0) {
      allowed.push(message);
      remainingForbiddenAllowances -= 1;
    } else {
      unexpected.push(message);
    }
  }
  return { allowed, unexpected };
}

function pngStructureProblem(file) {
  const header = Buffer.alloc(24);
  const descriptor = fs.openSync(file, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytesRead < header.length || !header.subarray(0, 8).equals(signature)) {
    return 'screenshot has an invalid PNG signature/header';
  }
  if (header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') {
    return 'screenshot is missing a valid PNG IHDR';
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 32_768 || height > 32_768) {
    return `screenshot has invalid PNG dimensions: ${width}x${height}`;
  }
  return null;
}

function webmStructureProblem(file) {
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(Math.min(4_096, fs.fstatSync(descriptor).size));
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.length < 4 || header.readUInt32BE(0) !== 0x1a45dfa3) {
    return 'video has an invalid WebM/EBML signature';
  }
  const webmDocType = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  if (header.indexOf(webmDocType) < 0) return 'video has no WebM document type in its EBML header';
  return null;
}

let crc32Table;
function crc32(buffer) {
  if (!crc32Table) {
    crc32Table = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      return value >>> 0;
    });
  }
  let checksum = 0xffffffff;
  for (const byte of buffer) checksum = crc32Table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function traceZipStructureProblem(file) {
  const archive = fs.readFileSync(file);
  const earliestEocd = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let cursor = archive.length - 22; cursor >= earliestEocd; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === 0x06054b50) {
      eocd = cursor;
      break;
    }
  }
  if (eocd < 0) return 'trace is not an intact ZIP archive (end record missing)';
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) {
    return 'trace ZIP uses unsupported multi-disk storage';
  }
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (diskEntries !== totalEntries || totalEntries === 0
      || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return 'trace ZIP has unsupported or empty central-directory metadata';
  }
  if (centralOffset + centralSize > eocd) return 'trace ZIP central directory is truncated';

  const names = new Set();
  let cursor = centralOffset;
  try {
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
        return 'trace ZIP central-directory entry is invalid';
      }
      const flags = archive.readUInt16LE(cursor + 8);
      const method = archive.readUInt16LE(cursor + 10);
      const expectedCrc = archive.readUInt32LE(cursor + 16);
      const compressedSize = archive.readUInt32LE(cursor + 20);
      const uncompressedSize = archive.readUInt32LE(cursor + 24);
      const nameLength = archive.readUInt16LE(cursor + 28);
      const extraLength = archive.readUInt16LE(cursor + 30);
      const commentLength = archive.readUInt16LE(cursor + 32);
      const localOffset = archive.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > archive.length || compressedSize === 0xffffffff
          || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        return 'trace ZIP entry metadata is truncated or unsupported';
      }
      if ((flags & 1) !== 0 || ![0, 8].includes(method)) {
        return 'trace ZIP entry is encrypted or uses unsupported compression';
      }
      const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      names.add(name);
      if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
        return `trace ZIP local entry is missing: ${name}`;
      }
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > archive.length) return `trace ZIP entry data is truncated: ${name}`;
      const compressed = archive.subarray(dataStart, dataEnd);
      const content = method === 0 ? compressed : zlib.inflateRawSync(compressed);
      if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
        return `trace ZIP entry failed size/CRC validation: ${name}`;
      }
      cursor = next;
    }
  } catch (error) {
    return `trace ZIP cannot be decompressed: ${error.message}`;
  }
  if (cursor !== centralOffset + centralSize) return 'trace ZIP central-directory size is inconsistent';
  for (const required of ['trace.trace', 'trace.network']) {
    if (!names.has(required)) return `trace ZIP is missing required entry: ${required}`;
  }
  return null;
}

function requiredArtifactProblem(label, file) {
  if (!file) return `${label} path was not produced`;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return `${label} is not a file: ${file}`;
    if (stat.size === 0) return `${label} is zero-byte: ${file}`;
  } catch (error) {
    return `${label} is missing or unreadable: ${file} (${error.message})`;
  }
  try {
    if (label === 'screenshot') return pngStructureProblem(file);
    if (label === 'video') return webmStructureProblem(file);
    if (label === 'trace') return traceZipStructureProblem(file);
  } catch (error) {
    return `${label} structural validation failed: ${error.message}`;
  }
  return null;
}

async function api(page, pathName, options = {}) {
  return page.evaluate(async ({ pathName, options }) => {
    const response = await fetch(pathName, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { nonJson: true }; }
    return { status: response.status, body };
  }, { pathName, options });
}

function attachGuards(page, origin, expectedDenials) {
  const state = {
    pageErrors: [],
    consoleErrors: [],
    unexpectedResponses: [],
    matchedExpectedDenials: []
  };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() < 400 || response.status() >= 600) return;
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== origin) return;
    const method = response.request().method();
    const index = expectedDenials.findIndex(item => item.status === response.status()
      && item.path === url.pathname && (!item.method || item.method === method));
    if (index >= 0) {
      const [matched] = expectedDenials.splice(index, 1);
      state.matchedExpectedDenials.push({ ...matched, method });
    }
    else state.unexpectedResponses.push(`${response.status()} ${url.pathname}`);
  });
  return state;
}

async function setupFirstRun(page, username, password) {
  await page.goto(page.context()._batchOrigin, { waitUntil: 'domcontentloaded' });
  await page.locator('#setup-username').waitFor({ state: 'visible' });
  await page.locator('#setup-username').fill(username);
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(password);
  await page.locator('#setup-submit').click();
  await page.locator('#auth-overlay').waitFor({ state: 'detached' });
  await page.locator('#nav-dashboard').waitFor({ state: 'visible' });
}

async function login(page, username, password) {
  await page.goto(page.context()._batchOrigin, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-username').waitFor({ state: 'visible' });
  await page.locator('#auth-username').fill(username);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await page.locator('#auth-overlay').waitFor({ state: 'detached' });
  await page.locator('#nav-dashboard').waitFor({ state: 'visible' });
}

async function selectNav(page, navId, viewId) {
  await page.locator(`#nav-${navId}`).click();
  await page.locator(`#view-${viewId}`).waitFor({ state: 'visible' });
  expect(await page.locator(`#view-${viewId}`).evaluate(el => el.classList.contains('active')),
    `Expected ${viewId} view to be active`);
}

async function createUserThroughUi(page, user) {
  await selectNav(page, 'settings', 'settings');
  await page.locator('#btn-add-user').waitFor({ state: 'visible' });
  await page.locator('#btn-add-user').click();
  await page.locator('#nu-username').fill(user.username);
  await page.locator('#nu-password').fill(user.password);
  await page.locator('#nu-role').selectOption(user.role);
  await page.locator('#nu-save').click();
  await page.locator('#nu-close').waitFor({ state: 'visible' });
  await page.locator('#nu-close').click();
}

async function resetPasswordThroughUi(page, username, password) {
  await selectNav(page, 'settings', 'settings');
  const row = page.locator('tr').filter({ hasText: username });
  await row.waitFor({ state: 'visible' });
  page.once('dialog', dialog => dialog.accept(password));
  const response = page.waitForResponse(response => response.url().includes('/password')
    && response.request().method() === 'PUT');
  await row.getByRole('button', { name: 'Reset PW' }).click();
  expect((await response).status() === 200, `Password reset for ${username} failed`);
}

function roleNavAssertions(page, expectedVisible, expectedHidden) {
  return Promise.all([
    ...expectedVisible.map(id => page.locator(`#nav-${id}`).isVisible().then(value =>
      expect(value, `Expected ${id} navigation to be visible`))),
    ...expectedHidden.map(id => page.locator(`#nav-${id}`).isVisible().then(value =>
      expect(!value, `Expected ${id} navigation to be hidden`)))
  ]);
}

async function runCase(browser, runDir, origin, caseName, options, body, allResults) {
  const slug = caseName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const mediaDir = path.join(runDir, 'media', slug);
  fs.mkdirSync(mediaDir, { recursive: true });
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 900 },
    recordVideo: { dir: mediaDir, size: options.videoSize || { width: 1280, height: 720 } }
  });
  context._batchOrigin = origin;
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const expectedDenials = [];
  const guard = attachGuards(page, origin, expectedDenials);
  const started = Date.now();
  let status = 'passed';
  let error = null;
  const evidenceErrors = [];
  const video = page.video();
  try {
    await body({ page, expectedDenials, expect, api: (pathname, opts) => api(page, pathname, opts) });
    expect(expectedDenials.length === 0, `Expected denials were not observed: ${JSON.stringify(expectedDenials)}`);
    expect(guard.pageErrors.length === 0, `Uncaught page errors: ${guard.pageErrors.join(' | ')}`);
    expect(guard.unexpectedResponses.length === 0,
      `Unexpected same-origin HTTP errors: ${guard.unexpectedResponses.join(' | ')}`);
  } catch (caught) {
    status = 'failed';
    error = caught && caught.message ? caught.message : String(caught);
  }
  const screenshot = path.join(runDir, 'screenshots', `${slug}.png`);
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  try {
    await page.screenshot({ path: screenshot, fullPage: true });
  } catch (caught) {
    evidenceErrors.push(`screenshot capture failed: ${caught.message || String(caught)}`);
  }
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
  for (const [label, file] of [['screenshot', screenshot], ['trace', trace], ['video', videoPath]]) {
    const problem = requiredArtifactProblem(label, file);
    if (problem) evidenceErrors.push(problem);
  }
  if (evidenceErrors.length) {
    status = 'failed';
    error = [error, `Evidence gate failed: ${evidenceErrors.join(' | ')}`].filter(Boolean).join(' | ');
  }
  const consoleClassification = classifyConsoleErrors(guard.consoleErrors, guard.matchedExpectedDenials);
  if (consoleClassification.unexpected.length) {
    status = 'failed';
    error = [error, `Unexpected console errors: ${consoleClassification.unexpected.join(' | ')}`]
      .filter(Boolean).join(' | ');
  }
  const result = {
    name: caseName,
    status,
    duration_ms: Date.now() - started,
    error,
    console_errors: guard.consoleErrors,
    allowed_console_errors: consoleClassification.allowed,
    unexpected_console_errors: consoleClassification.unexpected,
    matched_expected_denials: guard.matchedExpectedDenials,
    unexpected_responses: guard.unexpectedResponses,
    screenshot: requiredArtifactProblem('screenshot', screenshot) ? null : path.relative(runDir, screenshot),
    trace: requiredArtifactProblem('trace', trace) ? null : path.relative(runDir, trace),
    video: requiredArtifactProblem('video', videoPath) ? null : path.relative(runDir, videoPath)
  };
  allResults.push(result);
  if (status !== 'passed') throw expectationError(`${caseName}: ${error}`);
}

function writeEvidence(runDir, results, startedAt, origin) {
  const completedAt = new Date().toISOString();
  const payload = {
    batch: '18A',
    started_at: startedAt,
    completed_at: completedAt,
    origin,
    disposable: true,
    cases: results,
    totals: {
      total: results.length,
      passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status !== 'passed').length
    }
  };
  fs.writeFileSync(path.join(runDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  const artifactLink = (file, label) => file ? `<a href="${escapeHtml(file)}">${label}</a>` : `${label}: missing`;
  const rows = results.map(result => `<tr><td>${escapeHtml(result.name)}</td><td>${escapeHtml(result.status)}</td>`
    + `<td>${result.duration_ms}</td><td>${result.error ? escapeHtml(result.error) : ''}</td>`
    + `<td>${artifactLink(result.screenshot, 'screenshot')} · ${artifactLink(result.trace, 'trace')}`
    + ` · ${artifactLink(result.video, 'video')}</td></tr>`).join('');
  fs.writeFileSync(path.join(runDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Batch 18A</title>`
    + `<h1>Batch 18A isolated browser evidence</h1><p>Disposable loopback app: ${escapeHtml(origin)}</p>`
    + '<table border="1"><thead><tr><th>Case</th><th>Status</th><th>ms</th><th>Error</th><th>Evidence</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`);
  const files = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (!['evidence-manifest.json'].includes(entry.name)) files.push(item);
    }
  };
  visit(runDir);
  const manifest = files.sort().map(file => ({
    path: path.relative(runDir, file),
    bytes: fs.statSync(file).size,
    sha256: sha256(file)
  }));
  fs.writeFileSync(path.join(runDir, 'evidence-manifest.json'), `${JSON.stringify({ generated_at: completedAt, files: manifest }, null, 2)}\n`);
  return payload;
}

async function main() {
  assertSafeConfiguredOrigins();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeId('run')}`;
  const runDir = path.join(EVIDENCE_ROOT, runId);
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poultry-b18a-'));
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const superUser = { username: safeId('super'), password: safeId('Pw') + 'Aa9!' };
  const users = ['farmer', 'viewer', 'admin'].map(role => ({
    role,
    username: safeId(role),
    password: safeId('Pw') + 'Aa9!'
  }));
  const results = [];
  let server;
  let browser;
  const startedAt = new Date().toISOString();
  try {
    fs.mkdirSync(runDir, { recursive: true });
    copyIsolatedApp(appDir);
    const started = startDisposableServer(appDir, port, safeId('session'), superUser.password);
    server = started.child;
    await waitForHealth(origin, server);
    browser = await chromium.launch({ headless: true });

    await runCase(browser, runDir, origin, '01 first-run setup and logout-login', {}, async ({ page }) => {
      await setupFirstRun(page, superUser.username, superUser.password);
      await selectNav(page, 'settings', 'settings');
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#btn-logout').click();
      await page.locator('#auth-overlay').waitFor({ state: 'visible' });
      await page.locator('#auth-username').fill(superUser.username);
      await page.locator('#auth-password').fill(superUser.password);
      await page.locator('#auth-submit').click();
      await page.locator('#auth-overlay').waitFor({ state: 'detached' });
    }, results);

    await runCase(browser, runDir, origin, '02 super-admin desktop navigation and user setup', {}, async ({ page }) => {
      await login(page, superUser.username, superUser.password);
      await roleNavAssertions(page,
        ['dashboard', 'generator', 'batches', 'docs', 'analytics', 'payment-inbox', 'customer-accounts', 'settings'], []);
      for (const [nav, view] of [['dashboard', 'dashboard'], ['generator', 'generator'], ['batches', 'batches'],
        ['docs', 'docs'], ['analytics', 'analytics'], ['payment-inbox', 'payment-inbox'],
        ['customer-accounts', 'customer-accounts'], ['settings', 'settings']]) {
        await selectNav(page, nav, view);
      }
      for (const user of users) await createUserThroughUi(page, user);
    }, results);

    await runCase(browser, runDir, origin, '03 password-change overlay for newly created farmer', {}, async ({ page }) => {
      await login(page, users[0].username, users[0].password);
      await page.evaluate(() => window.switchView('docs'));
      await page.locator('#must-change-pw-blocker').waitFor({ state: 'visible' });
    }, results);

    await runCase(browser, runDir, origin, '04 reset disposable role passwords through settings', {}, async ({ page }) => {
      await login(page, superUser.username, superUser.password);
      for (const user of users) await resetPasswordThroughUi(page, user.username, user.password);
    }, results);

    await runCase(browser, runDir, origin, '05 farmer navigation and finance denials', {}, async ({ page, expectedDenials, api: callApi }) => {
      await login(page, users[0].username, users[0].password);
      await roleNavAssertions(page, ['payment-inbox', 'customer-accounts'], ['analytics', 'settings']);
      await selectNav(page, 'customer-accounts', 'customer-accounts');
      expect(!(await page.locator('#customer-credit-note-card').isVisible()), 'Farmer must not see credit-note controls');
      expect(!(await page.locator('#customer-refund-card').isVisible()), 'Farmer must not see refund controls');
      expectedDenials.push(
        { status: 403, method: 'POST', path: '/api/customer-credit-notes' },
        { status: 403, method: 'POST', path: '/api/customer-refunds' }
      );
      expect((await callApi('/api/customer-credit-notes', { method: 'POST', body: {} })).status === 403, 'Farmer credit-note denial');
      expect((await callApi('/api/customer-refunds', { method: 'POST', body: {} })).status === 403, 'Farmer refund denial');
    }, results);

    await runCase(browser, runDir, origin, '06 viewer navigation and finance denials', {}, async ({ page, expectedDenials, api: callApi }) => {
      await login(page, users[1].username, users[1].password);
      await roleNavAssertions(page, ['dashboard'], ['generator', 'payment-inbox', 'customer-accounts']);
      await page.evaluate(() => window.switchView('payment-inbox'));
      expect(await page.locator('#view-dashboard').evaluate(element => element.classList.contains('active')),
        'Viewer direct navigation to Payment Inbox must be redirected to dashboard');
      expectedDenials.push(
        { status: 403, method: 'GET', path: '/api/payment-imports' },
        { status: 403, method: 'POST', path: '/api/customer-credit-notes' },
        { status: 403, method: 'POST', path: '/api/customer-refunds' }
      );
      expect((await callApi('/api/payment-imports?limit=1')).status === 403, 'Viewer inbox read denial');
      expect((await callApi('/api/customer-credit-notes', { method: 'POST', body: {} })).status === 403, 'Viewer credit-note denial');
      expect((await callApi('/api/customer-refunds', { method: 'POST', body: {} })).status === 403, 'Viewer refund denial');
    }, results);

    await runCase(browser, runDir, origin, '07 admin navigation and permitted financial surfaces', {}, async ({ page, api: callApi }) => {
      await login(page, users[2].username, users[2].password);
      await roleNavAssertions(page, ['payment-inbox', 'customer-accounts', 'settings'], []);
      await selectNav(page, 'customer-accounts', 'customer-accounts');
      expect(await page.locator('#customer-credit-note-card').isVisible(), 'Admin should see credit-note controls');
      expect(await page.locator('#customer-refund-card').isVisible(), 'Admin should see refund controls');
      expect((await callApi('/api/payment-imports?limit=1')).status === 200, 'Admin inbox read should work');
    }, results);

    await runCase(browser, runDir, origin, '08 super-admin mobile navigation reachability', {
      viewport: { width: 390, height: 844 }, videoSize: { width: 390, height: 844 }
    }, async ({ page }) => {
      await login(page, superUser.username, superUser.password);
      await page.locator('#btn-hamburger').click();
      await page.locator('#nav-payment-inbox').click();
      await page.locator('#view-payment-inbox').waitFor({ state: 'visible' });
      await page.locator('#btn-hamburger').click();
      await page.locator('#nav-customer-accounts').click();
      await page.locator('#view-customer-accounts').waitFor({ state: 'visible' });
    }, results);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server);
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    if (fs.existsSync(runDir)) {
      const payload = writeEvidence(runDir, results, startedAt, origin);
      process.stdout.write(`Batch 18A: ${payload.totals.passed}/${payload.totals.total} passed. Evidence: ${runDir}\n`);
    }
  }
  const failures = results.filter(result => result.status !== 'passed');
  if (failures.length) process.exitCode = 1;
}

module.exports = {
  main,
  assertSafeConfiguredOrigins,
  copyIsolatedApp,
  classifyConsoleErrors,
  requiredArtifactProblem,
  GENERIC_FORBIDDEN_CONSOLE_ERROR
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Batch 18A failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
