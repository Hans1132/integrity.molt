#!/usr/bin/env node
'use strict';
/**
 * scripts/enrich-creators-rugcheck.js
 *
 * Obohacení known_scams tabulky o creator wallet adresy pomocí RugCheck API.
 * RugCheck /v1/tokens/{mint}/report vrací pole `creator` bez autentikace.
 *
 * Tento skript NEPROVÁDÍ žádná Helius RPC volání.
 *
 * Použití:
 *   node scripts/enrich-creators-rugcheck.js [--limit N] [--batch-size N] [--delay-ms N]
 *
 * Možnosti:
 *   --limit N       Maximální počet mintů ke zpracování (výchozí: 1000)
 *   --batch-size N  Počet mintů před uložením progressu (výchozí: 50)
 *   --delay-ms N    Prodleva mezi požadavky v ms (výchozí: 700)
 *   --all           Zpracuj všechny minity bez limitu
 *   --resume        Přeskoč mints, které již mají creator (výchozí: ano)
 *
 * Při přerušení lze skript spustit znovu — přeskočí již zpracované.
 * Progress se průběžně zapisuje do databáze.
 */

const https = require('https');
const path  = require('path');

const db = require('../db');

// ── Konfigurace ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const LIMIT      = args.includes('--all') ? Infinity : parseInt(getArg('--limit', '1000'), 10);
const BATCH_SIZE = parseInt(getArg('--batch-size', '50'), 10);
const DELAY_MS   = parseInt(getArg('--delay-ms', '700'), 10);

const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1/tokens';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve(null);  // Token neznámý v RugCheck — přeskočit
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('RATE_LIMITED'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('JSON parse error'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Validace Solana adresy ────────────────────────────────────────────────────

function isValidSolanaAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  // Base58, 32-44 znaků, bez 0, O, I, l
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ── Hlavní logika ─────────────────────────────────────────────────────────────

async function main() {
  await db.initSchema();

  // Načti mints bez creator, seřazené dle confidence DESC (nejjistější rug pully první)
  const mints = db.db.prepare(`
    SELECT mint, confidence, rug_pattern
    FROM known_scams
    WHERE (creator IS NULL OR creator = '')
    ORDER BY confidence DESC, created_at ASC
    ${LIMIT === Infinity ? '' : `LIMIT ${LIMIT}`}
  `).all();

  console.log(`\nenrich-creators-rugcheck.js`);
  console.log(`══════════════════════════════════════════`);
  console.log(`Mints ke zpracování : ${mints.length}`);
  console.log(`Prodleva mezi req   : ${DELAY_MS} ms`);
  console.log(`Batch size          : ${BATCH_SIZE}`);
  console.log(`\nSpouštím obohacení...\n`);

  let processed  = 0;
  let enriched   = 0;
  let notFound   = 0;
  let noCreator  = 0;
  let errors     = 0;
  let rateLimited = 0;

  for (let i = 0; i < mints.length; i++) {
    const { mint } = mints[i];

    let data;
    try {
      data = await fetchJson(`${RUGCHECK_BASE}/${mint}/report`);
    } catch (e) {
      if (e.message === 'RATE_LIMITED') {
        rateLimited++;
        // Exponential backoff: čekej déle a zkus znovu
        const backoffMs = 5000 + Math.random() * 5000;
        console.warn(`  [RATE_LIMIT] backoff ${Math.round(backoffMs / 1000)}s ... (${mint.slice(0, 8)}...)`);
        await sleep(backoffMs);
        i--;  // retry this mint
        continue;
      }
      errors++;
      if (errors <= 5 || errors % 100 === 0) {
        console.warn(`  [ERR] ${mint.slice(0, 8)}... — ${e.message}`);
      }
      await sleep(DELAY_MS);
      continue;
    }

    processed++;

    if (data === null) {
      notFound++;
    } else {
      const creator = data.creator || '';
      if (isValidSolanaAddress(creator)) {
        // Aktualizuj creator field (COALESCE v upsert zachová existující hodnoty)
        db.db.prepare(`
          UPDATE known_scams SET creator = ?, updated_at = datetime('now')
          WHERE mint = ? AND (creator IS NULL OR creator = '')
        `).run(creator, mint);
        enriched++;
      } else {
        noCreator++;
      }
    }

    // Progress report každých 100 mintů
    if (processed % 100 === 0) {
      const pct = ((i + 1) / mints.length * 100).toFixed(1);
      console.log(`  [${pct}%] processed=${processed} enriched=${enriched} notFound=${notFound} noCreator=${noCreator} errors=${errors}`);
    }

    await sleep(DELAY_MS);
  }

  // ── Závěrečná statistika ──────────────────────────────────────────────────

  console.log(`\n══════════════════════════════════════════`);
  console.log(`Hotovo!`);
  console.log(`  Zpracováno    : ${processed}`);
  console.log(`  Obohaceno     : ${enriched} (creator nalezen)`);
  console.log(`  Nenalezeno    : ${notFound} (RugCheck 404)`);
  console.log(`  Bez creator   : ${noCreator} (API vrátilo prázdný creator)`);
  console.log(`  Chyby         : ${errors}`);
  console.log(`  Rate limity   : ${rateLimited}`);

  // Přepočítej scam_creators tabulku
  console.log(`\nPřepočítávám scam_creators...`);
  const creatorCount = db.rebuildScamCreators();
  console.log(`scam_creators: ${creatorCount} unikátních tvůrců`);

  // Top 10 recidivisté
  const top10 = db.db.prepare(`
    SELECT creator_wallet, scam_count, patterns
    FROM scam_creators
    ORDER BY scam_count DESC
    LIMIT 10
  `).all();

  if (top10.length) {
    console.log(`\nTop recidivisté (scam_creators):`);
    for (const row of top10) {
      const patterns = row.patterns ? JSON.parse(row.patterns) : [];
      console.log(`  ${row.creator_wallet.slice(0, 12)}...  scams=${row.scam_count}  patterns=${patterns.join(',') || 'null'}`);
    }
  }

  // Celkový stav
  const totalWithCreator = db.db.prepare(`SELECT COUNT(*) AS cnt FROM known_scams WHERE creator IS NOT NULL AND creator != ''`).get().cnt;
  const totalScams       = db.db.prepare(`SELECT COUNT(*) AS cnt FROM known_scams`).get().cnt;
  console.log(`\nStav known_scams: ${totalWithCreator}/${totalScams} má creator`);

  process.exit(0);
}

main().catch(e => {
  console.error('Enrichment selhal:', e.message);
  process.exit(1);
});
