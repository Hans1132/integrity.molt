'use strict';
/**
 * tests/features/iris-score.test.js
 *
 * Unit tests for src/features/iris-score.js
 * Covers: calculateIRIS (all four dimensions) and formatIrisForLLM
 *
 * Pure function tests — no DB, no network, no env vars required.
 * getLegitMints() reads data/legit-tokens.json once on first call;
 * test mints are not in the whitelist, so mint_authority scoring applies.
 *
 * NOTE: scoreSpeed adds +5 during UTC peak attack hours (15-19).
 * Tests that check total score account for this potential variance.
 *
 * Run: node tests/features/iris-score.test.js
 */

'use strict';

const assert = require('assert');
const { calculateIRIS, formatIrisForLLM } = require('../../src/features/iris-score');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

function makeEnrichment({
  liquidity = null,
  lpBurn    = null,
  sells     = 0,
  buys      = 0,
  mintAuth  = null,
  freezeAuth = null,
  topHolders = [],
  ageHours  = null,
  extensions = null,
} = {}) {
  return {
    mint: 'TESTmintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    external_sources: {
      rugcheck: {
        mint_authority:   mintAuth   || null,
        freeze_authority: freezeAuth || null,
        top_holders:      topHolders,
        insiders_detected: 0,
        rugged: false,
      },
      solana_tracker: {
        liquidity_usd: liquidity,
        lp_burn_pct:   lpBurn,
        buys_24h:      buys,
        sells_24h:     sells,
        age_hours:     ageHours,
      },
    },
    token_extensions: extensions || null,
  };
}

