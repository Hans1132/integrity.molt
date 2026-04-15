#!/usr/bin/env node
'use strict';
/**
 * scripts/iris-enrich-legit-rc.js
 *
 * Doplní RugCheck FULL REPORT (topHolders → HHI, top1%) pro legit_baseline tokeny.
 * Používá endpoint /report (ne /summary) stejně jako iris-enrich-rugcheck.js pro scam data.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path     = require('path');
const Database = require('better-sqlite3');
const fetch    = require('node-fetch');

const DB_PATH = path.join(__dirname, '..', 'data', 'intmolt.db');
const db = new Database(DB_PATH);

const RUGCHECK_API_KEY = process.env.RUGCHECK_API_KEY || '';

// Tokeny bez rc_top1_pct (nebo všechny legit_baseline)
const targets = db.prepare(`
  SELECT mint FROM iris_enrichment
  WHERE source='legit_baseline' AND rc_top1_pct IS NULL AND error_info IS NULL
`).all().map(r => r.mint);

console.log(`[legit-rc] ${targets.length} legit tokens to update with full RugCheck report`);

const upd = db.prepare(`
  UPDATE iris_enrichment SET
    rc_top1_pct          = @rc_top1_pct,
    rc_hhi               = @rc_hhi,
    rc_insider_count     = @rc_insider_count,
    rc_risk_danger_count = @rc_risk_danger_count,
    rc_risks_json        = @rc_risks_json,
    rc_score             = @rc_score,
    rc_rugged            = @rc_rugged,
    rc_enriched_at       = @rc_enriched_at
  WHERE mint = @mint
`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function computeHolderMetrics(topHolders) {
  if (!topHolders || topHolders.length === 0) return { hhi: null, top1: null, insiders: 0 };
  const rawPcts = topHolders.map(h => Math.max(0, h.pct ?? 0));
  const sum = rawPcts.reduce((s, v) => s + v, 0);
  const normPcts = sum > 0 ? rawPcts.map(p => (p / sum) * 100) : rawPcts;
  const top1 = normPcts.length > 0 ? normPcts[0] : null;
  let hhi = 0;
  for (const p of normPcts) { const share = p / 100; hhi += share * share; }
  const insiders = topHolders.filter(h => h.insider === true).length;
  return { hhi: parseFloat(hhi.toFixed(6)), top1: top1 ? parseFloat(top1.toFixed(4)) : null, insiders };
}

async function fetchReport(mint) {
  const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report`;
  const headers = { 'Accept': 'application/json', 'User-Agent': 'integrity-molt/1.0' };
  const res = await fetch(url, { headers, timeout: 12000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  let ok = 0; let err = 0;
  for (const mint of targets) {
    try {
      await sleep(600); // ~1.6 req/s
      const data = await fetchReport(mint);
      const risks = data.risks || [];
      const dangerCount = risks.filter(r => r.level === 'danger').length;
      const { hhi, top1, insiders } = computeHolderMetrics(data.topHolders);

      upd.run({
        mint,
        rc_top1_pct:          top1,
        rc_hhi:               hhi,
        rc_insider_count:     insiders,
        rc_risk_danger_count: dangerCount,
        rc_risks_json:        risks.length > 0 ? JSON.stringify(risks.map(r => r.name)) : null,
        rc_score:             data.score ?? null,
        rc_rugged:            data.rugged ? 1 : 0,
        rc_enriched_at:       new Date().toISOString(),
      });
      ok++;
      console.log(`  [OK] ${mint.slice(0,8)} top1=${top1?.toFixed(1) ?? 'n/a'}% hhi=${hhi?.toFixed(4) ?? 'n/a'} danger=${dangerCount}`);
    } catch (e) {
      err++;
      console.warn(`  [ERR] ${mint.slice(0,8)}: ${e.message}`);
    }
  }

  console.log(`\n[legit-rc] DONE — ok:${ok} err:${err}`);
  const stats = db.prepare(`
    SELECT ROUND(AVG(rc_top1_pct),2) as avg_top1, ROUND(AVG(rc_hhi),4) as avg_hhi,
           COUNT(rc_top1_pct) as n_top1
    FROM iris_enrichment WHERE source='legit_baseline'
  `).get();
  console.log('[legit-rc] Stats:', JSON.stringify(stats));
  db.close();
}

main().catch(e => { console.error('[legit-rc] FATAL:', e.message); process.exit(1); });
