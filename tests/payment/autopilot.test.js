'use strict';
/**
 * tests/payment/autopilot.test.js
 *
 * Unit tests for AutoPilot co-signing rules engine.
 * Uses an in-memory SQLite database — no running server required.
 */

// ── Override DB path to in-memory SQLite before any require ──────────────────
process.env.SQLITE_DB_PATH = ':memory:';

// Configure AutoPilot via env before loading the module
process.env.AUTOPILOT_ENABLED          = 'true';
process.env.AUTOPILOT_MAX_TX_USDC      = '5.0';
process.env.AUTOPILOT_MAX_DAILY_USDC   = '50.0';
process.env.AUTOPILOT_ALLOWED_SKILLS   = 'quick_scan,token_audit,agent_token_scan,wallet_profile';
process.env.AUTOPILOT_BLACKLIST        = '';

const { db }                   = require('../../db');
const { initAutopilotSchema }  = require('../../db'); // initSchema for used_signatures etc.

async function run() {
  let pass = 0;
  let fail = 0;

  function ok(label, condition) {
    if (condition) {
      console.log(`  ok ${label}`);
      pass++;
    } else {
      console.error(`  FAIL ${label}`);
      fail++;
    }
  }

  // Ensure the main schema (used_signatures etc.) is initialised
  const dbModule = require('../../db');
  await dbModule.initSchema();

  // Load autopilot module — triggers initAutopilotSchema() automatically
  // We use a fresh require after env vars are set
  const autopilot = require('../../src/a2a/autopilot');
  const { canAutoSign, logAutoSignDecision, getAgentDailySpending } = autopilot;

  const TEST_MINT = 'TestMint1111111111111111111111111111111111';

  // ── Test 1: approved for valid request under both limits ─────────────────────
  {
    const result = canAutoSign(TEST_MINT, 'quick_scan', 0.50);
    ok('canAutoSign: approved for valid request under limit', result.approved === true);
    ok('canAutoSign: no rejection reason when approved', result.reason === undefined);
  }

  // ── Test 2: rejected when amountUsdc > maxTxUsdc ─────────────────────────────
  {
    const result = canAutoSign(TEST_MINT, 'token_audit', 6.0);
    ok('canAutoSign: rejected when amountUsdc > maxTxUsdc', result.approved === false);
    ok('canAutoSign: rejection reason present (tx limit)', typeof result.reason === 'string' && result.reason.length > 0);
  }

  // ── Test 3: rejected when skill not in allowedSkills ─────────────────────────
  {
    const result = canAutoSign(TEST_MINT, 'deep_audit', 4.99);
    ok('canAutoSign: rejected when skill not in allowedSkills', result.approved === false);
    ok('canAutoSign: rejection reason mentions skill', result.reason && result.reason.includes('deep_audit'));
  }

  // ── Test 4: AutoPilot disabled → always reject ────────────────────────────────
  {
    // Temporarily override config for this test
    const configModule = require('../../config/autopilot');
    const originalEnabled = configModule.enabled;
    configModule.enabled = false;

    const result = canAutoSign(TEST_MINT, 'quick_scan', 0.10);
    ok('canAutoSign: rejected when AutoPilot disabled', result.approved === false);
    ok('canAutoSign: rejection reason mentions disabled', result.reason && result.reason.toLowerCase().includes('disabled'));

    configModule.enabled = originalEnabled;
  }

  // ── Test 5: logAutoSignDecision + getAgentDailySpending round-trip ────────────
  {
    const MINT_RT = 'RoundTripMint22222222222222222222222222222';

    // Initially zero spending
    const before = getAgentDailySpending(MINT_RT);
    ok('getAgentDailySpending: initial spent_usdc is 0', before.spent_usdc === 0);
    ok('getAgentDailySpending: initial tx_count is 0',   before.tx_count   === 0);
    ok('getAgentDailySpending: limit_usdc matches config', before.limit_usdc === 50.0);
    ok('getAgentDailySpending: remaining_usdc equals limit when no spending', before.remaining_usdc === 50.0);

    // Log two approved transactions
    logAutoSignDecision(MINT_RT, 'quick_scan', 0.50, 'approved', 'sig_test_1');
    logAutoSignDecision(MINT_RT, 'token_audit', 0.75, 'approved', 'sig_test_2');
    // Log one rejected transaction — should NOT count toward daily spending
    logAutoSignDecision(MINT_RT, 'deep_audit', 5.00, 'rejected', null, 'skill not allowed');

    const after = getAgentDailySpending(MINT_RT);
    ok('getAgentDailySpending: spent_usdc sums approved only', Math.abs(after.spent_usdc - 1.25) < 0.0001);
    ok('getAgentDailySpending: tx_count counts approved only', after.tx_count === 2);
    ok('getAgentDailySpending: remaining_usdc is limit minus spent', Math.abs(after.remaining_usdc - 48.75) < 0.0001);
  }

  // ── Test 6: daily cap enforcement ────────────────────────────────────────────
  {
    const MINT_CAP = 'DailyCapMint33333333333333333333333333333';

    // Approve transactions summing to 49.0 USDC (under 50.0 limit)
    logAutoSignDecision(MINT_CAP, 'quick_scan', 49.0, 'approved', 'sig_cap_1');

    // Next transaction of 1.01 USDC would push over 50.0 — should be rejected
    const result = canAutoSign(MINT_CAP, 'quick_scan', 1.01);
    ok('canAutoSign: rejected when daily cap would be exceeded', result.approved === false);
    ok('canAutoSign: rejection reason mentions daily limit', result.reason && result.reason.includes('Daily limit'));

    // But a transaction of exactly 1.0 USDC should be approved (49 + 1 = 50 = limit)
    const exactResult = canAutoSign(MINT_CAP, 'quick_scan', 1.0);
    ok('canAutoSign: approved when spending exactly hits daily limit', exactResult.approved === true);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
