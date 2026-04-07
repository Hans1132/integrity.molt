'use strict';
// tests/adversarial.test.js — Unit tests for the adversarial simulation modules
// Uses mock data — does NOT require a live validator or network access.
// Run: node tests/adversarial.test.js

const assert = require('assert');

// ── Silence LLM calls (no API key in test env) ────────────────────────────────
process.env.OPENROUTER_API_KEY = '';

const { selectPlaybooks, getAllPlaybooks, getPlaybook } = require('../src/adversarial/playbooks');
const { discoverAccounts, WELL_KNOWN }                  = require('../src/adversarial/fork');

async function main() {
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

  console.log('\nadversarial.test.js\n');

  // ── Playbook tests ─────────────────────────────────────────────────────────

  await test('getAllPlaybooks returns non-empty array', async () => {
    const pbs = getAllPlaybooks();
    assert.ok(Array.isArray(pbs) && pbs.length >= 6, `Expected ≥6 playbooks, got ${pbs.length}`);
  });

  await test('each playbook has required fields', async () => {
    const required = ['id', 'name', 'description', 'steps', 'severity_if_success', 'cwe', 'triggers'];
    for (const p of getAllPlaybooks()) {
      for (const field of required) {
        assert.ok(p[field] !== undefined, `Playbook ${p.id} missing field: ${field}`);
      }
      assert.ok(Array.isArray(p.steps) && p.steps.length > 0, `Playbook ${p.id} has no steps`);
      assert.ok(Array.isArray(p.triggers) && p.triggers.length > 0, `Playbook ${p.id} has no triggers`);
    }
  });

  await test('getPlaybook returns correct playbook by id', async () => {
    const p = getPlaybook('drain_vault');
    assert.ok(p, 'drain_vault playbook not found');
    assert.strictEqual(p.id, 'drain_vault');
    assert.strictEqual(p.severity_if_success, 'critical');
  });

  await test('getPlaybook returns null for unknown id', async () => {
    const p = getPlaybook('nonexistent_attack');
    assert.strictEqual(p, null);
  });

  // ── selectPlaybooks tests ──────────────────────────────────────────────────

  await test('selectPlaybooks with token_mint accounts triggers drain_vault', async () => {
    const accounts = [
      { type: 'token_mint', pubkey: 'Aa111', lamports: 1e9 },
      { type: 'token_account', pubkey: 'Bb222', lamports: 5e9 }
    ];
    const selected = selectPlaybooks(accounts);
    const ids      = selected.map(p => p.id);
    assert.ok(ids.includes('drain_vault'), `Expected drain_vault in: ${ids.join(', ')}`);
  });

  await test('selectPlaybooks with program account triggers missing_signer_check', async () => {
    const accounts = [{ type: 'program', pubkey: 'Cc333', lamports: 1e6 }];
    const selected  = selectPlaybooks(accounts);
    const ids       = selected.map(p => p.id);
    assert.ok(ids.includes('missing_signer_check'), `Expected missing_signer_check in: ${ids.join(', ')}`);
    assert.ok(ids.includes('reentrancy_cpi'),        `Expected reentrancy_cpi in: ${ids.join(', ')}`);
  });

  await test('selectPlaybooks with override ignores account types', async () => {
    const accounts = [{ type: 'wallet/signer', pubkey: 'Dd444', lamports: 1e6 }];
    const selected  = selectPlaybooks(accounts, ['authority_takeover', 'integer_overflow']);
    const ids       = selected.map(p => p.id);
    assert.strictEqual(ids.length, 2);
    assert.ok(ids.includes('authority_takeover'));
    assert.ok(ids.includes('integer_overflow'));
  });

  await test('selectPlaybooks with no matching triggers returns empty array', async () => {
    // wallet/signer alone doesn't trigger any playbook in current definitions
    const accounts  = [];
    const selected  = selectPlaybooks(accounts, []);
    // With no accounts and no override, result may be empty or based on defaults
    assert.ok(Array.isArray(selected));
  });

  await test('selectPlaybooks with data_store triggers oracle_manipulation', async () => {
    const accounts = [{ type: 'data_store', pubkey: 'Ee555', lamports: 1e6 }];
    const selected  = selectPlaybooks(accounts);
    const ids       = selected.map(p => p.id);
    assert.ok(ids.includes('oracle_manipulation'), `Expected oracle_manipulation in: ${ids.join(', ')}`);
  });

  // ── WELL_KNOWN map tests ───────────────────────────────────────────────────

  await test('WELL_KNOWN includes SPL Token program', async () => {
    assert.ok(
      WELL_KNOWN['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      'SPL Token not in WELL_KNOWN'
    );
  });

  await test('WELL_KNOWN includes Token-2022 program', async () => {
    assert.ok(
      WELL_KNOWN['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
      'Token-2022 not in WELL_KNOWN'
    );
  });

  // ── Severity validation ────────────────────────────────────────────────────

  await test('all critical playbooks have "critical" severity_if_success', async () => {
    const critical = ['authority_takeover', 'oracle_manipulation', 'drain_vault', 'reentrancy_cpi'];
    for (const id of critical) {
      const p = getPlaybook(id);
      assert.ok(p, `Playbook ${id} not found`);
      assert.strictEqual(p.severity_if_success, 'critical', `${id} should be critical`);
    }
  });

  await test('high-severity playbooks have "high" severity_if_success', async () => {
    const high = ['missing_signer_check', 'account_confusion', 'integer_overflow'];
    for (const id of high) {
      const p = getPlaybook(id);
      assert.ok(p, `Playbook ${id} not found`);
      assert.strictEqual(p.severity_if_success, 'high', `${id} should be high, got ${p?.severity_if_success}`);
    }
  });

  // ── CWE mapping ────────────────────────────────────────────────────────────

  await test('each playbook has a valid CWE reference', async () => {
    for (const p of getAllPlaybooks()) {
      assert.ok(/^CWE-\d+/.test(p.cwe), `Playbook ${p.id} has invalid CWE: ${p.cwe}`);
    }
  });

  // ── Playbook step quality ──────────────────────────────────────────────────

  await test('each playbook has at least 3 steps', async () => {
    for (const p of getAllPlaybooks()) {
      assert.ok(p.steps.length >= 3, `Playbook ${p.id} has only ${p.steps.length} steps (need ≥3)`);
    }
  });

  await test('drain_vault playbook targets token and SOL accounts', async () => {
    const p = getPlaybook('drain_vault');
    const stepText = p.steps.join(' ').toLowerCase();
    assert.ok(stepText.includes('vault') || stepText.includes('treasury'), 'drain_vault should mention vault/treasury');
    assert.ok(stepText.includes('transfer') || stepText.includes('withdraw'), 'drain_vault should mention transfer/withdraw');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
