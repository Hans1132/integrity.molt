#!/usr/bin/env node
'use strict';
/**
 * scripts/import-scam-db.js
 *
 * Import scam tokenů z akademických datasetů do SQLite known_scams tabulky.
 *
 * Podporované zdroje:
 *   --source solrpds   : SolRPDS dataset (CSV nebo JSON)
 *                        Stáhnout z: https://github.com/mitosis-project/solrpds
 *                        Uložit do:  data/scam-datasets/solrpds.csv
 *
 *   --source solrugdet : SolRugDetector dataset (CSV nebo JSON)
 *                        Stáhnout z: https://github.com/Mik-TF/solrugdetector
 *                        Uložit do:  data/scam-datasets/solrugdetector.csv
 *
 *   --source csv <file> : Obecný CSV soubor s hlavičkou: mint,label,scam_type,confidence
 *
 * Použití:
 *   node scripts/import-scam-db.js --source solrpds
 *   node scripts/import-scam-db.js --source solrugdet
 *   node scripts/import-scam-db.js --source csv data/scam-datasets/custom.csv
 *   node scripts/import-scam-db.js --stats
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data/scam-datasets');

// Lazy load db — pouze pokud běží z CLI
const db = require('../db');

// ── CSV parser (bez externích závislostí) ─────────────────────────────────────

function parseCsv(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
  });
}

// ── Importery pro konkrétní formáty ──────────────────────────────────────────

function importSolRPDS(filePath) {
  // SolRPDS CSV formát: LIQUIDITY_POOL_ADDRESS, MINT, TOTAL_ADDED_LIQUIDITY,
  // TOTAL_REMOVED_LIQUIDITY, NUM_LIQUIDITY_ADDS, NUM_LIQUIDITY_REMOVES,
  // ADD_TO_REMOVE_RATIO, LAST_POOL_ACTIVITY_TIMESTAMP, FIRST_POOL_ACTIVITY_TIMESTAMP,
  // LAST_SWAP_TIMESTAMP, LAST_SWAP_TX_ID, INACTIVITY_STATUS
  //
  // Importujeme VŠECHNY řádky (aktivní i neaktivní):
  //   Inactive → confidence 0.90, rug_pattern 'inactive_pool' (potvrzený rug pull)
  //   Active   → confidence 0.50, rug_pattern dle poměru removed/added
  //
  // Tvůrce (creator) v SolRPDS není — pole creator zůstane NULL.

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines   = content.split('\n').filter(l => l.trim());
  if (!lines.length) return { imported: 0, skipped: 0 };

  const headers      = lines[0].split(',');
  const mintIdx      = headers.indexOf('MINT');
  const statusIdx    = headers.indexOf('INACTIVITY_STATUS');
  const addedIdx     = headers.indexOf('TOTAL_ADDED_LIQUIDITY');
  const removedIdx   = headers.indexOf('TOTAL_REMOVED_LIQUIDITY');
  const firstTsIdx   = headers.indexOf('FIRST_POOL_ACTIVITY_TIMESTAMP');

  // Fallback: pokud CSV nemá MINT sloupec, zkus generický parser
  if (mintIdx === -1) {
    const rows = parseCsv(content);
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const mint = row.mint || row.MINT || row.token_address || row.address;
      if (!mint || mint.length < 32 || mint.length > 44) { skipped++; continue; }
      db.upsertKnownScam({
        mint, source: 'solrpds', scam_type: 'rug_pull', confidence: 0.75,
        label: 'SolRPDS dataset', raw_data: null,
      });
      imported++;
    }
    return { imported, skipped };
  }

  let imported = 0, skipped = 0;
  const seen = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cols   = lines[i].split(',');
    const mint   = (cols[mintIdx]   || '').trim();
    if (!mint || mint.length < 32 || mint.length > 44) { skipped++; continue; }
    if (seen.has(mint)) { skipped++; continue; }
    seen.add(mint);

    const status     = statusIdx    !== -1 ? (cols[statusIdx]    || '').trim() : '';
    const added      = addedIdx     !== -1 ? parseFloat(cols[addedIdx]    || '0') : 0;
    const removed    = removedIdx   !== -1 ? parseFloat(cols[removedIdx]  || '0') : 0;
    const firstTsRaw = firstTsIdx   !== -1 ? (cols[firstTsIdx]   || '').trim() : '';

    // Normalize timestamp (CSV má formát "2023-12-30 22:24:29.000")
    const first_seen_at = firstTsRaw ? firstTsRaw.replace(' ', 'T').replace(/\.000$/, 'Z') : null;

    // Odvodit rug_pattern z dostupných dat
    let rug_pattern;
    if (status === 'Inactive') {
      rug_pattern = 'inactive_pool';
    } else if (removed > added * 1.2) {
      rug_pattern = 'liquidity_drain';
    } else {
      rug_pattern = 'active_suspicious';
    }

    // Confidence: vyšší pro potvrzené Inactive rugy
    const confidence = status === 'Inactive' ? 0.90 : 0.50;
    const label = status === 'Inactive'
      ? 'SolRPDS: inactive liquidity pool (rug pull pattern)'
      : `SolRPDS: active pool (suspicious — rug_pattern: ${rug_pattern})`;

    db.upsertKnownScam({
      mint,
      source:     'solrpds',
      scam_type:  'rug_pull',
      confidence,
      label,
      raw_data:   null,
      creator:    null,
      first_seen_at,
      first_seen_slot: null,
      rug_pattern,
      confidence_score: confidence,
    });
    imported++;
  }
  return { imported, skipped };
}

function importSolRugDetector(filePath) {
  // SolRugDetector (arxiv 2603.24625) — dataset nebyl veřejně publikován k 2026-04-13.
  // Tento importer podporuje očekávaný formát datasetu (CSV nebo JSON) se sloupci:
  //   mint / address / token   — mint adresa tokenu (povinné)
  //   creator / deployer       — wallet adresa tvůrce (klíčové pro guilt-by-association)
  //   type / scam_type         — typ podvodu (rug_pull, honeypot, atd.)
  //   confidence               — míra jistoty (0.0 – 1.0)
  //   name / symbol            — název / symbol tokenu
  //   first_seen_at / date     — datum první detekce
  //   rug_pattern              — vzor podvodu
  const content = fs.readFileSync(filePath, 'utf-8');
  let rows;

  if (filePath.endsWith('.json')) {
    const data = JSON.parse(content);
    rows = Array.isArray(data) ? data : data.tokens || [];
  } else {
    rows = parseCsv(content);
  }

  // Validace Solana adresy (base58, 32–44 znaků)
  function isValidSolanaAddr(addr) {
    return addr && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  }

  let imported  = 0;
  let skipped   = 0;
  let withCreator = 0;

  for (const row of rows) {
    const mint = row.mint || row.address || row.token;
    if (!isValidSolanaAddr(mint)) { skipped++; continue; }

    // Creator/deployer wallet — klíčové pole pro guilt-by-association
    const creator = row.creator || row.deployer || row.deploy_wallet || null;

    // Normalizuj timestamp
    const firstSeenRaw = row.first_seen_at || row.date || row.created_at || null;
    const first_seen_at = firstSeenRaw
      ? firstSeenRaw.replace(' ', 'T').replace(/\.000$/, 'Z')
      : null;

    db.upsertKnownScam({
      mint,
      source:           'solrugdetector',
      scam_type:        row.type || row.scam_type || 'rug_pull',
      confidence:       parseFloat(row.confidence || '1.0') || 1.0,
      label:            row.name || row.symbol || null,
      raw_data:         row,
      creator:          isValidSolanaAddr(creator) ? creator : null,
      first_seen_at,
      first_seen_slot:  row.slot ? parseInt(row.slot, 10) : null,
      rug_pattern:      row.rug_pattern || row.pattern || null,
      confidence_score: parseFloat(row.confidence || '1.0') || 1.0,
    });
    imported++;
    if (creator && isValidSolanaAddr(creator)) withCreator++;
  }

  console.log(`  SolRugDetector: ${imported} tokenů, z toho ${withCreator} má creator wallet`);
  return { imported, skipped, withCreator };
}

function importGenericCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows    = parseCsv(content);
  let imported  = 0;
  let skipped   = 0;

  for (const row of rows) {
    const mint = row.mint || row.address;
    if (!mint || mint.length < 32 || mint.length > 44) { skipped++; continue; }

    db.upsertKnownScam({
      mint,
      source:     'manual',
      scam_type:  row.scam_type || row.type || null,
      confidence: parseFloat(row.confidence || '1.0') || 1.0,
      label:      row.label || row.name || null,
      raw_data:   row,
    });
    imported++;
  }
  return { imported, skipped };
}

// ── Main CLI ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const source = args[0] === '--source' ? args[1] : null;
const doStats = args[0] === '--stats';

if (doStats) {
  const count = db.getKnownScamsCount();
  console.log(`known_scams tabulka: ${count} tokenů`);
  process.exit(0);
}

if (!source) {
  console.error('Použití: node scripts/import-scam-db.js --source <solrpds|solrugdet|csv> [file]');
  console.error('         node scripts/import-scam-db.js --stats');
  process.exit(1);
}

// Inicializuj schéma (tabulky musí existovat)
db.initSchema().then(() => {
  let result;
  try {
    if (source === 'solrpds') {
      // Podporujeme multi-file formát (solrpds_2021.csv...solrpds_2024.csv)
      // nebo jednoduchý solrpds.csv
      const specificFile = args[2];
      const multiFiles = ['2021','2022','2023','2024']
        .map(y => path.join(DATA_DIR, `solrpds_${y}.csv`))
        .filter(f => fs.existsSync(f));
      const singleFile = path.join(DATA_DIR, 'solrpds.csv');

      const filesToImport = specificFile ? [specificFile]
        : multiFiles.length ? multiFiles
        : fs.existsSync(singleFile) ? [singleFile] : [];

      if (!filesToImport.length) {
        console.error('Žádný SolRPDS soubor nenalezen v data/scam-datasets/');
        console.error('Stáhněte dataset z: https://github.com/DeFiLabX/SolRPDS');
        process.exit(1);
      }

      let totalImported = 0, totalSkipped = 0;
      for (const file of filesToImport) {
        console.log(`Importuji: ${path.basename(file)}`);
        const r = importSolRPDS(file);
        totalImported += r.imported;
        totalSkipped  += r.skipped;
      }
      result = { imported: totalImported, skipped: totalSkipped };

    } else if (source === 'solrugdet') {
      // SolRugDetector dataset (2603.24625) - zatím není veřejně k dispozici
      // Paper: Jiaxin Chen et al., arxiv.org/abs/2603.24625 (Mar 2026)
      // Jakmile bude dataset publikován, stáhněte ho a spusťte tento příkaz
      const defaultFile = args[2] || path.join(DATA_DIR, 'solrugdetector.csv');
      if (!fs.existsSync(defaultFile)) {
        console.error(`Soubor nenalezen: ${defaultFile}`);
        console.error('SolRugDetector dataset není zatím veřejně dostupný (paper: arxiv.org/abs/2603.24625)');
        console.error('Sledujte: https://github.com/DeFiLabX/ nebo autoři: ziguijiang, jiaxin-chen (GitHub)');
        process.exit(1);
      }
      console.log(`Importuji SolRugDetector z: ${defaultFile}`);
      result = importSolRugDetector(defaultFile);

    } else if (source === 'csv') {
      const file = args[2];
      if (!file || !fs.existsSync(file)) {
        console.error('Zadejte platný CSV soubor jako třetí argument');
        process.exit(1);
      }
      console.log(`Importuji CSV z: ${file}`);
      result = importGenericCsv(file);

    } else {
      console.error(`Neznámý zdroj: ${source}. Povolené hodnoty: solrpds, solrugdet, csv`);
      process.exit(1);
    }

    console.log(`Import dokončen: ${result.imported} přidáno, ${result.skipped} přeskočeno`);
    console.log(`Celkem v databázi: ${db.getKnownScamsCount()} tokenů`);

    // Přepočítej scam_creators tabulku po každém importu
    console.log('Přepočítávám scam_creators...');
    const creatorCount = db.rebuildScamCreators();
    console.log(`scam_creators: ${creatorCount} unikátních tvůrců`);

    process.exit(0);
  } catch (e) {
    console.error('Import selhal:', e.message);
    process.exit(1);
  }
}).catch(e => {
  console.error('DB init selhal:', e.message);
  process.exit(1);
});
