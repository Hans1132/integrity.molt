#!/usr/bin/env node
'use strict';
/**
 * scripts/iris-enrich-legit.js
 *
 * Obohacuje legitimní tokeny (data/legit-tokens.json) stejnými features
 * jako scam dataset: mintAuthority, freezeAuthority, HHI, top1%, RugCheck.
 *
 * Výsledky ukládá do iris_enrichment se source='legit_baseline'.
 *
 * Použití:
 *   node scripts/iris-enrich-legit.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path     = require('path');
const Database = require('better-sqlite3');
const fetch    = require('node-fetch');

const DB_PATH  = path.join(__dirname, '..', 'data', 'intmolt.db');
const RPC_URL  = process.env.ALCHEMY_RPC_URL;

if (!RPC_URL) {
  console.error('ERROR: ALCHEMY_RPC_URL not set in .env');
  process.exit(1);
}

const LEGIT_TOKENS = require('../data/legit-tokens.json').tokens;
const db = new Database(DB_PATH);

// Schéma — upsert pro legit tokeny
const upsert = db.prepare(`
  INSERT INTO iris_enrichment
    (mint, mint_authority, freeze_authority, mint_auth_active, freeze_auth_active,
     top1_holder_pct, top10_holder_pct, hhi, holder_count, supply_total, error_info, source,
     rc_score, rc_rugged, rc_top1_pct, rc_hhi, rc_insider_count,
     rc_risk_danger_count, rc_risks_json, rc_enriched_at)
  VALUES
    (@mint, @mint_authority, @freeze_authority, @mint_auth_active, @freeze_auth_active,
     @top1_holder_pct, @top10_holder_pct, @hhi, @holder_count, @supply_total, @error_info, 'legit_baseline',
     @rc_score, @rc_rugged, @rc_top1_pct, @rc_hhi, @rc_insider_count,
     @rc_risk_danger_count, @rc_risks_json, @rc_enriched_at)
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
    source               = 'legit_baseline',
    rc_score             = excluded.rc_score,
    rc_rugged            = excluded.rc_rugged,
    rc_top1_pct          = excluded.rc_top1_pct,
    rc_hhi               = excluded.rc_hhi,
    rc_insider_count     = excluded.rc_insider_count,
    rc_risk_danger_count = excluded.rc_risk_danger_count,
    rc_risks_json        = excluded.rc_risks_json,
    rc_enriched_at       = excluded.rc_enriched_at,
    enriched_at          = datetime('now')
`);

// ─── RPC helpers ─────────────────────────────────────────────────────────────

let reqId = 1;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpcCall(method, params, retries = 2) {
  const body = { jsonrpc: '2.0', id: reqId++, method, params };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 12000,
      });
      if (res.status === 429 || res.status === 503) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'RPC error');
      return json.result;
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function fetchRugcheck(mint) {
  const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'integrity-molt/1.0' },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`RugCheck HTTP ${res.status}`);
  return res.json();
}

// ─── Feature extraction ──────────────────────────────────────────────────────

function parseMintAccountData(base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length < 82) throw new Error(`mint data too short: ${buf.length}`);
  const mintAuthOption   = buf.readUInt32LE(0);
  const freezeAuthOption = buf.readUInt32LE(46);
  const _bs58  = require('bs58');
  const enc    = (_bs58.default || _bs58).encode.bind(_bs58.default || _bs58);
  const supplyLow  = buf.readUInt32LE(36);
  const supplyHigh = buf.readUInt32LE(40);
  const supply = BigInt(supplyHigh) * 0x100000000n + BigInt(supplyLow);
  return {
    mintAuthority:   mintAuthOption  === 1 ? enc(buf.slice(4, 36))  : null,
    freezeAuthority: freezeAuthOption === 1 ? enc(buf.slice(50, 82)) : null,
    supply:          supply.toString(),
  };
}

function computeHolderMetrics(accounts) {
  if (!accounts || accounts.length === 0) return { hhi: null, top1: null, top10: null };
  const amounts = accounts.map(a => BigInt(a.amount));
  const total   = amounts.reduce((s, v) => s + v, 0n);
  if (total === 0n) return { hhi: null, top1: null, top10: null };
  amounts.sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const top1Pct  = Number(amounts[0] * 10000n / total) / 100;
  const top10Sum = amounts.slice(0, 10).reduce((s, v) => s + v, 0n);
  const top10Pct = Number(top10Sum * 10000n / total) / 100;
  let hhi = 0;
  for (const a of amounts) {
    const share = Number(a) / Number(total);
    hhi += share * share;
  }
  return { hhi: parseFloat(hhi.toFixed(6)), top1: top1Pct, top10: top10Pct };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function enrichToken({ mint, symbol }) {
  const row = {
    mint,
    mint_authority: null, freeze_authority: null,
    mint_auth_active: null, freeze_auth_active: null,
    top1_holder_pct: null, top10_holder_pct: null,
    hhi: null, holder_count: null, supply_total: null,
    error_info: null,
    rc_score: null, rc_rugged: null, rc_top1_pct: null,
    rc_hhi: null, rc_insider_count: null,
    rc_risk_danger_count: null, rc_risks_json: null,
    rc_enriched_at: null,
  };

  try {
    // 1. getAccountInfo → authority check
    const acctInfo = await rpcCall('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!acctInfo?.value) {
      row.error_info = JSON.stringify({ step: 'getAccountInfo', error: 'not found' });
      upsert.run(row);
      console.log(`  [SKIP] ${symbol} (${mint.slice(0,8)}) — account not found`);
      return;
    }
    const encoded = Array.isArray(acctInfo.value.data) ? acctInfo.value.data[0] : null;
    if (encoded) {
      try {
        const parsed = parseMintAccountData(encoded);
        row.mint_authority    = parsed.mintAuthority   ?? 'revoked';
        row.freeze_authority  = parsed.freezeAuthority ?? 'revoked';
        row.mint_auth_active  = parsed.mintAuthority   ? 1 : 0;
        row.freeze_auth_active = parsed.freezeAuthority ? 1 : 0;
        row.supply_total      = parsed.supply;
      } catch (parseErr) {
        row.error_info = JSON.stringify({ step: 'parseMint', error: parseErr.message });
      }
    }
    await sleep(250);

    // 2. getTokenLargestAccounts → HHI
    try {
      const largestRes = await rpcCall('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], 1);
      const accounts = largestRes?.value ?? [];
      row.holder_count = accounts.length;
      if (accounts.length > 0) {
        const m = computeHolderMetrics(accounts);
        row.hhi = m.hhi; row.top1_holder_pct = m.top1; row.top10_holder_pct = m.top10;
      }
    } catch (_) {}
    await sleep(250);

    // 3. RugCheck
    try {
      const rc = await fetchRugcheck(mint);
      const risks = rc.risks || [];
      const dangerCount = risks.filter(r => r.level === 'danger').length;
      const topH = (rc.topHolders || []);
      const topAmts = topH.map(h => h.pct || 0);
      const rcTop1 = topAmts.length > 0 ? topAmts[0] : null;
      // RugCheck HHI z top10 holders
      let rcHhi = null;
      if (topAmts.length > 0) {
        const s = topAmts.reduce((a, b) => a + b, 0) / 100;
        rcHhi = topAmts.reduce((a, b) => a + (b/100)*(b/100), 0);
        rcHhi = parseFloat(rcHhi.toFixed(6));
      }
      row.rc_score             = rc.score ?? null;
      row.rc_rugged            = rc.rugged ? 1 : 0;
      row.rc_top1_pct          = rcTop1;
      row.rc_hhi               = rcHhi;
      row.rc_insider_count     = rc.graphInsidersDetected || 0;
      row.rc_risk_danger_count = dangerCount;
      row.rc_risks_json        = risks.length > 0 ? JSON.stringify(risks.map(r => r.name)) : null;
      row.rc_enriched_at       = new Date().toISOString();
    } catch (rcErr) {
      console.warn(`  [WARN] ${symbol} RugCheck failed: ${rcErr.message}`);
    }

    upsert.run(row);
    const authStr = row.mint_auth_active === 1 ? 'mint_active' : row.mint_auth_active === 0 ? 'mint_revoked' : 'unknown';
    console.log(`  [OK] ${symbol.padEnd(10)} ${mint.slice(0,8)} — ${authStr}, top1=${row.rc_top1_pct?.toFixed(1) ?? 'n/a'}%, hhi=${row.rc_hhi?.toFixed(3) ?? 'n/a'}`);
  } catch (err) {
    row.error_info = JSON.stringify({ step: 'enrich', error: err.message });
    upsert.run(row);
    console.error(`  [ERR] ${symbol} (${mint.slice(0,8)}): ${err.message}`);
  }
}

async function main() {
  console.log(`[legit-enrich] Enriching ${LEGIT_TOKENS.length} legit tokens...`);
  const t0 = Date.now();

  for (const token of LEGIT_TOKENS) {
    await enrichToken(token);
    await sleep(500); // 2 req/s overall (RugCheck rate limit)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[legit-enrich] DONE — ${LEGIT_TOKENS.length} tokens in ${elapsed}s`);

  // Rychlá sumarizace
  const stats = db.prepare(`
    SELECT
      COUNT(*) as n,
      ROUND(AVG(mint_auth_active)*100,1) as mint_active_pct,
      ROUND(AVG(freeze_auth_active)*100,1) as freeze_active_pct,
      ROUND(AVG(rc_top1_pct),2) as avg_top1,
      ROUND(AVG(rc_hhi),4) as avg_hhi,
      SUM(rc_rugged) as rugged_count
    FROM iris_enrichment WHERE source='legit_baseline'
  `).get();
  console.log('[legit-enrich] Summary:', JSON.stringify(stats, null, 2));

  db.close();
}

main().catch(err => {
  console.error('[legit-enrich] FATAL:', err.message);
  process.exit(1);
});
