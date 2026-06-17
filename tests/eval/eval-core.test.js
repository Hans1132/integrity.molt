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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
