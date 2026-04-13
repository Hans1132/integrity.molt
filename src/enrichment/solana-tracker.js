'use strict';
/**
 * src/enrichment/solana-tracker.js
 *
 * Solana Tracker Public API — token metadata, pool data, deployer, risk,
 * LP burn %, market cap, buy/sell pressure.
 *
 * API key vyžadován: SOLANA_TRACKER_API_KEY v .env
 * Bez klíče: vrátí null (graceful fail)
 *
 * Cache: in-memory, TTL 2 minuty
 */

const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL   = 'https://data.solanatracker.io';
const TIMEOUT_MS = 10_000;
const MEM_TTL_MS = 2 * 60_000; // 2 minuty

const API_KEY = process.env.SOLANA_TRACKER_API_KEY
  || (() => { try { return fs.readFileSync('/root/.secrets/solana_tracker_api_key', 'utf-8').trim(); } catch { return ''; } })();

// ── In-memory cache ───────────────────────────────────────────────────────────

/** @type {Map<string, {data: object|null, ts: number}>} */
const _memCache = new Map();

function memGet(mint) {
  const hit = _memCache.get(mint);
  if (!hit) return undefined; // undefined = no cache entry
  if (Date.now() - hit.ts > MEM_TTL_MS) { _memCache.delete(mint); return undefined; }
  return hit.data; // null = cached "no data" response
}

function memSet(mint, data) {
  _memCache.set(mint, { data, ts: Date.now() });
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchToken(mint) {
  if (!API_KEY) return null;

  const t0  = Date.now();
  const res = await fetch(`${BASE_URL}/tokens/${mint}`, {
    headers: {
      'x-api-key':  API_KEY,
      'Accept':     'application/json',
      'User-Agent': 'integrity-molt/1.0'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const ms = Date.now() - t0;

  if (res.status === 404) {
    console.log(`[enrichment/solana-tracker] not found mint=${mint.slice(0, 8)} ms=${ms}`);
    return null;
  }
  if (!res.ok) throw new Error(`Solana Tracker HTTP ${res.status} (${ms}ms)`);

  const raw = await res.json();
  console.log(`[enrichment/solana-tracker] fetched mint=${mint.slice(0, 8)} ms=${ms}`);
  return raw;
}

// ── Normalizace ───────────────────────────────────────────────────────────────

function normalize(raw) {
  if (!raw) return null;

  // Solana Tracker vrací pole poolů — vezmi první s nejvyšší likviditou
  const pools = Array.isArray(raw.pools) ? raw.pools : [];
  pools.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const topPool = pools[0] || null;

  const liquidity  = topPool?.liquidity?.usd        || 0;
  const marketCap  = topPool?.marketCap?.usd         || raw.marketCap?.usd || 0;
  const market     = topPool?.market                 || null;
  const lpBurnPct  = topPool?.lpBurn                 ?? null; // 0-100 %
  const buys24h    = topPool?.txns?.h24?.buys        || 0;
  const sells24h   = topPool?.txns?.h24?.sells       || 0;

  const token     = raw.token   || {};
  const risk      = raw.risk    || {};
  const deployer  = token.creator || null;

  // Věk tokenu
  let createdAt = null;
  let ageHours  = null;
  if (token.createdOn) {
    createdAt = new Date(token.createdOn).toISOString();
    ageHours  = (Date.now() - new Date(token.createdOn).getTime()) / 3_600_000;
  }

  return {
    source:          'solana_tracker',
    name:            token.name   || null,
    symbol:          token.symbol || null,
    deployer,
    launchpad:       token.mint?.startsWith('pump') ? 'pumpfun' : (raw.launchpad || null),
    lp_burn_pct:     lpBurnPct,
    market,
    buys_24h:        buys24h,
    sells_24h:       sells24h,
    holders:         raw.holders   ?? null,
    liquidity_usd:   liquidity,
    market_cap_usd:  marketCap,
    created_at:      createdAt,
    age_hours:       ageHours !== null ? Math.round(ageHours) : null,
    risk:            {
                       rugged:       risk.rugged       ?? false,
                       score:        risk.score        ?? null,
                       risks:        risk.risks        || []
                     },
    image:           token.image   || null,
    fetched_at:      new Date().toISOString()
  };
}

// ── Hlavní export ─────────────────────────────────────────────────────────────

/**
 * Vrátí Solana Tracker data pro daný mint.
 * Pokud není API klíč nebo fetch selže → null.
 *
 * @param {string} mint
 * @returns {Promise<object|null>}
 */
async function getSolanaTrackerData(mint) {
  if (!API_KEY) return null;

  const cached = memGet(mint);
  if (cached !== undefined) return cached;

  try {
    const raw        = await fetchToken(mint);
    const normalized = normalize(raw);
    memSet(mint, normalized);
    return normalized;
  } catch (e) {
    console.warn(`[enrichment/solana-tracker] failed for ${mint.slice(0, 8)}: ${e.message}`);
    memSet(mint, null); // cachuj fail aby se neopakoval
    return null;
  }
}

module.exports = { getSolanaTrackerData };
