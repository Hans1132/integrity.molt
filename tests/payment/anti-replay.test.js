'use strict';
/**
 * tests/payment/anti-replay.test.js
 *
 * Unit tests for anti-replay protection and pricing consistency.
 * Uses an in-memory SQLite database — no running server required.
 */

const assert = require('assert');
const path   = require('path');

// ── Override DB path to an in-memory database for testing ────────────────────
process.env.SQLITE_DB_PATH = ':memory:';
const db = require('../../db');

async function run() {
  let pass = 0;
  let fail = 0;

  function ok(label, condition) {
    if (condition) {
      console.log(`  ✅ ${label}`);
      pass++;
    } else {
      console.error(`  ❌ ${label}`);
      fail++;
    }
  }

  // Initialise schema (creates used_signatures table)
  await db.initSchema();

  // ── Test 1: Fresh signature is not already used ───────────────────────────
  const fresh = await db.isAlreadyUsed('test_sig_new_' + Date.now());
  ok('Fresh signature: isAlreadyUsed returns false', fresh === false);

  // ── Test 2: markSignatureUsed + isAlreadyUsed ────────────────────────────
  const testSig = 'test_sig_' + Date.now();
  db.markSignatureUsed(testSig);
  const used = await db.isAlreadyUsed(testSig);
  ok('After markSignatureUsed: isAlreadyUsed returns true', used === true);

  // ── Test 3: markSignatureUsed is idempotent (no error on double INSERT) ──
  let threw = false;
  try {
    db.markSignatureUsed(testSig);
    db.markSignatureUsed(testSig); // should be INSERT OR IGNORE, no throw
  } catch (e) {
    threw = true;
  }
  ok('markSignatureUsed is idempotent (INSERT OR IGNORE)', threw === false);

  // ── Test 4: Different signatures are independent ─────────────────────────
  const sig1 = 'sig_a_' + Date.now();
  const sig2 = 'sig_b_' + Date.now();
  db.markSignatureUsed(sig1);
  const sig2Used = await db.isAlreadyUsed(sig2);
  ok('Different signatures are independent', sig2Used === false);

  // ── Test 5: Pricing constants are defined and correct ────────────────────
  const { PRICING, PRICING_DISPLAY } = require('../../config/pricing');

  ok('PRICING.quick  = 500000  (0.50 USDC)',  PRICING.quick  === 500_000);
  ok('PRICING.deep   = 5000000 (5.00 USDC)',  PRICING.deep   === 5_000_000);
  ok('PRICING.token  = 750000  (0.75 USDC)',  PRICING.token  === 750_000);
  ok('PRICING.wallet = 500000  (0.50 USDC)',  PRICING.wallet === 500_000);
  ok('PRICING.pool   = 500000  (0.50 USDC)',  PRICING.pool   === 500_000);
  ok('PRICING.delta  = 1000000 (1.00 USDC)',  PRICING.delta  === 1_000_000);
  ok('PRICING.adversarial = 10000000 (10.00 USDC)', PRICING.adversarial === 10_000_000);

  ok('PRICING_DISPLAY.token  = "0.75 USDC"', PRICING_DISPLAY.token  === '0.75 USDC');
  ok('PRICING_DISPLAY.wallet = "0.50 USDC"', PRICING_DISPLAY.wallet === '0.50 USDC');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
