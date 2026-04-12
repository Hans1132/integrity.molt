'use strict';
// tests/scanner/accuracy.test.js — Deterministic scorer accuracy against golden dataset
// Tests validateLLMScore rules directly against known token profiles.
// NO network calls, NO Helius RPC, NO API keys needed.
// Run: node tests/scanner/accuracy.test.js

const assert = require('assert');
const path   = require('path');
const { validateLLMScore } = require('../../src/llm/scan-validator');

const dataset = require('./golden-dataset.json');

let passed = 0;
let failed = 0;
const results = { safe: { tp: 0, fp: 0, fn: 0 }, danger: { tp: 0, fp: 0, fn: 0 } };

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

console.log('\nscanner/accuracy.test.js — Golden Dataset Validation\n');
console.log(`Testing ${dataset.tokens.length} tokens from golden dataset\n`);

// ── Helper: build auditData mock from dataset entry ───────────────────────────

function buildMockAuditData(token, overrides = {}) {
  return {
    mint_address: token.mint,
    raw_score: overrides.raw_score ?? 50,
    findings: overrides.findings ?? [],
    mint_info: overrides.mint_info ?? {
      mint_authority: overrides.mint_authority ?? null,
      freeze_authority: overrides.freeze_authority ?? null,
      supply: '1000000000',
      decimals: 6,
      is_token_2022: overrides.is_token_2022 ?? false
    },
    concentration: overrides.concentration ?? { top1_pct: overrides.top1_pct ?? 5 },
    ...overrides.extra
  };
}

// ── Scan-validator rule tests per token category ──────────────────────────────

console.log('--- Safe tokens: validator must not over-flag ---\n');

const safeTokens = dataset.tokens.filter(t => t.category === 'safe');
for (const token of safeTokens) {
  test(`${token.symbol || token.name} (${token.mint.slice(0, 8)}…): clean profile → no correction flags`, () => {
    const auditData = buildMockAuditData(token, {
      raw_score: 5,
      findings: [],
      mint_authority: null,
      freeze_authority: null,
      top1_pct: 5
    });
    const { corrected, flags } = validateLLMScore(5, { risk_score: 5, category: 'SAFE' }, auditData);
    assert.strictEqual(flags.length, 0, `Expected no flags for ${token.symbol}, got: ${flags.join(', ')}`);
    assert.strictEqual(corrected.category, 'SAFE');
    results.safe.tp++;
  });

  if (token.must_not_be === 'DANGER') {
    test(`${token.symbol || token.name}: must not be classified as DANGER`, () => {
      const auditData = buildMockAuditData(token, { raw_score: 50, top1_pct: 5 });
      const { corrected } = validateLLMScore(50, { risk_score: 50, category: 'CAUTION' }, auditData);
      assert.notStrictEqual(corrected.category, 'DANGER',
        `${token.symbol} should never be DANGER — false positive risk`);
    });
  }
}

console.log('\n--- Scam tokens: validator must enforce minimum scores ---\n');

const scamTokens = dataset.tokens.filter(t => t.category === 'scam');
for (const token of scamTokens) {
  test(`${token.name} (${token.mint.slice(0, 8)}…): active mint authority → score forced ≥40`, () => {
    if (!token.must_have_flags?.includes('mint_authority_active')) return; // skip if no mint_authority
    const auditData = buildMockAuditData(token, {
      raw_score: 70,
      mint_authority: 'SomeActiveWallet111',
      freeze_authority: null,
      top1_pct: 85,
      findings: [{ severity: 'high', label: 'Mint authority active' }]
    });
    // Simulate LLM trying to under-report
    const { corrected, flags } = validateLLMScore(70, { risk_score: 10, category: 'SAFE' }, auditData);
    assert.ok(corrected.risk_score >= 40, `Score should be ≥40 (active mint), got ${corrected.risk_score}`);
    assert.ok(flags.length > 0, 'Expected correction flags for scam token');
    results.danger.tp++;
  });

  test(`${token.name} (${token.mint.slice(0, 8)}…): high concentration → score forced ≥31`, () => {
    const auditData = buildMockAuditData(token, {
      raw_score: 75,
      mint_authority: null,
      freeze_authority: null,
      top1_pct: 88,
      findings: [{ severity: 'high', label: 'Single holder dominance' }]
    });
    const { corrected, flags } = validateLLMScore(75, { risk_score: 15, category: 'SAFE' }, auditData);
    assert.ok(corrected.risk_score >= 31, `Score should be ≥31, got ${corrected.risk_score}`);
    assert.ok(corrected.category !== 'SAFE', `Scam token must not be SAFE, got ${corrected.category}`);
  });

  test(`${token.name} (${token.mint.slice(0, 8)}…): rawScore>65 locks DANGER category`, () => {
    const auditData = buildMockAuditData(token, { raw_score: 75, top1_pct: 85 });
    const { corrected } = validateLLMScore(75, { risk_score: 75, category: 'CAUTION' }, auditData);
    assert.strictEqual(corrected.category, 'DANGER', `Expected DANGER for scam token, got ${corrected.category}`);
  });
}

