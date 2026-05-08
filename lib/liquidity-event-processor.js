'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Prepared statements

const stmtAddLiquidity = db.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_added_liquidity, add_count,
     first_activity_ts, last_activity_ts, updated_at)
  VALUES (?, ?, ?, 1, ?, ?, unixepoch() * 1000)
  ON CONFLICT(pool_address, mint) DO UPDATE SET
    total_added_liquidity = total_added_liquidity + excluded.total_added_liquidity,
    add_count             = add_count + 1,
    last_activity_ts      = MAX(last_activity_ts, excluded.last_activity_ts),
    updated_at            = unixepoch() * 1000
`);

const stmtRemoveLiquidity = db.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, total_removed_liquidity, remove_count,
     first_activity_ts, last_activity_ts, last_liquidity_remove_ts, updated_at)
  VALUES (?, ?, ?, 1, ?, ?, ?, unixepoch() * 1000)
  ON CONFLICT(pool_address, mint) DO UPDATE SET
    total_removed_liquidity = total_removed_liquidity + excluded.total_removed_liquidity,
    remove_count            = remove_count + 1,
    last_activity_ts        = MAX(last_activity_ts, excluded.last_activity_ts),
    last_liquidity_remove_ts = MAX(COALESCE(last_liquidity_remove_ts, 0), excluded.last_liquidity_remove_ts),
    updated_at              = unixepoch() * 1000
`);

const stmtSwap = db.prepare(`
  INSERT INTO pool_activity
    (pool_address, mint, first_activity_ts, last_activity_ts,
     last_swap_ts, last_swap_tx, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)
  ON CONFLICT(pool_address, mint) DO UPDATE SET
    last_swap_ts  = CASE WHEN excluded.last_swap_ts > COALESCE(last_swap_ts, 0)
                         THEN excluded.last_swap_ts ELSE last_swap_ts END,
    last_swap_tx  = CASE WHEN excluded.last_swap_ts > COALESCE(last_swap_ts, 0)
                         THEN excluded.last_swap_tx ELSE last_swap_tx END,
    updated_at    = unixepoch() * 1000
`);

const stmtGet = db.prepare(`
  SELECT * FROM pool_activity WHERE pool_address = ? AND mint = ?
`);

const stmtActiveCount = db.prepare(`
  SELECT COUNT(*) AS cnt FROM pool_activity WHERE inactivity_status = 'active'
`);

// Public API

function recordLiquidityEvent(eventType, poolAddress, mint, amount, timestamp, txHash) {
  if (!poolAddress || !mint) return;

  switch (eventType) {
    case 'ADD_LIQUIDITY':
      stmtAddLiquidity.run(poolAddress, mint, amount || 0, timestamp, timestamp);
      break;

    case 'REMOVE_LIQUIDITY':
      stmtRemoveLiquidity.run(poolAddress, mint, amount || 0, timestamp, timestamp, timestamp);
      break;

    case 'SWAP':
      stmtSwap.run(poolAddress, mint, timestamp, timestamp, timestamp, txHash || null);
      break;

    default:
      console.warn(`[liquidity-processor] Unknown eventType: ${eventType}`);
  }
}

const recordBatch = db.transaction((events) => {
  for (const ev of events) {
    recordLiquidityEvent(ev.eventType, ev.poolAddress, ev.mint, ev.amount, ev.timestamp, ev.txHash);
  }
});

function getPoolActivity(poolAddress, mint) {
  return stmtGet.get(poolAddress, mint) || null;
}

function getActivePoolCount() {
  return stmtActiveCount.get().cnt;
}

module.exports = { recordLiquidityEvent, recordBatch, getPoolActivity, getActivePoolCount };
