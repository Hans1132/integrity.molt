'use strict';
// src/adversarial/executor.js — Actual transaction-level attack executor
// Uses @solana/web3.js against the forked local validator.
// Each exported function tries a specific low-level exploit and returns a result.

const {
  Connection, Keypair, PublicKey, Transaction,
  SystemProgram, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} = require('@solana/web3.js');

const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const SOLANA_BIN    = '/root/.local/share/solana/install/active_release/bin';
const KEYGEN_BIN    = path.join(SOLANA_BIN, 'solana-keygen');

// ── Helpers ───────────────────────────────────────────────────────────────────

function newConnection(rpcUrl) {
  return new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

/** Generate a fresh funded keypair on the local validator (via airdrop). */
async function newFundedAttacker(connection) {
  const kp = Keypair.generate();
  try {
    const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
  } catch (e) {
    // Airdrop may be throttled; continue with unfunded attacker
    console.warn('[executor] airdrop failed:', e.message);
  }
  return kp;
}

/** Structured result for one exploit attempt. */
function result(exploitId, outcome, detail, txSig = null) {
  return { exploitId, outcome, detail, txSig, ts: new Date().toISOString() };
}

// ── Exploit: unauthorized SOL drain ───────────────────────────────────────────

/**
 * Attempt to transfer SOL from a target account using an unauthorized keypair.
 * On a real program this will fail because we can't sign for the vault PDA,
 * but the error message itself is diagnostic.
 */
async function tryUnauthorizedSolTransfer(rpcUrl, targetPubkey) {
  const id = 'drain_vault:sol_transfer';
  try {
    const conn     = newConnection(rpcUrl);
    const attacker = await newFundedAttacker(conn);
    const target   = new PublicKey(targetPubkey);

    // Try to build a system-program transfer FROM target TO attacker.
    // This will fail if we can't sign for target, which is expected — but
    // how it fails tells us whether the account has proper ownership checks.
    const balance = await conn.getBalance(target);
    if (balance === 0) {
      return result(id, 'skip', 'Target has zero balance, skipping drain attempt');
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: target,
        toPubkey:   attacker.publicKey,
        lamports:   Math.floor(balance * 0.5)
      })
    );
    // We intentionally do NOT have the private key for `target`.
    // Signing only with attacker — this SHOULD be rejected.
    tx.feePayer = attacker.publicKey;
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(attacker);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(sig, 'confirmed');

    // If we reach here, the transfer went through — CRITICAL finding
    return result(id, 'CRITICAL', `Unauthorized SOL transfer of ${balance} lamports SUCCEEDED from ${targetPubkey}`, sig);
  } catch (e) {
    const msg = e.message || String(e);
    // "missing required signature" = correctly protected
    if (/missing.*(required|signature)|not enough signers/i.test(msg)) {
      return result(id, 'pass', `Correctly rejected: ${msg.slice(0, 120)}`);
    }
    // Any other error: not a security issue but record it
    return result(id, 'error', msg.slice(0, 200));
  }
}

// ── Exploit: account existence and rent check ─────────────────────────────────

/**
 * Check if a high-value account can be closed by an unauthorized keypair.
 * Closing an account (zeroing lamports) would redirect rent to the attacker.
 */
async function tryUnauthorizedAccountClose(rpcUrl, targetPubkey) {
  const id = 'drain_vault:close_account';
  try {
    const conn     = newConnection(rpcUrl);
    const attacker = await newFundedAttacker(conn);
    const target   = new PublicKey(targetPubkey);
    const info     = await conn.getAccountInfo(target);
    if (!info) return result(id, 'skip', 'Target account not found on forked validator');

    // A properly owned account can only be closed by its owning program.
    // Attempting a direct SOL drain to zero via system program should fail.
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: target,
        toPubkey:   attacker.publicKey,
        lamports:   info.lamports
      })
    );
    tx.feePayer = attacker.publicKey;
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(attacker);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(sig, 'confirmed');

    return result(id, 'CRITICAL', `Account close succeeded — ${info.lamports} lamports redirected from ${targetPubkey}`, sig);
  } catch (e) {
    const msg = e.message || String(e);
    if (/missing.*(required|signature)|not.*signer/i.test(msg)) {
      return result(id, 'pass', 'Close attempt correctly rejected: missing required signature');
    }
    return result(id, 'error', msg.slice(0, 200));
  }
}

// ── Exploit: bad-account-type substitution ────────────────────────────────────

/**
 * Inspect whether two accounts of different types have the same owner —
 * a common prerequisite for account confusion attacks.
 */
async function checkAccountOwnerConsistency(rpcUrl, pubkeys) {
  const id = 'account_confusion:owner_check';
  try {
    const conn    = newConnection(rpcUrl);
    const infos   = await conn.getMultipleAccountsInfo(pubkeys.map(p => new PublicKey(p)));
    const owners  = infos.map((info, i) => ({
      pubkey: pubkeys[i],
      owner:  info?.owner?.toBase58() || 'null',
      size:   info?.data?.length || 0,
      exists: !!info
    }));
    const uniqueOwners = [...new Set(owners.filter(o => o.exists).map(o => o.owner))];
    return result(id, 'info', JSON.stringify({ accounts: owners, unique_owners: uniqueOwners }));
  } catch (e) {
    return result(id, 'error', (e.message || '').slice(0, 200));
  }
}

// ── Exploit: balance snapshot before/after ────────────────────────────────────

/**
 * Snapshot SOL and token balances of all accounts before running other attacks.
 * Used to detect any unexpected fund movements.
 */
async function snapshotBalances(rpcUrl, pubkeys) {
  try {
    const conn = newConnection(rpcUrl);
    const out  = {};
    for (const pk of pubkeys.slice(0, 20)) {
      try {
        const bal = await conn.getBalance(new PublicKey(pk));
        out[pk] = bal;
      } catch {}
    }
    return out;
  } catch { return {}; }
}

// ── Exploit: signer requirement probe ────────────────────────────────────────

/**
 * Submit a no-op transaction (just a memo) with an unexpected feePayer to probe
 * whether the validator is properly isolating accounts. This is a sanity check.
 */
async function probeValidatorSanity(rpcUrl) {
  const id = 'sanity:validator_ready';
  try {
    const conn     = newConnection(rpcUrl);
    const attacker = await newFundedAttacker(conn);
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction();
    tx.feePayer = attacker.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(attacker);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    return result(id, 'pass', 'Validator is live and processing transactions');
  } catch (e) {
    return result(id, 'error', `Validator sanity probe failed: ${e.message}`);
  }
}

module.exports = {
  tryUnauthorizedSolTransfer,
  tryUnauthorizedAccountClose,
  checkAccountOwnerConsistency,
  snapshotBalances,
  probeValidatorSanity,
  newFundedAttacker,
  newConnection
};
