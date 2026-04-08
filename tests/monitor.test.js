'use strict';

/**
 * tests/monitor.test.js — Unit testy pro Live Runtime Monitoring modul
 * Spustit: node tests/monitor.test.js
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ── Mock data ─────────────────────────────────────────────────────────────────

const WATCHED_ADDRESS = 'So1anaProgramXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const UNKNOWN_PROGRAM = 'UnknownEvil111111111111111111111111111111111';
const BPF_LOADER      = 'BPFLoaderUpgradeab1e111111111111111111111111111';
const USDC_MINT       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeParsed(overrides) {
  return {
    signature:       'sig_' + Math.random().toString(36).slice(2, 10),
    timestamp:       Date.now(),
    type:            'UNKNOWN',
    accounts:        [WATCHED_ADDRESS],
    nativeTransfers: [],
    tokenTransfers:  [],
    instructions:    [],
    programs:        [],
    ...overrides,
  };
}

async function main() {
  // ── [1] Alert Engine ──────────────────────────────────────────────────────
  console.log('\n[1] Alert Engine\n');

  const {
    evaluateTransaction,
    detectAuthorityChange,
    detectProgramUpgrade,
    detectLargeTransfer,
    detectNewMint,
    detectAccountClose,
    LARGE_TRANSFER_SOL_LAMPORTS,
    LARGE_TRANSFER_TOKEN_AMOUNT,
  } = require('../src/monitor/alerts');

  await test('authority_change — Helius type SET_AUTHORITY → critical alert', () => {
    const parsed = makeParsed({ type: 'SET_AUTHORITY' });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'authority_change');
    assert(a, 'Expected authority_change alert');
    assert.strictEqual(a.severity, 'critical');
    assert.strictEqual(a.address, WATCHED_ADDRESS);
    assert(a.id, 'Alert must have id');
    assert(a.tx_signature, 'Alert must have tx_signature');
  });

  await test('authority_change — parsed instruction type setAuthority → critical alert', () => {
    const parsed = makeParsed({
      instructions: [{ parsed: { type: 'setAuthority' }, accounts: [WATCHED_ADDRESS] }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    assert(alerts.some(a => a.rule === 'authority_change'), 'Expected authority_change alert');
  });

  await test('program_upgrade — BPF Loader + UPGRADE_PROGRAM type → critical alert', () => {
    const parsed = makeParsed({
      type:         'UPGRADE_PROGRAM',
      programs:     [BPF_LOADER, WATCHED_ADDRESS],
      accounts:     [WATCHED_ADDRESS],
      instructions: [{ program: BPF_LOADER, data: '', accounts: [] }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'program_upgrade');
    assert(a, 'Expected program_upgrade alert');
    assert.strictEqual(a.severity, 'critical');
  });

  await test('large_transfer — SOL ≥ 100 SOL → warning alert', () => {
    const parsed = makeParsed({
      nativeTransfers: [{ from: WATCHED_ADDRESS, to: 'someOther', amount: LARGE_TRANSFER_SOL_LAMPORTS + 1 }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'large_transfer');
    assert(a, 'Expected large_transfer alert');
    assert.strictEqual(a.severity, 'warning');
    assert.strictEqual(a.details.token, 'SOL');
  });

  await test('large_transfer — SOL < 100 SOL → žádný alert', () => {
    const parsed = makeParsed({
      nativeTransfers: [{ from: WATCHED_ADDRESS, to: 'someOther', amount: 50 * 1e9 }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    assert(!alerts.some(a => a.rule === 'large_transfer'), 'Unexpected large_transfer alert');
  });

  await test('large_transfer — USDC ≥ 10k → warning', () => {
    const parsed = makeParsed({
      tokenTransfers: [{
        from: WATCHED_ADDRESS, to: 'dest', mint: USDC_MINT,
        amount: 15_000 * 1e6,
      }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'large_transfer');
    assert(a, 'Expected large_transfer for USDC');
    assert.strictEqual(a.details.token, 'USDC');
  });

  await test('new_mint — mintTo instruction na sledovaný mint → warning', () => {
    const parsed = makeParsed({
      accounts: [WATCHED_ADDRESS],
      instructions: [{
        parsed: { type: 'mintTo', info: { mint: WATCHED_ADDRESS, amount: 1000000 } },
        accounts: [WATCHED_ADDRESS],
      }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'new_mint');
    assert(a, 'Expected new_mint alert');
    assert.strictEqual(a.severity, 'warning');
  });

  await test('account_close — closeAccount instruction → high alert', () => {
    const parsed = makeParsed({
      accounts: [WATCHED_ADDRESS],
      instructions: [{
        parsed: { type: 'closeAccount', info: { account: WATCHED_ADDRESS } },
        accounts: [WATCHED_ADDRESS],
      }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'account_close');
    assert(a, 'Expected account_close alert');
    assert.strictEqual(a.severity, 'high');
  });

  await test('suspicious_cpi — neznámý CPI program → warning', () => {
    const parsed = makeParsed({
      accounts: [WATCHED_ADDRESS],
      programs: [WATCHED_ADDRESS, UNKNOWN_PROGRAM],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    const a = alerts.find(a => a.rule === 'suspicious_cpi');
    assert(a, 'Expected suspicious_cpi alert');
    assert.strictEqual(a.severity, 'warning');
    assert.strictEqual(a.details.targetProgram, UNKNOWN_PROGRAM);
  });

  await test('suspicious_cpi — pouze known programs → žádný alert', () => {
    const parsed = makeParsed({
      accounts: [WATCHED_ADDRESS],
      programs: [WATCHED_ADDRESS, '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    assert(!alerts.some(a => a.rule === 'suspicious_cpi'), 'Unexpected suspicious_cpi for known programs');
  });

  await test('čistá tx (malý SOL transfer) → žádný alert', () => {
    const parsed = makeParsed({
      type:            'TRANSFER',
      programs:        ['11111111111111111111111111111111'],
      nativeTransfers: [{ from: WATCHED_ADDRESS, to: 'dest', amount: 1_000_000 }],
    });
    const alerts = evaluateTransaction(parsed, WATCHED_ADDRESS);
    assert.strictEqual(alerts.length, 0,
      `Expected 0 alerts, got ${alerts.length}: ${JSON.stringify(alerts.map(a => a.rule))}`);
  });

  // ── [2] Notifications ─────────────────────────────────────────────────────
  console.log('\n[2] Notifications — deduplikace a rate limiting\n');

  const { isDuplicate, isRateLimited, _sentAlerts, _rateWindows } = require('../src/monitor/notifications');

  await test('deduplikace — stejný tx_signature + rule → přeskočí', () => {
    _sentAlerts.clear();
    const alert1 = { id: 'a1', tx_signature: 'sig_dup', rule: 'authority_change', address: 'addr1' };
    assert.strictEqual(isDuplicate(alert1), false, 'První výskyt by neměl být duplikát');
    assert.strictEqual(isDuplicate({ ...alert1 }), true, 'Druhý výskyt musí být duplikát');
  });

  await test('deduplikace — různé tx_signature → oba prochází', () => {
    _sentAlerts.clear();
    assert.strictEqual(isDuplicate({ tx_signature: 'sig_A', rule: 'large_transfer' }), false);
    assert.strictEqual(isDuplicate({ tx_signature: 'sig_B', rule: 'large_transfer' }), false);
  });

  await test('deduplikace — různé rule u stejného sig → oba prochází', () => {
    _sentAlerts.clear();
    assert.strictEqual(isDuplicate({ tx_signature: 'sig_X', rule: 'authority_change' }), false);
    assert.strictEqual(isDuplicate({ tx_signature: 'sig_X', rule: 'large_transfer'   }), false);
  });

  await test('rate limit — 10 alertů projde, 11. se blokuje', () => {
    _rateWindows.clear();
    const addr = 'rl_' + Date.now();
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(isRateLimited(addr), false, `Alert ${i + 1} by neměl být blokován`);
    }
    assert.strictEqual(isRateLimited(addr), true, '11. alert musí být blokován');
  });

  await test('rate limit — různé adresy mají oddělené limity', () => {
    _rateWindows.clear();
    const addr1 = 'rl1_' + Date.now();
    const addr2 = 'rl2_' + Date.now();
    for (let i = 0; i < 10; i++) isRateLimited(addr1);
    assert.strictEqual(isRateLimited(addr1), true,  'addr1 měla by být blokována');
    assert.strictEqual(isRateLimited(addr2), false, 'addr2 by neměla být blokována');
  });

  // ── [3] Webhook Receiver — parsování ─────────────────────────────────────
  console.log('\n[3] Webhook Receiver — parsování\n');

  const { parseEnhancedTransaction } = require('../src/monitor/webhook-receiver');

  await test('parseEnhancedTransaction — základní Helius enhanced TX', () => {
    const rawTx = {
      signature:       'txSig123',
      timestamp:       1700000000,
      type:            'TRANSFER',
      feePayer:        'payer111',
      fee:             5000,
      slot:            299000000,
      accountData:     [{ account: 'acc1', owner: 'prog1' }],
      nativeTransfers: [{ fromUserAccount: 'payer111', toUserAccount: 'recv111', amount: 1e9 }],
      tokenTransfers:  [],
      instructions:    [{ programId: 'prog1', data: 'data', accounts: ['acc1'] }],
    };
    const parsed = parseEnhancedTransaction(rawTx);
    assert.strictEqual(parsed.signature, 'txSig123');
    assert.strictEqual(parsed.type, 'TRANSFER');
    assert.strictEqual(parsed.nativeTransfers[0].from, 'payer111');
    assert.strictEqual(parsed.nativeTransfers[0].amount, 1e9);
    assert(parsed.programs.includes('prog1'), 'Programs should include prog1');
  });

  await test('parseEnhancedTransaction — chybějící pole necrashuje', () => {
    const parsed = parseEnhancedTransaction({});
    assert(Array.isArray(parsed.accounts));
    assert(Array.isArray(parsed.nativeTransfers));
    assert(Array.isArray(parsed.tokenTransfers));
    assert(Array.isArray(parsed.instructions));
    assert(Array.isArray(parsed.programs));
  });

  await test('parseEnhancedTransaction — token transfery se mapují správně', () => {
    const rawTx = {
      signature:      'tokSig',
      tokenTransfers: [{
        fromUserAccount: 'from111',
        toUserAccount:   'to111',
        mint:            USDC_MINT,
        tokenAmount:     5000,
        decimals:        6,
      }],
      accountData:     [],
      nativeTransfers: [],
      instructions:    [],
    };
    const parsed = parseEnhancedTransaction(rawTx);
    assert.strictEqual(parsed.tokenTransfers[0].from, 'from111');
    assert.strictEqual(parsed.tokenTransfers[0].mint, USDC_MINT);
    assert.strictEqual(parsed.tokenTransfers[0].amount, 5000);
  });

  // ── Výsledky ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error('Test runner crashed:', e); process.exit(1); });
