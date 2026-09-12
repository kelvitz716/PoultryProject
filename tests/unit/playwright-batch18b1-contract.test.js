'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertSafeConfiguredOrigins,
  copyTreeIsolated,
  expectedScreenshotRelativePaths,
  validateThreeStateScreenshots,
  stagingModuleCounts,
  WORKFLOW_STATES
} = require('../playwright/batch18b1');

function pngHeader(width = 1440, height = 900) {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

test('Batch 18B1 refuses configured target origins and command-line arguments', () => {
  assert.doesNotThrow(() => assertSafeConfiguredOrigins({}, []));
  assert.throws(() => assertSafeConfiguredOrigins({ BASE_URL: 'https://farm.example' }, []),
    /refuses non-loopback BASE_URL/);
  assert.throws(() => assertSafeConfiguredOrigins({ PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3000' }, []),
    /owns a fresh copied app/);
  assert.throws(() => assertSafeConfiguredOrigins({}, ['https://farm.example']), /accepts no command-line/);
});

test('isolated copy excludes repository, secrets, database data, and evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18b1-copy-test-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'server.js'), 'server');
    for (const excluded of ['.git', 'data', 'evidence']) {
      fs.mkdirSync(path.join(source, excluded));
      fs.writeFileSync(path.join(source, excluded, 'private'), 'private');
    }
    fs.writeFileSync(path.join(source, '.env'), 'SECRET=value');
    copyTreeIsolated(source, target);
    assert.equal(fs.readFileSync(path.join(target, 'server.js'), 'utf8'), 'server');
    for (const excluded of ['.git', '.env', 'data', 'evidence']) {
      assert.equal(fs.existsSync(path.join(target, excluded)), false, `${excluded} must be excluded`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each writable workflow has exactly three ordered deterministic screenshot states', () => {
  assert.deepEqual(WORKFLOW_STATES.map(state => state.key), ['default', 'filled', 'submitted']);
  assert.deepEqual(expectedScreenshotRelativePaths('02 daily operational log'), [
    path.join('screenshots', '02-daily-operational-log', '01-default.png'),
    path.join('screenshots', '02-daily-operational-log', '02-filled-not-submitted.png'),
    path.join('screenshots', '02-daily-operational-log', '03-submitted-confirmed.png')
  ]);
});

test('three-state screenshot gate rejects missing, extra, and out-of-order evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18b1-screenshot-test-'));
  const workflow = '03 egg collection';
  const expected = expectedScreenshotRelativePaths(workflow);
  try {
    for (const relative of expected) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pngHeader());
    }
    assert.equal(validateThreeStateScreenshots(root, workflow, expected), null);
    assert.match(validateThreeStateScreenshots(root, workflow, [...expected].reverse()), /out of order/);

    fs.writeFileSync(path.join(root, 'screenshots', '03-egg-collection', '04-extra.png'), pngHeader());
    assert.match(validateThreeStateScreenshots(root, workflow, expected), /exactly three/);
    fs.rmSync(path.join(root, 'screenshots', '03-egg-collection', '04-extra.png'));

    fs.rmSync(path.join(root, expected[1]));
    assert.match(validateThreeStateScreenshots(root, workflow, expected), /exactly three/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staging readback counts all supported Batch 18B1 daily modules and no water module', () => {
  const counts = stagingModuleCounts({
    eggs: { collections: [{ id: 'egg-1' }] },
    feed: { events: [{ id: 'feed-1' }] },
    mortality: { events: [{ id: 'mortality-1' }] },
    sensors: { sample_count: 1 },
    gases: [{ id: 'gas-1' }],
    notes: [{ id: 'note-1' }]
  });
  assert.deepEqual(counts, { eggs: 1, feed: 1, mortality: 1, sensors: 1, gases: 1, notes: 1 });
  assert.equal(Object.hasOwn(counts, 'water'), false);
});
