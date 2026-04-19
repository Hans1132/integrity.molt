'use strict';
/**
 * tests/payment/anti-replay.test.js
 *
 * Regression suite for anti-replay protection in payment flow.
 * Covers:
 *   - Basic sequential markSignatureUsed / isAlreadyUsed contract
 *   - Atomic claim: N concurrent callers with same sig → exactly 1 winner
 *   - High-concurrency N=50 variant
 *   - Independent sigs each win independently
 *   - Simulation of verifyPayment gate (mocked RPC, real DB layer)
 *   - Pricing constants regression
 *
 * Uses an in-memory SQLite database — no running server required.
 *
 * Run: node tests/payment/anti-replay.test.js
 */

// ── Override DB path to an in-memory database for testing ────────────────────
process.env.SQLITE_DB_PATH = ':memory:';
// Prevent server.js bootstrap side effects if accidentally required
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';

const db = require('../../db');

// ── Test harness ─────────────────────────────────────────────────────────────

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

/** Generate a deterministic 88-char hex sig unique to this test run. */
let _sigCounter = 0;
function makeSig(prefix = 'test') {
  const base = `${prefix}_${Date.now()}_${++_sigCounter}`;
  // Pad to 88 chars the way Solana base58 sigs look in length tests
  return base.padEnd(88, '0');
}

