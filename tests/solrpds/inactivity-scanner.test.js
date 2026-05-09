'use strict';
// Unit tests for lib/inactivity-scanner.js
// Uses temp SQLite DB with synthetic data. RugCheck is stubbed via require.cache.

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const tmpDb = path.join(os.tmpdir(), `test-scanner-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDb;

// ── Schema setup ─────────────────────────────────────────────────────────────

const setupDb = new Database(tmpDb);
setupDb.pragma('journal_mode = WAL');
setupDb.exec(`
  CREATE TABLE IF NOT EXISTS pool_activity (
    pool_address TEXT NOT NULL, mint TEXT NOT NULL,
    total_added_liquidity REAL DEFAULT 0,
    total_removed_liquidity REAL DEFAULT 0,
    add_count INTEGER DEFAULT 0, remove_count INTEGER DEFAULT 0,
    first_activity_ts INTEGER, last_activity_ts INTEGER,
    last_liquidity_remove_ts INTEGER, last_swap_ts INTEGER,
    last_swap_tx TEXT, inactivity_status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (pool_address, mint)
  );
  CREATE TABLE IF NOT EXISTS polling_state (
    dex_program_id TEXT PRIMARY KEY,
    dex_name TEXT NOT NULL,
    last_seen_signature TEXT, last_seen_ts INTEGER,
    last_poll_ts INTEGER, last_poll_tx_count INTEGER DEFAULT 0,
    last_poll_credits_used INTEGER DEFAULT 0,
    total_polls INTEGER DEFAULT 0, total_credits_used INTEGER DEFAULT 0,
    total_tx_processed INTEGER DEFAULT 0,
    last_error TEXT, last_error_ts INTEGER,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );
  CREATE TABLE IF NOT EXISTS token_whitelist (
    mint TEXT PRIMARY KEY, symbol TEXT, name TEXT,
    source TEXT NOT NULL DEFAULT 'jupiter_strict',
    added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE TABLE IF NOT EXISTS known_scams (
    mint TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    scam_type TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    label TEXT, raw_data TEXT,
    creator TEXT, first_seen_slot INTEGER, first_seen_at TEXT,
    rug_pattern TEXT, confidence_score REAL,
    add_to_remove_ratio REAL, inactivity_days INTEGER, flagged_at INTEGER,
    rugcheck_verified INTEGER DEFAULT 0,
    rugcheck_response_summary TEXT,
    flag_reasons TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// V4 anchor: epoch 0 so all pool_activity rows (created_at > 0) pass the filter
setupDb.prepare(`INSERT INTO polling_state (dex_program_id, dex_name, created_at) VALUES ('bitquery_dexpools', 'Bitquery DEXPools', 0)`).run();

const now = Date.now();
const EIGHT_DAYS_AGO   = now - (8  * 24 * 60 * 60 * 1000);
const THREE_DAYS_AGO   = now - (3  * 24 * 60 * 60 * 1000);
const EIGHT_MONTHS_AGO = now - (8  * 30 * 24 * 60 * 60 * 1000);
const THREE_MONTHS_AGO = now - (3  * 30 * 24 * 60 * 60 * 1000);

// Pool A: rug pull candidate (old token, inactive 8d, swap before removal)
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, first_activity_ts, last_activity_ts,
     last_liquidity_remove_ts, last_swap_ts)
  VALUES ('Pool1', 'MintRug1', 1000, 500, 5, 3, ?, ?, ?, ?)
`).run(EIGHT_MONTHS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO - 1000);

// Pool B: recent activity (should NOT be flagged — last_swap_ts too recent)
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, first_activity_ts, last_activity_ts,
     last_liquidity_remove_ts, last_swap_ts)
  VALUES ('Pool2', 'MintActive', 2000, 100, 10, 1, ?, ?, ?, ?)
`).run(EIGHT_MONTHS_AGO, THREE_DAYS_AGO, THREE_DAYS_AGO - 5000, THREE_DAYS_AGO);

// Pool C: add-only (no removal — total_removed = 0, stmtGetCandidates filters it)
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, first_activity_ts, last_activity_ts, last_swap_ts)
  VALUES ('Pool3', 'MintNoRemove', 500, 0, 3, 0, ?, ?, ?)
`).run(EIGHT_MONTHS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO - 1000);

// Pool D: young token (3 months) — age guard should block
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, first_activity_ts, last_activity_ts,
     last_liquidity_remove_ts, last_swap_ts)
  VALUES ('Pool4', 'MintYoung', 100, 200, 2, 3, ?, ?, ?, ?)
`).run(THREE_MONTHS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO - 1000);

// Pool E: whitelisted mint — whitelist guard should block
const WL_MINT = 'WHITELIST1111111111111111111111111111111111';
setupDb.prepare(`INSERT INTO token_whitelist (mint, symbol, name, source, added_at) VALUES (?, 'WL', 'WhitelistedToken', 'test', ?)`).run(WL_MINT, now);
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, first_activity_ts, last_activity_ts,
     last_liquidity_remove_ts, last_swap_ts)
  VALUES ('Pool5', ?, 100, 200, 2, 3, ?, ?, ?, ?)
