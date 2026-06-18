'use strict';
const assert = require('node:assert');
const { computeMetrics } = require('../../scripts/eval/lib/metrics');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Per-token eval výsledky: { category, predictedVerdict, predictedScore, label }
const rows = [
  // 2 scamy: 1 chycen (danger), 1 minut (caution) → recall_scam = 0.5
  { category: 'scam', predictedVerdict: 'danger',  predictedScore: 85, label: { score_range: [70, 100] } },
  { category: 'scam', predictedVerdict: 'caution', predictedScore: 55, label: { score_range: [70, 100] } },
  // 2 legit: oba safe → 0 false positive
  { category: 'legit', predictedVerdict: 'safe', predictedScore: 10, label: { score_range: [0, 39] } },
  { category: 'legit', predictedVerdict: 'safe', predictedScore: 20, label: { score_range: [0, 39] } },
  // 1 edge: predikováno danger → false positive
  { category: 'edge', predictedVerdict: 'danger', predictedScore: 80, label: { score_range: [0, 69] } },
];

test('recall_scam = chycené scamy / všechny scamy', () => {
  const m = computeMetrics(rows);
  assert.strictEqual(m.recall_scam, 0.5);
});
test('FPR = clean predikované danger / všechny clean', () => {
  const m = computeMetrics(rows);
  // clean = 2 legit + 1 edge = 3; danger mezi nimi = 1 (edge) → 1/3
  assert.ok(Math.abs(m.fpr - 1 / 3) < 1e-9);
});
test('score MAE počítá odchylku od nejbližší hrany range', () => {
  const m = computeMetrics(rows);
  // scam#2 score 55, range[70,100] → odchylka 15; ostatní v range → 0; edge 80 vs [0,69] → 11
  // MAE = (0 + 15 + 0 + 0 + 11) / 5 = 5.2
  assert.ok(Math.abs(m.score_mae - 5.2) < 1e-9);
});
test('prázdný vstup → nuly, ne NaN', () => {
  const m = computeMetrics([]);
  assert.strictEqual(m.recall_scam, 0);
  assert.strictEqual(m.fpr, 0);
  assert.strictEqual(m.precision_scam, 0);
  assert.strictEqual(m.score_mae, 0);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