/** Reset the used_signatures table between test cases for isolation. */
function clearUsedSignatures() {
  db.db.prepare('DELETE FROM used_signatures').run();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  // Initialise schema (creates used_signatures table and all other tables)
  await db.initSchema();

  console.log('\n── Anti-Replay Regression Tests ─────────────────────────────────────────────\n');

  // ── Test 1: Fresh signature is not already used ───────────────────────────
  {
    const fresh = await db.isAlreadyUsed(makeSig('fresh'));
    ok('Fresh signature: isAlreadyUsed returns false', fresh === false);
  }

  // ── Test 2: markSignatureUsed + isAlreadyUsed ────────────────────────────
  {
    const sig = makeSig('sequential');
    const firstResult = db.markSignatureUsed(sig);
    ok('markSignatureUsed first call returns true', firstResult === true);
    const used = await db.isAlreadyUsed(sig);
    ok('After markSignatureUsed: isAlreadyUsed returns true', used === true);
    // Second sequential call must return false
    const secondResult = db.markSignatureUsed(sig);
    ok('markSignatureUsed second call returns false (idempotent atomic claim)', secondResult === false);
  }

  // ── Test 3: markSignatureUsed is safe to call repeatedly (no throw) ───────
  {
    const sig = makeSig('idempotent');
    let threw = false;
    try {
      db.markSignatureUsed(sig);
      db.markSignatureUsed(sig);
      db.markSignatureUsed(sig);
    } catch (e) {
      threw = true;
    }
    ok('markSignatureUsed repeated calls do not throw (INSERT OR IGNORE)', threw === false);
  }

  // ── Test 4: Different signatures are independent ─────────────────────────
  {
    const sigA = makeSig('indep_a');
    const sigB = makeSig('indep_b');
    db.markSignatureUsed(sigA);
    const bUsed = await db.isAlreadyUsed(sigB);
    ok('Different signatures are independent: marking A does not affect B', bUsed === false);
    const bWon = db.markSignatureUsed(sigB);
    ok('Independent sig B can claim after A already claimed', bWon === true);
  }

  // ── Test 5: Atomic claim — N=10 concurrent callers, exactly 1 winner ─────
  //
  // better-sqlite3 is synchronous so Promise.all resolves all calls in a
  // single tick. The invariant under test is not timing but the return-value
  // contract of INSERT OR IGNORE on a PRIMARY KEY: exactly one caller sees
  // r.changes === 1 (the atomic "claim"); all others see 0.
  // In production the race window opens during the `await rpcPost` between
  // the early isAlreadyUsed() check and the authoritative markSignatureUsed()
  // call. This test confirms markSignatureUsed() correctly identifies the
  // single winner regardless of how many concurrent requests reach it.
  {
    clearUsedSignatures();
    const sig = makeSig('concurrent10');
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => Promise.resolve(db.markSignatureUsed(sig)))
    );
    const winners = results.filter(r => r === true);
    const losers  = results.filter(r => r === false);
    ok(`N=${N} concurrent callers: exactly 1 winner`, winners.length === 1);
    ok(`N=${N} concurrent callers: exactly ${N - 1} rejected`, losers.length === N - 1);
  }

  // ── Test 6: High concurrency N=50 ────────────────────────────────────────
  {
    clearUsedSignatures();
    const sig = makeSig('concurrent50');
    const N = 50;
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () => Promise.resolve(db.markSignatureUsed(sig)))
    );
    const elapsed = Date.now() - t0;
    const winners = results.filter(r => r === true);
    const losers  = results.filter(r => r === false);
    ok(`N=${N} concurrent callers: exactly 1 winner`, winners.length === 1);
    ok(`N=${N} concurrent callers: exactly ${N - 1} rejected`, losers.length === N - 1);
    ok(`N=${N} completed under 2 000 ms (was ${elapsed} ms)`, elapsed < 2000);
  }

  // ── Test 7: Five independent sigs in parallel — each has its own winner ──
  {
    clearUsedSignatures();
    const sigs = Array.from({ length: 5 }, (_, i) => makeSig(`multisig_${i}`));
    const N_PER_SIG = 8;

    // For each sig, fire N_PER_SIG concurrent claims
    const perSigResults = await Promise.all(
      sigs.map(sig =>
        Promise.all(
          Array.from({ length: N_PER_SIG }, () => Promise.resolve(db.markSignatureUsed(sig)))
        )
      )
    );

    let allCorrect = true;
    for (let i = 0; i < sigs.length; i++) {
      const winners = perSigResults[i].filter(r => r === true);
      if (winners.length !== 1) allCorrect = false;
    }
    ok('5 independent sigs in parallel: each has exactly 1 winner (5 total winners)', allCorrect);
  }

  // ── Test 8: verifyPayment gate simulation — mock RPC, real DB ────────────
  //
  // verifyPayment() is not exported from server.js (it would start the HTTP
  // server on require). We test the authoritative protection layer directly:
  // simulate N parallel "post-RPC-verification" markSignatureUsed calls, which
  // is the exact code path that protects against double-spend. This is
  // equivalent to N concurrent verifyPayment() calls all receiving a valid
  // transaction from RPC and racing to claim the same sig.
  {
    clearUsedSignatures();
    const sig = makeSig('verifymock');
    const N = 5;

    // Simulate: each caller passed RPC check (verified=true) and calls the gate
    const gateResults = await Promise.all(
      Array.from({ length: N }, async () => {
        // mimic the verifyPayment() block after `if (verified)`:
        const reserved = db.markSignatureUsed(sig);
        if (!reserved) {
          return { ok: false, reason: 'transaction already used (race)' };
        }
        return { ok: true, reason: 'payment confirmed' };
      })
    );

    const okResults   = gateResults.filter(r => r.ok === true);
    const raceRejects = gateResults.filter(r => r.ok === false && r.reason.includes('already used'));

    ok('verifyPayment gate: exactly 1 ok=true result', okResults.length === 1);
    ok(`verifyPayment gate: ${N - 1} race-rejected with 'already used' reason`, raceRejects.length === N - 1);
  }

  // ── Test 9: markSignatureUsed is idempotent (no error on double INSERT) ──
  // (kept from original suite, now with explicit return value assertions)
  {
    const sig = makeSig('dbl_insert');
    let threw = false;
    let firstWon, secondWon;
    try {
      firstWon  = db.markSignatureUsed(sig);
      secondWon = db.markSignatureUsed(sig);
    } catch (e) {
      threw = true;
    }
    ok('Double INSERT does not throw', threw === false);
    ok('First INSERT returns true',    firstWon  === true);
    ok('Second INSERT returns false',  secondWon === false);
  }

  // ── Test 10: Pricing constants are defined and correct ───────────────────
  {
    const { PRICING, PRICING_DISPLAY } = require('../../config/pricing');

    ok('PRICING.quick  = 500000  (0.50 USDC)',  PRICING.quick  === 500_000);
    ok('PRICING.deep   = 5000000 (5.00 USDC)',  PRICING.deep   === 5_000_000);
    ok('PRICING.token  = 750000  (0.75 USDC)',  PRICING.token  === 750_000);
    ok('PRICING.wallet = 750000  (0.75 USDC)',  PRICING.wallet === 750_000);
    ok('PRICING.pool   = 750000  (0.75 USDC)',  PRICING.pool   === 750_000);
    ok('PRICING.delta  = 1000000 (1.00 USDC)',  PRICING.delta  === 1_000_000);
    ok('PRICING.adversarial = 4000000 (4.00 USDC)', PRICING.adversarial === 4_000_000);

    ok('PRICING_DISPLAY.token  = "0.75 USDC"', PRICING_DISPLAY.token  === '0.75 USDC');
    ok('PRICING_DISPLAY.wallet = "0.75 USDC"', PRICING_DISPLAY.wallet === '0.75 USDC');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
