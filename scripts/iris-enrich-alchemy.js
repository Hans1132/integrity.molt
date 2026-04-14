#!/usr/bin/env node
/**
 * IRIS Enrichment — Alchemy RPC
 *
 * Pro každý mint z known_scams (kde creator IS NOT NULL) volá:
 *   1. getAccountInfo(mint)       → mintAuthority, freezeAuthority
 *   2. getTokenLargestAccounts(mint) → HHI, top1/top10 holder %
 *
 * Výsledky ukládá do iris_enrichment tabulky v data/intmolt.db.
 * Rate limit: max 5 req/s (2 volání/mint → max 2-3 mintů/s).
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fetch    = require('node-fetch');
const path     = require('path');

const DB_PATH  = path.join(__dirname, '..', 'data', 'intmolt.db');
const RPC_URL  = process.env.ALCHEMY_RPC_URL;

if (!RPC_URL) {
  console.error('ERROR: ALCHEMY_RPC_URL not set in .env');
  process.exit(1);
}

// ─── DB setup ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS iris_enrichment (
    mint                   TEXT PRIMARY KEY,
    mint_authority         TEXT,   -- base58 pubkey | 'revoked' | 'unknown'
    freeze_authority       TEXT,   -- base58 pubkey | 'revoked' | 'unknown'
    mint_auth_active       INTEGER,  -- 1 = active, 0 = revoked, NULL = unknown
    freeze_auth_active     INTEGER,
    top1_holder_pct        REAL,   -- % supply held by largest account
    top10_holder_pct       REAL,   -- % supply held by top-10 accounts
    hhi                    REAL,   -- Herfindahl-Hirschman Index [0,1]
    holder_count           INTEGER,  -- accounts returned (max 20 from Alchemy)
    supply_total           TEXT,   -- raw u64 string
    error_info             TEXT,   -- JSON error if RPC call failed
    enriched_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS iris_enrichment_mint_auth
    ON iris_enrichment (mint_auth_active, freeze_auth_active);
`);

const upsert = db.prepare(`
  INSERT INTO iris_enrichment
    (mint, mint_authority, freeze_authority, mint_auth_active, freeze_auth_active,
     top1_holder_pct, top10_holder_pct, hhi, holder_count, supply_total, error_info)
  VALUES
    (@mint, @mint_authority, @freeze_authority, @mint_auth_active, @freeze_auth_active,
     @top1_holder_pct, @top10_holder_pct, @hhi, @holder_count, @supply_total, @error_info)
  ON CONFLICT(mint) DO UPDATE SET
    mint_authority       = excluded.mint_authority,
    freeze_authority     = excluded.freeze_authority,
    mint_auth_active     = excluded.mint_auth_active,
    freeze_auth_active   = excluded.freeze_auth_active,
    top1_holder_pct      = excluded.top1_holder_pct,
    top10_holder_pct     = excluded.top10_holder_pct,
    hhi                  = excluded.hhi,
    holder_count         = excluded.holder_count,
    supply_total         = excluded.supply_total,
    error_info           = excluded.error_info,
    enriched_at          = datetime('now')
`);

// Přeskoč mints které už máme enrichnuté (bez chyby)
const alreadyDone = new Set(
  db.prepare(`SELECT mint FROM iris_enrichment WHERE error_info IS NULL`)
    .all()
    .map(r => r.mint)
);

const mints = db.prepare(
  `SELECT mint FROM known_scams WHERE creator IS NOT NULL`
).all().map(r => r.mint).filter(m => !alreadyDone.has(m));

console.error(`[iris-enrich] DB: ${DB_PATH}`);
console.error(`[iris-enrich] Mints to enrich: ${mints.length} (${alreadyDone.size} already done)`);
console.error(`[iris-enrich] RPC: ${RPC_URL.replace(/\/v2\/.*$/, '/v2/***')}`);

// ─── RPC helpers ─────────────────────────────────────────────────────────────

let reqId = 1;
const MAX_RPS = 3; // volání za sekundu (2 volání/mint → ~1,5 mintů/s)
const DELAY_MS = Math.ceil(1000 / MAX_RPS); // 333 ms mezi voláními

async function rpcCall(method, params, retries = 3) {
  const body = {
    jsonrpc: '2.0',
    id: reqId++,
    method,
    params,
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 15000,
    });
    if (res.status === 503 || res.status === 429) {
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
      if (attempt < retries) { await sleep(waitMs); continue; }
      throw new Error(`HTTP ${res.status} after ${retries} retries`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  }
  throw new Error('rpcCall: exhausted retries');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Feature extraction ──────────────────────────────────────────────────────

/**
 * Parsuje SPL Token Mint account data (base64, layout v1).
 * Vrací { mintAuthority, freezeAuthority, supply } nebo throws.
 */
