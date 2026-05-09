'use strict';
require('dotenv').config({ path: '/root/x402-server/.env' });

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'intmolt.db');
const db = new Database(DB_PATH, { readonly: true });

console.log('=== False Positive Guards Health Check ===\n');

// V4 anchor — scanner is disabled if this row is missing
const anchor = db.prepare(`SELECT created_at FROM polling_state WHERE dex_program_id = 'bitquery_dexpools'`).get();
if (!anchor) {
  console.error('FAIL: bitquery_dexpools row missing from polling_state — scanner is disabled!');
  process.exit(1);
}
console.log('V4 anchor:', new Date(anchor.created_at).toISOString(), '✓\n');

// New column presence
const cols = db.prepare('PRAGMA table_info(known_scams)').all().map(c => c.name);
const required = ['rugcheck_verified', 'rugcheck_response_summary', 'flag_reasons'];
console.log('Schema check:');
for (const col of required) {
  console.log(`  ${col}: ${cols.includes(col) ? '✓' : '✗ MISSING'}`);
}

// Whitelist
const wl = db.prepare('SELECT COUNT(*) AS cnt FROM token_whitelist').get();
console.log(`\ntoken_whitelist: ${wl.cnt} entries`);
if (wl.cnt === 0) console.log('  ⚠️  Run: node scripts/seed-whitelist.js');

// known_scams by source with confidence stats
const scamStats = db.prepare(`
  SELECT source,
         COUNT(*) AS count,
         ROUND(AVG(confidence), 3) AS avg_confidence,
         ROUND(MIN(confidence), 3) AS min_confidence,
         ROUND(MAX(confidence), 3) AS max_confidence
  FROM known_scams
  GROUP BY source
  ORDER BY count DESC
`).all();
console.log('\nknown_scams by source:');
console.table(scamStats);

// Recent hybrid_realtime flags with guard details
const recent = db.prepare(`
  SELECT mint, confidence, inactivity_days,
         rugcheck_verified, rugcheck_response_summary, flag_reasons, flagged_at
  FROM known_scams
  WHERE source = 'hybrid_realtime'
  ORDER BY flagged_at DESC
  LIMIT 10
`).all();
console.log('\nRecent hybrid_realtime flags:');
if (recent.length === 0) {
  console.log('  (none yet — needs 7+ days of data + age filter satisfied)');
} else {
  console.table(recent.map(r => ({
    mint:       (r.mint || '').slice(0, 12) + '...',
    confidence: r.confidence?.toFixed(2),
    days:       r.inactivity_days,
    rugcheck:   r.rugcheck_verified ? r.rugcheck_response_summary : 'not_checked',
    reasons:    r.flag_reasons,
    flagged:    r.flagged_at ? new Date(r.flagged_at).toISOString() : null,
  })));
}

// Confidence distribution
const dist = db.prepare(`
  SELECT
    SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) AS high,
    SUM(CASE WHEN confidence >= 0.5 AND confidence < 0.8 THEN 1 ELSE 0 END) AS medium,
    SUM(CASE WHEN confidence < 0.5 THEN 1 ELSE 0 END) AS low
  FROM known_scams
  WHERE source = 'hybrid_realtime'
`).get();
if (recent.length > 0) {
  console.log('\nConfidence distribution (hybrid_realtime):');
  console.log(`  High (≥0.8):     ${dist.high}`);
  console.log(`  Medium (0.5–0.8): ${dist.medium}`);
  console.log(`  Low (<0.5):       ${dist.low}`);
}
