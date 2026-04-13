'use strict';
/**
 * src/rpc.js — Centrální Solana RPC konfigurace
 *
 * Priorita:
 *   1. ALCHEMY_RPC_URL (nový Alchemy endpoint, celá URL v .env)
 *   2. SOLANA_RPC_URL  (starý endpoint nebo libovolná URL)
 *   3. ALCHEMY_API_KEY (jen klíč → sestaví Alchemy URL)
 *   4. ALCHEMY_API_KEY ze souboru /root/.secrets/alchemy_api_key
 *   5. https://api.mainnet-beta.solana.com (public fallback, rate-limited)
 *
 * Použití v scannerech (raw fetch):
 *   const { SOLANA_RPC_URL } = require('../src/rpc');
 *
 * Použití s @solana/web3.js:
 *   const { connection } = require('../src/rpc');
 */

const fs = require('fs');
const { Connection } = require('@solana/web3.js');

// ── Resolve RPC URL ───────────────────────────────────────────────────────────

const PUBLIC_FALLBACK = 'https://api.mainnet-beta.solana.com';

function resolveRpcUrl() {
  // 1. Nový Alchemy endpoint (celá URL)
  if (process.env.ALCHEMY_RPC_URL) return process.env.ALCHEMY_RPC_URL;

  // 2. Libovolný endpoint z SOLANA_RPC_URL
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;

  // 3. ALCHEMY_API_KEY z env
  if (process.env.ALCHEMY_API_KEY) {
    return `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }

  // 4. ALCHEMY_API_KEY ze secrets souboru
  try {
    const k = fs.readFileSync('/root/.secrets/alchemy_api_key', 'utf-8').trim();
    if (k) return `https://solana-mainnet.g.alchemy.com/v2/${k}`;
  } catch {}

  // 5. Veřejný fallback
  return PUBLIC_FALLBACK;
}

const SOLANA_RPC_URL = resolveRpcUrl();

const rpcProvider = (() => {
  if (SOLANA_RPC_URL.includes('alchemy.com'))      return 'alchemy';
  if (SOLANA_RPC_URL.includes('helius'))           return 'helius';
  if (SOLANA_RPC_URL.includes('fluxrpc'))          return 'fluxrpc';
  if (SOLANA_RPC_URL.includes('mainnet-beta'))     return 'public';
  return 'custom';
})();

if (rpcProvider === 'public') {
  console.warn('[rpc] WARNING: Using public Solana RPC — rate-limited, not for production. Set ALCHEMY_RPC_URL in .env');
} else {
  console.log(`[rpc] Solana RPC: ${rpcProvider} (${SOLANA_RPC_URL.replace(/\?key=.+$/, '?key=***').replace(/\/v2\/.+$/, '/v2/***')})`);
}

// ── @solana/web3.js Connection (pro kód který jej potřebuje) ──────────────────

const connection = new Connection(SOLANA_RPC_URL, {
  commitment:                      'confirmed',
  confirmTransactionInitialTimeout: 30_000,
  disableRetryOnRateLimit:          false,
});

module.exports = { SOLANA_RPC_URL, connection, rpcProvider };
