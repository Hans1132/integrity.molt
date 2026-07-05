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

test('fail-closed: non-numeric baseline metric → pass false', () => {
  const r = checkRegression({ recall_scam: 0.9, fpr: 0.05 }, { recall_scam: 'x', fpr: 0.05 }, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('invalid')));
});
test('fail-closed: missing current metric → pass false', () => {
  const r = checkRegression({ fpr: 0.05 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
});
test('fail-closed: negative tolerance → pass false', () => {
  const r = checkRegression({ recall_scam: 0.9, fpr: 0.05 }, baseline, -0.1);
  assert.strictEqual(r.pass, false);
});
test('fail-closed: null input → pass false', () => {
  const r = checkRegression(null, baseline, TOL);
  assert.strictEqual(r.pass, false);
});

// ── CLI wrapper (main()) — scripts/eval/check-regression.js ────────────────
// check-regression.js reads 'data/ground-truth/{gold-v1.json,baseline.json}' relative
// to process.cwd(), and pulls production weights via ../../../src/features/iris-score
// (resolved relative to the script file itself, unaffected by cwd). We spawn the real
// script with cwd pointed at an isolated fixture directory so the real repo's gold
// anchor / baseline are never touched.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CHECK_REGRESSION_SCRIPT = path.join(REPO_ROOT, 'scripts', 'eval', 'check-regression.js');
const sampleSnapshot = require('./fixtures/sample-enrichment.json');

// calculateIRIS_v2(sampleSnapshot) under EVAL_SCAM_DB deterministically scores 14/safe
// (verified against src/features/iris-score.js + data/rules-v2.json v2.0.1).
function buildFixtureAnchor() {
  return {
    _meta: { version: '1.0', counts: {}, split: {} },
    tokens: [{
      id: 'gt-cli-001', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'FIX', name: 'Fixture Token', category: 'legit', split: 'tune',
      label: { verdict: 'safe', score_range: [0, 39], scam_type: null,
               anchor_confidence: 1.0, verified_at: '2026-06-17', verified_by: 'test', rationale: 'fixture' },
      sources: [{ name: 'onchain', verdict: 'confirmed' }],
      snapshot: sampleSnapshot, must_flag: [], must_not_flag: [],
    }],
  };
}

function withFixtureCwd(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-check-regression-'));
  const gtDir = path.join(tmpDir, 'data', 'ground-truth');
  fs.mkdirSync(gtDir, { recursive: true });
  fs.writeFileSync(path.join(gtDir, 'gold-v1.json'), JSON.stringify(buildFixtureAnchor()));
  try {
    return fn(tmpDir, gtDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runCheckRegression(cwd) {
  return spawnSync(process.execPath, [CHECK_REGRESSION_SCRIPT], { cwd, encoding: 'utf8' });
}

test('CLI: missing baseline.json → SKIP with exit 0', () => {
  withFixtureCwd((tmpDir) => {
    const res = runCheckRegression(tmpDir);
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes('SKIP'), `expected SKIP message, got: ${res.stdout}`);
  });
});

test('CLI: baseline matching current metrics → PASS with exit 0', () => {
  withFixtureCwd((tmpDir, gtDir) => {
    fs.writeFileSync(path.join(gtDir, 'baseline.json'), JSON.stringify({
      anchor_version: '1.0', recall_scam: 0, fpr: 0,
    }));
    const res = runCheckRegression(tmpDir);
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes('PASS'), `expected PASS message, got: ${res.stdout}`);
  });
});

test('CLI: anchor_version mismatch → FAIL with exit 1, independent of metric values', () => {
  withFixtureCwd((tmpDir, gtDir) => {
    fs.writeFileSync(path.join(gtDir, 'baseline.json'), JSON.stringify({
      anchor_version: '99.0', recall_scam: 0, fpr: 0,
    }));
    const res = runCheckRegression(tmpDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('anchor_version'), `expected anchor_version mismatch message, got: ${res.stderr}`);
  });
});

test('CLI: baseline recall_scam far above current → FAIL with exit 1 and reason in stderr', () => {
  withFixtureCwd((tmpDir, gtDir) => {
    fs.writeFileSync(path.join(gtDir, 'baseline.json'), JSON.stringify({
      anchor_version: '1.0', recall_scam: 0.9, fpr: 0,
    }));
    const res = runCheckRegression(tmpDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('recall_scam'), `expected recall_scam reason, got: ${res.stderr}`);
  });
});

test('CLI: explicit baseline.tolerance overrides the 0.02 default', () => {
  withFixtureCwd((tmpDir, gtDir) => {
    // current recall_scam=0; baseline=0.5 but tolerance=1.0 → within tolerance → PASS
    fs.writeFileSync(path.join(gtDir, 'baseline.json'), JSON.stringify({
      anchor_version: '1.0', recall_scam: 0.5, fpr: 0, tolerance: 1.0,
    }));
    const res = runCheckRegression(tmpDir);
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes('PASS'), `expected PASS message, got: ${res.stdout}`);
  });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
