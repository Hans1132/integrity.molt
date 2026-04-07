'use strict';
// src/adversarial/playbooks.js — Attack playbook definitions and selector
// Each playbook describes one attack vector. The runner uses these to
// orchestrate the AI agent and actual transaction tests.

// ── Playbook definitions ───────────────────────────────────────────────────────

const PLAYBOOKS = [
  {
    id:          'authority_takeover',
    name:        'Authority Takeover',
    description: 'Attempt to change mint/freeze/upgrade/admin authority without permission.',
    steps: [
      'Identify all authority accounts (mint, freeze, upgrade, admin PDA)',
      'For each authority account, attempt to call change/set_authority instruction from an unauthorized keypair',
      'Attempt to pass a forged signer account with the expected authority pubkey',
      'Record: accepted / rejected / error per attempt'
    ],
    triggers:          ['token_mint', 'program', 'config_medium'],
    severity_if_success: 'critical',
    cwe:               'CWE-285: Improper Authorization',
    solana_checks:     ['missing_signer_check', 'missing_owner_check']
  },
  {
    id:          'oracle_manipulation',
    name:        'Oracle Price Manipulation',
    description: 'Fork state, mutate oracle/price-feed account data, then invoke price-dependent instructions.',
    steps: [
      'Identify oracle/price-feed accounts referenced by the program (Pyth, Switchboard, custom)',
      'In the forked validator, overwrite oracle account data with manipulated prices',
      'Invoke swap/liquidate/borrow instructions that depend on the oracle price',
      'Measure: is profit extractable from the price discrepancy?'
    ],
    triggers:          ['data_store', 'config_medium', 'config_small'],
    severity_if_success: 'critical',
    cwe:               'CWE-345: Insufficient Verification of Data Authenticity',
    solana_checks:     ['missing_owner_check', 'unsigned_oracle_data']
  },
  {
    id:          'missing_signer_check',
    name:        'Missing Signer Verification',
    description: 'Call each program instruction without the required signer.',
    steps: [
      'For each instruction discriminator discovered in the program, attempt to call it without any signer',
      'Attempt to pass an account that is not a signer as if it were a signer (account_meta.is_signer = true but no private key)',
      'Record which instructions are callable without proper authorization'
    ],
    triggers:          ['program', 'config_small', 'config_medium', 'data_store'],
    severity_if_success: 'high',
    cwe:               'CWE-862: Missing Authorization',
    solana_checks:     ['missing_signer_check', 'missing_is_signer']
  },
  {
    id:          'account_confusion',
    name:        'Account Type Confusion',
    description: 'Pass wrong account types or PDAs with wrong seeds to each instruction.',
    steps: [
      'For each instruction, substitute a token account where a mint is expected, and vice versa',
      'Pass a PDA derived with wrong seeds but correct program ID',
      'Pass a system account instead of a program-owned account',
      'Pass an account owned by a different program',
      'Record: does the program accept the wrong account type?'
    ],
    triggers:          ['program', 'token_mint', 'token_account', 'data_store'],
    severity_if_success: 'high',
    cwe:               'CWE-704: Incorrect Type Conversion',
    solana_checks:     ['missing_owner_check', 'account_discriminator_check']
  },
  {
    id:          'drain_vault',
    name:        'Unauthorized Fund Withdrawal',
    description: 'Attempt to drain SOL and token balances from vault/treasury accounts.',
    steps: [
      'Identify vault/treasury accounts holding SOL or tokens (high lamport balances)',
      'Attempt withdraw/transfer instructions from an unauthorized keypair',
      'Attempt CPI into the token program using a spoofed program-as-authority',
      'Attempt close_account instruction on vault accounts to redirect rent to attacker',
      'Record: were any funds moved?'
    ],
    triggers:          ['token_account', 'wallet/signer', 'token_mint'],
    severity_if_success: 'critical',
    cwe:               'CWE-284: Improper Access Control',
    solana_checks:     ['missing_authority_check', 'unchecked_token_transfer']
  },
  {
    id:          'reentrancy_cpi',
    name:        'CPI Reentrancy',
    description: 'Deploy a malicious program that re-enters the target during a CPI callback.',
    steps: [
      'Identify all CPI invocations in the program (via static instruction analysis)',
      'Note intermediate state: does the program update state before or after CPI?',
      'Simulate a malicious callee that calls back into the target program during CPI',
      'Check: is the re-entered call allowed? Is state consistent afterward?'
    ],
    triggers:          ['program'],
    severity_if_success: 'critical',
    cwe:               'CWE-362: Race Condition / Reentrancy',
    solana_checks:     ['cpi_reentrancy', 'state_update_order']
  },
  {
    id:          'integer_overflow',
    name:        'Arithmetic Overflow / Underflow',
    description: 'Pass extreme values to arithmetic-heavy instructions to trigger overflow.',
    steps: [
      'Identify instructions that accept u64/u128 amount parameters',
      'Submit u64::MAX, u64::MAX - 1, 0, and 1 as amounts',
      'Check if the program uses checked arithmetic (checked_add, checked_mul)',
      'Record: does any combination cause incorrect account state?'
    ],
    triggers:          ['program', 'token_mint', 'token_account'],
    severity_if_success: 'high',
    cwe:               'CWE-190: Integer Overflow or Wraparound',
    solana_checks:     ['integer_overflow', 'unchecked_arithmetic']
  }
];

// ── Playbook selector ──────────────────────────────────────────────────────────

/**
 * Select applicable playbooks based on account types found in the program.
 * @param {Array<{ type: string }>} accounts  from discoverAccounts()
 * @param {string[]} [override]  specific playbook IDs to run (skips auto-select)
 * @returns {Array} applicable playbook objects
 */
function selectPlaybooks(accounts, override = []) {
  if (override.length) {
    return PLAYBOOKS.filter(p => override.includes(p.id));
  }
  const foundTypes = new Set(accounts.map(a => a.type));
  return PLAYBOOKS.filter(p =>
    p.triggers.some(t => foundTypes.has(t))
  );
}

/**
 * Return all playbooks (for discovery endpoint).
 */
function getAllPlaybooks() {
  return PLAYBOOKS;
}

/**
 * Return a single playbook by id.
 */
function getPlaybook(id) {
  return PLAYBOOKS.find(p => p.id === id) || null;
}

module.exports = { PLAYBOOKS, selectPlaybooks, getAllPlaybooks, getPlaybook };
