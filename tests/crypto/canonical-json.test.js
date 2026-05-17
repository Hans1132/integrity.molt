'use strict';
// tests/crypto/canonical-json.test.js
// Unit testy pro canonicalJSON — deterministic JSON serialization with sorted keys.
// Pure function, zero dependencies, < 10ms runtime.
// Run: node tests/crypto/canonical-json.test.js

const assert = require('assert');
const { canonicalJSON, buildMetaplexAgentPayload } = require('../../src/crypto/sign');

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


// ── buildMetaplexAgentPayload regression tests ────────────────────────────────

test('metaplex agent receipt shape — keys sorted alphabetically (issuer first)', () => {
  const payload = buildMetaplexAgentPayload({
    address: 'So1111111111111111111111111111111111111111112',
    metaplex_agent_audit: {
      registration_uri: 'ar://TX123',
      overall_score: 35,
      risk_level: 'medium',
    },
  });
  const result = canonicalJSON(payload);
  // Sorted: issuer, issuer_kid, subject_metaplex_asset, subject_metaplex_risk,
  //         subject_metaplex_score, subject_metaplex_uri, subject_type
  assert.ok(result.startsWith('{"issuer":'), `expected issuer first, got: ${result.slice(0, 40)}`);
  // asset (subject_metaplex_asset) must appear before risk (subject_metaplex_risk)
  const assetPos = result.indexOf('"subject_metaplex_asset"');
  const riskPos  = result.indexOf('"subject_metaplex_risk"');
  assert.ok(assetPos < riskPos, `asset must come before risk (asset@${assetPos} risk@${riskPos})`);
  // Idempotent
  assert.strictEqual(canonicalJSON(payload), result);
});

test('metaplex receipt — alphabetical order of subject_metaplex_* keys', () => {
  // Deliberately unordered input
  const payload = {
    subject_type:           'metaplex_agent',
    subject_metaplex_uri:   'ar://X',
    subject_metaplex_score: 50,
    subject_metaplex_risk:  'high',
    subject_metaplex_asset: 'ADDR',
    issuer:                 'i',
    issuer_kid:             'k',
  };
  const result = canonicalJSON(payload);
  // Must start with issuer
  assert.ok(result.startsWith('{"issuer":'), `expected issuer first, got: ${result.slice(0, 40)}`);
  // Verify subject_metaplex_* ordering: asset < risk < score < uri < type
  const assetPos = result.indexOf('"subject_metaplex_asset"');
  const riskPos  = result.indexOf('"subject_metaplex_risk"');
  const scorePos = result.indexOf('"subject_metaplex_score"');
  const uriPos   = result.indexOf('"subject_metaplex_uri"');
  const typePos  = result.indexOf('"subject_type"');
  assert.ok(assetPos < riskPos,  `asset must precede risk (asset@${assetPos} risk@${riskPos})`);
  assert.ok(riskPos  < scorePos, `risk must precede score (risk@${riskPos} score@${scorePos})`);
  assert.ok(scorePos < uriPos,   `score must precede uri (score@${scorePos} uri@${uriPos})`);
  assert.ok(uriPos   < typePos,  `uri must precede type (uri@${uriPos} type@${typePos})`);
});

test('metaplex payload with null auditData — null fields serialize correctly', () => {
  const payload = buildMetaplexAgentPayload(null);
  assert.strictEqual(payload.subject_metaplex_asset, null, 'subject_metaplex_asset must be null');
  // Must not throw
  let result;
  assert.doesNotThrow(() => { result = canonicalJSON(payload); });
  // null serializes as JSON null (no quotes)
  assert.ok(result.includes('"subject_metaplex_asset":null'), `expected null field, got: ${result}`);
});

test('existing real-world receipt shape is unchanged after new import', () => {
  const envelope = {
    signer:       'integrity.molt',
    signed_at:    '2026-05-06T00:00:00Z',
    algorithm:    'Ed25519',
    mint_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    risk_score:   12,
    category:     'SAFE',
  };
  const result = canonicalJSON(envelope);
  // Sorted keys: algorithm, category, mint_address, risk_score, signed_at, signer
  assert.ok(result.startsWith('{"algorithm"'), `expected algorithm first, got: ${result.slice(0, 40)}`);
  assert.ok(result.includes('"signer":"integrity.molt"'), 'signer value must be present');
  // Idempotent
  assert.strictEqual(canonicalJSON(envelope), result);
});

// ── Výsledek ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
