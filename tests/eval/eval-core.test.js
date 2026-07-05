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

test('score_range with non-finite values (NaN/Infinity) → error', () => {
  const bad = { ...validEntry, label: { ...validEntry.label, score_range: [0, Infinity] } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('score_range')));
});
test('score_range out of 0..100 bounds → error', () => {
  const bad = { ...validEntry, label: { ...validEntry.label, score_range: [0, 150] } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('score_range')));
});
test('loadAnchor throws when tokens is not an array', () => {
  const { loadAnchor } = require('../../scripts/eval/lib/schema');
  const tmp = require('path').join(process.env.CLAUDE_JOB_DIR || '/tmp', 'tmp', 'bad-anchor.json');
  require('fs').mkdirSync(require('path').dirname(tmp), { recursive: true });
  require('fs').writeFileSync(tmp, JSON.stringify({ _meta: {}, tokens: 'nope' }));
  assert.throws(() => loadAnchor(tmp), /tokens missing or not an array/);
});

// ── Additional schema.js edge cases ────────────────────────────────────────

test('split must be tune|holdout', () => {
  const bad = { ...validEntry, split: 'test' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('split')));
});
test('mint shorter than 32 chars → error', () => {
  const bad = { ...validEntry, mint: 'tooshort' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('mint')));
});
test('non-string mint → error', () => {
  const bad = { ...validEntry, mint: 12345 };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('mint')));
});
test('missing label entirely → verdict + score_range errors, no throw', () => {
  const bad = { ...validEntry, label: undefined };
  const errs = validateGoldEntry(bad);
  assert.ok(errs.some(e => e.includes('verdict')));
  assert.ok(errs.some(e => e.includes('score_range')));
});
test('must_flag not an array → error', () => {
  const bad = { ...validEntry, must_flag: 'not-an-array' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('must_flag')));
});
test('must_not_flag not an array → error', () => {
  const bad = { ...validEntry, must_not_flag: 'not-an-array' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('must_not_flag')));
});
test('missing snapshot.goplus → error', () => {
  const bad = { ...validEntry, snapshot: { enrichment: {} } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('snapshot.goplus')));
});
test('null entry → single generic error, no throw', () => {
  assert.deepStrictEqual(validateGoldEntry(null), ['entry is not an object']);
});
test('valid entry with verdict "danger" and category "scam" passes', () => {
  const entry = { ...validEntry, category: 'scam',
    label: { ...validEntry.label, verdict: 'danger', score_range: [70, 100] } };
  assert.deepStrictEqual(validateGoldEntry(entry), []);
});
test('valid entry with verdict "unknown" passes (empty snapshot)', () => {
  const entry = { ...validEntry, label: { ...validEntry.label, verdict: 'unknown', score_range: [0, 100] } };
  assert.deepStrictEqual(validateGoldEntry(entry), []);
});

// ── Additional eval-core.js coverage: match/mismatch fields + whitelist toggle ──

test('evalToken: mustFlagOk is false when a required factor is absent', () => {
  const token = { category: 'legit', label: { verdict: 'safe', score_range: [0, 39] },
                  must_flag: ['nonexistent_signal_xyz'], must_not_flag: [], snapshot: sampleSnapshot };
  assert.strictEqual(evalToken(token).mustFlagOk, false);
});
test('evalToken: mustNotFlagOk is false when a forbidden factor is present', () => {
  const token = { category: 'legit', label: { verdict: 'safe', score_range: [0, 39] },
                  must_flag: [], must_not_flag: ['freeze_authority_active'], snapshot: sampleSnapshot };
  assert.strictEqual(evalToken(token).mustNotFlagOk, false);
});
test('evalToken: verdictMatch/scoreInRange are false on a mismatched label', () => {
  const token = { category: 'legit', label: { verdict: 'caution', score_range: [40, 69] },
                  must_flag: [], must_not_flag: [], snapshot: sampleSnapshot };
  const r = evalToken(token);
  assert.strictEqual(r.verdictMatch, false);
  assert.strictEqual(r.scoreInRange, false);
});
test('evalToken: opts.whitelistMeta simulates soft-whitelist and lowers score vs. default', () => {
  const token = { category: 'legit', label: { verdict: 'safe', score_range: [0, 39] },
                  must_flag: [], must_not_flag: [], snapshot: sampleSnapshot };
  const baseline = evalToken(token);
  const tier1 = evalToken(token, { whitelistMeta: { tier: 1 } });
  const tier2 = evalToken(token, { whitelistMeta: { tier: 2 } });
  // tier 1 = full (1.0) whitelist strength → strongest reduction; tier !== 1 = 0.7 strength.
  assert.ok(tier1.predictedScore < baseline.predictedScore,
    `tier1 score (${tier1.predictedScore}) should be lower than default (${baseline.predictedScore})`);
  assert.ok(tier1.predictedScore < tier2.predictedScore,
    `tier1 (${tier1.predictedScore}) should reduce more than tier2 (${tier2.predictedScore})`);
  assert.ok(tier2.predictedScore < baseline.predictedScore,
    `tier2 score (${tier2.predictedScore}) should still be lower than default (${baseline.predictedScore})`);
});
test('evalToken: default call (no opts) leaves EVAL_SCAM_DB untouched (no whitelist applied)', () => {
  const token = { category: 'legit', label: { verdict: 'safe', score_range: [0, 39] },
                  must_flag: [], must_not_flag: [], snapshot: sampleSnapshot };
  const r1 = evalToken(token);
  const r2 = evalToken(token, {});
  assert.strictEqual(r1.predictedScore, r2.predictedScore, 'no opts and empty opts must behave identically');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
