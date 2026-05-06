'use strict';
// tests/crypto/canonical-json.test.js
// Unit testy pro canonicalJSON — deterministic JSON serialization with sorted keys.
// Pure function, zero dependencies, < 10ms runtime.
// Run: node tests/crypto/canonical-json.test.js

const assert = require('assert');
const { canonicalJSON } = require('../../src/crypto/sign');

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

console.log('\ncanonical-json.test.js\n');

// ── Objekty ───────────────────────────────────────────────────────────────────

test('sorts object keys alphabetically', () => {
  assert.strictEqual(canonicalJSON({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test('reverse-ordered keys produce identical output to forward-ordered', () => {
  assert.strictEqual(
    canonicalJSON({ z: 3, y: 2, x: 1 }),
    canonicalJSON({ x: 1, y: 2, z: 3 })
  );
});

test('nested object — keys sorted recursively', () => {
  assert.strictEqual(
    canonicalJSON({ outer: { z: 1, a: 2 } }),
    '{"outer":{"a":2,"z":1}}'
  );
});

test('3+ levels deep nesting — all levels sorted', () => {
  const input = { c: { b: { a: 1, z: 99 }, x: 0 }, a: 'top' };
  assert.strictEqual(
    canonicalJSON(input),
    '{"a":"top","c":{"b":{"a":1,"z":99},"x":0}}'
  );
});

test('empty object', () => {
  assert.strictEqual(canonicalJSON({}), '{}');
});

// ── Pole ──────────────────────────────────────────────────────────────────────

test('array of objects — object keys sorted, array element order preserved', () => {
  const input = {
    findings: [
      { severity: 'high', rule: 'drain' },
      { rule: 'phish', severity: 'low' },
    ],
  };
  assert.strictEqual(
    canonicalJSON(input),
    '{"findings":[{"rule":"drain","severity":"high"},{"rule":"phish","severity":"low"}]}'
  );
});

test('array of primitives — order preserved, no transformation', () => {
  assert.strictEqual(canonicalJSON({ tags: ['b', 'a', 'c'] }), '{"tags":["b","a","c"]}');
});

test('top-level array of objects — keys inside sorted', () => {
  assert.strictEqual(
    canonicalJSON([{ b: 2, a: 1 }]),
    '[{"a":1,"b":2}]'
  );
});

test('empty array', () => {
  assert.strictEqual(canonicalJSON([]), '[]');
});

// ── Primitiva ─────────────────────────────────────────────────────────────────

test('null passthrough', () => {
  assert.strictEqual(canonicalJSON(null), 'null');
});

test('boolean passthrough', () => {
  assert.strictEqual(canonicalJSON(true), 'true');
  assert.strictEqual(canonicalJSON(false), 'false');
});

test('number passthrough — integer and float', () => {
  assert.strictEqual(canonicalJSON(42), '42');
  assert.strictEqual(canonicalJSON(3.14), '3.14');
  assert.strictEqual(canonicalJSON(0), '0');
});

test('string passthrough with JSON escaping', () => {
  assert.strictEqual(canonicalJSON('hello'), '"hello"');
  assert.strictEqual(canonicalJSON('say "hi"'), '"say \\"hi\\""');
});

// ── Signed receipt regression: fields known to exist in real envelopes ────────

test('real-world receipt shape — sorted deterministically', () => {
  const envelope = {
    signer:     'integrity.molt',
    signed_at:  '2026-05-06T00:00:00Z',
    algorithm:  'Ed25519',
    mint_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    risk_score: 12,
    category:   'SAFE',
  };
  const result = canonicalJSON(envelope);
  // Sorted keys: algorithm, category, mint_address, risk_score, signed_at, signer
  assert.ok(result.startsWith('{"algorithm"'), `expected sorted start, got: ${result.slice(0, 30)}`);
  assert.ok(result.includes('"signer":"integrity.molt"'), 'signer must be present');
  // Idempotent: same input always produces same output
  assert.strictEqual(canonicalJSON(envelope), result);
});

// ── Výsledek ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
