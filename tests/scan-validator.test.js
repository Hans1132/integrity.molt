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

// ── address validation ────────────────────────────────────────────────────────
// Note: valid EVM address = 0x + exactly 40 hex chars. The address
// "0x833589fCD6eDb6E8f4c7C32D4f71b54bdA2913" in the bug report has only 38 hex
// chars (truncated). Real USDC on Base = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
// Both truncated and valid EVM addresses are rejected with HTTP 400 before payment.
const { isEvmAddress, isSolanaAddress, detectChain } = require('../src/validation/address');

const EVM_VALID   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // 40 hex chars
const EVM_SPEC    = '0x833589fCD6eDb6E8f4c7C32D4f71b54bdA2913';  // 38 hex chars (bug-report addr)
const SOL_USDC    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_WRAPPED = 'So11111111111111111111111111111111111111112';

test('isEvmAddress — valid 40-char EVM address', () => {
  assert.strictEqual(isEvmAddress(EVM_VALID), true);
});

test('isEvmAddress — lowercase hex', () => {
  assert.strictEqual(isEvmAddress('0xabcdef1234567890abcdef1234567890abcdef12'), true);
});

test('isEvmAddress — Solana USDC address is NOT EVM', () => {
  assert.strictEqual(isEvmAddress(SOL_USDC), false);
});

test('isEvmAddress — truncated 0x address (38 hex) is not valid EVM', () => {
  assert.strictEqual(isEvmAddress(EVM_SPEC), false);
});

test('isSolanaAddress — USDC mint is valid Solana', () => {
  assert.strictEqual(isSolanaAddress(SOL_USDC), true);
});

test('isSolanaAddress — wrapped SOL is valid Solana', () => {
  assert.strictEqual(isSolanaAddress(SOL_WRAPPED), true);
});

test('isSolanaAddress — valid EVM address is NOT Solana', () => {
  assert.strictEqual(isSolanaAddress(EVM_VALID), false);
});

test('isSolanaAddress — truncated 0x address is NOT Solana (0 not in base58)', () => {
  assert.strictEqual(isSolanaAddress(EVM_SPEC), false);
});

test('isSolanaAddress — sanitized EVM string (old regex bug) is NOT Solana', () => {
  // Old code: address.replace(/[^1-9A-HJ-NP-Za-km-z]/g,'') on EVM_SPEC
  // removes '0', keeps 'x' → resulting string has 39 chars but fails PublicKey
  const sanitized = EVM_SPEC.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  assert.strictEqual(isSolanaAddress(sanitized), false, `sanitized EVM "${sanitized}" must NOT pass`);
});

test('isSolanaAddress — too short', () => {
  assert.strictEqual(isSolanaAddress('abc123'), false);
});

test('isSolanaAddress — empty string', () => {
  assert.strictEqual(isSolanaAddress(''), false);
});

test('detectChain — valid EVM', () => {
  assert.strictEqual(detectChain(EVM_VALID), 'evm');
});

test('detectChain — Solana', () => {
  assert.strictEqual(detectChain(SOL_USDC), 'solana');
});

test('detectChain — garbage → unknown', () => {
  assert.strictEqual(detectChain('notanaddress'), 'unknown');
});

test('detectChain — truncated 0x → unknown (not valid EVM, not Solana)', () => {
  assert.strictEqual(detectChain(EVM_SPEC), 'unknown');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