function parseMintAccountData(base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  // SPL Mint layout (82 bytes):
  //   [0..4]   mintAuthorityOption (u32)  — 0 = None, 1 = Some
  //   [4..36]  mintAuthority (Pubkey 32 bytes)
  //   [36..44] supply (u64 le)
  //   [44]     decimals (u8)
  //   [45]     isInitialized (bool)
  //   [46..50] freezeAuthorityOption (u32)
  //   [50..82] freezeAuthority (Pubkey 32 bytes)
  if (buf.length < 82) throw new Error(`mint data too short: ${buf.length}`);

  const mintAuthOption    = buf.readUInt32LE(0);
  const mintAuthBytes     = buf.slice(4, 36);
  const supplyLow         = buf.readUInt32LE(36);
  const supplyHigh        = buf.readUInt32LE(40);
  const supply            = BigInt(supplyHigh) * BigInt(0x100000000) + BigInt(supplyLow);
  const freezeAuthOption  = buf.readUInt32LE(46);
  const freezeAuthBytes   = buf.slice(50, 82);

  const _bs58  = require('bs58');
  const bs58enc = (_bs58.default || _bs58).encode.bind(_bs58.default || _bs58);
  const mintAuth   = mintAuthOption  === 1 ? bs58enc(mintAuthBytes)  : null;
  const freezeAuth = freezeAuthOption === 1 ? bs58enc(freezeAuthBytes) : null;

  return {
    mintAuthority:   mintAuth,
    freezeAuthority: freezeAuth,
    supply:          supply.toString(),
  };
}

/**
 * Spočítá HHI a top1/top10 % z pole { amount } objektů.
 */
function computeHolderMetrics(accounts) {
  if (!accounts || accounts.length === 0) return { hhi: null, top1: null, top10: null };

  const amounts = accounts.map(a => BigInt(a.amount));
  const total   = amounts.reduce((s, v) => s + v, 0n);
  if (total === 0n) return { hhi: null, top1: null, top10: null };

  // Seřadit sestupně
  amounts.sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));

  const top1Pct  = Number(amounts[0] * 10000n / total) / 100;
  const top10Sum = amounts.slice(0, 10).reduce((s, v) => s + v, 0n);
  const top10Pct = Number(top10Sum * 10000n / total) / 100;

  // HHI = Σ(share²), share = amount/total jako float
  let hhi = 0;
  for (const a of amounts) {
    const share = Number(a) / Number(total);
    hhi += share * share;
  }

  return { hhi: parseFloat(hhi.toFixed(6)), top1: top1Pct, top10: top10Pct };
}

// ─── Main loop ───────────────────────────────────────────────────────────────

const stats = {
  enriched: 0,
  errors: 0,
  mint_auth_active: 0,
  mint_auth_revoked: 0,
  freeze_auth_active: 0,
  freeze_auth_revoked: 0,
};

