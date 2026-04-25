'use strict';
/**
 * src/lib/ottersec.js — OtterSec verify.osec.io fetch wrapper
 *
 * Caches results in SQLite (ottersec_verifications, 1h TTL).
 * Circuit breaker opens after 5 failures within 60s; stays open 5 min.
 */

const { db }              = require('../../db');
const { isSolanaAddress } = require('../validation/address');

const OTTERSEC_BASE       = process.env.OTTERSEC_API || 'https://verify.osec.io';
const CACHE_TTL_S         = 3600;
const FETCH_TIMEOUT_MS    = 5000;
const CIRCUIT_THRESHOLD   = 5;
const CIRCUIT_WINDOW_MS   = 60_000;
const CIRCUIT_COOLDOWN_MS = 300_000;

// ── Circuit breaker state (in-memory, per process) ────────────────────────────

const circuit = {
  failures: [], // Unix ms timestamps of recent failures
  openedAt: null,
};

function circuitIsOpen() {
  if (!circuit.openedAt) return false;
  if (Date.now() - circuit.openedAt >= CIRCUIT_COOLDOWN_MS) {
    // Cooldown elapsed — reset and allow a probe request
    circuit.openedAt = null;
    circuit.failures  = [];
    return false;
  }
  return true;
}

function recordFailure() {
  const now = Date.now();
  circuit.failures.push(now);
  // Prune failures outside the window
  circuit.failures = circuit.failures.filter(t => now - t <= CIRCUIT_WINDOW_MS);
  if (circuit.failures.length >= CIRCUIT_THRESHOLD && !circuit.openedAt) {
    circuit.openedAt = now;
    console.warn('[ottersec] Circuit opened after %d failures within %dms', CIRCUIT_THRESHOLD, CIRCUIT_WINDOW_MS);
  }
}

// ── Cache helpers (synchronous — better-sqlite3) ──────────────────────────────

const stmtRead = db.prepare(
  'SELECT * FROM ottersec_verifications WHERE program_id = ?'
);

const stmtWrite = db.prepare(`
  INSERT OR REPLACE INTO ottersec_verifications
    (program_id, is_verified, on_chain_hash, executable_hash, repo_url,
     last_verified_at, source, fetched_at, expires_at, fetch_error)
  VALUES
    (@program_id, @is_verified, @on_chain_hash, @executable_hash, @repo_url,
     @last_verified_at, @source, @fetched_at, @expires_at, @fetch_error)
`);

function readCache(programId) {
  const now = Math.floor(Date.now() / 1000);
  const row = stmtRead.get(programId);
  if (!row) return null;
  if (row.expires_at < now) return null; // expired
  return row;
}

function writeCache(programId, result, ttlSeconds = CACHE_TTL_S) {
  const now = Math.floor(Date.now() / 1000);
  stmtWrite.run({
    program_id:       programId,
    is_verified:      result.is_verified === null ? null : (result.is_verified ? 1 : 0),
    on_chain_hash:    result.on_chain_hash    ?? null,
    executable_hash:  result.executable_hash  ?? null,
    repo_url:         result.repo_url         ?? null,
    last_verified_at: result.last_verified_at ?? null,
    source:           result.source,
    fetched_at:       now,
    expires_at:       now + ttlSeconds,
    fetch_error:      result.fetch_error      ?? null,
  });
}

// ── HTTP fetch (no cache, no circuit logic) ───────────────────────────────────

async function fetchFresh(programId) {
  const url        = `${OTTERSEC_BASE}/status/${encodeURIComponent(programId)}`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      is_verified:      null,
      on_chain_hash:    null,
      executable_hash:  null,
      repo_url:         null,
      last_verified_at: null,
      source:           isTimeout ? 'ottersec_timeout' : 'ottersec_error',
      fetch_error:      err.message,
    };
  }
  clearTimeout(timer);

  if (res.status === 404) {
    return {
      is_verified:      false,
      on_chain_hash:    null,
      executable_hash:  null,
      repo_url:         null,
      last_verified_at: null,
      source:           'ottersec_404',
      fetch_error:      null,
    };
  }

  if (!res.ok) {
    return {
      is_verified:      null,
      on_chain_hash:    null,
      executable_hash:  null,
      repo_url:         null,
      last_verified_at: null,
      source:           'ottersec_error',
      fetch_error:      `HTTP ${res.status}`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return {
      is_verified:      null,
      on_chain_hash:    null,
      executable_hash:  null,
      repo_url:         null,
      last_verified_at: null,
      source:           'ottersec_error',
      fetch_error:      'invalid_json: ' + err.message,
    };
  }

  // Graceful fallback if schema is unexpected
  return {
    is_verified:      typeof body.is_verified === 'boolean' ? body.is_verified : null,
    on_chain_hash:    typeof body.on_chain_hash    === 'string' ? body.on_chain_hash    : null,
    executable_hash:  typeof body.executable_hash  === 'string' ? body.executable_hash  : null,
    repo_url:         typeof body.repo_url         === 'string' ? body.repo_url         : null,
    last_verified_at: typeof body.last_verified_at === 'string' ? body.last_verified_at : null,
    source:           'ottersec_api',
    fetch_error:      null,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function getVerificationStatus(programId) {
  if (!isSolanaAddress(programId)) {
    throw new Error(`[ottersec] Invalid Solana address: ${programId}`);
  }

  const nowS = Math.floor(Date.now() / 1000);

  // 1. Cache hit
  const cached = readCache(programId);
  if (cached) {
    return {
      program_id:       programId,
      is_verified:      cached.is_verified === null ? null : Boolean(cached.is_verified),
      on_chain_hash:    cached.on_chain_hash    ?? null,
      executable_hash:  cached.executable_hash  ?? null,
      repo_url:         cached.repo_url         ?? null,
      last_verified_at: cached.last_verified_at ?? null,
      source:           'cache',
      fetched_at:       cached.fetched_at,
      cache_age_s:      nowS - cached.fetched_at,
    };
  }

  // 2. Circuit breaker
  if (circuitIsOpen()) {
    return {
      program_id:       programId,
      is_verified:      null,
      on_chain_hash:    null,
      executable_hash:  null,
      repo_url:         null,
      last_verified_at: null,
      source:           'ottersec_circuit_open',
      fetched_at:       nowS,
      cache_age_s:      0,
    };
  }

  // 3. Fresh fetch
  const result = await fetchFresh(programId);

  const isTransient = result.source === 'ottersec_timeout' || result.source === 'ottersec_error';

  if (isTransient) {
    // Do NOT cache transient errors; increment circuit counter
    recordFailure();
  } else {
    // Cache both success and authoritative negatives (404)
    writeCache(programId, result, CACHE_TTL_S);
  }

  return {
    program_id:       programId,
    is_verified:      result.is_verified,
    on_chain_hash:    result.on_chain_hash    ?? null,
    executable_hash:  result.executable_hash  ?? null,
    repo_url:         result.repo_url         ?? null,
    last_verified_at: result.last_verified_at ?? null,
    source:           result.source,
    fetched_at:       nowS,
    cache_age_s:      0,
  };
}

// ── Test helper (not called in production) ────────────────────────────────────
function _resetCircuit() {
  circuit.failures = [];
  circuit.openedAt = null;
}

module.exports = { getVerificationStatus, fetchFresh, readCache, writeCache, _resetCircuit };
