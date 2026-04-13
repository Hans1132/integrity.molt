'use strict';
// src/adversarial/fork.js — Local validator fork for adversarial simulation
// Spins up solana-test-validator cloning the target program and its accounts,
// waits for readiness, and provides a cleanup handle.

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const os    = require('os');
const crypto = require('crypto');

const SOLANA_BIN    = '/root/.local/share/solana/install/active_release/bin';
const VALIDATOR_BIN = path.join(SOLANA_BIN, 'solana-test-validator');
const KEYGEN_BIN    = path.join(SOLANA_BIN, 'solana-keygen');
const { SOLANA_RPC_URL: MAINNET_RPC } = require('../rpc');

const DEFAULT_RPC_PORT  = 8899;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes
const READY_POLL_MS      = 800;
const READY_MAX_POLLS    = 30;               // up to 24 s startup

// ── RPC helper (works for both http and https) ─────────────────────────────────

function rpcCall(url, method, params = []) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = mod.request(options, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error('RPC parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Account discovery ──────────────────────────────────────────────────────────

// Well-known program IDs used in most DeFi / token programs
const WELL_KNOWN = {
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':    'SPL Token',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb':    'Token-2022',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS':   'Associated Token',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s':    'Metaplex Metadata',
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX':    'Serum DEX v3',
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin':   'Serum DEX v2',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':   'Raydium AMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':    'Whirlpools (Orca)',
  'So11111111111111111111111111111111111111112':      'System Program',
  '11111111111111111111111111111111':                 'System Program'
};

// Heuristic account classification based on data size and content
function classifyAccount(pubkey, info) {
  const dataLen = info?.data?.length ?? 0;
  const owner   = info?.owner || '';
  const isExec  = info?.executable || false;

  if (isExec)      return 'program';
  if (dataLen === 0) return 'wallet/signer';

  // SPL token mint: 82 bytes; token account: 165 bytes
  if (owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
    if (dataLen === 82)  return 'token_mint';
    if (dataLen === 165) return 'token_account';
    return 'token_related';
  }
  if (owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') return 'token22_account';

  // Heuristics: large accounts are likely vaults or data stores
  if (dataLen < 64)   return 'config_small';
  if (dataLen < 512)  return 'config_medium';
  return 'data_store';
}

/**
 * Discover all accounts owned by programId on mainnet.
 * Returns up to 50 accounts with type classification.
 *
 * @param {string} programId base58 program address
 * @returns {Promise<Array<{ pubkey, type, lamports, dataSize, owner }>>}
 */
async function discoverAccounts(programId) {
  const results = [];

  // 1. Get program account itself
  try {
    const acctResp = await rpcCall(MAINNET_RPC, 'getAccountInfo', [
      programId, { encoding: 'base64', commitment: 'confirmed' }
    ]);
    const info = acctResp?.result?.value;
    if (info) {
      const dataB64 = Array.isArray(info.data) ? info.data[0] : (info.data || '');
      results.push({
        pubkey:   programId,
        type:     info.executable ? 'program' : classifyAccount(programId, { ...info, data: dataB64 }),
        lamports: info.lamports || 0,
        dataSize: dataB64 ? Buffer.from(dataB64, 'base64').length : 0,
        owner:    info.owner,
        executable: info.executable
      });
    }
  } catch (e) {
    console.error('[adversarial/fork] getAccountInfo failed:', e.message);
  }

  // 2. Get all accounts owned by the program (capped at 50)
  try {
    const progAccts = await rpcCall(MAINNET_RPC, 'getProgramAccounts', [
      programId,
      {
        encoding:   'base64',
        commitment: 'confirmed',
        dataSlice:  { offset: 0, length: 0 }  // skip data, just get metadata
      }
    ]);
    const accounts = progAccts?.result || [];
    for (const { pubkey, account } of accounts.slice(0, 50)) {
      const dataB64 = Array.isArray(account.data) ? account.data[0] : '';
      results.push({
        pubkey,
        type:     classifyAccount(pubkey, { ...account, data: [] }),
        lamports: account.lamports || 0,
        dataSize: account.space || 0,
        owner:    account.owner
      });
    }
  } catch (e) {
    console.error('[adversarial/fork] getProgramAccounts failed:', e.message);
  }

  // Deduplicate by pubkey
  const seen = new Set();
  return results.filter(a => { if (seen.has(a.pubkey)) return false; seen.add(a.pubkey); return true; });
}

// ── Validator fork ─────────────────────────────────────────────────────────────

/**
 * Start a local solana-test-validator cloning the target program and its accounts.
 *
 * @param {string} programId  base58 program address to clone
 * @param {object} options
 * @param {number} [options.rpcPort=8899]
 * @param {number} [options.timeoutMs=300000]  auto-shutdown after N ms
 * @param {string[]} [options.extraClone=[]]    additional pubkeys to clone
 * @returns {Promise<{ validator: ChildProcess, rpcUrl: string, ledgerDir: string, cleanup: () => void }>}
 */
async function forkState(programId, options = {}) {
  const rpcPort   = options.rpcPort  || DEFAULT_RPC_PORT;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ledgerDir = path.join(os.tmpdir(), `adversarial-ledger-${crypto.randomBytes(6).toString('hex')}`);
  const rpcUrl    = `http://127.0.0.1:${rpcPort}`;

  // Use pre-discovered accounts if provided (avoids redundant RPC call when runner already ran discoverAccounts)
  let accounts = options.accounts || [];
  if (!accounts.length) {
    try {
      accounts = await discoverAccounts(programId);
      console.log(`[adversarial/fork] discovered ${accounts.length} accounts for ${programId.slice(0, 8)}…`);
    } catch (e) {
      console.error('[adversarial/fork] account discovery failed, forking with program only:', e.message);
    }
  } else {
    console.log(`[adversarial/fork] reusing ${accounts.length} pre-discovered accounts for ${programId.slice(0, 8)}…`);
  }

  // Build clone arguments
  const cloneArgs = ['--clone', programId];

  // Clone discovered accounts (skip the program itself, already added)
  for (const acct of accounts) {
    if (acct.pubkey !== programId) {
      cloneArgs.push('--clone', acct.pubkey);
    }
  }

  // Clone extra pubkeys provided by caller
  for (const pk of (options.extraClone || [])) {
    cloneArgs.push('--clone', pk);
  }

  // Clone well-known SPL programs always referenced by Solana programs
  const alwaysClone = [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS',  // Associated Token
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',   // Metaplex
  ];
  for (const pk of alwaysClone) {
    if (pk !== programId) cloneArgs.push('--clone', pk);
  }

  const args = [
    '--url',       MAINNET_RPC,
    '--ledger',    ledgerDir,
    '--rpc-port',  String(rpcPort),
    '--faucet-port', String(rpcPort + 1),
    '--quiet',
    ...cloneArgs
  ];

  console.log(`[adversarial/fork] starting validator: ${VALIDATOR_BIN} (port ${rpcPort})`);
  const validator = spawn(VALIDATOR_BIN, args, {
    env:   process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  validator.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[validator] ${line.slice(0, 120)}`);
  });

  // Wait for validator to be ready
  let ready = false;
  for (let i = 0; i < READY_MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, READY_POLL_MS));
    try {
      await rpcCall(rpcUrl, 'getHealth', []);
      ready = true;
      break;
    } catch {}
  }

  if (!ready) {
    validator.kill('SIGTERM');
    try { fs.rmSync(ledgerDir, { recursive: true, force: true }); } catch {}
    throw new Error('solana-test-validator did not become ready in time');
  }

  console.log(`[adversarial/fork] validator ready at ${rpcUrl}`);

  // Auto-shutdown timer
  const autoKillTimer = setTimeout(() => {
    console.log('[adversarial/fork] auto-shutdown after timeout');
    cleanup();
  }, timeoutMs);

  function cleanup() {
    clearTimeout(autoKillTimer);
    try { validator.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try { fs.rmSync(ledgerDir, { recursive: true, force: true }); } catch {}
    }, 2000);
  }

  validator.on('exit', () => {
    clearTimeout(autoKillTimer);
    try { fs.rmSync(ledgerDir, { recursive: true, force: true }); } catch {}
  });

  return { validator, rpcUrl, ledgerDir, accounts, cleanup };
}

module.exports = { forkState, discoverAccounts, rpcCall, WELL_KNOWN };
