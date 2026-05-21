'use strict';
// tests/iris/iris-calibration.test.js — accuracy gate against labeled dataset.
//
// Runs each mint through live /scan/v1/ endpoint, classifies score, asserts targets per
// amendment v2 §4 (Bucket targets aligned to preserved 40/70 thresholds):
//   Bucket A — confirmed scams: ≥95% score ≥ 70
//   Bucket B — tier-1 whitelist: ≥95% score ≤ 39
//   Bucket C — unlabeled: ≥30% in [40, 70] (continuous scoring goal)
//   Bucket D — 5pdyeWSC regression: score ≥ 51 (amendment v3 §3.3 projects 64)
//
// Until backend Phase 2A/2C deploys v2 to the live service, this gate runs against v1.
// Expected v1 behavior: Bucket A passes (known_scams hits floor 76), Bucket B passes
// (whitelist override), Bucket D passes (RC danger step floor 51), Bucket C FAILS
// (bimodal 0/76, ~5% in [40,70]). That is the documented RED state for qa Phase 2B.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCAN_URL_BASE = process.env.SCAN_URL_BASE || 'http://localhost:3402';

const dataset = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'calibration-v2.json'), 'utf8'),
);

async function scanMint(mint) {
  const url = `${SCAN_URL_BASE}/scan/v1/${encodeURIComponent(mint)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'X-MCP-Caller': 'qa-calibration' },
    });
    if (!res.ok) return { mint, score: null, risk_level: 'unknown', error: `HTTP ${res.status}` };
    const j = await res.json();
    return {
      mint,
      score: j.iris_score,
      risk_level: j.risk_level,
      iris_version: j.iris_version,
    };
  } catch (err) {
    return { mint, score: null, risk_level: 'unknown', error: err.message };
  } finally {
    clearTimeout(t);
  }
}

async function scanAll(items) {
  const out = [];
  // Sequential to avoid hammering the live service.
  for (const it of items) {
    out.push({ ...it, ...(await scanMint(it.mint)) });
  }
  return out;
}

test('Bucket A — confirmed scams: ≥95% score ≥70', { timeout: 300_000 }, async () => {
  const results = await scanAll(dataset.bucket_a_scams);
  const passed = results.filter(r => r.score !== null && r.score >= 70);
  const precision = passed.length / results.length;
  console.log(`Bucket A: ${passed.length}/${results.length} ≥70 (precision ${(precision*100).toFixed(1)}%)`);
  if (precision < 0.95) {
    const misses = results.filter(r => r.score === null || r.score < 70).slice(0, 5);
    console.log('  sample misses:', JSON.stringify(misses, null, 2));
  }
  assert.ok(precision >= 0.95, `Bucket A precision ${precision.toFixed(3)} < 0.95`);
});

test('Bucket B — tier-1 whitelist: ≥95% score ≤39', { timeout: 120_000 }, async () => {
  const results = await scanAll(dataset.bucket_b_whitelist);
  const passed = results.filter(r => r.score !== null && r.score <= 39);
  const specificity = passed.length / results.length;
  console.log(`Bucket B: ${passed.length}/${results.length} ≤39 (specificity ${(specificity*100).toFixed(1)}%)`);
  if (specificity < 0.95) {
    const misses = results.filter(r => r.score === null || r.score > 39);
    console.log('  misses:', JSON.stringify(misses, null, 2));
  }
  assert.ok(specificity >= 0.95, `Bucket B specificity ${specificity.toFixed(3)} < 0.95`);
});

test('Bucket C — unlabeled: ≥30% in [40, 70] (continuous scoring goal)', { timeout: 180_000 }, async () => {
  const results = await scanAll(dataset.bucket_c_unlabeled);
  const inCaution = results.filter(r => r.score !== null && r.score >= 40 && r.score <= 70);
  const spread = inCaution.length / results.length;
  // distribution audit
  const buckets = { lt40: 0, in40_70: 0, gt70: 0, nullish: 0 };
  for (const r of results) {
    if (r.score === null) buckets.nullish++;
    else if (r.score < 40) buckets.lt40++;
    else if (r.score <= 70) buckets.in40_70++;
    else buckets.gt70++;
  }
  console.log(`Bucket C distribution: ${JSON.stringify(buckets)} (spread in [40,70]: ${(spread*100).toFixed(1)}%)`);
  assert.ok(spread >= 0.30, `Bucket C spread ${spread.toFixed(3)} < 0.30 — v2 still bimodal`);
});

test('Bucket D — 5pdyeWSC regression: score ≥ 51', { timeout: 30_000 }, async () => {
  const [r] = await scanAll(dataset.bucket_d_regression);
  console.log(`Bucket D: 5pdyeWSC score=${r.score} risk_level=${r.risk_level} iris_version=${r.iris_version}`);
  assert.ok(r.score !== null && r.score >= 51, `5pdyeWSC regression: score ${r.score} < 51`);
});
