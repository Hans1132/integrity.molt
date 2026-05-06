'use strict';
// tests/security/path-traversal.test.js
// Regresní test pro CRITICAL-2: path traversal na /report/download
// Commit 1840ab5 — opraveno pomocí path.resolve + startsWith(REPORTS_DIR + path.sep).
// Testuje logiku sanitizace přímo bez HTTP (bez závislosti na portu 3402).
// Run: node tests/security/path-traversal.test.js

const assert = require('assert');
const path   = require('path');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

// Replika logiky z server.js /report/download route (commit 1840ab5)
const REPORTS_DIR = path.resolve('/root/scanner/reports');

function isPathSafe(filename) {
  if (!filename) return false;
  const resolved = path.resolve(REPORTS_DIR, filename);
  return resolved.startsWith(REPORTS_DIR + path.sep);
}

console.log('\npath-traversal.test.js\n');

// ── Musí projít (legitimní cesty) ────────────────────────────────────────────

test('plain filename passes', () => {
  assert.strictEqual(isPathSafe('report-USDC-2026-05-06.txt'), true);
});

test('filename with extension passes', () => {
  assert.strictEqual(isPathSafe('scan-EPjFW.signed.json'), true);
});

// ── Musí být odmítnuto (traversal pokusy) ────────────────────────────────────

test('../../../etc/passwd is rejected', () => {
  assert.strictEqual(isPathSafe('../../../etc/passwd'), false);
});

test('one level up is rejected', () => {
  assert.strictEqual(isPathSafe('../other-dir/file.txt'), false);
});

test('URL-encoded traversal ..%2F..%2Fetc%2Fpasswd is rejected after decode', () => {
  // decodeURIComponent simuluje co Express dělá při parsování path parametrů
  const decoded = decodeURIComponent('..%2F..%2Fetc%2Fpasswd');
  assert.strictEqual(isPathSafe(decoded), false);
});

test('sibling directory (REPORTS_DIR-evil) is rejected by sep check', () => {
  // path.resolve('/root/scanner/reports', '/root/scanner/reports-evil/file') →
  // startsWith('/root/scanner/reports/') → false (missing trailing sep)
  const sibling = '/root/scanner/reports-evil/file.txt';
  assert.strictEqual(isPathSafe(sibling), false);
});

test('empty string is rejected', () => {
  assert.strictEqual(isPathSafe(''), false);
});

test('null is rejected', () => {
  assert.strictEqual(isPathSafe(null), false);
});

test('absolute path outside REPORTS_DIR is rejected', () => {
  assert.strictEqual(isPathSafe('/etc/shadow'), false);
});

test('dot-only path is rejected', () => {
  // path.resolve(REPORTS_DIR, '.') === REPORTS_DIR — chybí sep suffix
  assert.strictEqual(isPathSafe('.'), false);
});

// ── Výsledek ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
