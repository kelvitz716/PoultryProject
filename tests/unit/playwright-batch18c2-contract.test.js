'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EVIDENCE_ROOT,
  assertSafeConfiguredOrigins,
  expectedScreenshotRelativePaths,
  sourceTreeDigest,
  writeEvidence
} = require('../playwright/batch18c2');

test('Batch 18C.2 owns its dedicated finance evidence root and refuses targets', () => {
  assert.match(EVIDENCE_ROOT, /evidence[\\/]playwright[\\/]batch18c2$/);
  assert.throws(() => assertSafeConfiguredOrigins({}, ['https://example.test']), /accepts no command-line target/);
  assert.throws(() => assertSafeConfiguredOrigins({ BATCH18C2_ORIGIN: 'https://example.test' }, []), /refuses non-loopback/);
  assert.throws(() => assertSafeConfiguredOrigins({ BATCH18C2_ORIGIN: 'http://127.0.0.1:9999' }, []), /does not accept/);
});

test('Batch 18C.2 source-tree digest is deterministic and excludes runtime data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18c2-digest-'));
  try {
    fs.mkdirSync(path.join(directory, 'nested'));
    fs.mkdirSync(path.join(directory, 'data'));
    fs.writeFileSync(path.join(directory, 'nested', 'b.txt'), 'beta');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(directory, 'data', 'runtime.db'), 'first');
    const first = sourceTreeDigest(directory);
    fs.writeFileSync(path.join(directory, 'data', 'runtime.db'), 'second');
    const second = sourceTreeDigest(directory);
    assert.deepEqual(second, first, 'runtime database content must not alter the copied-source digest');
    fs.writeFileSync(path.join(directory, 'nested', 'b.txt'), 'changed');
    assert.notEqual(sourceTreeDigest(directory).digest, first.digest, 'copied source content must alter the digest');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Batch 18C.2 results and manifest require the recorded copied-app digest', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18c2-evidence-'));
  const digest = { algorithm: 'sha256', digest: 'a'.repeat(64), file_count: 1 };
  try {
    const screenshot = expectedScreenshotRelativePaths('02 payment inbox rejection');
    for (const relative of screenshot) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    // The report writer's source-digest obligation is independent of media validity.
    writeEvidence(directory, [], '2026-09-13T00:00:00.000Z', 'http://127.0.0.1:12345', digest);
    const results = JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'evidence-manifest.json'), 'utf8'));
    assert.deepEqual(results.copied_app_source_tree, digest);
    assert.deepEqual(manifest.copied_app_source_tree, digest);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
