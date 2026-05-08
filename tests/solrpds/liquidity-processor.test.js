'use strict';
// Unit tests for lib/liquidity-event-processor.js
// Uses temp SQLite file (SQLITE_DB_PATH env var) — no live DB writes.

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Setup: temp DB with required schema
const tmpDb = path.join(os.tmpdir(), `test-liquidity-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDb;

const setupDb = new Database(tmpDb);
setupDb.pragma('journal_mode = WAL');
setupDb.exec(`
  CREATE TABLE IF NOT EXISTS pool_activity (
    pool_address TEXT NOT NULL,
    mint TEXT NOT NULL,
    total_added_liquidity REAL DEFAULT 0,
    total_removed_liquidity REAL DEFAULT 0,
    add_count INTEGER DEFAULT 0,
    remove_count INTEGER DEFAULT 0,
    first_activity_ts INTEGER,
    last_activity_ts INTEGER,
    last_liquidity_remove_ts INTEGER,
    last_swap_ts INTEGER,
    last_swap_tx TEXT,
    inactivity_status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (pool_address, mint)
  );
`);
setupDb.close();

// Import module AFTER setting env var
const {
  recordLiquidityEvent,
  recordBatch,
  getPoolActivity,
  getActivePoolCount
} = require('../../lib/liquidity-event-processor');

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

const POOL = 'PoolAddr111111111111111111111111111111111111';
const MINT = 'MintAddr111111111111111111111111111111111111';
const TS = 1700000000000;

test('Single ADD_LIQUIDITY creates row with correct totals', () => {
  recordLiquidityEvent('ADD_LIQUIDITY', POOL, MINT, 500, TS, 'tx1');
  const row = getPoolActivity(POOL, MINT);
  assert.ok(row, 'row should exist');
  assert.strictEqual(row.total_added_liquidity, 500);
  assert.strictEqual(row.add_count, 1);
  assert.strictEqual(row.total_removed_liquidity, 0);
  assert.strictEqual(row.last_activity_ts, TS);
  assert.strictEqual(row.first_activity_ts, TS);
  assert.strictEqual(row.inactivity_status, 'active');
});

test('Second ADD_LIQUIDITY accumulates totals', () => {
  recordLiquidityEvent('ADD_LIQUIDITY', POOL, MINT, 300, TS + 1000, 'tx2');
  const row = getPoolActivity(POOL, MINT);
  assert.strictEqual(row.total_added_liquidity, 800);
  assert.strictEqual(row.add_count, 2);
  assert.strictEqual(row.last_activity_ts, TS + 1000);
  assert.strictEqual(row.first_activity_ts, TS); // must NOT regress
});

test('REMOVE_LIQUIDITY sets last_liquidity_remove_ts', () => {
  const removeTs = TS + 5000;
  recordLiquidityEvent('REMOVE_LIQUIDITY', POOL, MINT, 200, removeTs, 'tx3');
  const row = getPoolActivity(POOL, MINT);
  assert.strictEqual(row.total_removed_liquidity, 200);
  assert.strictEqual(row.remove_count, 1);
  assert.strictEqual(row.last_liquidity_remove_ts, removeTs);
  assert.strictEqual(row.last_activity_ts, removeTs);
});

test('SWAP updates last_swap_ts and last_swap_tx', () => {
  const swapTs = TS + 10000;
  recordLiquidityEvent('SWAP', POOL, MINT, 0, swapTs, 'txSwap1');
  const row = getPoolActivity(POOL, MINT);
  assert.strictEqual(row.last_swap_ts, swapTs);
  assert.strictEqual(row.last_swap_tx, 'txSwap1');
  assert.strictEqual(row.total_removed_liquidity, 200); // unchanged
});

test('Out-of-order SWAP (older timestamp) does NOT regress last_swap_ts', () => {
  const olderSwapTs = TS + 1000;
  recordLiquidityEvent('SWAP', POOL, MINT, 0, olderSwapTs, 'txOld');
  const row = getPoolActivity(POOL, MINT);
  assert.strictEqual(row.last_swap_ts, TS + 10000); // must NOT regress
  assert.strictEqual(row.last_swap_tx, 'txSwap1');   // must NOT regress
});

test('recordBatch processes multiple events atomically', () => {
  const POOL2 = 'PoolAddr222222222222222222222222222222222222';
  const MINT2 = 'MintAddr222222222222222222222222222222222222';
  const events = [
    { eventType: 'ADD_LIQUIDITY',    poolAddress: POOL2, mint: MINT2, amount: 1000, timestamp: TS, txHash: 'btx1' },
    { eventType: 'REMOVE_LIQUIDITY', poolAddress: POOL2, mint: MINT2, amount: 1000, timestamp: TS + 1, txHash: 'btx2' },
    { eventType: 'SWAP',             poolAddress: POOL2, mint: MINT2, amount: 0,    timestamp: TS + 2, txHash: 'btx3' },
  ];
  recordBatch(events);
  const row = getPoolActivity(POOL2, MINT2);
  assert.ok(row, 'batch row should exist');
  assert.strictEqual(row.add_count, 1);
  assert.strictEqual(row.remove_count, 1);
  assert.strictEqual(row.total_added_liquidity, 1000);
  assert.strictEqual(row.total_removed_liquidity, 1000);
  assert.ok(row.last_swap_ts, 'last_swap_ts should be set');
});

test('getActivePoolCount returns count of active pools', () => {
  const count = getActivePoolCount();
  assert.ok(typeof count === 'number', 'should return a number');
  assert.ok(count >= 2, 'should have at least 2 pools from above tests');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
try { fs.unlinkSync(tmpDb); } catch {}
if (failed > 0) process.exit(1);
