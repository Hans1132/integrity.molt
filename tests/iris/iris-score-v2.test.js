'use strict';
// tests/iris/iris-score-v2.test.js — per-dimension unit tests for IRIS v2 scoring engine.
//
// Targets `calculateIRIS_v2` in src/features/iris-score.js after backend Phase 2A
// rewrite (plan Task 14). Until that commit lands on main, this file fails to
// destructure `calculateIRIS_v2` — that is the documented RED state for qa Phase 2B
// (implementation plan Task 18 step 2).
//
// Specs:
//  - docs/superpowers/specs/2026-05-19-iris-v2-scope-a-plan.md §2 (8-dim mapping)
//  - amendment v2 §1.1 (3-tier safe/caution/danger 40/70)
//  - amendment v3 (external oracle floor)

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateIRIS_v2 } = require('../../src/features/iris-score');

function mkEnrichment(overrides = {}) {
  return {
    mint: 'TestMint11111111111111111111111111111111111',
    external_sources: {
      rugcheck:        overrides.rugcheck       || null,
      solana_tracker:  overrides.solana_tracker || null,
    },
    token_extensions: overrides.token_extensions || { is_token_2022: false },
    ...overrides,
  };
}

test('scoring: empty inputs → low safe score (or unknown if circuit breakers cascade)', () => {
  const r = calculateIRIS_v2(
    mkEnrichment(),
    { known_scam: null, whitelisted: false },
    { source_health: 'circuit_breaker_open' },
  );
  // honeypot drops out. With ~all-null enrichment, multiple dims will be 0 or partial.
  // Spec allows: score < 30 with risk_level safe (if engine treats missing as 0)
  //          OR: score null + risk_level unknown if ≥3 sources fail (insufficient_data).
  if (r.score === null) {
    assert.equal(r.risk_level, 'unknown');
  } else {
    assert.ok(r.score < 40, `expected safe-band score, got ${r.score}`);
    assert.equal(r.risk_level, 'safe');
  }
});

test('scoring: confirmed scam with known_scam confidence=1.0 → soft floor ≥ 90', () => {
  const r = calculateIRIS_v2(
    mkEnrichment({ rugcheck: { rugged: true, score_normalised: 20, mint_authority: 'X', top_holders: [] } }),
    { known_scam: { confidence: 1.0, scam_type: 'rug_pull' }, whitelisted: false },
    { source_health: 'ok', is_malicious: 1, risk_count: 3, cannot_sell_all: 1, can_buy: 0 },
  );
  // soft_floor_offset(50) + confidence(1.0)*soft_floor_scale(40) = 90
  assert.ok(r.score >= 90, `soft floor min 90, got ${r.score}`);
  assert.equal(r.risk_level, 'danger');
});

test('scoring: tier-1 whitelist → soft whitelist drops score into safe band', () => {
  // High risk signals would compute mid-range; soft whitelist tier-1 reduces score by 0.7×strength
  const r = calculateIRIS_v2(
    mkEnrichment({
      rugcheck: { mint_authority: 'X', top_holders: [{ address: 'A', pct: 75 }] },
      solana_tracker: { liquidity_usd: 5000, lp_burn_pct: 0, age_hours: 2 },
    }),
    { known_scam: null, whitelisted: true, whitelist_meta: { tier: 1 } },
    { source_health: 'ok', cannot_sell_all: 0, can_buy: 1 },
  );
  assert.ok(r.score < 40, `whitelisted token should land in safe, got ${r.score}`);
  assert.equal(r.risk_level, 'safe');
});

test('scoring: 3+ enrichment sources fail → null score path or insufficient_data', () => {
  const enrichment = mkEnrichment(); // all null
  const r = calculateIRIS_v2(
    enrichment,
    { known_scam: null, whitelisted: false },
    { source_health: 'circuit_breaker_open' },
  );
  // Engine may either return null+unknown (HTTP 503 candidate) or partial+safe.
  // Both are spec-compliant; assert internal consistency.
  if (r.score === null) {
    assert.equal(r.risk_level, 'unknown');
    assert.ok(r.confidence_level === 'insufficient' || r.confidence_level === 'low');
  } else {
    assert.ok(r.score >= 0 && r.score <= 100);
  }
});

test('scoring: weights_version field is present (v2.0.0)', () => {
  const r = calculateIRIS_v2(
    mkEnrichment(),
    { known_scam: null, whitelisted: false },
    { source_health: 'ok' },
  );
  assert.equal(r.weights_version, 'v2.0.0');
});

test('scoring: breakdown has all 8 dimension keys', () => {
  const r = calculateIRIS_v2(
    mkEnrichment(),
    { known_scam: null, whitelisted: false },
    { source_health: 'ok' },
  );
  const expectedKeys = ['liquidity', 'authority', 'concentration', 'lineage', 'reputation', 'trading', 'honeypot', 'age'];
  assert.deepEqual(Object.keys(r.breakdown).sort(), expectedKeys.sort());
});

test('scoring: signal shape — {name, score} objects in dim.signals[]', () => {
  const r = calculateIRIS_v2(
    mkEnrichment({ rugcheck: { freeze_authority: 'FreezerWallet', top_holders: [] } }),
    { known_scam: null, whitelisted: false },
    { source_health: 'ok' },
  );
  const authSig = r.breakdown.authority.signals.find(s => s.name === 'freeze_authority_active');
  assert.ok(authSig, 'freeze_authority_active signal expected when freeze_authority set');
  assert.equal(typeof authSig.name, 'string');
  assert.equal(typeof authSig.score, 'number');
  assert.equal(authSig.score, 20);
});

test('scoring: external oracle danger floor — rcDanger + score_norm 71, no known_scam → ≥ 51', () => {
  // Amendment v3 §3.3: rcDanger + score_norm 71 + no scam_db match → floor 51 + (71-50)*0.6 = 63.6 → 64
  const r = calculateIRIS_v2(
    mkEnrichment({
      rugcheck: { risk_level: 'danger', score_norm: 71, score_normalised: 71, top_holders: [] },
    }),
    { known_scam: null, whitelisted: false },
    { source_health: 'ok' },
  );
  assert.ok(r.score >= 51, `external_oracle_floor: expected ≥51, got ${r.score}`);
  assert.equal(r.risk_level, 'caution');
});
