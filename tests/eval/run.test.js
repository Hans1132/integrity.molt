'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

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

console.log('\nrun.test.js — Eval Harness Runner (scripts/eval/run.js)\n');

const REPO_ROOT = path.join(__dirname, '../..');
const sampleSnapshot = require('./fixtures/sample-enrichment.json');
const { main } = require('../../scripts/eval/run');

function writeTempAnchor(tokens, metaVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-anchor-'));
  const file = path.join(dir, 'anchor.json');
  fs.writeFileSync(file, JSON.stringify({ _meta: { version: metaVersion }, tokens }));
  return file;
}

function reportPathFor(report) {
  const ts = report.generated_at.replace(/[:.]/g, '-');
  return path.join(REPO_ROOT, 'data/ground-truth/reports', `eval-${report.rules_version}-${ts}.json`);
}

// sample-enrichment.json scores as 'safe' with a low score under the eval leakage guard
// (see eval-core.test.js — guarded score is well below the danger threshold).
const legitToken = {
  id: 'gt-test-legit', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC', category: 'legit', split: 'tune',
  label: { verdict: 'safe', score_range: [0, 39], scam_type: null,
           anchor_confidence: 1.0, verified_at: '2026-06-15', verified_by: 'hans', rationale: 'test fixture' },
  sources: [{ name: 'onchain', verdict: 'confirmed' }],
  snapshot: sampleSnapshot,
  must_flag: [], must_not_flag: ['nonexistent_factor'],
};

// Same snapshot, but the label deliberately disagrees with reality → must show up as a failure.
const mismatchedHoldoutToken = {
  ...legitToken,
  id: 'gt-test-holdout',
  split: 'holdout',
  label: { ...legitToken.label, verdict: 'danger', score_range: [70, 100] },
};

test('main(): --split all evaluates every token and writes a report file', () => {
  const anchorPath = writeTempAnchor([legitToken, mismatchedHoldoutToken], 'test-1.0');
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  let report;
  let reportFile;
  try {
    process.argv = ['node', 'run.js', '--anchor', anchorPath, '--split', 'all'];
    process.chdir(REPO_ROOT);
    report = main();
    reportFile = reportPathFor(report);

    assert.strictEqual(report.metrics.n, 2);
    assert.strictEqual(report.anchor_version, 'test-1.0');
    assert.strictEqual(report.split, 'all');
    assert.ok(typeof report.rules_version === 'string' && report.rules_version.length > 0);
    // The mismatched holdout token must appear in failures (label disagrees with the real prediction).
    const failure = report.failures.find(f => f.category === 'legit' && f.expected === 'danger');
    assert.ok(failure, 'expected mismatched token to be recorded as a failure');
    assert.strictEqual(failure.verdictMatch, false);
    assert.strictEqual(failure.scoreInRange, false);
    assert.ok(fs.existsSync(reportFile), 'report JSON file should be written to data/ground-truth/reports');
    const written = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.strictEqual(written.metrics.n, 2);
  } finally {
    process.argv = savedArgv;
    process.chdir(savedCwd);
    if (reportFile && fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
    fs.rmSync(path.dirname(anchorPath), { recursive: true, force: true });
  }
});

test('main(): --split tune filters out holdout tokens', () => {
  const anchorPath = writeTempAnchor([legitToken, mismatchedHoldoutToken], 'test-1.0');
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  let report;
  let reportFile;
  try {
    process.argv = ['node', 'run.js', '--anchor', anchorPath, '--split', 'tune'];
    process.chdir(REPO_ROOT);
    report = main();
    reportFile = reportPathFor(report);

    assert.strictEqual(report.metrics.n, 1);
    assert.strictEqual(report.split, 'tune');
    // The lone tune token (legitToken) matches its label → no failures.
    assert.strictEqual(report.failures.length, 0);
  } finally {
    process.argv = savedArgv;
    process.chdir(savedCwd);
    if (reportFile && fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
    fs.rmSync(path.dirname(anchorPath), { recursive: true, force: true });
  }
});

test('main(): default --anchor/--split (tune) works against the real gold anchor', () => {
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  let report;
  let reportFile;
  try {
    process.argv = ['node', 'run.js'];
    process.chdir(REPO_ROOT);
    report = main();
    reportFile = reportPathFor(report);
    assert.strictEqual(report.anchor, 'data/ground-truth/gold-v1.json');
    assert.strictEqual(report.split, 'tune');
    assert.ok(report.metrics.n > 0);
  } finally {
    process.argv = savedArgv;
    process.chdir(savedCwd);
    if (reportFile && fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
  }
});

test('main(): an empty tokens[] anchor produces a zero-row report without exiting', () => {
  const anchorPath = writeTempAnchor([], 'empty-1.0');
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  let report;
  let reportFile;
  try {
    process.argv = ['node', 'run.js', '--anchor', anchorPath, '--split', 'tune'];
    process.chdir(REPO_ROOT);
    report = main();
    reportFile = reportPathFor(report);
    assert.strictEqual(report.metrics.n, 0);
    assert.strictEqual(report.failures.length, 0);
  } finally {
    process.argv = savedArgv;
    process.chdir(savedCwd);
    if (reportFile && fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
    fs.rmSync(path.dirname(anchorPath), { recursive: true, force: true });
  }
});

test('CLI: exits 1 with a helpful stderr message when --split matches no tokens', () => {
  const anchorPath = writeTempAnchor([legitToken], 'test-1.0'); // only a 'tune' token exists
  try {
    let threw = null;
    try {
      execFileSync('node', ['scripts/eval/run.js', '--anchor', anchorPath, '--split', 'holdout'],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'expected the CLI to exit non-zero');
    assert.strictEqual(threw.status, 1);
    assert.ok(threw.stderr.includes('nematchuje'));
    assert.ok(threw.stderr.includes('holdout'));
  } finally {
    fs.rmSync(path.dirname(anchorPath), { recursive: true, force: true });
  }
});

test('CLI: an invalid --anchor path fails loudly instead of silently producing an empty report', () => {
  let threw = null;
  try {
    execFileSync('node', ['scripts/eval/run.js', '--anchor', '/nonexistent/path/anchor.json', '--split', 'all'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected the CLI to exit non-zero for a missing anchor file');
  assert.notStrictEqual(threw.status, 0);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);