async function run() {
  console.log('\n── IRIS Score Tests ───────────────────────────────────────────────────────────\n');

  await test('null inputs: score <= 5, grade is LOW (peak hours may add 5)', async () => {
    const result = calculateIRIS(null, null);
    assert.ok(result.score <= 5, `score should be 0 or 5 (peak hours), got ${result.score}`);
    assert.strictEqual(result.grade, 'LOW');
    assert.strictEqual(result.breakdown.inflows.score, 0);
    assert.strictEqual(result.breakdown.rights.score, 0);
    assert.strictEqual(result.breakdown.imbalance.score, 0);
  });

  await test('scoreInflows: liquidity < $1k adds 10 to inflows score', async () => {
    const result = calculateIRIS(makeEnrichment({ liquidity: 500 }), null);
    assert.ok(result.breakdown.inflows.score >= 10, `inflows score should be >= 10, got ${result.breakdown.inflows.score}`);
    assert.ok(result.breakdown.inflows.details.some(d => d.includes('liquidity_critical')), 'should report liquidity_critical');
  });

  await test('scoreInflows: lp_burn_pct = 0 adds 10 to inflows score', async () => {
    const result = calculateIRIS(makeEnrichment({ lpBurn: 0 }), null);
    assert.ok(result.breakdown.inflows.score >= 10, `inflows score should be >= 10, got ${result.breakdown.inflows.score}`);
    assert.ok(result.breakdown.inflows.details.some(d => d.includes('lp_unburned')), 'should report lp_unburned');
  });

  await test('scoreInflows: sell pressure (sells > 2x buys) adds 5', async () => {
    const result = calculateIRIS(makeEnrichment({ buys: 10, sells: 30 }), null);
    assert.ok(result.breakdown.inflows.score >= 5, `inflows score should be >= 5 for sell pressure, got ${result.breakdown.inflows.score}`);
    assert.ok(result.breakdown.inflows.details.some(d => d.includes('sell_pressure')));
  });

  await test('scoreRights: active mint authority on new token (< 168h) adds 15', async () => {
    const result = calculateIRIS(makeEnrichment({ mintAuth: 'SomeWalletXXXXXXXXXXXXXXXXXXXXXXXXXXX', ageHours: 24 }), null);
    assert.strictEqual(result.breakdown.rights.score, 15, `rights score should be 15, got ${result.breakdown.rights.score}`);
    assert.ok(result.breakdown.rights.details.some(d => d.includes('mint_authority_active')));
  });

  await test('scoreRights: freeze authority active adds 8', async () => {
    const result = calculateIRIS(makeEnrichment({ freezeAuth: 'FreezeKeyXXXXXXXXXXXXXXXXXXXXXXXXXX' }), null);
    assert.ok(result.breakdown.rights.score >= 8, `rights score should be >= 8, got ${result.breakdown.rights.score}`);
    assert.ok(result.breakdown.rights.details.some(d => d.includes('freeze_authority_active')));
  });

  await test('scoreImbalance: top holder > 70% adds 10', async () => {
    const topHolders = [{ address: 'WhaleWalletXXXXXXXXXXXXXXXXXXXXXXXXXX', pct: 75 }];
    const result = calculateIRIS(makeEnrichment({ topHolders }), null);
    assert.ok(result.breakdown.imbalance.score >= 10, `imbalance score should be >= 10, got ${result.breakdown.imbalance.score}`);
    assert.ok(result.breakdown.imbalance.details.some(d => d.includes('top_holder_critical')));
  });

  await test('scoreImbalance: known_scam with inactive_pool rug_pattern adds 20', async () => {
    const scamDb = { known_scam: { rug_pattern: 'inactive_pool' } };
    const result = calculateIRIS(makeEnrichment({}), scamDb);
    assert.ok(result.breakdown.imbalance.score >= 20, `imbalance score should be >= 20, got ${result.breakdown.imbalance.score}`);
    assert.ok(result.breakdown.imbalance.details.some(d => d.includes('known_scam:inactive_pool')));
  });

  await test('scoreImbalance: liquidity_drain pattern adds 15', async () => {
    const scamDb = { known_scam: { rug_pattern: 'liquidity_drain' } };
    const result = calculateIRIS(makeEnrichment({}), scamDb);
    assert.ok(result.breakdown.imbalance.score >= 15, `imbalance score should be >= 15, got ${result.breakdown.imbalance.score}`);
  });

  await test('scoreSpeed: age < 1h adds 20 to speed dimension', async () => {
    const result = calculateIRIS(makeEnrichment({ ageHours: 0.5 }), null);
    assert.ok(result.breakdown.speed.score >= 20, `speed score should be >= 20, got ${result.breakdown.speed.score}`);
    assert.ok(result.breakdown.speed.details.some(d => d.includes('age_critical')));
  });

  await test('scoreSpeed: age 24-168h is medium risk (+6)', async () => {
    const result = calculateIRIS(makeEnrichment({ ageHours: 72 }), null);
    assert.ok(result.breakdown.speed.score >= 6, `speed score should be >= 6 for medium age, got ${result.breakdown.speed.score}`);
  });

  await test('confirmed rug_pull with confidence 0.8 floors total to >= 76', async () => {
    const scamDb = { known_scam: { scam_type: 'rug_pull', confidence: 0.8, confidence_score: 0.8 } };
    const result = calculateIRIS(makeEnrichment({}), scamDb);
    assert.ok(result.score >= 76, `score should be >= 76 for confirmed rug_pull, got ${result.score}`);
    assert.strictEqual(result.grade, 'CRITICAL');
  });

  await test('total score cannot exceed 100 (all signals maxed)', async () => {
    const topHolders = [{ address: 'WhaleXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', pct: 80 }];
    const scamDb = { known_scam: { rug_pattern: 'inactive_pool' } };
    const enrichment = makeEnrichment({
      liquidity:  0,
      lpBurn:     0,
      mintAuth:   'MintKeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      freezeAuth: 'FreezeKeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      topHolders,
      ageHours:   0.5,
      buys:       10,
      sells:      30,
    });
    const result = calculateIRIS(enrichment, scamDb);
    assert.ok(result.score <= 100, `score must not exceed 100, got ${result.score}`);
  });

  await test('formatIrisForLLM returns string with all four dimension names', async () => {
    const iris = calculateIRIS(makeEnrichment({ liquidity: 500 }), null);
    const output = formatIrisForLLM(iris);
    assert.strictEqual(typeof output, 'string');
    assert.ok(output.includes('Inflows'),   'output should mention Inflows');
    assert.ok(output.includes('Rights'),    'output should mention Rights');
    assert.ok(output.includes('Imbalance'), 'output should mention Imbalance');
    assert.ok(output.includes('Speed'),     'output should mention Speed');
  });

  await test('formatIrisForLLM returns empty string for null input', async () => {
    assert.strictEqual(formatIrisForLLM(null), '');
  });

  await test('breakdown scores each have max: 25 field', async () => {
    const result = calculateIRIS(null, null);
    for (const dim of ['inflows', 'rights', 'imbalance', 'speed']) {
      assert.strictEqual(result.breakdown[dim].max, 25, `breakdown.${dim}.max should be 25`);
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
