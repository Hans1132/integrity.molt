'use strict';

require('dotenv').config({ path: '/root/x402-server/.env' });
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'intmolt.db');
const db = new Database(DB_PATH, { readonly: true });

console.log('=== Bitquery V4 Pipeline Health Check ===\n');

const state = db.prepare(`SELECT * FROM polling_state WHERE dex_program_id = 'bitquery_dexpools'`).get();
if (!state) {
  console.error('FAIL: No polling_state row for bitquery_dexpools');
  process.exit(1);
}

console.log('Polling state:', {
  total_polls: state.total_polls,
  total_credits_used: state.total_credits_used,
  total_tx_processed: state.total_tx_processed,
  last_poll: state.last_poll_ts ? new Date(state.last_poll_ts).toISOString() : 'never',
  last_seen: state.last_seen_ts ? new Date(state.last_seen_ts).toISOString() : 'never',
  last_error: state.last_error ? state.last_error.slice(0, 100) : 'none',
});

const poolStats = db.prepare(`
  SELECT
    COUNT(*) as total_pools,
    SUM(CASE WHEN inactivity_status = 'inactive' THEN 1 ELSE 0 END) as inactive,
    SUM(CASE WHEN inactivity_status = 'active'   THEN 1 ELSE 0 END) as active,
    AVG(add_count)    as avg_adds,
    AVG(remove_count) as avg_removes,
    SUM(CASE WHEN total_added_liquidity   > 0 THEN 1 ELSE 0 END) as pools_with_adds,
    SUM(CASE WHEN total_removed_liquidity > 0 THEN 1 ELSE 0 END) as pools_with_removes
  FROM pool_activity
`).get();
console.log('\nPool activity:', poolStats);

const sources = db.prepare(`SELECT source, COUNT(*) as count FROM known_scams GROUP BY source`).all();
console.log('\nknown_scams by source:');
console.table(sources);

const recent = db.prepare(`
  SELECT mint, add_to_remove_ratio, inactivity_days, flagged_at
  FROM known_scams
  WHERE source = 'bitquery_realtime'
  ORDER BY flagged_at DESC LIMIT 10
`).all();
console.log('\nRecent bitquery_realtime flags:');
if (recent.length === 0) {
  console.log('  (none yet — scanner needs 7+ days of data accumulation)');
} else {
  console.table(recent.map(r => ({
    mint: r.mint?.slice(0, 12) + '...',
    ratio: r.add_to_remove_ratio?.toFixed(4),
    inactive_days: r.inactivity_days,
    flagged: new Date(r.flagged_at).toISOString(),
  })));
}

if (state.total_polls > 0) {
  const avgPerPoll = state.total_credits_used / state.total_polls;
  const monthlyProjection = avgPerPoll * 60; // 12h interval = 60 polls/month
  console.log('\nCredit projection (12h interval):');
  console.log(`  Avg per poll: ${avgPerPoll.toFixed(1)} pts`);
  console.log(`  Projected monthly: ${monthlyProjection.toFixed(0)} pts`);
  console.log(`  Free plan budget: 1000 pts — headroom: ${(1000 / monthlyProjection).toFixed(1)}x`);
  if (monthlyProjection > 900) {
    console.warn('  WARNING: projected spend >900 pts/month. Increase BITQUERY_POLL_INTERVAL_HOURS or reduce PAGE_SIZE.');
  }
}
