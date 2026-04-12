'use strict';
// tests/scan-validator.test.js — Unit tests for src/llm/scan-validator.js
// Pure function tests — no network, no RPC, no API keys needed.
// Run: node tests/scan-validator.test.js

const assert = require('assert');
const { validateLLMScore, validateAdversarialResult } = require('../src/llm/scan-validator');

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

console.log('\nscan-validator.test.js\n');

// ── validateLLMScore ──────────────────────────────────────────────────────────

test('drift >20 corrects score down to rawScore-20', () => {
  const { corrected, flags } = validateLLMScore(80, { risk_score: 10, category: 'SAFE' }, {});
  assert.strictEqual(corrected.risk_score, 60);
  assert.ok(flags.some(f => f.startsWith('llm_score_corrected_drift')), `Expected drift flag, got: ${flags}`);
});

test('drift exactly 20 is allowed (no correction)', () => {
  const { corrected, flags } = validateLLMScore(50, { risk_score: 30, category: 'SAFE' }, {});
  assert.strictEqual(corrected.risk_score, 30);
  assert.ok(!flags.some(f => f.startsWith('llm_score_corrected_drift')), 'Should not have drift flag');
});

test('drift <20 is allowed (no correction)', () => {
  const { corrected, flags } = validateLLMScore(50, { risk_score: 45, category: 'CAUTION' }, {});
  assert.strictEqual(corrected.risk_score, 45);
  assert.strictEqual(flags.length, 0);
});

test('LLM stricter than deterministic is allowed', () => {
  const { corrected, flags } = validateLLMScore(20, { risk_score: 95, category: 'DANGER' }, {});
  assert.strictEqual(corrected.risk_score, 95);
  assert.strictEqual(flags.length, 0);
});

test('active mint authority forces score >= 40', () => {
  const auditData = { mint_info: { mint_authority: 'SomeWallet111', freeze_authority: null }, findings: [], concentration: {} };
  const { corrected, flags } = validateLLMScore(25, { risk_score: 20, category: 'SAFE' }, auditData);
  assert.ok(corrected.risk_score >= 40, `Expected >=40, got ${corrected.risk_score}`);
  assert.ok(flags.includes('llm_score_corrected_mint_authority_active'));
});

test('renounced mint authority does not trigger correction', () => {
  const auditData = { mint_info: { mint_authority: 'renounced', freeze_authority: null }, findings: [], concentration: {} };
  const { corrected, flags } = validateLLMScore(25, { risk_score: 20, category: 'SAFE' }, auditData);
  assert.ok(!flags.includes('llm_score_corrected_mint_authority_active'));
});

test('active freeze authority forces score >= 35', () => {
  const auditData = { mint_info: { mint_authority: null, freeze_authority: 'SomeAuthority' }, findings: [], concentration: {} };
  const { corrected, flags } = validateLLMScore(20, { risk_score: 10, category: 'SAFE' }, auditData);
  assert.ok(corrected.risk_score >= 35, `Expected >=35, got ${corrected.risk_score}`);
  assert.ok(flags.includes('llm_score_corrected_freeze_authority_active'));
});

test('top1 holder >50% forces score >= 31', () => {
  const auditData = { mint_info: null, findings: [], concentration: { top1_pct: 75 } };
  const { corrected, flags } = validateLLMScore(20, { risk_score: 10, category: 'SAFE' }, auditData);
  assert.ok(corrected.risk_score >= 31, `Expected >=31, got ${corrected.risk_score}`);
  assert.ok(flags.some(f => f.startsWith('llm_score_corrected_concentration')));
});

test('critical finding forces score >= 31', () => {
  const auditData = { mint_info: null, findings: [{ severity: 'critical', label: 'mint rug' }], concentration: {} };
  const { corrected, flags } = validateLLMScore(20, { risk_score: 5, category: 'SAFE' }, auditData);
  assert.ok(corrected.risk_score >= 31, `Expected >=31, got ${corrected.risk_score}`);
  assert.ok(flags.includes('llm_score_corrected_danger_findings_present'));
});

