'use strict';
// src/lib/risk-classification.js
// Single source of truth for score → risk_level classification across:
//   - IRIS v2.0 scoring (src/features/iris-score.js)
//   - Metaplex agent flow (src/enrichment/metaplex-agent.js)
//   - Any future scanner using the unified risk taxonomy
//
// 3-tier enum: safe < caution < danger. "unknown" for null/undefined score.
// Thresholds 40/70 — preserved from prior metaplex implementation per
// amendment §1.3 (no evidence base for shifting; deferred to post-deploy
// calibration cycle in amendment §1.4).

function classifyRisk(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return 'unknown';
  if (score >= 70) return 'danger';
  if (score >= 40) return 'caution';
  return 'safe';
}

function isElevatedRisk(label) {
  return label === 'caution' || label === 'danger';
}

module.exports = { classifyRisk, isElevatedRisk };
