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
  // SolRPDS CSV formát: LIQUIDITY_POOL_ADDRESS, MINT, ..., INACTIVITY_STATUS
  // Importujeme pouze tokeny s INACTIVITY_STATUS = "Inactive" (rug pull pattern)
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines   = content.split('\n').filter(l => l.trim());
  if (!lines.length) return { imported: 0, skipped: 0 };

  const headers   = lines[0].split(',');
  const mintIdx   = headers.indexOf('MINT');
  const statusIdx = headers.indexOf('INACTIVITY_STATUS');

  // Fallback: pokud CSV nemá tyto sloupce, zkus generický parser
  if (mintIdx === -1) {
    const rows = parseCsv(content);
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const mint = row.mint || row.MINT || row.token_address || row.address;
      if (!mint || mint.length < 32 || mint.length > 44) { skipped++; continue; }
      db.upsertKnownScam({ mint, source: 'solrpds', scam_type: 'rug_pull', confidence: 0.85,
        label: 'SolRPDS dataset', raw_data: null });
      imported++;
    }
    return { imported, skipped };
  }

  let imported = 0, skipped = 0;
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const cols   = lines[i].split(',');
    const mint   = (cols[mintIdx]   || '').trim();
    const status = (cols[statusIdx] || '').trim();
    if (!mint || mint.length < 32 || mint.length > 44) { skipped++; continue; }
    if (statusIdx !== -1 && status !== 'Inactive') { skipped++; continue; }
    if (seen.has(mint)) { skipped++; continue; }
    seen.add(mint);
    db.upsertKnownScam({
      mint, source: 'solrpds', scam_type: 'rug_pull', confidence: 0.85,
      label: 'SolRPDS: inactive liquidity pool (rug pull pattern)', raw_data: null,
    });
    imported++;
  }
  return { imported, skipped };
}

function importSolRugDetector(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let rows;

  if (filePath.endsWith('.json')) {
    const data = JSON.parse(content);
    rows = Array.isArray(data) ? data : data.tokens || [];
  } else {
    rows = parseCsv(content);
  }

  let imported = 0;
  let skipped  = 0;
  for (const row of rows) {
    const mint = row.mint || row.address || row.token;
    if (!mint || mint.length < 32 || mint.length > 44) { skipped++; continue; }

    db.upsertKnownScam({
      mint,
      source:     'solrugdetector',
      scam_type:  row.type || row.scam_type || 'rug_pull',
      confidence: parseFloat(row.confidence || '1.0') || 1.0,
      label:      row.name || row.symbol || null,
      raw_data:   row,
    });
    imported++;
  }
  return { imported, skipped };
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
    process.exit(0);
  } catch (e) {
    console.error('Import selhal:', e.message);
    process.exit(1);
  }
}).catch(e => {
  console.error('DB init selhal:', e.message);
  process.exit(1);
});
