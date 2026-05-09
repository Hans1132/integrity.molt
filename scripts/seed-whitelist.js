'use strict';
require('dotenv').config({ path: '/root/x402-server/.env' });

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'intmolt.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Primary: Jupiter strict-list JSON API
const JUPITER_STRICT_URL = 'https://token.jup.ag/strict';
// Fallback: Jupiter validated-tokens CSV on GitHub (community-validated subset)
const JUPITER_CSV_URL = 'https://raw.githubusercontent.com/jup-ag/token-list/main/validated-tokens.csv';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'integrity-molt/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCsv(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'text/csv', 'User-Agent': 'integrity-molt/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  // CSV: Name,Symbol,Mint,Decimals,LogoURI,Community Validated
  return lines.slice(1) // skip header
    .filter(l => l.endsWith(',true'))
    .map(l => {
      const parts = l.split(',');
      // Mint is column 2 (index 2)
      return { name: parts[0], symbol: parts[1], address: parts[2] };
    })
    .filter(t => t.address && t.address.length > 30); // basic sanity
}

async function seedWhitelist() {
  let tokens = [];
  let source = 'jupiter_strict';

  console.log('[seed-whitelist] Trying Jupiter strict list (token.jup.ag)...');
  try {
    tokens = await fetchJson(JUPITER_STRICT_URL);
    console.log(`[seed-whitelist] Got ${tokens.length} tokens from Jupiter strict list`);
  } catch (e) {
    console.warn(`[seed-whitelist] Primary source failed (${e.message}), trying GitHub CSV fallback...`);
    source = 'jupiter_validated_csv';
    tokens = await fetchCsv(JUPITER_CSV_URL);
    console.log(`[seed-whitelist] Got ${tokens.length} community-validated tokens from GitHub CSV`);
  }

  if (tokens.length === 0) throw new Error('No tokens fetched from any source');

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO token_whitelist (mint, symbol, name, source, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertBatch = db.transaction((tokens, source) => {
    const now = Date.now();
    let count = 0;
    for (const t of tokens) {
      const mint = t.address || t.mint;
      if (mint) {
        upsert.run(mint, t.symbol || null, t.name || null, source, now);
        count++;
      }
    }
    return count;
  });

  const inserted = insertBatch(tokens, source);
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM token_whitelist').get().cnt;
  console.log(`[seed-whitelist] Upserted ${inserted} entries (source: ${source}). Total: ${total}`);
}

seedWhitelist().catch(e => {
  console.error('[seed-whitelist] FAIL:', e.message);
  process.exit(1);
});
