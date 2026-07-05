'use strict';
// tests/eval/run.test.js — CLI integration tests for scripts/eval/run.js.
//
// run.js reads the gold anchor path given via --anchor (relative to cwd), filters by
// --split, evaluates every token through the real production IRIS v2 scorer, and writes
// a JSON report to 'data/ground-truth/reports/' (also relative to cwd). The rules
// version is pulled via require('../../data/rules-v2.json') resolved relative to the
// script file itself, so it always reflects the real repo's production weights
// regardless of the spawned cwd.
//
// We spawn the real script with cwd pointed at an isolated temp fixture directory so
// the real repo's gold anchor / reports directory are never touched.
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

console.log('\nrun.test.js — Eval Harness Runner CLI\n');

const REPO_ROOT = path.join(__dirname, '..', '..');
const RUN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'eval', 'run.js');
const sampleSnapshot = require('./fixtures/sample-enrichment.json');

// calculateIRIS_v2(sampleSnapshot) under EVAL_SCAM_DB deterministically scores 14/safe
// (verified against src/features/iris-score.js + data/rules-v2.json v2.0.1).
function passingToken(overrides = {}) {
  return {
    id: 'gt-run-pass', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'PASS', name: 'Pass Token', category: 'legit', split: 'tune',
    label: { verdict: 'safe', score_range: [0, 39], scam_type: null,
             anchor_confidence: 1.0, verified_at: '2026-06-17', verified_by: 'test', rationale: 'fixture-pass' },
    sources: [{ name: 'onchain', verdict: 'confirmed' }],
    snapshot: sampleSnapshot, must_flag: [], must_not_flag: [],
    ...overrides,
  };
}

function failingToken(overrides = {}) {
  return {
    id: 'gt-run-fail', mint: 'So11111111111111111111111111111111111111112',
    symbol: 'FAIL', name: 'Fail Token', category: 'legit', split: 'tune',
    // Same snapshot (score 14, safe) but labeled as expecting danger → guaranteed mismatch.
    label: { verdict: 'danger', score_range: [70, 100], scam_type: null,
             anchor_confidence: 1.0, verified_at: '2026-06-17', verified_by: 'test', rationale: 'fixture-fail' },
    sources: [{ name: 'onchain', verdict: 'confirmed' }],
    snapshot: sampleSnapshot, must_flag: [], must_not_flag: [],
    ...overrides,
  };
}

function withFixtureCwd(tokens, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-run-'));
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

function runHarness(cwd, args = []) {
  return spawnSync(process.execPath, [RUN_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function latestReport(gtDir) {
  const reportsDir = path.join(gtDir, 'reports');
  const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('eval-'));
  assert.strictEqual(files.length, 1, `expected exactly one report file, found: ${files.join(', ')}`);
  return JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
}

test('exits 0 and reports n=1/recall=0/fpr=0/mae=0 for a single passing legit token', () => {
  withFixtureCwd([passingToken()], (tmpDir, gtDir) => {
    const res = runHarness(tmpDir, ['--split', 'all']);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('n=1'), `expected n=1 in stdout, got: ${res.stdout}`);
    assert.ok(res.stdout.includes('recall_scam=0.000'));
    assert.ok(res.stdout.includes('fpr=0.000'));
    assert.ok(res.stdout.includes('mae=0.000'));
    assert.ok(res.stdout.includes('failures: 0'));

    const report = latestReport(gtDir);
    assert.strictEqual(report.metrics.n, 1);
    assert.strictEqual(report.metrics.score_mae, 0);
    assert.strictEqual(report.failures.length, 0);
    assert.strictEqual(report.anchor_version, '1.0');
    assert.strictEqual(report.split, 'all');
    assert.strictEqual(typeof report.rules_version, 'string');
    assert.strictEqual(typeof report.generated_at, 'string');
  });
});

test('report failures[] captures a mismatched token with full diagnostic fields', () => {
  withFixtureCwd([passingToken(), failingToken()], (tmpDir, gtDir) => {
    const res = runHarness(tmpDir, ['--split', 'tune']);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('n=2'));
    assert.ok(res.stdout.includes('failures: 1'));

    const report = latestReport(gtDir);
    assert.strictEqual(report.failures.length, 1);
    const f = report.failures[0];
    assert.strictEqual(f.category, 'legit');
    assert.strictEqual(f.predicted, 'safe');
    assert.strictEqual(f.expected, 'danger');
    assert.strictEqual(f.verdictMatch, false);
    assert.strictEqual(f.scoreInRange, false);
    assert.strictEqual(f.mustFlagOk, true);
    assert.strictEqual(f.mustNotFlagOk, true);
    assert.ok(Array.isArray(f.risk_factors));
  });
});

test('defaults to --split tune when no --split flag is given', () => {
  withFixtureCwd([passingToken({ split: 'holdout' })], (tmpDir) => {
    // Only holdout token exists but default split filter is 'tune' → no matching tokens → exit 1.
    const res = runHarness(tmpDir, []);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("split 'tune'"), `expected tune split error, got: ${res.stderr}`);
  });
});

test('exits 1 with a clear message when --split matches zero tokens (non-empty anchor)', () => {
  withFixtureCwd([passingToken({ split: 'tune' })], (tmpDir) => {
    const res = runHarness(tmpDir, ['--split', 'holdout']);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("split 'holdout'"), `expected holdout split error, got: ${res.stderr}`);
    assert.ok(res.stderr.includes('tune | holdout | all'));
  });
});

test('--split all bypasses the split filter and includes every token', () => {
  withFixtureCwd([passingToken({ split: 'tune' }), passingToken({ id: 'gt-run-pass-2', split: 'holdout' })], (tmpDir) => {
    const res = runHarness(tmpDir, ['--split', 'all']);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('n=2'), `expected n=2, got: ${res.stdout}`);
  });
});

test('--anchor pointing at a missing file crashes with a non-zero exit code', () => {
  withFixtureCwd([passingToken()], (tmpDir) => {
    const res = runHarness(tmpDir, ['--anchor', 'data/ground-truth/does-not-exist.json']);
    assert.notStrictEqual(res.status, 0);
    assert.ok(res.stderr.includes('ENOENT'), `expected ENOENT error, got: ${res.stderr}`);
  });
});

test('report file name embeds the rules_version and a sanitized ISO timestamp', () => {
  withFixtureCwd([passingToken()], (tmpDir, gtDir) => {
    const res = runHarness(tmpDir, ['--split', 'all']);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    const files = fs.readdirSync(path.join(gtDir, 'reports'));
    assert.strictEqual(files.length, 1);
    assert.ok(/^eval-.+-\d{4}-\d{2}-\d{2}T.+\.json$/.test(files[0]), `unexpected report filename: ${files[0]}`);
    assert.ok(!files[0].includes(':'), 'report filename must not contain raw colons from ISO timestamp');
  });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);