'use strict';
// scripts/eval/lib/eval-core.js — per-token eval přes produkční IRIS v2. Žádné RPC (snapshot only).
const { calculateIRIS_v2 } = require('../../../src/features/iris-score');

// Leakage guard: prázdný scamDb vypne Floor 1 (known_scam soft floor) i soft whitelist
// (viz iris-score.js calculateIRIS_v2). Skóre tak měří enrichment-derived dimenze, ne DB label.
const EVAL_SCAM_DB = Object.freeze({ known_scam: null, scam_creators: null, whitelisted: false, rugcheck: null });

function evalToken(token) {
  const { enrichment, goplus } = token.snapshot;
  const iris = calculateIRIS_v2(enrichment, EVAL_SCAM_DB, goplus);
  const predictedVerdict = iris.risk_level;            // 'safe'|'caution'|'danger'|'unknown'
  const predictedScore = iris.score;                   // 0..100 | null
  const factors = iris.risk_factors || [];
  const [lo, hi] = token.label.score_range;
  return {
    category: token.category,
    predictedVerdict,
    predictedScore,
    label: token.label,
    verdictMatch: predictedVerdict === token.label.verdict,
    scoreInRange: predictedScore != null && predictedScore >= lo && predictedScore <= hi,
    mustFlagOk: (token.must_flag || []).every(f => factors.includes(f)),
    mustNotFlagOk: (token.must_not_flag || []).every(f => !factors.includes(f)),
    risk_factors: factors,
  };
}

module.exports = { evalToken, EVAL_SCAM_DB };
