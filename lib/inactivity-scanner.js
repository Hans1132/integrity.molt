'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const stmtMarkInactive = db.prepare(`
  UPDATE pool_activity
  SET inactivity_status = 'inactive',
      updated_at = ?
  WHERE inactivity_status = 'active'
    AND last_swap_ts IS NOT NULL
    AND last_swap_ts < ?
    AND last_liquidity_remove_ts IS NOT NULL
    AND last_swap_ts < last_liquidity_remove_ts
`);

const stmtFlagRugPulls = db.prepare(`
  INSERT OR IGNORE INTO known_scams
    (mint, source, add_to_remove_ratio, inactivity_days, flagged_at)
  SELECT
    mint,
    'helius_realtime',
    CASE WHEN total_removed_liquidity > 0
         THEN total_added_liquidity / total_removed_liquidity
         ELSE NULL END,
    CAST((? - last_activity_ts) / 86400000 AS INTEGER),
    ?
  FROM pool_activity
  WHERE inactivity_status = 'inactive'
    AND total_removed_liquidity > 0
    AND last_activity_ts < ?
    AND mint NOT IN (SELECT mint FROM known_scams)
`);

function scanForInactivity() {
  const now = Date.now();
  const cutoff = now - SEVEN_DAYS_MS;

  try {
    const inactiveResult = stmtMarkInactive.run(now, cutoff);
    const flaggedResult = stmtFlagRugPulls.run(now, now, cutoff);

    return {
      poolsMarkedInactive: inactiveResult.changes,
      newRugPullsFlagged: flaggedResult.changes,
      timestamp: now,
    };
  } catch (err) {
    console.error('[inactivity-scanner] Error:', err.message);
    return { error: err.message };
  }
}

module.exports = { scanForInactivity };
