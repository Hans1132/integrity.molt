'use strict';
// Unit tests for lib/inactivity-scanner.js
// Uses temp SQLite DB with synthetic pool_activity rows.

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const tmpDb = path.join(os.tmpdir(), `test-scanner-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDb;

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
  CREATE TABLE IF NOT EXISTS known_scams (
    mint TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    scam_type TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    label TEXT,
    raw_data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    add_to_remove_ratio REAL,
    inactivity_days INTEGER,
    flagged_at INTEGER
  );
`);

const now = Date.now();
const EIGHT_DAYS_AGO = now - (8 * 24 * 60 * 60 * 1000);
const THREE_DAYS_AGO = now - (3 * 24 * 60 * 60 * 1000);

// Pool A: rug pull candidate (last_swap BEFORE last_remove, > 7 days ago)
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, last_activity_ts, last_liquidity_remove_ts, last_swap_ts)
  VALUES ('Pool1', 'MintRug1', 1000, 500, 5, 3, ?, ?, ?)
`).run(EIGHT_DAYS_AGO, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO - 1000); // swap before remove

// Pool B: recent activity (should NOT be flagged)
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, last_activity_ts, last_liquidity_remove_ts, last_swap_ts)
  VALUES ('Pool2', 'MintActive', 2000, 100, 10, 1, ?, ?, ?)
`).run(THREE_DAYS_AGO, THREE_DAYS_AGO - 5000, THREE_DAYS_AGO);

// Pool C: add-only (no removal — should NOT be flagged)
setupDb.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, total_removed_liquidity,
     add_count, remove_count, last_activity_ts, last_swap_ts)
  VALUES ('Pool3', 'MintNoRemove', 500, 0, 3, 0, ?, ?)
`).run(EIGHT_DAYS_AGO, EIGHT_DAYS_AGO - 1000);

setupDb.close();

const { scanForInactivity } = require('../../lib/inactivity-scanner');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

test('First scan flags rug pull candidate and marks it inactive', () => {
  const result = scanForInactivity();
  assert.ok(!result.error, `scan returned error: ${result.error}`);
  assert.strictEqual(result.poolsMarkedInactive, 1, 'should mark 1 pool inactive');
  assert.strictEqual(result.newRugPullsFlagged, 1, 'should flag 1 rug pull');
});

test('Second scan is idempotent — flags 0 new entries', () => {
  const result = scanForInactivity();
  assert.ok(!result.error, `scan returned error: ${result.error}`);
  assert.strictEqual(result.poolsMarkedInactive, 0, 'no new inactive pools');
  assert.strictEqual(result.newRugPullsFlagged, 0, 'no new rug pull flags');
});

test('Flagged entry has correct source and add_to_remove_ratio', () => {
  const verifyDb = new Database(tmpDb);
  const row = verifyDb.prepare(
    "SELECT * FROM known_scams WHERE mint = 'MintRug1'"
  ).get();
  verifyDb.close();

  assert.ok(row, 'MintRug1 should be in known_scams');
  assert.strictEqual(row.source, 'helius_realtime');
  assert.ok(row.add_to_remove_ratio !== null, 'add_to_remove_ratio should be set');
  assert.ok(row.inactivity_days >= 7, `inactivity_days should be >= 7 (got ${row.inactivity_days})`);
  assert.ok(row.flagged_at, 'flagged_at should be set');
});

test('Recent pool (Pool2/MintActive) is NOT flagged', () => {
  const verifyDb = new Database(tmpDb);
  const row = verifyDb.prepare(
    "SELECT * FROM known_scams WHERE mint = 'MintActive'"
  ).get();
  verifyDb.close();
  assert.strictEqual(row, undefined, 'MintActive should NOT be in known_scams');
});

test('Add-only pool (Pool3/MintNoRemove) is NOT flagged', () => {
  const verifyDb = new Database(tmpDb);
  const row = verifyDb.prepare(
    "SELECT * FROM known_scams WHERE mint = 'MintNoRemove'"
  ).get();
  verifyDb.close();
  assert.strictEqual(row, undefined, 'MintNoRemove should NOT be in known_scams');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
try { fs.unlinkSync(tmpDb); } catch {}
if (failed > 0) process.exit(1);
