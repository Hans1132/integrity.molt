'use strict';
require('dotenv').config({ path: '/root/x402-server/.env' });

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

const db = new Database(DB_PATH, { readonly: true });

console.log('=== SolRPDS Extension Pipeline Health Check ===\n');

// Polling state
const pollState = db.prepare('SELECT * FROM polling_state ORDER BY dex_name').all();
console.log('Polling state per DEX:');
console.table(pollState.map(s => ({
  DEX: s.dex_name,
  total_polls: s.total_polls,
  total_credits: s.total_credits_used,
  total_tx: s.total_tx_processed,
  last_poll: s.last_poll_ts ? new Date(s.last_poll_ts).toISOString() : 'never',
  last_error: s.last_error ? s.last_error.slice(0, 40) : 'none',
})));

// Pool activity
const poolStats = db.prepare(`
  SELECT
    COUNT(*) AS total_pools,
    SUM(CASE WHEN inactivity_status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
    SUM(CASE WHEN inactivity_status = 'active'   THEN 1 ELSE 0 END) AS active,
    ROUND(AVG(add_count), 1) AS avg_adds,
    ROUND(AVG(remove_count), 1) AS avg_removes
  FROM pool_activity
`).get();
console.log('\nPool activity summary:', poolStats);

// known_scams source breakdown
const sourceBreakdown = db.prepare(`
  SELECT source, COUNT(*) AS count FROM known_scams GROUP BY source
`).all();
console.log('\nknown_scams by source:');
console.table(sourceBreakdown);

// Recent helius_realtime flags
const recentFlags = db.prepare(`
  SELECT mint, add_to_remove_ratio, inactivity_days, flagged_at
  FROM known_scams
  WHERE source = 'helius_realtime'
  ORDER BY flagged_at DESC
  LIMIT 10
`).all();
if (recentFlags.length > 0) {
  console.log('\nRecent helius_realtime flags:');
  console.table(recentFlags.map(r => ({
    mint: (r.mint || '').slice(0, 12) + '...',
    ratio: r.add_to_remove_ratio != null ? r.add_to_remove_ratio.toFixed(4) : 'null',
    inactive_days: r.inactivity_days,
    flagged: r.flagged_at ? new Date(r.flagged_at).toISOString() : 'null',
  })));
} else {
  console.log('\nNo helius_realtime flags yet (pipeline may still be accumulating data)');
}

// Credit usage projection
const totalCreditsLastCycle = pollState.reduce((sum, s) => sum + (s.last_poll_credits_used || 0), 0);
const projectedDaily = totalCreditsLastCycle * 24;
const projectedMonthly = projectedDaily * 30;
console.log(`\nCredit projection (based on last cycle): ${totalCreditsLastCycle} credits/cycle`);
console.log(`  ~${projectedDaily}/day, ~${projectedMonthly}/month`);
if (projectedMonthly > 0) {
  console.log(`  Budget: 10M/month → ${(10000000 / projectedMonthly).toFixed(1)}x headroom`);
}

// known_scams integrity check
const solrpdsCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE source = 'solrpds'"
).get().cnt;
console.log(`\nSolRPDS baseline integrity: ${solrpdsCount} entries (expected ~33359)`);
if (solrpdsCount < 33000) {
  console.error('WARNING: SolRPDS baseline count is low — possible data loss!');
}

console.log('\n=== Health check complete ===');
