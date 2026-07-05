'use strict';
const assert = require('node:assert');
const { checkRegression } = require('../../scripts/eval/check-regression');

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

console.log('\nregression-gate.test.js — Non-Regression Gate\n');

const baseline = { recall_scam: 0.90, fpr: 0.05 };
const TOL = 0.02; // placeholder tolerance — finální hodnota z baseline variability (spec §9)

test('stejné metriky → PASS', () => {
  assert.strictEqual(checkRegression({ recall_scam: 0.90, fpr: 0.05 }, baseline, TOL).pass, true);
});
test('recall klesl pod baseline-tol → FAIL', () => {
  const r = checkRegression({ recall_scam: 0.85, fpr: 0.05 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('recall')));
});
test('FPR stoupl nad baseline+tol → FAIL', () => {
  const r = checkRegression({ recall_scam: 0.90, fpr: 0.09 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('fpr')));
});
test('zlepšení (vyšší recall, nižší FPR) → PASS', () => {
  assert.strictEqual(checkRegression({ recall_scam: 0.95, fpr: 0.02 }, baseline, TOL).pass, true);
});

test('fail-closed: non-numeric baseline metric → pass false', () => {
  const r = checkRegression({ recall_scam: 0.9, fpr: 0.05 }, { recall_scam: 'x', fpr: 0.05 }, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('invalid')));
});
test('fail-closed: missing current metric → pass false', () => {
  const r = checkRegression({ fpr: 0.05 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
});
test('fail-closed: negative tolerance → pass false', () => {
  const r = checkRegression({ recall_scam: 0.9, fpr: 0.05 }, baseline, -0.1);
  assert.strictEqual(r.pass, false);
});
test('fail-closed: null input → pass false', () => {
  const r = checkRegression(null, baseline, TOL);
  assert.strictEqual(r.pass, false);
});

test('boundary: recall exactly at baseline - tol → PASS (inclusive)', () => {
  const r = checkRegression({ recall_scam: 0.88, fpr: 0.05 }, baseline, TOL);
  assert.strictEqual(r.pass, true);
});
test('boundary: fpr exactly at baseline + tol → PASS (inclusive)', () => {
  const r = checkRegression({ recall_scam: 0.90, fpr: 0.07 }, baseline, TOL);
  assert.strictEqual(r.pass, true);
});
test('tolerance of 0 requires exact-or-better metrics', () => {
  assert.strictEqual(checkRegression({ recall_scam: 0.90, fpr: 0.05 }, baseline, 0).pass, true);
  assert.strictEqual(checkRegression({ recall_scam: 0.899999, fpr: 0.05 }, baseline, 0).pass, false);
});
test('both metrics regress simultaneously → both reasons reported', () => {
  const r = checkRegression({ recall_scam: 0.5, fpr: 0.5 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reasons.length, 2);
  assert.ok(r.reasons.some(x => x.includes('recall_scam')));
  assert.ok(r.reasons.some(x => x.includes('fpr')));
});
test('fail-closed: NaN metric value → pass false with invalid_inputs reason', () => {
  const r = checkRegression({ recall_scam: NaN, fpr: 0.05 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('invalid_inputs')));
});
test('fail-closed: Infinity tolerance is finite-checked and rejected', () => {
  const r = checkRegression({ recall_scam: 0.9, fpr: 0.05 }, baseline, Infinity);
  assert.strictEqual(r.pass, false);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
