'use strict';
// scripts/eval/freeze-baseline.js — zmrazí aktuální tune-split metriky jako referenci pro regresní bránu.
// Spouštět AŽ po naplnění gold anchoru reálnými snapshoty (deferred calibration, spec §7).
// Usage: node scripts/eval/freeze-baseline.js
const fs = require('fs');
const { loadAnchor } = require('./lib/schema');
const { evalToken } = require('./lib/eval-core');
const { computeMetrics } = require('./lib/metrics');

const data = loadAnchor('data/ground-truth/gold-v1.json');
const rows = data.tokens.filter(t => t.split === 'tune').map(evalToken);
const metrics = computeMetrics(rows);
const baseline = {
  frozen_at: new Date().toISOString(),
  rules_version: require('../../data/rules-v2.json').version,
  anchor_version: data._meta.version,
  split: 'tune', n: metrics.n,
  recall_scam: metrics.recall_scam,
  fpr: metrics.fpr,
  score_mae: metrics.score_mae,
};
fs.writeFileSync('data/ground-truth/baseline.json', JSON.stringify(baseline, null, 2));
console.log('[baseline] frozen:', JSON.stringify(baseline, null, 2));
