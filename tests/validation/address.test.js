'use strict';
/**
 * tests/validation/address.test.js
 *
 * Unit tests for src/validation/address.js
 * Covers: isEvmAddress, isSolanaAddress, detectChain
 *
 * Pure function tests — no DB, no network, no env vars required.
 * This module gates chain routing for the entire scan pipeline, so the
 * base58 charset / length / off-curve boundaries matter.
 *
 * Run: node tests/validation/address.test.js
 */

const assert = require('assert');
const { isEvmAddress, isSolanaAddress, detectChain } = require('../../src/validation/address');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

// Real on-chain, on-curve addresses (valid base58 PublicKeys).
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM_USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

console.log('\n── Address / Chain Validation Tests ───────────────────────────────────────────\n');

// ── isEvmAddress ──────────────────────────────────────────────────────────────
test('isEvmAddress accepts canonical 0x + 40 hex', () => {
  assert.strictEqual(isEvmAddress(EVM_USDC), true);
  assert.strictEqual(isEvmAddress('0x' + 'a'.repeat(40)), true);
  assert.strictEqual(isEvmAddress('0x' + 'F'.repeat(40)), true);
});

test('isEvmAddress rejects wrong length / missing prefix / non-hex', () => {
  assert.strictEqual(isEvmAddress('0x' + 'a'.repeat(39)), false, '39 nibbles');
  assert.strictEqual(isEvmAddress('0x' + 'a'.repeat(41)), false, '41 nibbles');
  assert.strictEqual(isEvmAddress('a'.repeat(40)), false, 'no 0x prefix');
  assert.strictEqual(isEvmAddress('0x' + 'g'.repeat(40)), false, 'non-hex chars');
});

// ── isSolanaAddress: type guard ───────────────────────────────────────────────
test('isSolanaAddress rejects non-string input without throwing', () => {
  assert.strictEqual(isSolanaAddress(null), false);
  assert.strictEqual(isSolanaAddress(undefined), false);
  assert.strictEqual(isSolanaAddress(12345), false);
  assert.strictEqual(isSolanaAddress({}), false);
  assert.strictEqual(isSolanaAddress(['So11111111111111111111111111111111111111112']), false);
});

// ── isSolanaAddress: EVM must not be mistaken for Solana ──────────────────────
test('isSolanaAddress rejects EVM addresses (chain discrimination)', () => {
  assert.strictEqual(isSolanaAddress(EVM_USDC), false);
});

// ── isSolanaAddress: base58 charset boundaries ────────────────────────────────
test('isSolanaAddress rejects base58-illegal characters (0, O, I, l)', () => {
  // Same length as USDC mint but seeded with each forbidden base58 char.
  const len = USDC_MINT.length;
  for (const bad of ['0', 'O', 'I', 'l']) {
    const candidate = bad + 'A'.repeat(len - 1);
    assert.strictEqual(isSolanaAddress(candidate), false, `char "${bad}" must be rejected`);
  }
});

test('isSolanaAddress rejects strings with non-base58 punctuation', () => {
  assert.strictEqual(isSolanaAddress('So1111111111111111111111111111111111111111+'), false);
  assert.strictEqual(isSolanaAddress('So111111111111111111111111111111111111111 2'), false);
});

// ── isSolanaAddress: length boundaries ────────────────────────────────────────
test('isSolanaAddress rejects too-short (<32) and too-long (>44) strings', () => {
  assert.strictEqual(isSolanaAddress('A'.repeat(31)), false, '31 chars');
  assert.strictEqual(isSolanaAddress('A'.repeat(45)), false, '45 chars');
});

// ── isSolanaAddress: charset-valid but off-curve (PublicKey try/catch path) ───
test('isSolanaAddress accepts real on-curve mints', () => {
  assert.strictEqual(isSolanaAddress(SOL_MINT), true);
  assert.strictEqual(isSolanaAddress(USDC_MINT), true);
});

test('isSolanaAddress: charset-valid string that decodes to wrong byte-length is rejected', () => {
  // 44 base58 'z' chars decode to 33 bytes (not 32), so PublicKey construction
  // throws and the function must return false — exercising the try/catch branch,
  // not just the regex pre-check.
  const candidate = 'z'.repeat(44);
  assert.strictEqual(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate), true, 'passes regex pre-check');
  assert.strictEqual(isSolanaAddress(candidate), false, 'but must fail PublicKey decode');
});

// ── detectChain ───────────────────────────────────────────────────────────────
test('detectChain routes evm / solana / unknown correctly', () => {
  assert.strictEqual(detectChain(EVM_USDC), 'evm');
  assert.strictEqual(detectChain(SOL_MINT), 'solana');
  assert.strictEqual(detectChain('not an address'), 'unknown');
  assert.strictEqual(detectChain(''), 'unknown');
  assert.strictEqual(detectChain(null), 'unknown');
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
