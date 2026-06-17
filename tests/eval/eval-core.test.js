'use strict';
const assert = require('node:assert');
const { validateGoldEntry } = require('../../scripts/eval/lib/schema');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log('\neval-core.test.js — Gold Schema Validation\n');

const validEntry = {
  id: 'gt-0001', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC', category: 'legit', split: 'tune',
  label: { verdict: 'safe', score_range: [0, 39], scam_type: null,
           anchor_confidence: 1.0, verified_at: '2026-06-15', verified_by: 'hans', rationale: 'Circle stablecoin' },
  sources: [{ name: 'onchain', verdict: 'confirmed' }],
  snapshot: { enrichment: {}, goplus: {} },
  must_flag: [], must_not_flag: ['authority_active'],
};

test('valid entry passes', () => {
  assert.deepStrictEqual(validateGoldEntry(validEntry), []);
});
test('missing snapshot.enrichment → error', () => {
  const bad = { ...validEntry, snapshot: { goplus: {} } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('snapshot.enrichment')));
});
test('verdict must be lowercase enum', () => {
  const bad = { ...validEntry, label: { ...validEntry.label, verdict: 'SAFE' } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('verdict')));
});
test('category must be scam|legit|edge', () => {
  const bad = { ...validEntry, category: 'safe' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('category')));
});
test('missing sources[] → error', () => {
  const bad = { ...validEntry, sources: [] };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('sources')));
});
test('score_range with non-number values → error', () => {
  const bad = { ...validEntry, label: { ...validEntry.label, score_range: ['a', 'b'] } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('score_range')));
});
test('score_range with lo > hi → error', () => {
  const bad = { ...validEntry, label: { ...validEntry.label, score_range: [40, 10] } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('score_range')));
});
test('empty id → error', () => {
  const bad = { ...validEntry, id: '' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('id')));
});

// ── Task 4: eval-core + leakage guard ─────────────────────────────────────
const { evalToken, EVAL_SCAM_DB } = require('../../scripts/eval/lib/eval-core');
const { calculateIRIS_v2 } = require('../../src/features/iris-score');
const sampleSnapshot = require('./fixtures/sample-enrichment.json');

test('LEAKAGE GUARD: empty scamDb yields LOW score; injected known_scam floors it high', () => {
  const { enrichment, goplus } = sampleSnapshot;
  const guarded = calculateIRIS_v2(enrichment, EVAL_SCAM_DB, goplus);
  const leaked  = calculateIRIS_v2(enrichment, { known_scam: { confidence: 0.9 }, scam_creators: null, whitelisted: false }, goplus);
  // Guard path must NOT apply the known_scam floor:
  assert.ok(guarded.score < 86, `guarded score should be below soft floor 86, got ${guarded.score}`);
  // Leaked path (real scamDb) WOULD apply Floor 1 (50 + 0.9*40 = 86):
  assert.ok(leaked.score >= 86, `leaked score should hit floor >=86, got ${leaked.score}`);
  // Proves EVAL_SCAM_DB bypasses the leakage floor:
  assert.ok(guarded.score < leaked.score, 'guard must produce a strictly lower score than the leaked path');
});

test('EVAL_SCAM_DB is frozen and carries no known_scam / whitelist', () => {
  assert.strictEqual(EVAL_SCAM_DB.known_scam, null);
  assert.strictEqual(EVAL_SCAM_DB.whitelisted, false);
  assert.ok(Object.isFrozen(EVAL_SCAM_DB));
});

test('evalToken is deterministic (same snapshot → same score) and returns match fields', () => {
  const token = { category: 'legit', label: { verdict: 'safe', score_range: [0, 39] },
                  must_flag: [], must_not_flag: ['nonexistent_factor_xyz'], snapshot: sampleSnapshot };
  const r1 = evalToken(token);
  const r2 = evalToken(token);
  assert.strictEqual(r1.predictedScore, r2.predictedScore, 'eval must be deterministic');
  assert.ok('verdictMatch' in r1 && 'scoreInRange' in r1 && 'mustFlagOk' in r1 && 'mustNotFlagOk' in r1);
  assert.strictEqual(r1.mustNotFlagOk, true, 'a non-existent factor must not be flagged');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
