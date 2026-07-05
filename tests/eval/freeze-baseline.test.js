'use strict';
const assert = require('node:assert');
const fs = require('fs');
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

console.log('\nfreeze-baseline.test.js — scripts/eval/freeze-baseline.js\n');

const REPO_ROOT = path.join(__dirname, '../..');
const BASELINE_PATH = path.join(REPO_ROOT, 'data/ground-truth/baseline.json');

// freeze-baseline.js overwrites the committed data/ground-truth/baseline.json in place with no
// --output override. We deliberately do NOT execute its CLI main() against the real file here —
// only verify the safe-require contract (require.main guard) and the module's export shape.
test('requiring freeze-baseline.js as a library does not execute main() (no baseline.json mutation)', () => {
  const before = fs.readFileSync(BASELINE_PATH, 'utf8');
  delete require.cache[require.resolve('../../scripts/eval/freeze-baseline')];
  const mod = require('../../scripts/eval/freeze-baseline');
  const after = fs.readFileSync(BASELINE_PATH, 'utf8');
  assert.strictEqual(before, after, 'requiring the module must not mutate the committed baseline.json');
  assert.deepStrictEqual(mod, {}, 'freeze-baseline.js is CLI-only; module.exports must stay {}');
});

test('CLI: refuses to write a degenerate baseline when there are zero tune tokens', () => {
  // freeze-baseline.js hardcodes the anchor path as the *cwd-relative* literal
  // 'data/ground-truth/gold-v1.json' (see fs.readFileSync inside lib/schema.js's loadAnchor).
  // All of its require(...) calls, in contrast, are resolved relative to the script's own file
  // location, so they keep pointing at the real src/ and data/rules-v2.json regardless of cwd.
  // We only need to control the cwd-relative anchor file to exercise the zero-tune-rows guard,
  // without ever touching the real committed data/ground-truth/gold-v1.json or baseline.json.
  const os = require('os');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-baseline-scratch-'));
  try {
    fs.mkdirSync(path.join(scratch, 'data/ground-truth'), { recursive: true });

    // Anchor with only a holdout token → zero 'tune' rows after the split filter.
    fs.writeFileSync(path.join(scratch, 'data/ground-truth/gold-v1.json'), JSON.stringify({
      _meta: { version: 'scratch-1.0' },
      tokens: [{
        id: 'gt-scratch-1', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        symbol: 'X', category: 'legit', split: 'holdout',
        label: { verdict: 'safe', score_range: [0, 39], scam_type: null, anchor_confidence: 1.0,
                 verified_at: '2026-01-01', verified_by: 'test', rationale: 'scratch' },
        sources: [{ name: 'onchain', verdict: 'confirmed' }],
        snapshot: { enrichment: {}, goplus: {} },
        must_flag: [], must_not_flag: [],
      }],
    }));

    let threw = null;
    try {
      execFileSync('node', [path.join(REPO_ROOT, 'scripts/eval/freeze-baseline.js')],
        { cwd: scratch, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'expected freeze-baseline.js to exit non-zero for zero tune tokens');
    assert.strictEqual(threw.status, 1);
    assert.ok(threw.stderr.includes('žádné tune tokeny'));
    // The guard fires before any fs.writeFileSync call, so the real committed baseline.json
    // must remain completely untouched by this scratch-cwd run.
    assert.ok(fs.existsSync(BASELINE_PATH));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);