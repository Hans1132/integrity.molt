'use strict';
// tests/eval/gold-anchor-data.test.js — sanity checks on the real, committed ground-truth
// data files added in this PR: data/ground-truth/gold-v1.json, baseline.json, and the
// .gitignore rules that keep them (and only them) tracked under data/ground-truth/.
//
// These are data-quality regression tests: they protect the actual production gold
// anchor / baseline against silent corruption (duplicate ids/mints, schema violations,
// malformed baseline), independent of the pure-function unit tests in eval-core.test.js.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

console.log('\ngold-anchor-data.test.js — Real Ground-Truth Data Validation\n');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { loadAnchor } = require('../../scripts/eval/lib/schema');

const ANCHOR_PATH = path.join(REPO_ROOT, 'data', 'ground-truth', 'gold-v1.json');
const BASELINE_PATH = path.join(REPO_ROOT, 'data', 'ground-truth', 'baseline.json');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

test('real gold-v1.json passes loadAnchor schema validation without throwing', () => {
  assert.doesNotThrow(() => loadAnchor(ANCHOR_PATH));
});

test('real gold-v1.json has at least one token', () => {
  const data = loadAnchor(ANCHOR_PATH);
  assert.ok(data.tokens.length > 0);
});

test('every token id in gold-v1.json is unique', () => {
  const data = loadAnchor(ANCHOR_PATH);
  const ids = data.tokens.map(t => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate gold anchor ids detected');
});

test('every token mint in gold-v1.json is unique', () => {
  const data = loadAnchor(ANCHOR_PATH);
  const mints = data.tokens.map(t => t.mint);
  assert.strictEqual(new Set(mints).size, mints.length, 'duplicate gold anchor mints detected');
});

test('_meta.counts matches the actual per-category token counts', () => {
  const data = loadAnchor(ANCHOR_PATH);
  const actual = { scam: 0, legit: 0, edge: 0 };
  for (const t of data.tokens) actual[t.category] = (actual[t.category] || 0) + 1;
  assert.deepStrictEqual(actual, data._meta.counts,
    '_meta.counts is stale relative to the actual tokens[] category breakdown');
});

test('every token has a non-empty snapshot object (enrichment + goplus keys present)', () => {
  const data = loadAnchor(ANCHOR_PATH);
  for (const t of data.tokens) {
    assert.ok('enrichment' in t.snapshot, `${t.id} missing snapshot.enrichment`);
    assert.ok('goplus' in t.snapshot, `${t.id} missing snapshot.goplus`);
  }
});

test('every token split is either tune or holdout', () => {
  const data = loadAnchor(ANCHOR_PATH);
  for (const t of data.tokens) {
    assert.ok(t.split === 'tune' || t.split === 'holdout', `${t.id} has invalid split "${t.split}"`);
  }
});

test('real baseline.json has the required fields with correct types and value ranges', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.strictEqual(typeof baseline.frozen_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(baseline.frozen_at)), 'frozen_at must be a parseable date');
  assert.strictEqual(typeof baseline.rules_version, 'string');
  assert.strictEqual(typeof baseline.anchor_version, 'string');
  assert.strictEqual(baseline.split, 'tune');
  assert.ok(Number.isInteger(baseline.n) && baseline.n > 0);
  for (const key of ['recall_scam', 'fpr', 'score_mae']) {
    assert.strictEqual(typeof baseline[key], 'number', `${key} must be a number`);
    assert.ok(Number.isFinite(baseline[key]), `${key} must be finite`);
  }
  assert.ok(baseline.recall_scam >= 0 && baseline.recall_scam <= 1, 'recall_scam must be a 0..1 ratio');
  assert.ok(baseline.fpr >= 0 && baseline.fpr <= 1, 'fpr must be a 0..1 ratio');
});

test('baseline.json anchor_version matches the real gold-v1.json _meta.version', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const data = loadAnchor(ANCHOR_PATH);
  assert.strictEqual(baseline.anchor_version, data._meta.version,
    'baseline.json is stale relative to the current gold anchor version — re-run freeze-baseline.js');
});

test('.gitignore keeps the gold anchor + baseline allow-listed under data/ground-truth/', () => {
  const gitignore = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  for (const line of [
    '!data/ground-truth/',
    'data/ground-truth/*',
    '!data/ground-truth/gold-v1.json',
    '!data/ground-truth/SCHEMA.md',
    '!data/ground-truth/reports/',
    'data/ground-truth/reports/*',
    '!data/ground-truth/reports/.gitkeep',
    '!data/ground-truth/baseline.json',
  ]) {
    assert.ok(gitignore.includes(line), `.gitignore missing expected line: ${line}`);
  }
});

test('.gitignore does NOT allow-list arbitrary report JSON files (reports stay untracked)', () => {
  const lines = fs.readFileSync(GITIGNORE_PATH, 'utf8').split('\n').map(l => l.trim());
  const stragglers = lines.filter(l =>
    l.startsWith('!data/ground-truth/reports/') &&
    l !== '!data/ground-truth/reports/' &&
    l !== '!data/ground-truth/reports/.gitkeep'
  );
  assert.deepStrictEqual(stragglers, [], 'reports/ directory contents beyond .gitkeep must remain gitignored');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);