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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
