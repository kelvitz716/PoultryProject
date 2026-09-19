'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EVIDENCE_ROOT,
  expectedScreenshotRelativePaths,
  expectedSafetyScreenshotRelativePath,
  validateThreeStateScreenshots,
  validateWorkflowEvidence,
  capturedEvidenceForWorkflow,
  writeEvidence
} = require('../playwright/batch18b2');

function pngHeader() {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(1440, 16);
  header.writeUInt32BE(900, 20);
  return header;
}

test('Batch 18B2 writes evidence beneath its dedicated root', () => {
  assert.equal(path.basename(EVIDENCE_ROOT), 'batch18b2');
  assert.match(EVIDENCE_ROOT, /evidence[\\/]playwright[\\/]batch18b2$/);
});

test('Batch 18B2 report links the non-writable safety screenshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18b2-report-'));
  const safety = expectedSafetyScreenshotRelativePath('05 batch closure guard');
  try {
    writeEvidence(directory, [{
      name: '05 batch closure guard', status: 'passed', duration_ms: 1, error: null,
      screenshots: [], safety_screenshots: [safety], writable: false,
      trace: null, video: null, readback: { ok: false }
    }], '2026-09-13T00:00:00.000Z', 'http://127.0.0.1:12345');
    assert.match(fs.readFileSync(path.join(directory, 'report.html'), 'utf8'),
      new RegExp(`href="${safety.replaceAll('\\\\', '[\\\\\\\\/]')}"`));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Batch 18B2 rejects duplicate writable primary screenshot content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18b2-contract-'));
  const workflowName = '02 inventory adjustment';
  const screenshots = expectedScreenshotRelativePaths(workflowName);
  try {
    for (const relative of screenshots) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pngHeader());
    }
    assert.match(
      validateThreeStateScreenshots(directory, workflowName, screenshots),
      /must not share a SHA-256 hash/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Batch 18B2 requires writable readback and a complete non-writable safety observation', () => {
  assert.match(
    validateWorkflowEvidence({
      runDir: os.tmpdir(), workflowName: 'writable', captured: [], readback: null, writable: true
    }),
    /must return durable API readback evidence/
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18b2-safety-'));
  const workflowName = '05 batch closure guard';
  const safety = expectedSafetyScreenshotRelativePath(workflowName);
  try {
    assert.match(validateWorkflowEvidence({
      runDir: directory, workflowName, captured: [], readback: { ok: false }, writable: false
    }), /exactly one truthful safety screenshot/);
    const file = path.join(directory, safety);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pngHeader());
    assert.equal(validateWorkflowEvidence({
      runDir: directory, workflowName, captured: [safety], readback: { ok: false }, writable: false
    }), null);
    assert.match(validateWorkflowEvidence({
      runDir: directory, workflowName, captured: [safety], readback: null, writable: false
    }), /must return its safety observation/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Batch 18B2 routes safety captures, not writable captures, to its non-writable gate', () => {
  assert.deepEqual(capturedEvidenceForWorkflow({
    writable: true, captured: ['default', 'filled', 'submitted'], safetyScreenshots: ['safety']
  }), ['default', 'filled', 'submitted']);
  assert.deepEqual(capturedEvidenceForWorkflow({
    writable: false, captured: [], safetyScreenshots: ['safety']
  }), ['safety']);
});
