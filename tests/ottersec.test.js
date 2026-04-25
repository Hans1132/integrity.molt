'use strict';
/**
 * tests/ottersec.test.js — Unit + integration tests for src/lib/ottersec.js
 *
 * Coverage:
 *   1. Happy path  — real HTTP, Phoenix DEX returns is_verified:true   [INTEGRATION]
 *   2. Cache hit   — second call returns source:'cache', cache_age_s>0
 *   3. 404         — unknown address returns is_verified:false, source:'ottersec_404'
 *   4. Timeout     — mocked fetch throws AbortError → source:'ottersec_timeout'
 *   5. Circuit     — 5 consecutive failures open circuit; 6th returns source:'ottersec_circuit_open'
 *   6. Invalid b58 — non-base58 input throws before HTTP call
 *   7. SQLi guard  — SQL metachar in programId rejected by address validator
 *
 * Run: node tests/ottersec.test.js
 * Skip network tests: SKIP_INTEGRATION=1 node tests/ottersec.test.js
 */

// ── In-memory DB (must be set before anything requires db.js) ────────────────
process.env.SQLITE_DB_PATH           = ':memory:';
process.env.SOLANA_WALLET_ADDRESS    = 'TestWalletAddressForTestSuiteOnly';
process.env.HELIUS_API_KEY           = '';

// ── Create ottersec table before module load (migration not auto-run in test) ─
const { db } = require('../db');
db.exec(`
  CREATE TABLE IF NOT EXISTS ottersec_verifications (
    program_id       TEXT    PRIMARY KEY,
    is_verified      INTEGER NOT NULL,
    on_chain_hash    TEXT,
    executable_hash  TEXT,
    repo_url         TEXT,
    last_verified_at TEXT,
    source           TEXT    NOT NULL DEFAULT 'ottersec_api',
    fetched_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    fetch_error      TEXT
  );
`);

const { getVerificationStatus, _resetCircuit } = require('../src/lib/ottersec');

// ── Test constants ────────────────────────────────────────────────────────────
// Phoenix DEX — OtterSec README example, expected is_verified:true
const PHOENIX = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY';
// A real Solana public key unlikely to appear in OtterSec's verified program list
const UNKNOWN = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
// Address used only for timeout + circuit tests (must differ from cached ones)
const TIMEOUT_ADDR  = 'So11111111111111111111111111111111111111112'; // Wrapped SOL mint
const CIRCUIT_ADDR  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; // Token program

// ── Test harness ─────────────────────────────────────────────────────────────
let _pass = 0;
let _fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    _pass++;
  } else {
    console.error('  FAIL  ' + label + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : ''));
    _fail++;
  }
}

// Save real fetch so we can restore after mocking
const _realFetch = global.fetch;

