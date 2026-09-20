'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('release browser evidence command runs every isolated workflow suite', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['test:playwright:release'],
    'npm run test:playwright:batch18a:twice && npm run test:playwright:batch18b1 && npm run test:playwright:batch18b2 && npm run test:playwright:batch18c1 && npm run test:playwright:batch18c2');
});

const {
  classifyConsoleErrors,
  requiredArtifactProblem,
  GENERIC_FORBIDDEN_CONSOLE_ERROR
} = require('../playwright/batch18a');

function fixtureCrc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum & 1) ? (0xedb88320 ^ (checksum >>> 1)) : (checksum >>> 1);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [entryName, value] of entries) {
    const name = Buffer.from(entryName);
    const content = Buffer.from(value);
    const crc = fixtureCrc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function pngHeader(width = 1440, height = 900) {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

test('required artifact gate rejects absent and zero-byte evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18a-artifact-test-'));
  try {
    const missing = path.join(directory, 'missing.webm');
    assert.match(requiredArtifactProblem('video', missing), /missing or unreadable/);

    const empty = path.join(directory, 'empty.zip');
    fs.writeFileSync(empty, '');
    assert.match(requiredArtifactProblem('trace', empty), /zero-byte/);

  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('screenshot gate accepts sane PNG headers and rejects invalid signatures or dimensions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18a-png-test-'));
  try {
    const valid = path.join(directory, 'valid.png');
    fs.writeFileSync(valid, pngHeader());
    assert.equal(requiredArtifactProblem('screenshot', valid), null);

    const badSignature = path.join(directory, 'bad-signature.png');
    fs.writeFileSync(badSignature, Buffer.alloc(24));
    assert.match(requiredArtifactProblem('screenshot', badSignature), /invalid PNG signature/);

    const badDimensions = path.join(directory, 'bad-dimensions.png');
    fs.writeFileSync(badDimensions, pngHeader(0, 900));
    assert.match(requiredArtifactProblem('screenshot', badDimensions), /invalid PNG dimensions/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('video gate accepts a WebM EBML header and rejects wrong or non-WebM headers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18a-webm-test-'));
  try {
    const validHeader = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d
    ]);
    const valid = path.join(directory, 'valid.webm');
    fs.writeFileSync(valid, validHeader);
    assert.equal(requiredArtifactProblem('video', valid), null);

    const badSignature = path.join(directory, 'bad-signature.webm');
    fs.writeFileSync(badSignature, Buffer.from('not-webm'));
    assert.match(requiredArtifactProblem('video', badSignature), /invalid WebM\/EBML signature/);

    const wrongDocType = path.join(directory, 'wrong-doctype.webm');
    fs.writeFileSync(wrongDocType, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x6d, 0x61, 0x74, 0x72]));
    assert.match(requiredArtifactProblem('video', wrongDocType), /no WebM document type/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('trace gate validates ZIP integrity and required Playwright trace entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch18a-trace-test-'));
  try {
    const validArchive = storedZip([
      ['trace.trace', 'trace events'],
      ['trace.network', 'network events']
    ]);
    const valid = path.join(directory, 'valid.zip');
    fs.writeFileSync(valid, validArchive);
    assert.equal(requiredArtifactProblem('trace', valid), null);

    const corrupt = path.join(directory, 'corrupt.zip');
    const corruptArchive = Buffer.from(validArchive);
    corruptArchive[30 + Buffer.byteLength('trace.trace')] ^= 0xff;
    fs.writeFileSync(corrupt, corruptArchive);
    assert.match(requiredArtifactProblem('trace', corrupt), /size\/CRC validation/);

    const missingEntry = path.join(directory, 'missing-entry.zip');
    fs.writeFileSync(missingEntry, storedZip([['trace.trace', 'trace events']]));
    assert.match(requiredArtifactProblem('trace', missingEntry), /missing required entry: trace.network/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('console gate allows one exact generic 403 error per matched expected denial', () => {
  const matched = [{ status: 403, method: 'POST', path: '/api/customer-refunds' }];
  assert.deepEqual(classifyConsoleErrors([GENERIC_FORBIDDEN_CONSOLE_ERROR], matched), {
    allowed: [GENERIC_FORBIDDEN_CONSOLE_ERROR],
    unexpected: []
  });

  const surplus = classifyConsoleErrors(
    [GENERIC_FORBIDDEN_CONSOLE_ERROR, GENERIC_FORBIDDEN_CONSOLE_ERROR], matched
  );
  assert.equal(surplus.allowed.length, 1);
  assert.deepEqual(surplus.unexpected, [GENERIC_FORBIDDEN_CONSOLE_ERROR]);
});

test('console gate rejects generic 403 noise without a matched denial and all other errors', () => {
  assert.deepEqual(classifyConsoleErrors([GENERIC_FORBIDDEN_CONSOLE_ERROR], []), {
    allowed: [],
    unexpected: [GENERIC_FORBIDDEN_CONSOLE_ERROR]
  });
  assert.deepEqual(classifyConsoleErrors(['ReferenceError: broken is not defined'], [{ status: 403 }]), {
    allowed: [],
    unexpected: ['ReferenceError: broken is not defined']
  });
});
