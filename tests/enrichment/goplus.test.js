'use strict';
/**
 * tests/enrichment/goplus.test.js
 *
 * Unit tests for src/enrichment/goplus.js — GoPlus Token Security client.
 * Covers the circuit-breaker state machine (closed→open→half_open→closed),
 * field normalization (toBool/toFloat, is_malicious heuristic), and the
 * timeout / no-result failure paths.
 *
 * Offline: db and global.fetch are stubbed. Run: node tests/enrichment/goplus.test.js
 */

const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

// ── Stub db BEFORE requiring goplus so its top-level require resolves to us ────
const dbPath = require.resolve('../../db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    getGoplusCache: () => null,        // force live fetch
    setGoplusCache: () => {},
    setGoplusCacheError: () => {},
  },
};

// ── Mutable fetch mock ─────────────────────────────────────────────────────────
let fetchImpl;
let fetchCalls = 0;
global.fetch = (...args) => { fetchCalls++; return fetchImpl(...args); };

const { getGoplusReport, _cb } = require('../../src/enrichment/goplus');

function resetCb() {
  _cb.state = 'closed';
  _cb.consecFailures = 0;
  _cb.openedAt = 0;
}

let mintSeq = 0;
function freshMint() { return `MintTest${(++mintSeq).toString().padStart(36, '0')}`; }

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => { resetCb(); fetchCalls = 0; });

test('successful fetch with >=2 risk flags → is_malicious=1, health ok', async () => {
  const mint = freshMint();
  fetchImpl = async () => okResponse({ result: { [mint]: {
    is_blacklisted: '1', cannot_sell_all: '1', can_buy: '1', can_sell: '0', transfer_fee: '0.05',
  } } });
  const out = await getGoplusReport(mint);
  assert.equal(out.source_health, 'ok');
  assert.equal(out.is_malicious, 1);
  assert.equal(out.can_buy, 1);
  assert.equal(out.can_sell, 0);
  assert.equal(out.cannot_sell_all, 1);
  assert.equal(out.transfer_fee, 0.05);
  assert.equal(out.blacklist_function, 1);
  assert.equal(out.risk_count, 2);
  assert.equal(_cb.state, 'closed');
});

test('normalization: empty result → nulls, is_malicious=0, transfer_fee null', async () => {
  const mint = freshMint();
  fetchImpl = async () => okResponse({ result: { [mint]: {} } });
  const out = await getGoplusReport(mint);
  assert.equal(out.source_health, 'ok');
  assert.equal(out.is_malicious, 0);
  assert.equal(out.risk_count, 0);
  assert.equal(out.can_buy, null);
  assert.equal(out.transfer_fee, null);
});

test('single risk flag stays below malicious threshold (risk_count<2)', async () => {
  const mint = freshMint();
  fetchImpl = async () => okResponse({ result: { [mint]: { is_proxy: '1' } } });
  const out = await getGoplusReport(mint);
  assert.equal(out.risk_count, 1);
  assert.equal(out.is_malicious, 0);
});

test('no result for mint → fail_transient + consecutive-failure increment', async () => {
  const mint = freshMint();
  fetchImpl = async () => okResponse({ result: {} }); // mint absent
  const out = await getGoplusReport(mint);
  assert.equal(out.source_health, 'fail_transient');
  assert.equal(out.error, 'no_result_for_mint');
  assert.equal(_cb.consecFailures, 1);
});

test('circuit breaker opens after 3 consecutive fetch failures and short-circuits', async () => {
  fetchImpl = async () => { throw new Error('boom'); };
  for (let i = 0; i < 3; i++) await getGoplusReport(freshMint());
  assert.equal(_cb.state, 'open', 'breaker should be open after 3 failures');

  // 4th call must NOT hit the network while open
  const callsBefore = fetchCalls;
  const out = await getGoplusReport(freshMint());
  assert.equal(out.source_health, 'circuit_breaker_open');
  assert.equal(fetchCalls, callsBefore, 'fetch must not be called while breaker open');
});

test('cooldown elapses → half_open probe succeeds → breaker closes', async () => {
  _cb.state = 'open';
  _cb.openedAt = Date.now() - 61_000; // past 60s cooldown
  const mint = freshMint();
  fetchImpl = async () => okResponse({ result: { [mint]: { can_buy: '1', can_sell: '1' } } });
  const out = await getGoplusReport(mint);
  assert.equal(out.source_health, 'ok');
  assert.equal(_cb.state, 'closed', 'successful half_open probe closes the breaker');
});

test('AbortError is reported as a timeout', async () => {
  const mint = freshMint();
  fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const out = await getGoplusReport(mint);
  assert.equal(out.error, 'timeout');
});

test('HTTP non-200 is a transient failure', async () => {
  const mint = freshMint();
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const out = await getGoplusReport(mint);
  assert.equal(out.source_health, 'fail_transient');
  assert.equal(_cb.consecFailures, 1);
});
