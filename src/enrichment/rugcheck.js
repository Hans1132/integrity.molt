'use strict';
/**
 * src/enrichment/rugcheck.js
 *
 * RugCheck API integrace — plný /report endpoint s topHolders, insiders,
 * verifikací a trhy. Doplňuje stávající scam-db/lookup.js (který používá /summary).
 *
 * Cache: in-memory (5 min) → SQLite rugcheck_cache (24h, sdílená s lookup.js)
 * Rate limit: max 2 req/s (token bucket, sdílený stav v modulu)
 */

const fs = require('fs');
const db = require('../../db');

// ── Config ────────────────────────────────────────────────────────────────────

const RUGCHECK_BASE   = 'https://api.rugcheck.xyz/v1/tokens';
const TIMEOUT_MS      = 10_000;
const MEM_TTL_MS      = 5  * 60_000; // 5 minut in-memory
const DB_TTL_MS       = 24 * 60_000 * 60; // 24 hodin SQLite (sdílené s lookup.js)

// API klíč z env (volitelný — veřejné endpointy fungují i bez něj)
const RUGCHECK_API_KEY = process.env.RUGCHECK_API_KEY
  || (() => { try { return fs.readFileSync('/root/.secrets/rugcheck_api_key', 'utf-8').trim(); } catch { return ''; } })();

// ── Rate limiter (token bucket, max 2 req/s) ──────────────────────────────────

const MAX_RPS = 2;
let _tokens   = MAX_RPS;
let _lastFill = Date.now();

function acquireSlot() {
  const now  = Date.now();
  const diff = now - _lastFill;
  if (diff >= 1000) {
    _tokens   = MAX_RPS;
    _lastFill = now;
  }
  if (_tokens > 0) { _tokens--; return true; }
  return false;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

/** @type {Map<string, {data: object, ts: number}>} */
const _memCache = new Map();

function memGet(mint) {
  const hit = _memCache.get(mint);
  if (!hit) return null;
  if (Date.now() - hit.ts > MEM_TTL_MS) { _memCache.delete(mint); return null; }
  return hit.data;
}

function memSet(mint, data) {
  _memCache.set(mint, { data, ts: Date.now() });
}

// ── RugCheck fetch ────────────────────────────────────────────────────────────

async function fetchFullReport(mint) {
  const url = `${RUGCHECK_BASE}/${mint}/report`;
  const headers = {
    'Accept':     'application/json',
    'User-Agent': 'integrity-molt/1.0'
  };
  if (RUGCHECK_API_KEY) headers['x-api-key'] = RUGCHECK_API_KEY;

  const t0  = Date.now();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const ms  = Date.now() - t0;

  if (!res.ok) throw new Error(`RugCheck HTTP ${res.status} (${ms}ms)`);

  const raw = await res.json();
  console.log(`[enrichment/rugcheck] fetched mint=${mint.slice(0, 8)} ms=${ms}`);
  return raw;
}

// ── Normalizace odpovědi ──────────────────────────────────────────────────────

function normalize(raw) {
  const risks    = raw.risks     || [];
  const holders  = raw.topHolders || [];
  const markets  = raw.markets   || [];

  // Přeložení RugCheck risk levels na naše kategorie
  const riskLevel = raw.rugged
    ? 'danger'
    : risks.some(r => r.level === 'danger') ? 'danger'
    : risks.some(r => r.level === 'warn')   ? 'warn'
    : risks.length > 0                       ? 'info'
    : 'good';

  const totalLiquidity = (() => {
    if (typeof raw.totalMarketLiquidity === 'number') return raw.totalMarketLiquidity;
    return markets.reduce((s, m) => s + (m.liquidityUsd || m.liquidity_usd || 0), 0);
  })();

  const verified = !!(
    raw.verification?.jup_verified ||
    raw.verification?.jup_strict   ||
    raw.fileMeta?.image
  );

  return {
    source:               'rugcheck',
    score:                raw.score              ?? null,
    score_normalised:     raw.score_normalised   ?? null,
    risk_level:           riskLevel,
    rugged:               raw.rugged             ?? false,
    risks:                risks.map(r => ({
                            name:        r.name,
                            level:       r.level,
                            score:       r.score,
                            description: r.description,
                            value:       r.value
                          })),
    insiders_detected:    raw.graphInsidersDetected || 0,
    insider_networks:     raw.insiderNetworks     || null,
    top_holders:          holders.slice(0, 10).map(h => ({
                            address:  h.owner || h.address,
                            pct:      h.pct,
                            amount:   h.uiAmount,
                            insider:  h.insider || false
                          })),
    total_liquidity_usd:  totalLiquidity,
    mint_authority:       raw.mintAuthority       || null,
    freeze_authority:     raw.freezeAuthority     || null,
    token_program:        raw.tokenProgram
                            ? (raw.tokenProgram.startsWith('TokenzQ') ? 'spl-token-2022' : 'spl-token')
                            : null,
    verified,
    verification_meta:    raw.verification        || null,
    launchpad:            raw.launchpad           || raw.deployPlatform || null,
    markets_count:        markets.length,
    creator:              raw.creator             || null,
    rugged_events:        (raw.events || []).filter(e => e?.event === 'Rug'),
    fetched_at:           new Date().toISOString()
  };
}

// ── Hlavní export ─────────────────────────────────────────────────────────────

/**
 * Vrátí obohacená RugCheck data pro daný mint.
 * Pořadí: in-memory → SQLite → live fetch
 * Pokud live fetch selže nebo není slot, vrátí null.
 *
 * @param {string} mint
 * @returns {Promise<object|null>}
 */
async function getRugCheckReport(mint) {
  // 1. In-memory hit
  const mem = memGet(mint);
  if (mem) return mem;

  // 2. SQLite hit — raw_json obsahuje plnou odpověď (pokud byla fetchnuta z /report)
  try {
    const cached = db.getRugcheckCache(mint);
    if (cached?.raw_json && typeof cached.raw_json === 'object' && cached.raw_json.topHolders !== undefined) {
      const normalized = normalize(cached.raw_json);
      memSet(mint, normalized);
      return normalized;
    }
  } catch {}

  // 3. Live fetch
  if (!acquireSlot()) {
    console.warn(`[enrichment/rugcheck] rate-limited, skip mint=${mint.slice(0, 8)}`);
    return null;
  }

  try {
    const raw        = await fetchFullReport(mint);
    const normalized = normalize(raw);

    // Ulož do SQLite (sdílená cache s lookup.js)
    try {
      db.setRugcheckCache({
        mint,
        risk_level: normalized.risk_level,
        score:      normalized.score,
        score_norm: normalized.score_normalised,
        rugged:     normalized.rugged,
        risks:      normalized.risks,
        raw
      });
    } catch (e) {
      console.warn('[enrichment/rugcheck] SQLite write failed:', e.message);
    }

    memSet(mint, normalized);
    return normalized;
  } catch (e) {
    console.warn(`[enrichment/rugcheck] fetch failed for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

module.exports = { getRugCheckReport };
