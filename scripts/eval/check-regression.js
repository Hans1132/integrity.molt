'use strict';
// scripts/eval/check-regression.js — non-regression brána proti baseline.json.
// Čistá funkce checkRegression + CLI wrapper. Tolerance = parametr (z baseline variability, spec §9).
const fs = require('fs');

function checkRegression(current, baseline, tol) {
  const reasons = [];
  if (current.recall_scam < baseline.recall_scam - tol) {
    reasons.push(`recall_scam ${current.recall_scam.toFixed(3)} < baseline ${baseline.recall_scam.toFixed(3)} - tol ${tol}`);
  }
  if (current.fpr > baseline.fpr + tol) {
    reasons.push(`fpr ${current.fpr.toFixed(3)} > baseline ${baseline.fpr.toFixed(3)} + tol ${tol}`);
  }
  return { pass: reasons.length === 0, reasons };
}

function main() {
  const baselinePath = 'data/ground-truth/baseline.json';
  if (!fs.existsSync(baselinePath)) {
    console.log('[regression] ⏭  baseline.json chybí — SKIP (zmraz přes freeze-baseline.js po seedu)');
    process.exit(0); // neblokuj dokud baseline neexistuje
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const { evalToken } = require('./lib/eval-core');
  const { computeMetrics } = require('./lib/metrics');
  const { loadAnchor } = require('./lib/schema');
  const data = loadAnchor('data/ground-truth/gold-v1.json');
  const rows = data.tokens.filter(t => t.split === 'tune').map(evalToken);
  const current = computeMetrics(rows);
  const tol = baseline.tolerance ?? 0.02; // finální hodnota z baseline variability
  const res = checkRegression(current, baseline, tol);
  if (res.pass) { console.log('[regression] ✅ PASS'); process.exit(0); }
  console.error('[regression] ❌ FAIL:\n' + res.reasons.map(r => '  - ' + r).join('\n'));
  process.exit(1);
}

if (require.main === module) main();
module.exports = { checkRegression };