async function enrichMint(mint) {
  const row = {
    mint,
    mint_authority:    null,
    freeze_authority:  null,
    mint_auth_active:  null,
    freeze_auth_active: null,
    top1_holder_pct:   null,
    top10_holder_pct:  null,
    hhi:               null,
    holder_count:      null,
    supply_total:      null,
    error_info:        null,
  };

  try {
    // ── 1. getAccountInfo ──────────────────────────────────────────
    await sleep(DELAY_MS);
    const acctInfo = await rpcCall('getAccountInfo', [
      mint,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);

    if (!acctInfo || !acctInfo.value) {
      row.error_info = JSON.stringify({ step: 'getAccountInfo', error: 'account not found' });
      upsert.run(row);
      stats.errors++;
      return;
    }

    const data    = acctInfo.value.data;
    const encoded = Array.isArray(data) ? data[0] : null;
    if (!encoded) throw new Error('unexpected account data format');

    const parsed = parseMintAccountData(encoded);
    row.mint_authority    = parsed.mintAuthority   ?? 'revoked';
    row.freeze_authority  = parsed.freezeAuthority ?? 'revoked';
    row.mint_auth_active  = parsed.mintAuthority   ? 1 : 0;
    row.freeze_auth_active = parsed.freezeAuthority ? 1 : 0;
    row.supply_total      = parsed.supply;

    // ── 2. getTokenLargestAccounts (optional — může selhat na free plánu) ──
    try {
      await sleep(DELAY_MS);
      const largestRes = await rpcCall('getTokenLargestAccounts', [
        mint,
        { commitment: 'confirmed' },
      ], 0); // retries=0 — tato metoda není na free plánu, nezdržovat
      const accounts = largestRes?.value ?? [];
      row.holder_count = accounts.length;
      if (accounts.length > 0) {
        const metrics        = computeHolderMetrics(accounts);
        row.hhi              = metrics.hhi;
        row.top1_holder_pct  = metrics.top1;
        row.top10_holder_pct = metrics.top10;
      }
    } catch (_holderErr) {
      // holder data nedostupná — uložíme jen Rights data
    }

    upsert.run(row);
    stats.enriched++;
    if (row.mint_auth_active   === 1) stats.mint_auth_active++;
    else if (row.mint_auth_active === 0) stats.mint_auth_revoked++;
    if (row.freeze_auth_active  === 1) stats.freeze_auth_active++;
    else if (row.freeze_auth_active === 0) stats.freeze_auth_revoked++;

  } catch (err) {
    row.error_info = JSON.stringify({ step: 'enrich', error: err.message });
    upsert.run(row);
    stats.errors++;
  }
}

async function main() {
  const t0      = Date.now();
  const total   = mints.length;
  let   done    = 0;
  const REPORT  = 50;

  for (const mint of mints) {
    await enrichMint(mint);
    done++;

    if (done % REPORT === 0 || done === total) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const pct     = ((done / total) * 100).toFixed(1);
      console.error(
        `[iris-enrich] ${done}/${total} (${pct}%) — ` +
        `ok:${stats.enriched} err:${stats.errors} — ${elapsed}s`
      );
    }
  }

  // ─── Souhrn ──────────────────────────────────────────────────────
  const totalEnriched = stats.enriched + alreadyDone.size;
  const mintActivePct = stats.mint_auth_active + stats.mint_auth_revoked > 0
    ? ((stats.mint_auth_active / (stats.mint_auth_active + stats.mint_auth_revoked)) * 100).toFixed(1)
    : 'n/a';
  const freezeActivePct = stats.freeze_auth_active + stats.freeze_auth_revoked > 0
    ? ((stats.freeze_auth_active / (stats.freeze_auth_active + stats.freeze_auth_revoked)) * 100).toFixed(1)
    : 'n/a';

  const summary = {
    enriched_this_run: stats.enriched,
    errors_this_run:   stats.errors,
    total_enriched_in_db: totalEnriched,
    mint_authority: {
      active:  stats.mint_auth_active,
      revoked: stats.mint_auth_revoked,
      active_pct: mintActivePct,
    },
    freeze_authority: {
      active:  stats.freeze_auth_active,
      revoked: stats.freeze_auth_revoked,
      active_pct: freezeActivePct,
    },
    elapsed_s: ((Date.now() - t0) / 1000).toFixed(1),
  };

  console.log(JSON.stringify(summary, null, 2));

  // Helius-style progress report do stderr
  console.error('\n[iris-enrich] DONE');
  console.error(`  Enriched this run : ${stats.enriched}`);
  console.error(`  Errors            : ${stats.errors}`);
  console.error(`  MintAuth active   : ${stats.mint_auth_active} (${mintActivePct}%)`);
  console.error(`  MintAuth revoked  : ${stats.mint_auth_revoked}`);
  console.error(`  FreezeAuth active : ${stats.freeze_auth_active} (${freezeActivePct}%)`);
  console.error(`  FreezeAuth revoked: ${stats.freeze_auth_revoked}`);
  console.error(`  Elapsed           : ${summary.elapsed_s}s`);

  db.close();
}

main().catch(err => {
  console.error('[iris-enrich] FATAL:', err.message);
  process.exit(1);
});