console.log('\n--- Edge cases: Token-2022 and concentration ---\n');

const edgeTokens = dataset.tokens.filter(t => t.category === 'edge');

test('PYUSD (Token-2022 Permanent Delegate): not DANGER with legitimate profile', () => {
  const pyusd = edgeTokens.find(t => t.symbol === 'PYUSD');
  if (!pyusd) return;
  const auditData = buildMockAuditData(pyusd, {
    raw_score: 25,
    mint_authority: null,
    freeze_authority: null,
    top1_pct: 5,
    is_token_2022: true,
    findings: [{ severity: 'medium', label: 'Permanent Delegate extension active' }]
  });
  const { corrected } = validateLLMScore(25, { risk_score: 25, category: 'CAUTION' }, auditData);
  assert.notStrictEqual(corrected.category, 'DANGER', 'PYUSD should not be DANGER — false positive');
});

test('TRUMP (80% concentration): CAUTION not DANGER (mint revoked)', () => {
  const trump = edgeTokens.find(t => t.symbol === 'TRUMP');
  if (!trump) return;
  const auditData = buildMockAuditData(trump, {
    raw_score: 55,
    mint_authority: null,
    freeze_authority: null,
    top1_pct: 80,
    findings: [{ severity: 'high', label: 'Single holder ownership >80%' }]
  });
  const { corrected } = validateLLMScore(55, { risk_score: 55, category: 'CAUTION' }, auditData);
  assert.notStrictEqual(corrected.category, 'DANGER', 'TRUMP (revoked mint) should not be DANGER — false positive');
  assert.ok(corrected.risk_score >= 31, 'Concentration should keep score in CAUTION range');
});

test('WIF (memecoin, clean): SAFE category preserved', () => {
  const wif = edgeTokens.find(t => t.symbol === 'WIF');
  if (!wif) return;
  const auditData = buildMockAuditData(wif, {
    raw_score: 8,
    mint_authority: null,
    freeze_authority: null,
    top1_pct: 10,
    findings: []
  });
  const { corrected, flags } = validateLLMScore(8, { risk_score: 8, category: 'SAFE' }, auditData);
  assert.strictEqual(corrected.category, 'SAFE');
  assert.strictEqual(flags.length, 0);
});

// ── LLM drift protection: cross-dataset ──────────────────────────────────────

console.log('\n--- LLM drift protection ---\n');

test('LLM cannot downgrade DANGER scam to SAFE (drift protection)', () => {
  const auditData = buildMockAuditData({}, {
    raw_score: 80,
    top1_pct: 85,
    mint_authority: 'ActiveWallet',
    findings: [{ severity: 'critical', label: 'mint rug pattern' }]
  });
  const { corrected, flags } = validateLLMScore(80, { risk_score: 5, category: 'SAFE' }, auditData);
  assert.ok(corrected.risk_score >= 60, `Score must be ≥60 after drift correction, got ${corrected.risk_score}`);
  assert.strictEqual(corrected.category, 'DANGER');
  assert.ok(flags.some(f => f.startsWith('llm_score_corrected_drift')));
  results.danger.tp++;
});

test('LLM can downgrade score by exactly 20 points (boundary)', () => {
  const auditData = buildMockAuditData({}, { raw_score: 60, findings: [], top1_pct: 5 });
  const { corrected, flags } = validateLLMScore(60, { risk_score: 40, category: 'CAUTION' }, auditData);
  assert.strictEqual(corrected.risk_score, 40);
  assert.ok(!flags.some(f => f.startsWith('llm_score_corrected_drift')));
});

test('LLM can make score stricter (higher than deterministic)', () => {
  const auditData = buildMockAuditData({}, { raw_score: 30, findings: [], top1_pct: 5 });
  const { corrected } = validateLLMScore(30, { risk_score: 75, category: 'DANGER' }, auditData);
  assert.strictEqual(corrected.risk_score, 75);
});

// ── Consistency test ──────────────────────────────────────────────────────────

console.log('\n--- Consistency: same input → same output ---\n');

test('validateLLMScore is deterministic (idempotent on same input)', () => {
  const auditData = buildMockAuditData({}, {
    raw_score: 55,
    mint_authority: 'ActiveWallet',
    top1_pct: 60,
    findings: [{ severity: 'high', label: 'high concentration' }]
  });
  const llmInput = { risk_score: 20, category: 'SAFE' };
  const result1 = validateLLMScore(55, llmInput, auditData);
  const result2 = validateLLMScore(55, llmInput, auditData);
  const result3 = validateLLMScore(55, llmInput, auditData);
  assert.strictEqual(result1.corrected.risk_score, result2.corrected.risk_score);
  assert.strictEqual(result2.corrected.risk_score, result3.corrected.risk_score);
  assert.deepStrictEqual(result1.flags, result2.flags);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✅ ACCURACY GATE: PASS');
} else {
  console.log('❌ ACCURACY GATE: FAIL');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
