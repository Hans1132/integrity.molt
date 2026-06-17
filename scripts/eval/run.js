'use strict';
// scripts/eval/run.js — načte gold anchor, spustí eval, zapíše report + metriky.
// Běží jako čerstvý proces → načte aktuální rules-v2.json (module-init load v iris-score.js).
// Usage: node scripts/eval/run.js [--anchor data/ground-truth/gold-v1.json] [--split tune|holdout|all]
const fs = require('fs');
const path = require('path');
const { loadAnchor } = require('./lib/schema');
const { evalToken } = require('./lib/eval-core');
const { computeMetrics } = require('./lib/metrics');

function arg(k, d) { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; }

function main() {
  const anchorPath = arg('--anchor', 'data/ground-truth/gold-v1.json');
  const splitFilter = arg('--split', 'tune');
  const data = loadAnchor(anchorPath);
  const tokens = data.tokens.filter(t => splitFilter === 'all' || t.split === splitFilter);

  const rows = tokens.map(evalToken);
  const metrics = computeMetrics(rows);
  const rulesVersion = require('../../data/rules-v2.json').version;

  const report = {
    generated_at: new Date().toISOString(),
    anchor: anchorPath, anchor_version: data._meta.version,
    rules_version: rulesVersion, split: splitFilter,
    metrics,
    failures: rows.filter(r => !r.verdictMatch || !r.scoreInRange || !r.mustFlagOk || !r.mustNotFlagOk)
      .map(r => ({ category: r.category, predicted: r.predictedVerdict, score: r.predictedScore,
                   expected: r.label.verdict, verdictMatch: r.verdictMatch, scoreInRange: r.scoreInRange,
                   mustFlagOk: r.mustFlagOk, mustNotFlagOk: r.mustNotFlagOk, risk_factors: r.risk_factors })),
  };

  const ts = report.generated_at.replace(/[:.]/g, '-');
  const outDir = 'data/ground-truth/reports';
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `eval-${rulesVersion}-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\n━━━ EVAL ${rulesVersion} [${splitFilter}] ━━━`);
  console.log(`n=${metrics.n}  recall_scam=${metrics.recall_scam.toFixed(3)}  fpr=${metrics.fpr.toFixed(3)}  mae=${metrics.score_mae.toFixed(3)}`);
  console.log(`failures: ${report.failures.length}`);
  console.log(`report: ${outFile}\n`);
  return report;
}

if (require.main === module) main();
module.exports = { main };
