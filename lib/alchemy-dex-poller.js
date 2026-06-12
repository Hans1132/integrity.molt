'use strict';

// Alchemy RPC nahrazuje Helius Enhanced Transactions API (403 po konci
// předplatného, 2026-06-12). Dodává JEN SWAP eventy — REMOVE_LIQUIDITY
// dodává nezávislý Bitquery v4 poller. stmtSwap nepoužívá amount, proto
// se swap částky neparsují (amount: 0). Feed je sampling heuristika:
// cap MAX_SIG_PAGES×100 sigs/DEX/cyklus, burst gap je akceptovaný
// (ekvivalent starého MAX_PAGES capu).

require('dotenv').config({ path: '/root/x402-server/.env' });

const Database = require('better-sqlite3');
const path = require('path');
const { recordBatch } = require('./liquidity-event-processor');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Zrcadlí prioritu z src/rpc.js (pravidla 1 a 3); záměrná mini-duplikace,
// aby worker proces netahal server-orientovaný rpc modul.
function getAlchemyUrl() {
  if (process.env.ALCHEMY_RPC_URL) return process.env.ALCHEMY_RPC_URL;
  if (process.env.ALCHEMY_API_KEY) {
    return `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }
  throw new Error('ALCHEMY_RPC_URL ani ALCHEMY_API_KEY není v env');
}

const DEX_PROGRAMS = [
  { id: 'raydium_amm',    name: 'Raydium AMM v4',  programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' },
  { id: 'raydium_cpmm',   name: 'Raydium CPMM',    programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' },
  { id: 'orca_whirlpool', name: 'Orca Whirlpool',  programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' },
  { id: 'pumpfun',        name: 'Pump.fun',        programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' },
  { id: 'meteora_dlmm',   name: 'Meteora DLMM',    programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' },
];

const PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';

const MAX_SIG_PAGES = 3;       // cap: 3×100 sigs per DEX per cyklus
const TX_FETCH_DELAY_MS = 150; // throttle getTransaction (free tier throughput)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Jeden JSON-RPC call; 429 → 1 retry po 2 s; jiná HTTP chyba → throw.
async function rpc(method, params, stats, url = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url || getAlchemyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    stats.rpcCalls++;
    if (res.status === 429 && attempt === 0) {
      console.warn(`[alchemy-poller] 429 na ${method}, retry za 2 s`);
      await sleep(2000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alchemy RPC ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.error) throw new Error(`Alchemy RPC error: ${JSON.stringify(json.error).slice(0, 200)}`);
    return json.result;
  }
  throw new Error(`Alchemy RPC 429 i po retry (${method})`);
}

// Alchemy address index nepokrývá některé programy (empiricky 2026-06-12:
// Raydium CPMM, Meteora DLMM — public RPC je indexuje). Fallback jen pro
// signatures; getTransaction zůstává na Alchemy (funguje pro všechny).
async function getSignaturesPage(params, stats) {
  const viaAlchemy = await rpc('getSignaturesForAddress', params, stats);
  if (Array.isArray(viaAlchemy) && viaAlchemy.length > 0) return viaAlchemy;
  return rpc('getSignaturesForAddress', params, stats, PUBLIC_RPC_URL);
}

// Čistá funkce: jsonParsed getTransaction result → SWAP events.
// Per distinct mint emituje 1 event; poolAddress = owner token accountu
// s největší |delta| pro daný mint (aproximace pool keyingu, ekvivalent
// starého `toUserAccount || fromUserAccount` fallbacku).
function extractSwapEvents(txResult) {
  if (!txResult || !txResult.meta || txResult.meta.err) return [];
  const signature = txResult.transaction?.signatures?.[0];
  if (!signature) return [];
  const ts = (txResult.blockTime || 0) * 1000;

  const pre = new Map();
  for (const b of (txResult.meta.preTokenBalances || [])) pre.set(b.accountIndex, b);

  const byMint = new Map(); // mint -> { delta, owner }
  for (const post of (txResult.meta.postTokenBalances || [])) {
    if (!post.mint) continue;
    const before = pre.get(post.accountIndex);
    const delta = Math.abs(
      (post.uiTokenAmount?.uiAmount || 0) - (before?.uiTokenAmount?.uiAmount || 0)
    );
    if (delta === 0) continue;
    const cur = byMint.get(post.mint);
    if (!cur || delta > cur.delta) {
      byMint.set(post.mint, { delta, owner: post.owner || 'unknown' });
    }
  }

  const events = [];
  for (const [mint, info] of byMint) {
    events.push({
      eventType: 'SWAP',
      poolAddress: info.owner,
      mint,
      amount: 0, // stmtSwap amount nepoužívá
      timestamp: ts,
      txHash: signature,
    });
  }
  return events;
}

// getSignaturesForAddress items → pole signature stringů bez failed txs.
function filterNewSignatures(sigInfos) {
  if (!Array.isArray(sigInfos)) return [];
  return sigInfos.filter(s => s && s.err === null && s.signature).map(s => s.signature);
}

async function pollSingleDex(dex) {
  const startTs = Date.now();
  const stats = { rpcCalls: 0 };
  let txProcessed = 0;

  const state = db.prepare(
    'SELECT last_seen_signature FROM polling_state WHERE dex_program_id = ?'
  ).get(dex.programId);
  const untilSignature = state?.last_seen_signature || null;

  let newestSignature = null;
  let newestTs = null;

  try {
    // 1. Posbírej nové signatures (newest-first), `until` zastaví na známé.
    const allSigs = [];
    let before = null;
    for (let page = 0; page < MAX_SIG_PAGES; page++) {
      const params = [dex.programId, {
        limit: 100,
        ...(untilSignature ? { until: untilSignature } : {}),
        ...(before ? { before } : {}),
      }];
      const sigInfos = await getSignaturesPage(params, stats);
      if (!Array.isArray(sigInfos) || sigInfos.length === 0) break;
      allSigs.push(...sigInfos);
      if (sigInfos.length < 100) break; // dočerpáno k `until` nebo konec historie
      before = sigInfos[sigInfos.length - 1].signature;
    }

    if (allSigs.length > 0) {
      newestSignature = allSigs[0].signature;
      newestTs = (allSigs[0].blockTime || 0) * 1000;
    }

    // 2. Fetch + parse jen úspěšné txs, sekvenčně s throttlem.
    const signatures = filterNewSignatures(allSigs);
    for (const sig of signatures) {
      const tx = await rpc('getTransaction',
        [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], stats);
      const events = extractSwapEvents(tx);
      if (events.length > 0) {
        recordBatch(events);
        txProcessed++;
      }
      await sleep(TX_FETCH_DELAY_MS);
    }

    // 3. Cursor + telemetrie (credits sloupce = počet RPC callů).
    if (newestSignature) {
      db.prepare(`
        UPDATE polling_state
        SET last_seen_signature    = ?,
            last_seen_ts           = ?,
            last_poll_ts           = ?,
            last_poll_tx_count     = ?,
            last_poll_credits_used = ?,
            total_polls            = total_polls + 1,
            total_credits_used     = total_credits_used + ?,
            total_tx_processed     = total_tx_processed + ?,
            last_error             = NULL,
            last_error_ts          = NULL
        WHERE dex_program_id = ?
      `).run(newestSignature, newestTs, startTs, txProcessed, stats.rpcCalls,
             stats.rpcCalls, txProcessed, dex.programId);
    } else {
      db.prepare(`
        UPDATE polling_state
        SET last_poll_ts           = ?,
            last_poll_tx_count     = 0,
            last_poll_credits_used = ?,
            total_polls            = total_polls + 1,
            total_credits_used     = total_credits_used + ?
        WHERE dex_program_id = ?
      `).run(startTs, stats.rpcCalls, stats.rpcCalls, dex.programId);
    }

    return { success: true, rpcCalls: stats.rpcCalls, txProcessed, sigsSeen: allSigs.length };

  } catch (error) {
    console.error(`[alchemy-poller] Poll failed for ${dex.name}:`, error.message);
    db.prepare(`
      UPDATE polling_state
      SET last_error             = ?,
          last_error_ts          = ?,
          last_poll_credits_used = ?,
          total_credits_used     = total_credits_used + ?
      WHERE dex_program_id = ?
    `).run(error.message.slice(0, 500), startTs, stats.rpcCalls, stats.rpcCalls, dex.programId);
    return { success: false, reason: error.message, rpcCalls: stats.rpcCalls, txProcessed };
  }
}

async function pollAllDexes() {
  const results = [];
  for (const dex of DEX_PROGRAMS) {
    const result = await pollSingleDex(dex);
    results.push({ dex: dex.name, ...result });
    await sleep(1000);
  }
  const totalCalls = results.reduce((s, r) => s + (r.rpcCalls || 0), 0);
  const totalTx = results.reduce((s, r) => s + (r.txProcessed || 0), 0);
  console.log(`[alchemy-poller] Cycle complete: ${totalTx} txs, ${totalCalls} RPC calls`);
  return results;
}

module.exports = { pollAllDexes, pollSingleDex, extractSwapEvents, filterNewSignatures, DEX_PROGRAMS };