test('high finding forces score >= 31', () => {
  const auditData = { mint_info: null, findings: [{ severity: 'high', label: 'freeze risk' }], concentration: {} };
  const { corrected, flags } = validateLLMScore(20, { risk_score: 5, category: 'SAFE' }, auditData);
  assert.ok(corrected.risk_score >= 31);
  assert.ok(flags.includes('llm_score_corrected_danger_findings_present'));
});

test('null llm returns llm_score_missing flag', () => {
  const { corrected, flags } = validateLLMScore(50, null, {});
  assert.strictEqual(corrected, null);
  assert.ok(flags.includes('llm_score_missing'));
});

test('llm without risk_score returns llm_score_missing flag', () => {
  const { corrected, flags } = validateLLMScore(50, { summary: 'ok' }, {});
  assert.ok(flags.includes('llm_score_missing'));
});

test('rawScore >65 forces category to DANGER regardless of LLM', () => {
  const { corrected, flags } = validateLLMScore(70, { risk_score: 70, category: 'CAUTION' }, {});
  assert.strictEqual(corrected.category, 'DANGER');
  assert.ok(flags.some(f => f.startsWith('llm_category_overridden')));
});

test('rawScore >65, LLM SAFE → category overridden + flag', () => {
  const { corrected, flags } = validateLLMScore(80, { risk_score: 60, category: 'SAFE' }, {});
  assert.strictEqual(corrected.category, 'DANGER');
  assert.ok(flags.some(f => f.includes('DANGER')));
});

test('no flags for clean LLM output', () => {
  const { corrected, flags } = validateLLMScore(50, { risk_score: 50, category: 'CAUTION' }, { mint_info: { mint_authority: 'renounced', freeze_authority: null }, findings: [], concentration: { top1_pct: 10 } });
  assert.strictEqual(flags.length, 0);
  assert.strictEqual(corrected.risk_score, 50);
});

// ── validateAdversarialResult ─────────────────────────────────────────────────

test('SAFE verdict + critical finding adds conflict flag', () => {
  const result = validateAdversarialResult(
    { verdict: 'SAFE', confidence: 85, severity: 'info' },
    { rawScore: null, findings: [{ severity: 'critical', label: 'drain_vault' }] }
  );
  assert.ok(result.llm_validation_flags?.includes('adversarial_verdict_conflicts_critical_findings'));
});

test('VULNERABLE verdict with confidence <40 adds low confidence flag', () => {
  const result = validateAdversarialResult(
    { verdict: 'VULNERABLE', confidence: 30, severity: 'critical' },
    { rawScore: null, findings: [] }
  );
  assert.ok(result.llm_validation_flags?.includes('adversarial_low_confidence_vulnerable'));
});

test('adversarial score drift >20 adds flag', () => {
  const result = validateAdversarialResult(
    { verdict: 'PROTECTED', risk_score: 10, confidence: 80 },
    { rawScore: 80, findings: [] }
  );
  assert.ok(result.llm_validation_flags?.some(f => f.startsWith('adversarial_score_drift')));
});

test('null adversarialResult returns as-is', () => {
  const result = validateAdversarialResult(null, { rawScore: 50, findings: [] });
  assert.strictEqual(result, null);
});

test('null deterministicContext returns result as-is', () => {
  const input = { verdict: 'PROTECTED', confidence: 90 };
  const result = validateAdversarialResult(input, null);
  assert.strictEqual(result, input);
});

test('clean adversarial result has no llm_validation_flags added', () => {
  const result = validateAdversarialResult(
    { verdict: 'PROTECTED', confidence: 85, severity: 'info' },
    { rawScore: 30, findings: [] }
  );
  // Either no flags field, or empty array
  assert.ok(!result.llm_validation_flags || result.llm_validation_flags.length === 0);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
