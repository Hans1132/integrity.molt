'use strict';

// In-process RugCheck cache for inactivity scanner.
// Separate from the DB-backed rugcheck_cache used by src/scam-db/lookup.js.

const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1/tokens';
const HIT_TTL_MS   = 6  * 60 * 60 * 1000; // 6h for successful responses
const MISS_TTL_MS  = 15 * 60 * 1000;       // 15min for errors/timeouts
const TIMEOUT_MS   = 8000;
const MIN_CALL_INTERVAL_MS = 500; // max 2 req/s

// { mint → { data: object|null, ts: number, isError: boolean } }
const _cache = new Map();
let _lastCallTs = 0;

async function getRugCheckSummary(mint) {
  const hit = _cache.get(mint);
  if (hit) {
    const ttl = hit.isError ? MISS_TTL_MS : HIT_TTL_MS;
    if (Date.now() - hit.ts < ttl) return hit.data;
  }

  // Rate-limit: ensure at least 500ms between API call starts
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - _lastCallTs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTs = Date.now();

  let data = null;
  let isError = false;
  try {
    const res = await fetch(`${RUGCHECK_BASE}/${mint}/report/summary`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'integrity-molt/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      data = await res.json();
    } else {
      isError = res.status !== 404; // 404 = not found, cache long; other errors = cache short
    }
  } catch (_) {
    isError = true; // network error / timeout
  }

  _cache.set(mint, { data, ts: Date.now(), isError });
  return data;
}

// Returns structured verdict from a RugCheck summary response.
function classifyVerdict(summary) {
  if (!summary) return { verified: false, rugged: false, risk_level: 'unknown', score: null };

  const risks = summary.risks || [];
  let risk_level = 'good';
  if (summary.rugged) {
    risk_level = 'danger';
  } else {
    const levels = risks.map(r => r.level || 'info');
    if (levels.includes('danger')) risk_level = 'danger';
    else if (levels.includes('warn')) risk_level = 'warn';
  }

  return {
    verified: true,
    rugged: !!summary.rugged,
    risk_level,
    score: summary.score_normalised ?? summary.score ?? null,
  };
}

module.exports = { getRugCheckSummary, classifyVerdict };
