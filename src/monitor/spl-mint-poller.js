'use strict';

/**
 * spl-mint-poller.js — Alchemy poller pro nové SPL token minty
 *
 * Každých ~5 minut se ptá Alchemy na nejnovější transakce Pump.fun programu
 * (a Token-2022 programu jako doplněk). Transakcím hledá initializeMint
 * instrukci a ukládá do tabulky spl_mints v intmolt.db.
 * Kurzor (last_sig) zajišťuje inkrementální stahování bez duplikátů.
 *
 * Poznámka: Token Program (TokenkegQ...) Alchemy neindexuje přes
 * getSignaturesForAddress — proto používáme Pump.fun jako primární zdroj.
 * Pump.fun pokrývá drtivou většinu nových tokenů na Solaně (2026).
 */

// Pump.fun: primární zdroj nových tokenů — CREATE transakce obsahují initializeMint
const PUMPFUN_PROGRAM  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// Token-2022: novější tokeny, sekundární zdroj
const TOKEN22_PROGRAM  = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minut
const BATCH_SIZE       = 100;
const RPC_BATCH        = 5; // getTransaction paralelně najednou

let _db    = null;
let _timer = null;

function init(dbInstance) {
  _db = dbInstance;
  _ensureSchema();
  _poll();
  _timer = setInterval(_poll, POLL_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  console.log('[spl-mint-poller] started, interval=5min, source=pump.fun+token22');
}

function stop() {
  if (_timer) clearInterval(_timer);
}

function _ensureSchema() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS spl_mints (
      mint        TEXT    PRIMARY KEY,
      tx_sig      TEXT    NOT NULL UNIQUE,
      slot        INTEGER,
      block_time  INTEGER NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'alchemy_poller',
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
    CREATE INDEX IF NOT EXISTS idx_spl_mints_bt ON spl_mints(block_time DESC);
    CREATE TABLE IF NOT EXISTS spl_mint_cursor (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      last_sig    TEXT,
      last_run_at INTEGER
    );
  `);
}

async function _poll() {
  const rpcUrl = process.env.ALCHEMY_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl || rpcUrl.includes('api.mainnet-beta.solana.com')) {
    console.log('[spl-mint-poller] no Alchemy RPC URL configured, skipping');
    return;
  }

  let total = 0;
  try {
    total += await _pollProgram(rpcUrl, PUMPFUN_PROGRAM, 'pumpfun');
    total += await _pollProgram(rpcUrl, TOKEN22_PROGRAM, 'token22');
    console.log(`[spl-mint-poller] poll done: ${total} new mints stored`);
  } catch (e) {
    console.error('[spl-mint-poller] poll error:', e.message);
  }
  _updateLastRunAt();
}

async function _pollProgram(rpcUrl, programId, label) {
  const cursor = _db.prepare('SELECT last_sig FROM spl_mint_cursor WHERE id=1').get();
  const until  = cursor?.last_sig || undefined;

  const sigInfos = await _rpc(rpcUrl, 'getSignaturesForAddress', [
    programId,
    { limit: BATCH_SIZE, ...(until ? { until } : {}) },
  ]);

  if (!Array.isArray(sigInfos) || sigInfos.length === 0) return 0;

  const newCursorSig = sigInfos[0].signature;
  const validSigs = sigInfos.filter(s => !s.err).map(s => s.signature);
  if (!validSigs.length) {
    _updateCursor(newCursorSig);
    return 0;
  }

  let inserted = 0;
  for (let i = 0; i < validSigs.length; i += RPC_BATCH) {
    const chunk = validSigs.slice(i, i + RPC_BATCH);
    const txs = await Promise.all(
      chunk.map(sig => _rpc(rpcUrl, 'getTransaction', [
        sig,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]).catch(() => null))
    );
    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      if (!tx) continue;
      const mint = _extractInitializeMint(tx);
      if (!mint) continue;
      try {
        _db.prepare(`
          INSERT OR IGNORE INTO spl_mints (mint, tx_sig, slot, block_time, source)
          VALUES (?, ?, ?, ?, ?)
        `).run(mint, chunk[j], tx.slot ?? null, (tx.blockTime ?? 0) * 1000, label);
        inserted++;
      } catch (e) {
        if (!e.message.includes('UNIQUE')) console.error('[spl-mint-poller] insert error:', e.message);
      }
    }
  }

  _updateCursor(newCursorSig);
  return inserted;
}

function _updateCursor(sig) {
  _db.prepare(`
    INSERT INTO spl_mint_cursor (id, last_sig, last_run_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_sig=excluded.last_sig, last_run_at=excluded.last_run_at
  `).run(sig ?? null, Date.now());
}

function _updateLastRunAt() {
  _db.prepare(`
    INSERT INTO spl_mint_cursor (id, last_sig, last_run_at)
    VALUES (1, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at
  `).run(Date.now());
}

function _extractInitializeMint(tx) {
  try {
    const ixs   = tx.transaction?.message?.instructions || [];
    const inner = (tx.meta?.innerInstructions || []).flatMap(i => i.instructions || []);
    for (const ix of [...ixs, ...inner]) {
      const t = ix.parsed?.type;
      if ((t === 'initializeMint' || t === 'initializeMint2') && ix.parsed?.info?.mint) {
        return ix.parsed.info.mint;
      }
    }
  } catch {}
  return null;
}

async function _rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

module.exports = { init, stop };
