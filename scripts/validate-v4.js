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
  WHERE source = 'hybrid_realtime'
  ORDER BY flagged_at DESC LIMIT 10
`).all();
console.log('\nRecent hybrid_realtime flags:');
if (recent.length === 0) {
  console.log('  (none yet — scanner needs 7+ days of combined Helius+Bitquery data)');
} else {
  console.table(recent.map(r => ({
    mint: r.mint?.slice(0, 12) + '...',
    ratio: r.add_to_remove_ratio?.toFixed(4),
    inactive_days: r.inactivity_days,
    flagged: new Date(r.flagged_at).toISOString(),
  })));
}

// Credit projection: 4h interval, 5 pts/poll (single filtered query)
const POLLS_PER_MONTH = 6 * 30; // 6 polls/day × 30 days = 180
const PTS_PER_POLL = 5;
const monthlyProjection = POLLS_PER_MONTH * PTS_PER_POLL;
console.log('\nCredit projection (4h interval, single filtered query):');
console.log(`  Polls/month: ${POLLS_PER_MONTH}`);
console.log(`  Pts/poll: ${PTS_PER_POLL} (estimated)`);
console.log(`  Projected monthly: ${monthlyProjection} pts`);
console.log(`  Free plan budget: 1000 pts — headroom: ${(1000 / monthlyProjection).toFixed(1)}x`);

// 24h activity — created_at a updated_at jsou INTEGER ms, ne TEXT datetime
// Správný filtr: (strftime('%s','now') - 86400) * 1000
const since24h = (Math.floor(Date.now() / 1000) - 86400) * 1000;
const mints24h = db.prepare(`SELECT COUNT(*) as c FROM spl_mints WHERE created_at > ?`).get(since24h);
const pools24h = db.prepare(`SELECT COUNT(*) as c FROM pool_activity WHERE updated_at > ?`).get(since24h);
console.log('\n24h pipeline activity:');
console.log(`  New SPL mints detected:   ${mints24h.c}`);
console.log(`  Pool activity updates:    ${pools24h.c}`);

// Hybrid architecture status
const heliusRows = db.prepare(`SELECT COUNT(*) as c FROM pool_activity WHERE last_swap_ts IS NOT NULL`).get();
const removalRows = db.prepare(`SELECT COUNT(*) as c FROM pool_activity WHERE last_liquidity_remove_ts IS NOT NULL`).get();
const bothRows = db.prepare(`SELECT COUNT(*) as c FROM pool_activity WHERE last_swap_ts IS NOT NULL AND last_liquidity_remove_ts IS NOT NULL`).get();
console.log('\nHybrid signal coverage:');
console.log(`  Pools with Helius SWAP signal:     ${heliusRows.c}`);
console.log(`  Pools with Bitquery REMOVAL signal: ${removalRows.c}`);
console.log(`  Pools with BOTH signals (SolRPDS ready): ${bothRows.c}`);
