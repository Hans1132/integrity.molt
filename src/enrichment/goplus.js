'use strict';
// src/enrichment/goplus.js
// GoPlus Token Security API client for Solana tokens.
// Provides Honeypot dimension signals for IRIS v2.0.
// Per primary spec §4.2 + amendment §5: circuit breaker on 3 consecutive
// failures, 600ms per-call timeout, 1h success cache / 5min negative cache.

const db = require('../../db');

const GOPLUS_BASE_URL = process.env.GOPLUS_BASE_URL || 'https://api.gopluslabs.io/api/v1/solana/token_security';
const GOPLUS_TIMEOUT_MS = parseInt(process.env.GOPLUS_TIMEOUT_MS || '600', 10);
const CACHE_TTL_MS = 3600_000; // 1 hour

// Circuit breaker state — process-local, not persisted
const _cb = {
  state: 'closed',            // 'closed' | 'open' | 'half_open'
  consecFailures: 0,
  openedAt: 0,
  cooldownMs: 60_000,
  consecFailuresOpen: 3,
};

function _cbAdvance(success) {
  if (success) {
    if (_cb.state === 'half_open') _cb.state = 'closed';
    _cb.consecFailures = 0;
    return;
  }
  _cb.consecFailures += 1;
  if (_cb.consecFailures >= _cb.consecFailuresOpen) {
    _cb.state = 'open';
    _cb.openedAt = Date.now();
  }
}

function _cbCheck() {
  if (_cb.state !== 'open') return _cb.state;
  if (Date.now() - _cb.openedAt >= _cb.cooldownMs) {
    _cb.state = 'half_open';
    return 'half_open';
  }
  return 'open';
}

async function _fetchGoplus(mint) {
  const url = `${GOPLUS_BASE_URL}?contract_addresses=${encodeURIComponent(mint)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOPLUS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function _normalize(raw, mint) {
  // GoPlus returns { code, message, result: { <mint>: { ...fields } } }
  if (!raw || !raw.result || !raw.result[mint]) return null;
  const r = raw.result[mint];

  // Booleans in GoPlus are sometimes "1"/"0" strings — coerce
  const toBool = v => v === 1 || v === '1' || v === true ? 1
                  : v === 0 || v === '0' || v === false  ? 0 : null;
  const toFloat = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // Count risk flags for "is_malicious" heuristic
  let risk_count = 0;
  for (const f of ['is_proxy', 'is_blacklisted', 'cannot_sell_all']) {
    if (toBool(r[f]) === 1) risk_count += 1;
  }

  return {
    is_malicious:        risk_count >= 2 ? 1 : 0,
    can_buy:             toBool(r.can_buy),
    can_sell:            toBool(r.can_sell),
    cannot_sell_all:     toBool(r.cannot_sell_all),
    transfer_fee:        toFloat(r.transfer_fee),  // 0.0-1.0
    blacklist_function:  toBool(r.is_blacklisted) || toBool(r.has_blacklist_function),
    slippage_modifiable: toBool(r.slippage_modifiable),
    risk_count,
    raw_json:            JSON.stringify(r).slice(0, 8000), // cap
  };
}

/**
 * Get GoPlus security report for a Solana mint.
 * Returns normalized object or null on circuit-breaker-open / failure.
 * Tries cache first (1h TTL success, 5min TTL error), then live API.
 */
async function getGoplusReport(mint) {
  // L1: DB cache
  const cached = db.getGoplusCache(mint, CACHE_TTL_MS);
  if (cached) {
    if (cached.err_reason) {
      return { source_health: _cb.state === 'open' ? 'circuit_breaker_open' : 'fail_transient', error: cached.err_reason };
    }
    return {
      source_health: 'ok',
      is_malicious: cached.is_malicious,
      can_buy: cached.can_buy,
      can_sell: cached.can_sell,
      cannot_sell_all: cached.cannot_sell_all,
      transfer_fee: cached.transfer_fee,
      blacklist_function: cached.blacklist_function,
      slippage_modifiable: cached.slippage_modifiable,
      risk_count: cached.risk_count,
    };
  }

  // Circuit breaker
  const state = _cbCheck();
  if (state === 'open') {
    return { source_health: 'circuit_breaker_open' };
  }

  // Live fetch
  try {
    const raw = await _fetchGoplus(mint);
    const normalized = _normalize(raw, mint);
    if (!normalized) {
      _cbAdvance(false);
      db.setGoplusCacheError(mint, 'no_result_for_mint');
      return { source_health: 'fail_transient', error: 'no_result_for_mint' };
    }
    db.setGoplusCache(mint, normalized);
    _cbAdvance(true);
    return { source_health: 'ok', ...normalized };
  } catch (err) {
    _cbAdvance(false);
    const reason = err.name === 'AbortError' ? 'timeout' : (err.message || 'unknown');
    db.setGoplusCacheError(mint, reason);
    return {
      source_health: _cb.state === 'open' ? 'circuit_breaker_open' : 'fail_transient',
      error: reason,
    };
  }
}

module.exports = { getGoplusReport, _cb /* exposed for testing */ };