`).run(WL_MINT, EIGHT_MONTHS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO - 1000);

setupDb.close();

// ── Stub RugCheck (no live network calls in tests) ───────────────────────────

const rugcheckStub = {
  getRugCheckSummary: async () => null,
  classifyVerdict: () => ({ verified: false, rugged: false, risk_level: 'unknown', score: null }),
};
require.cache[require.resolve('../../lib/rugcheck-client')] = {
  id: require.resolve('../../lib/rugcheck-client'),
  filename: require.resolve('../../lib/rugcheck-client'),
  loaded: true,
  exports: rugcheckStub,
};

const { scanForInactivity } = require('../../lib/inactivity-scanner');

// ── Async test runner ─────────────────────────────────────────────────────────

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

test('First scan: marks inactive pools and flags Pool A (rug pull candidate)', async () => {
  const result = await scanForInactivity();
  assert.ok(!result.error, `scan returned error: ${result.error}`);
  // stmtMarkInactive marks ALL eligible pools (A + young-token D + whitelisted E = 3)
  assert.ok(result.poolsMarkedInactive >= 1, `expected >= 1 inactive, got ${result.poolsMarkedInactive}`);
  // Only Pool A passes all 3 guards → 1 flagged
  assert.strictEqual(result.newRugPullsFlagged, 1, `expected 1 flagged, got ${result.newRugPullsFlagged}`);
});

test('First scan: skips young token and whitelisted mint', async () => {
  // run already done above — check known_scams state
  const verifyDb = new Database(tmpDb, { readonly: true });
  const young = verifyDb.prepare(`SELECT 1 FROM known_scams WHERE mint = 'MintYoung'`).get();
  const wl    = verifyDb.prepare(`SELECT 1 FROM known_scams WHERE mint = ?`).get(WL_MINT);
  verifyDb.close();
  assert.strictEqual(young, undefined, 'MintYoung should NOT be flagged (age guard)');
  assert.strictEqual(wl,    undefined, `${WL_MINT.slice(0,8)}... should NOT be flagged (whitelist guard)`);
});

test('Flagged entry has correct source, ratio, confidence, and flag_reasons', () => {
  const verifyDb = new Database(tmpDb, { readonly: true });
  const row = verifyDb.prepare(`SELECT * FROM known_scams WHERE mint = 'MintRug1'`).get();
  verifyDb.close();

  assert.ok(row, 'MintRug1 should be in known_scams');
  assert.strictEqual(row.source, 'hybrid_realtime');
  assert.strictEqual(row.scam_type, 'rug_pull');
  assert.ok(row.add_to_remove_ratio !== null, 'add_to_remove_ratio should be set');
  assert.ok(row.inactivity_days >= 7, `inactivity_days should be >= 7 (got ${row.inactivity_days})`);
  assert.ok(row.flagged_at, 'flagged_at should be set');
  assert.ok(row.confidence >= 0.5 && row.confidence <= 1.0,
    `confidence should be in [0.5, 1.0] (got ${row.confidence})`);
  const reasons = JSON.parse(row.flag_reasons);
  assert.ok(Array.isArray(reasons), 'flag_reasons should be a JSON array');
  assert.ok(reasons.includes('age_ok'), 'flag_reasons should include age_ok');
});

test('Recent pool (MintActive) is NOT flagged', () => {
  const verifyDb = new Database(tmpDb, { readonly: true });
  const row = verifyDb.prepare(`SELECT 1 FROM known_scams WHERE mint = 'MintActive'`).get();
  verifyDb.close();
  assert.strictEqual(row, undefined, 'MintActive should NOT be in known_scams');
});

test('Add-only pool (MintNoRemove) is NOT flagged', () => {
  const verifyDb = new Database(tmpDb, { readonly: true });
  const row = verifyDb.prepare(`SELECT 1 FROM known_scams WHERE mint = 'MintNoRemove'`).get();
  verifyDb.close();
  assert.strictEqual(row, undefined, 'MintNoRemove should NOT be in known_scams');
});

test('Second scan is idempotent — flags 0 new entries', async () => {
  const result = await scanForInactivity();
  assert.ok(!result.error, `scan returned error: ${result.error}`);
  assert.strictEqual(result.poolsMarkedInactive, 0, 'no new inactive pools on second scan');
  assert.strictEqual(result.newRugPullsFlagged, 0, 'no new flags on second scan');
});

// ── Run ───────────────────────────────────────────────────────────────────────

async function runAll() {
  let passed = 0; let failed = 0;
  for (const { name, fn } of _tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch (_) {}
  }
  if (failed > 0) process.exit(1);
}

runAll().catch(e => {
  console.error('Fatal test error:', e.message, e.stack);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch (_) {}
  }
  process.exit(1);
});
