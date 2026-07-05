'use strict';
// scripts/eval/lib/metrics.js — čisté metriky nad per-token eval výsledky. Žádné I/O.

function distFromRange(score, [lo, hi]) {
  if (score == null) return null;
  if (score < lo) return lo - score;
  if (score > hi) return score - hi;
  return 0;
}

function computeMetrics(rows) {
  const scams = rows.filter(r => r.category === 'scam');
  const clean = rows.filter(r => r.category === 'legit' || r.category === 'edge');

  const scamCaught = scams.filter(r => r.predictedVerdict === 'danger').length;
  const cleanFalsePos = clean.filter(r => r.predictedVerdict === 'danger').length;

  const maes = rows.map(r => distFromRange(r.predictedScore, r.label.score_range)).filter(d => d != null);
  const scoreMae = maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : 0;

  // confusion matrix: category × predictedVerdict
  const matrix = {};
  for (const cat of ['scam', 'legit', 'edge']) {
    matrix[cat] = { safe: 0, caution: 0, danger: 0, unknown: 0 };
    for (const r of rows.filter(x => x.category === cat)) {
      matrix[cat][r.predictedVerdict] = (matrix[cat][r.predictedVerdict] || 0) + 1;
    }
  }

  return {
    n: rows.length,
    recall_scam: scams.length ? scamCaught / scams.length : 0,
    precision_scam: (() => {
      const predictedDanger = rows.filter(r => r.predictedVerdict === 'danger').length;
      return predictedDanger ? scamCaught / predictedDanger : 0;
    })(),
    fpr: clean.length ? cleanFalsePos / clean.length : 0,
    score_mae: Math.round(scoreMae * 1000) / 1000,
    matrix,
  };
}

module.exports = { computeMetrics, distFromRange };
