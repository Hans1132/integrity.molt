'use strict';
require('dotenv').config({ path: '/root/x402-server/.env' });

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

console.log(`[migration] DB: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Step 1: Run DDL from SQL file
const sqlPath = path.join(__dirname, '..', 'migrations', '001_solrpds_extension.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
console.log('[migration] Running 001_solrpds_extension.sql...');
db.exec(sql);
console.log('[migration] ✅ Tables created (idempotent)');

// Step 2: Add new columns to known_scams (idempotent)
// NOTE: known_scams.source already exists — only add 3 new analytics columns
const existingCols = db.prepare("PRAGMA table_info(known_scams)").all().map(c => c.name);
console.log('[migration] known_scams columns:', existingCols.join(', '));

const newColumns = [
  { name: 'add_to_remove_ratio', ddl: 'ALTER TABLE known_scams ADD COLUMN add_to_remove_ratio REAL' },
  { name: 'inactivity_days',     ddl: 'ALTER TABLE known_scams ADD COLUMN inactivity_days INTEGER' },
  { name: 'flagged_at',          ddl: 'ALTER TABLE known_scams ADD COLUMN flagged_at INTEGER' },
];

for (const col of newColumns) {
  if (existingCols.includes(col.name)) {
    console.log(`[migration] ⏭  ${col.name} already exists — skipping`);
  } else {
    db.exec(col.ddl);
    console.log(`[migration] ✅ Added column: ${col.name}`);
  }
}

// Step 3: Seed polling_state with 5 DEX rows
const DEX_PROGRAMS = [
  { id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', name: 'Raydium AMM v4' },
  { id: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', name: 'Raydium CPMM' },
  { id: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  name: 'Orca Whirlpool' },
  { id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  name: 'Pump.fun' },
  { id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  name: 'Meteora DLMM' },
];

const insertDex = db.prepare(`
  INSERT OR IGNORE INTO polling_state (dex_program_id, dex_name)
  VALUES (?, ?)
`);

for (const dex of DEX_PROGRAMS) {
  const result = insertDex.run(dex.id, dex.name);
  if (result.changes > 0) {
    console.log(`[migration] ✅ Seeded DEX: ${dex.name}`);
  } else {
    console.log(`[migration] ⏭  DEX already exists: ${dex.name}`);
  }
}

// Step 3b: Seed bitquery_dexpools row (V4 anchor required by inactivity scanner)
const insertBitquery = db.prepare(`INSERT OR IGNORE INTO polling_state (dex_program_id, dex_name) VALUES (?, ?)`);
const bqResult = insertBitquery.run('bitquery_dexpools', 'Bitquery DEXPools');
if (bqResult.changes > 0) {
  console.log('[migration] ✅ Seeded DEX: Bitquery DEXPools');
} else {
  console.log('[migration] ⏭  DEX already exists: Bitquery DEXPools');
}

// Step 4: Migration 002 — token_whitelist + false positive guard columns
const sql002 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '002_false_positive_guards.sql'), 'utf8');
console.log('[migration] Running 002_false_positive_guards.sql...');
db.exec(sql002);
console.log('[migration] ✅ token_whitelist created (idempotent)');

const existingCols002 = db.prepare("PRAGMA table_info(known_scams)").all().map(c => c.name);
const guardColumns = [
  { name: 'rugcheck_verified',          ddl: 'ALTER TABLE known_scams ADD COLUMN rugcheck_verified INTEGER DEFAULT 0' },
  { name: 'rugcheck_response_summary',  ddl: 'ALTER TABLE known_scams ADD COLUMN rugcheck_response_summary TEXT' },
  { name: 'flag_reasons',               ddl: 'ALTER TABLE known_scams ADD COLUMN flag_reasons TEXT' },
];
for (const col of guardColumns) {
  if (existingCols002.includes(col.name)) {
    console.log(`[migration] ⏭  ${col.name} already exists — skipping`);
  } else {
    db.exec(col.ddl);
    console.log(`[migration] ✅ Added column: ${col.name}`);
  }
}

// Step 5: Verify
const poolCount = db.prepare('SELECT COUNT(*) AS cnt FROM pool_activity').get().cnt;
const pollCount = db.prepare('SELECT COUNT(*) AS cnt FROM polling_state').get().cnt;
const wlCount  = db.prepare('SELECT COUNT(*) AS cnt FROM token_whitelist').get().cnt;
const ksInfo   = db.prepare("PRAGMA table_info(known_scams)").all().map(c => c.name);

console.log(`\n[migration] ── Verification ──────────────────────────────`);
console.log(`[migration] pool_activity rows: ${poolCount} (expected 0 on fresh run)`);
console.log(`[migration] polling_state rows: ${pollCount} (expected 6+)`);
console.log(`[migration] token_whitelist rows: ${wlCount}`);
console.log(`[migration] known_scams columns: ${ksInfo.join(', ')}`);

const hasNewCols = [
  'add_to_remove_ratio', 'inactivity_days', 'flagged_at',
  'rugcheck_verified', 'rugcheck_response_summary', 'flag_reasons',
].every(c => ksInfo.includes(c));
if (!hasNewCols) {
  console.error('[migration] ❌ FAIL: missing expected columns in known_scams');
  process.exit(1);
}

console.log('[migration] ✅ All checks passed — migration complete');