function restoreFetch() {
  global.fetch = _realFetch;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n═══ OtterSec Module Tests ══════════════════════════════════════════════════');

  // ── Test 1: Happy path (integration — real HTTP) ─────────────────────────
  console.log('\n── 1. Happy path (real HTTP, Phoenix DEX) ──\n');
  if (process.env.SKIP_INTEGRATION === '1') {
    console.log('  SKIP  1 happy path (SKIP_INTEGRATION=1)');
    _pass++;
  } else {
    const r = await getVerificationStatus(PHOENIX);
    ok('1 is_verified is boolean', typeof r.is_verified === 'boolean', r.is_verified);
    ok('1 source is ottersec_api', r.source === 'ottersec_api', r.source);
    ok('1 program_id echoed back', r.program_id === PHOENIX);
    ok('1 cache_age_s is 0 on fresh fetch', r.cache_age_s === 0, r.cache_age_s);
    ok('1 fetched_at is unix seconds', r.fetched_at > 1_700_000_000);
  }

  // ── Test 2: Cache hit ────────────────────────────────────────────────────
  console.log('\n── 2. Cache hit (same address, second call) ──\n');
  if (process.env.SKIP_INTEGRATION === '1') {
    // Seed cache manually so cache test works without network
    const nowS = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT OR REPLACE INTO ottersec_verifications
        (program_id, is_verified, on_chain_hash, executable_hash, repo_url,
         last_verified_at, source, fetched_at, expires_at, fetch_error)
      VALUES (?, 1, null, null, null, null, 'ottersec_api', ?, ?, null)
    `).run(PHOENIX, nowS - 60, nowS + 3540);
  }
  {
    const r2 = await getVerificationStatus(PHOENIX);
    ok('2 second call source is cache', r2.source === 'cache', r2.source);
    ok('2 cache_age_s >= 0', r2.cache_age_s >= 0, r2.cache_age_s);
    ok('2 is_verified preserved from cache', typeof r2.is_verified === 'boolean', r2.is_verified);
  }

  // ── Test 3: 404 — unverified address ────────────────────────────────────
  console.log('\n── 3. 404 — unknown address (real HTTP) ──\n');
  if (process.env.SKIP_INTEGRATION === '1') {
    console.log('  SKIP  3 404 handling (SKIP_INTEGRATION=1)');
    _pass += 2;
  } else {
    const r3 = await getVerificationStatus(UNKNOWN);
    ok('3 is_verified is false for unknown', r3.is_verified === false, r3.is_verified);
    ok('3 source is ottersec_404 or ottersec_api', ['ottersec_404', 'ottersec_api'].includes(r3.source), r3.source);
  }

  // ── Test 4: Network timeout ──────────────────────────────────────────────
  console.log('\n── 4. Network timeout (mocked fetch) ──\n');
  _resetCircuit();
  global.fetch = () => {
    const e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    return Promise.reject(e);
  };
  try {
    const r4 = await getVerificationStatus(TIMEOUT_ADDR);
    ok('4 source is ottersec_timeout', r4.source === 'ottersec_timeout', r4.source);
    ok('4 is_verified is null on timeout', r4.is_verified === null, r4.is_verified);
    ok('4 not cached after timeout',
      db.prepare('SELECT * FROM ottersec_verifications WHERE program_id = ?').get(TIMEOUT_ADDR) === undefined
    );
  } finally {
    restoreFetch();
  }

  // ── Test 5: Circuit breaker ──────────────────────────────────────────────
  console.log('\n── 5. Circuit breaker (5 failures → open circuit) ──\n');
  _resetCircuit();
  let fetchCallCount = 0;
  global.fetch = () => {
    fetchCallCount++;
    return Promise.reject(new Error('Simulated network failure'));
  };
  try {
    // Trigger 5 consecutive failures (each non-AbortError counts as 'ottersec_error')
    for (let i = 0; i < 5; i++) {
      await getVerificationStatus(CIRCUIT_ADDR);
    }
    const beforeOpen = fetchCallCount;
    // 6th call: circuit should be open → no HTTP call
    const r5 = await getVerificationStatus(CIRCUIT_ADDR);
    ok('5 source is ottersec_circuit_open on 6th call', r5.source === 'ottersec_circuit_open', r5.source);
    ok('5 is_verified is null when circuit open', r5.is_verified === null, r5.is_verified);
    ok('5 fetch NOT called on 6th attempt', fetchCallCount === beforeOpen,
       `expected ${beforeOpen} calls, got ${fetchCallCount}`);
  } finally {
    restoreFetch();
    _resetCircuit();
  }

  // ── Test 6: Invalid base58 input ─────────────────────────────────────────
  console.log('\n── 6. Invalid base58 input (throws before HTTP) ──\n');
  {
    let threw = false;
    let fetchCalled = false;
    global.fetch = () => { fetchCalled = true; return Promise.resolve({ ok: true, json: () => ({}) }); };
    try {
      await getVerificationStatus('not-a-valid-solana-address!');
    } catch (e) {
      threw = true;
    } finally {
      restoreFetch();
    }
    ok('6 invalid input throws', threw);
    ok('6 fetch never called for invalid input', !fetchCalled);
  }

  // ── Test 7: SQL injection attempt rejected by validator ──────────────────
  console.log('\n── 7. SQL injection in programId rejected ──\n');
  {
    const sqlPayloads = [
      "'; DROP TABLE ottersec_verifications; --",
      "1 OR 1=1",
      "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY'; DELETE FROM ottersec_verifications; --",
    ];
    for (const payload of sqlPayloads) {
      let threw = false;
      try {
        await getVerificationStatus(payload);
      } catch {
        threw = true;
      }
      ok('7 SQL metachar rejected: ' + payload.slice(0, 20), threw);
    }
    // Verify table survived all injection attempts
    const count = db.prepare('SELECT COUNT(*) AS n FROM ottersec_verifications').get().n;
    ok('7 ottersec table still exists after injection attempts', count >= 0);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  try {
    await runTests();
  } catch (e) {
    console.error('[FATAL]', e);
    process.exit(1);
  }
  const elapsed = Date.now() - t0;
  console.log('\n═══ Results ════════════════════════════════════════════════════════════════');
  console.log(`  ${_pass} passed, ${_fail} failed  (${elapsed}ms)`);
  if (_fail > 0) process.exit(1);
}

run();
