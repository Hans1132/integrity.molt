'use strict';
const assert = require('node:assert');
const { computeMetrics, distFromRange } = require('../../scripts/eval/lib/metrics');

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

// ── distFromRange (direct, exported pure helper) ────────────────────────────
test('distFromRange: score below range → distance to lo', () => {
  assert.strictEqual(distFromRange(5, [10, 20]), 5);
});
test('distFromRange: score above range → distance to hi', () => {
  assert.strictEqual(distFromRange(25, [10, 20]), 5);
});
test('distFromRange: score inside range → 0', () => {
  assert.strictEqual(distFromRange(15, [10, 20]), 0);
});
test('distFromRange: score on the exact boundary → 0', () => {
  assert.strictEqual(distFromRange(10, [10, 20]), 0);
  assert.strictEqual(distFromRange(20, [10, 20]), 0);
});
test('distFromRange: null score → null (excluded from MAE, not treated as 0)', () => {
  assert.strictEqual(distFromRange(null, [10, 20]), null);
});

// ── precision_scam ───────────────────────────────────────────────────────────
test('precision_scam = correctly-caught scams / all danger predictions (incl. false positives)', () => {
  const precRows = [
    { category: 'scam',  predictedVerdict: 'danger', predictedScore: 90, label: { score_range: [70, 100] } },
    { category: 'scam',  predictedVerdict: 'danger', predictedScore: 95, label: { score_range: [70, 100] } },
    { category: 'legit', predictedVerdict: 'danger', predictedScore: 80, label: { score_range: [0, 39] } },
  ];
  const m = computeMetrics(precRows);
  assert.ok(Math.abs(m.precision_scam - 2 / 3) < 1e-9);
});

// ── confusion matrix ─────────────────────────────────────────────────────────
test('matrix tallies category × predictedVerdict, including "unknown" verdicts', () => {
  const matrixRows = [
    { category: 'scam',  predictedVerdict: 'danger',  predictedScore: 90, label: { score_range: [70, 100] } },
    { category: 'scam',  predictedVerdict: 'unknown', predictedScore: null, label: { score_range: [70, 100] } },
    { category: 'edge',  predictedVerdict: 'unknown', predictedScore: null, label: { score_range: [0, 100] } },
    { category: 'legit', predictedVerdict: 'safe',    predictedScore: 5,  label: { score_range: [0, 39] } },
  ];
  const m = computeMetrics(matrixRows);
  assert.strictEqual(m.matrix.scam.danger, 1);
  assert.strictEqual(m.matrix.scam.unknown, 1);
  assert.strictEqual(m.matrix.scam.safe, 0);
  assert.strictEqual(m.matrix.edge.unknown, 1);
  assert.strictEqual(m.matrix.legit.safe, 1);
  assert.strictEqual(m.matrix.legit.danger, 0);
});

// ── fpr with no clean tokens ─────────────────────────────────────────────────
test('fpr = 0 (not NaN) when there are no legit/edge rows at all', () => {
  const onlyScamRows = [
    { category: 'scam', predictedVerdict: 'danger', predictedScore: 90, label: { score_range: [70, 100] } },
  ];
  const m = computeMetrics(onlyScamRows);
  assert.strictEqual(m.fpr, 0);
});

// ── score_mae excludes null-score rows and rounds to 3 decimals ────────────
test('score_mae ignores rows with null predictedScore (does not treat them as 0 error)', () => {
  const rows = [
    { category: 'scam', predictedVerdict: 'unknown', predictedScore: null, label: { score_range: [70, 100] } },
    { category: 'scam', predictedVerdict: 'danger',  predictedScore: 80,  label: { score_range: [70, 100] } },
  ];
  const m = computeMetrics(rows);
  // only the second row contributes (dist=0); the null-score row must not drag the average toward 0/70
  assert.strictEqual(m.score_mae, 0);
});
test('score_mae rounds the average to 3 decimal places', () => {
  const rows = [
    { category: 'scam', predictedVerdict: 'danger', predictedScore: 10, label: { score_range: [9, 9] } },
    { category: 'scam', predictedVerdict: 'danger', predictedScore: 10, label: { score_range: [9, 9] } },
    { category: 'scam', predictedVerdict: 'danger', predictedScore: 11, label: { score_range: [9, 9] } },
  ];
  const m = computeMetrics(rows);
  assert.strictEqual(m.score_mae, 1.333);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
