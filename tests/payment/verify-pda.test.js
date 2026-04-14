'use strict';
/**
 * tests/payment/verify-pda.test.js
 *
 * Unit tests for src/payment/verify-pda.js
 * No running server or network required — pure local computation.
 */

const assert = require('assert');
const { deriveAssetSignerPDA, isAssetSignerPDA, enrichPaymentContextWithPDA, MPL_CORE_PROGRAM_ID } = require('../../src/payment/verify-pda');

// Known valid Solana base58 address used as a stand-in for an agent mint.
// This is the Metaplex Core program address itself — a canonical on-chain pubkey.
const SAMPLE_MINT = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
// A different valid pubkey — used to test mismatch.
const OTHER_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint

async function run() {
  let pass = 0;
  let fail = 0;

  function ok(label, condition) {
    if (condition) {
      console.log(`  PASS  ${label}`);
      pass++;
    } else {
      console.error(`  FAIL  ${label}`);
      fail++;
    }
  }

  // ── 1. MPL_CORE_PROGRAM_ID is exported as a non-empty string ────────────────
  ok('MPL_CORE_PROGRAM_ID is a non-empty string',
    typeof MPL_CORE_PROGRAM_ID === 'string' && MPL_CORE_PROGRAM_ID.length > 0);

  // ── 2. deriveAssetSignerPDA returns a consistent base58 string ───────────────
  const pda1 = deriveAssetSignerPDA(SAMPLE_MINT);
  const pda2 = deriveAssetSignerPDA(SAMPLE_MINT);
  ok('deriveAssetSignerPDA returns a string for valid mint', typeof pda1 === 'string' && pda1.length > 0);
  ok('deriveAssetSignerPDA is deterministic (same mint → same PDA)', pda1 === pda2);

  // ── 3. Different mints produce different PDAs ────────────────────────────────
  const pdaOther = deriveAssetSignerPDA(OTHER_MINT);
  ok('deriveAssetSignerPDA returns a string for a different valid mint',
    typeof pdaOther === 'string' && pdaOther.length > 0);
  ok('Different mints produce different PDAs', pda1 !== pdaOther);

  // ── 4. deriveAssetSignerPDA returns null for invalid mint ────────────────────
  ok('deriveAssetSignerPDA returns null for empty string',   deriveAssetSignerPDA('') === null);
  ok('deriveAssetSignerPDA returns null for garbage input',  deriveAssetSignerPDA('not-a-valid-pubkey!!!') === null);
  ok('deriveAssetSignerPDA returns null for null input',     deriveAssetSignerPDA(null) === null);

  // ── 5. isAssetSignerPDA — basic cases ────────────────────────────────────────
  ok('isAssetSignerPDA returns false when senderAddress is null',
    isAssetSignerPDA(null, SAMPLE_MINT) === false);
  ok('isAssetSignerPDA returns false when agentMint is not provided',
    isAssetSignerPDA(pda1) === false);
  ok('isAssetSignerPDA returns false when agentMint is null',
    isAssetSignerPDA(pda1, null) === false);

  // ── 6. isAssetSignerPDA — correct PDA matches ────────────────────────────────
  ok('isAssetSignerPDA returns true for matching PDA and mint',
    isAssetSignerPDA(pda1, SAMPLE_MINT) === true);

  // ── 7. isAssetSignerPDA — wrong sender does not match ────────────────────────
  ok('isAssetSignerPDA returns false for mismatched sender',
    isAssetSignerPDA(pdaOther, SAMPLE_MINT) === false);
  ok('isAssetSignerPDA returns false for random address',
    isAssetSignerPDA(OTHER_MINT, SAMPLE_MINT) === false);

  // ── 8. enrichPaymentContextWithPDA — no mint supplied ────────────────────────
  const ctx1 = enrichPaymentContextWithPDA(pda1, null);
  ok('enrichPaymentContextWithPDA: isPDA=false when no mint',   ctx1.isPDA    === false);
  ok('enrichPaymentContextWithPDA: pdaValid=false when no mint', ctx1.pdaValid === false);
  ok('enrichPaymentContextWithPDA: agentMint=null when no mint', ctx1.agentMint === null);

  // ── 9. enrichPaymentContextWithPDA — valid PDA + correct mint ────────────────
  const ctx2 = enrichPaymentContextWithPDA(pda1, SAMPLE_MINT);
  ok('enrichPaymentContextWithPDA: isPDA=true when mint supplied',      ctx2.isPDA    === true);
  ok('enrichPaymentContextWithPDA: pdaValid=true for correct sender',   ctx2.pdaValid === true);
  ok('enrichPaymentContextWithPDA: agentMint echoed back',              ctx2.agentMint === SAMPLE_MINT);

  // ── 10. enrichPaymentContextWithPDA — wrong sender + correct mint ────────────
  const ctx3 = enrichPaymentContextWithPDA(OTHER_MINT, SAMPLE_MINT);
  ok('enrichPaymentContextWithPDA: isPDA=true when mint supplied (mismatch)',  ctx3.isPDA    === true);
  ok('enrichPaymentContextWithPDA: pdaValid=false for wrong sender',           ctx3.pdaValid === false);

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
