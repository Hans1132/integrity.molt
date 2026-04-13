'use strict';
/**
 * src/scam-db/lookup.js
 *
 * Obohacení scan výsledků o informace ze scam databází:
 *   1. Statická tabulka known_scams (import z SolRPDS / SolRugDetector)
 *   2. RugCheck API cache (TTL 24h, rate-limit 2 req/s)
 *
 * Nezávislý na Helius API — žádné RPC volání!
 */

const db = require('../../db');

// ── RugCheck API rate limiter (max 2 req/s) ──────────────────────────────────
const RUGCHECK_BASE_URL = 'https://api.rugcheck.xyz/v1/tokens';
const RUGCHECK_RPS = 2;          // max požadavky za sekundu
const RUGCHECK_TIMEOUT_MS = 8000;

let _rugcheckTokens = RUGCHECK_RPS;
let _rugcheckLastRefill = Date.now();

function canCallRugcheck() {
  const now = Date.now();
  const elapsed = now - _rugcheckLastRefill;
  if (elapsed >= 1000) {
    _rugcheckTokens = RUGCHECK_RPS;
    _rugcheckLastRefill = now;
  }
  if (_rugcheckTokens > 0) {
    _rugcheckTokens--;
    return true;
  }
  return false;
}

// ── RugCheck API fetch ────────────────────────────────────────────────────────

async function fetchRugcheck(mint) {
  const url = `${RUGCHECK_BASE_URL}/${mint}/report/summary`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'integrity-molt/1.0' },
    signal: AbortSignal.timeout(RUGCHECK_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`RugCheck HTTP ${res.status}`);
  return res.json();
}

/**
 * Přeloží RugCheck risks array na nejvyšší úroveň rizika.
 * RugCheck levely: "danger" > "warn" > "info"
 */
function calcRiskLevel(risks) {
  if (!Array.isArray(risks) || !risks.length) return 'good';
  const levels = risks.map(r => r.level || 'info');
  if (levels.includes('danger')) return 'danger';
  if (levels.includes('warn')) return 'warn';
  return 'info';
}

// ── Hlavní export ─────────────────────────────────────────────────────────────

/**
 * Vyhledá mint adresu v scam databázích.
 *
 * @param {string} mint  — Solana mint address
 * @returns {{ known_scam: object|null, rugcheck: object|null, db_match: boolean }}
 */
async function lookupScamDb(mint) {
  if (!mint || typeof mint !== 'string') {
    return { known_scam: null, rugcheck: null, db_match: false };
  }

  // 1. Statická scam tabulka — synchronní, nulové latency
  const known = db.lookupKnownScam(mint);

  // 2. RugCheck cache nebo live fetch
  let rugcheck = null;
  try {
    const cached = db.getRugcheckCache(mint);
    if (cached) {
      rugcheck = cached;
    } else if (canCallRugcheck()) {
      const raw = await fetchRugcheck(mint);
      const risks     = raw.risks   || [];
      const riskLevel = raw.rugged  ? 'danger' : calcRiskLevel(risks);
      db.setRugcheckCache({
        mint,
        risk_level: riskLevel,
        score:      raw.score      ?? null,
        score_norm: raw.score_normalised ?? null,
        rugged:     raw.rugged     ?? false,
        risks,
        raw,
      });
      rugcheck = {
        risk_level:  riskLevel,
        score:       raw.score      ?? null,
        score_norm:  raw.score_normalised ?? null,
        rugged:      raw.rugged     ?? false,
        risks_json:  risks,
        raw_json:    raw,
      };
    }
  } catch (e) {
    console.warn('[scam-db] RugCheck lookup failed:', e.message);
  }

  const db_match = !!(known || (rugcheck?.rugged));
  return { known_scam: known, rugcheck, db_match };
}

module.exports = { lookupScamDb, calcRiskLevel };
