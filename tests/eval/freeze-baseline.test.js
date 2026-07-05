'use strict';
// tests/eval/freeze-baseline.test.js — CLI integration tests for scripts/eval/freeze-baseline.js.
//
// freeze-baseline.js reads 'data/ground-truth/gold-v1.json' (relative to cwd), evaluates
// only the 'tune' split through the real production IRIS v2 scorer, and writes
// 'data/ground-truth/baseline.json' (also relative to cwd). Like run.js, the rules
// version is pulled relative to the script file itself, so it always reflects the real
// repo's production weights regardless of the spawned cwd.
//
// We spawn the real script with cwd pointed at an isolated temp fixture directory so
// the real repo's gold anchor / baseline.json are never touched.
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

console.log('\nfreeze-baseline.test.js — Baseline Freeze CLI\n');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FREEZE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'eval', 'freeze-baseline.js');
const sampleSnapshot = require('./fixtures/sample-enrichment.json');

// calculateIRIS_v2(sampleSnapshot) under EVAL_SCAM_DB deterministically scores 14/safe
// (verified against src/features/iris-score.js + data/rules-v2.json v2.0.1).
function tuneToken(overrides = {}) {
  return {
    id: 'gt-freeze-001', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'FIX', name: 'Fixture Token', category: 'legit', split: 'tune',
    label: { verdict: 'safe', score_range: [0, 39], scam_type: null,
             anchor_confidence: 1.0, verified_at: '2026-06-17', verified_by: 'test', rationale: 'fixture' },
    sources: [{ name: 'onchain', verdict: 'confirmed' }],
    snapshot: sampleSnapshot, must_flag: [], must_not_flag: [],
    ...overrides,
  };
}

function withFixtureCwd(tokens, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-freeze-'));
  const gtDir = path.join(tmpDir, 'data', 'ground-truth');
  fs.mkdirSync(gtDir, { recursive: true });
  const anchor = { _meta: { version: '1.0', counts: {}, split: {} }, tokens };
  fs.writeFileSync(path.join(gtDir, 'gold-v1.json'), JSON.stringify(anchor));
  try {
    return fn(tmpDir, gtDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runFreeze(cwd) {
  return spawnSync(process.execPath, [FREEZE_SCRIPT], { cwd, encoding: 'utf8' });
}

test('writes baseline.json with the correct shape from a single tune-split token', () => {
  withFixtureCwd([tuneToken()], (tmpDir, gtDir) => {
    const res = runFreeze(tmpDir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);

    const baselinePath = path.join(gtDir, 'baseline.json');
    assert.ok(fs.existsSync(baselinePath), 'baseline.json should be written');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

    assert.strictEqual(baseline.anchor_version, '1.0');
    assert.strictEqual(baseline.split, 'tune');
    assert.strictEqual(baseline.n, 1);
    assert.strictEqual(baseline.recall_scam, 0);
    assert.strictEqual(baseline.fpr, 0);
    assert.strictEqual(baseline.score_mae, 0);
    assert.strictEqual(typeof baseline.rules_version, 'string');
    assert.strictEqual(typeof baseline.frozen_at, 'string');
    assert.ok(!Number.isNaN(Date.parse(baseline.frozen_at)), 'frozen_at must be a parseable ISO date');
  });
});

test('only evaluates tokens from the tune split, ignoring holdout tokens', () => {
  withFixtureCwd([tuneToken(), tuneToken({ id: 'gt-freeze-holdout', split: 'holdout' })], (tmpDir, gtDir) => {
    const res = runFreeze(tmpDir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    const baseline = JSON.parse(fs.readFileSync(path.join(gtDir, 'baseline.json'), 'utf8'));
    assert.strictEqual(baseline.n, 1, 'holdout token must not be counted in the tune-split baseline');
  });
});

test('exits 1 and does not write baseline.json when there are zero tune tokens', () => {
  withFixtureCwd([tuneToken({ split: 'holdout' })], (tmpDir, gtDir) => {
    const res = runFreeze(tmpDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('žádné tune tokeny') || res.stderr.length > 0, `expected error message, got: ${res.stderr}`);
    assert.ok(!fs.existsSync(path.join(gtDir, 'baseline.json')), 'baseline.json must not be created on failure');
  });
});

test('overwrites a pre-existing baseline.json (re-freeze semantics)', () => {
  withFixtureCwd([tuneToken()], (tmpDir, gtDir) => {
    const baselinePath = path.join(gtDir, 'baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify({ stale: true, n: 999 }));
    const res = runFreeze(tmpDir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.strictEqual(baseline.stale, undefined, 'baseline.json must be fully overwritten, not merged');
    assert.strictEqual(baseline.n, 1);
  });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);