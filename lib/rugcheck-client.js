'use strict';

// In-process RugCheck cache for inactivity scanner.
// Separate from the DB-backed rugcheck_cache used by src/scam-db/lookup.js —
// scanner is a long-running cron process; 6h in-memory TTL is sufficient.

const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1/tokens';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const TIMEOUT_MS = 8000;
const MIN_CALL_INTERVAL_MS = 500; // max 2 req/s

const _cache = new Map(); // mint → { data, ts }
let _lastCallTs = 0;

async function getRugCheckSummary(mint) {
  const hit = _cache.get(mint);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  // Rate-limit to 2 req/s
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - _lastCallTs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTs = Date.now();

  let data = null;
  try {
    const res = await fetch(`${RUGCHECK_BASE}/${mint}/report/summary`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'integrity-molt/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) data = await res.json();
  } catch (_) {
    // network error / timeout — data stays null, cached as null to avoid hammering
  }

  _cache.set(mint, { data, ts: Date.now() });
  return data;
}

// Returns structured verdict from a RugCheck summary response.
// { verified, rugged, risk_level, score }
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
