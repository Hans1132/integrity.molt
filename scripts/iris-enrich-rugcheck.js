#!/usr/bin/env node
/**
 * IRIS Enrichment — RugCheck API
 *
 * Pro každý mint z known_scams (creator IS NOT NULL) volá:
 *   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report
 *
 * Extrahuje:
 *   - topHolders → HHI, top1_pct, top10_pct, insider_count
 *   - risks      → danger count, total score, raw JSON
 *   - score      → RugCheck normalized score
 *   - rugged     → boolean flag
 *   - totalHolders, totalMarketLiquidity
 *
 * Ukládá do sloupců rc_* v tabulce iris_enrichment.
 * Rate limit: max 2 req/s. Timeout: 5s. Skip on failure.
 */

'use strict';

const Database = require('better-sqlite3');
const fetch    = require('node-fetch');
const path     = require('path');

const DB_PATH      = path.join(__dirname, '..', 'data', 'intmolt.db');
const RUGCHECK_URL = 'https://api.rugcheck.xyz/v1/tokens';
const MAX_RPS      = 2;
const DELAY_MS     = Math.ceil(1000 / MAX_RPS); // 500 ms mezi voláními
const TIMEOUT_MS   = 5000;

// ─── DB setup ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

const upsert = db.prepare(`
  UPDATE iris_enrichment SET
    rc_score            = @rc_score,
    rc_rugged           = @rc_rugged,
    rc_top1_pct         = @rc_top1_pct,
    rc_top10_pct        = @rc_top10_pct,
    rc_hhi              = @rc_hhi,
    rc_insider_count    = @rc_insider_count,
    rc_total_holders    = @rc_total_holders,
    rc_total_liquidity  = @rc_total_liquidity,
    rc_risk_danger_count = @rc_risk_danger_count,
    rc_risk_score_total = @rc_risk_score_total,
    rc_risks_json       = @rc_risks_json,
    rc_enriched_at      = datetime('now')
  WHERE mint = @mint
`);

// Mints které ještě nemají RC data
const mints = db.prepare(`
  SELECT mint FROM iris_enrichment
  WHERE rc_enriched_at IS NULL
  ORDER BY mint
`).all().map(r => r.mint);

console.error(`[iris-rugcheck] DB: ${DB_PATH}`);
console.error(`[iris-rugcheck] Mints to enrich: ${mints.length}`);
console.error(`[iris-rugcheck] Rate: ${MAX_RPS} req/s · Timeout: ${TIMEOUT_MS}ms`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Spočítá HHI a top holder % z pole { pct } objektů RugChecku.
 * pct je už procentuální hodnota (0–100).
 */
function computeHolderMetrics(topHolders) {
  if (!topHolders || topHolders.length === 0) {
    return { hhi: null, top1: null, top10: null, insiders: 0 };
  }

  // Normalizuj pct — RugCheck občas vrací pct > 100 pro tokeny
  // s nestandardní supply (LP accounts, burned supply atp.)
  // Normalizujeme na součet = 100 aby HHI zůstal v [0,1].
  const rawPcts = topHolders.map(h => Math.max(0, h.pct ?? 0));
  const pctSum  = rawPcts.reduce((s, p) => s + p, 0);
  const normPcts = pctSum > 0
    ? rawPcts.map(p => (p / pctSum) * 100)
    : rawPcts;

  // top1 = největší holder (normalizovaný %)
  const top1 = normPcts.length > 0 ? normPcts[0] : null;

  // top10 = součet prvních 10 normalizovaných %
  const top10 = normPcts.slice(0, 10).reduce((s, p) => s + p, 0);

  // HHI = Σ(share²) kde share = normPct/100 → výsledek vždy v [0,1]
  let hhi = 0;
  for (const p of normPcts) {
    const share = p / 100;
    hhi += share * share;
  }

  // insider count
  const insiders = topHolders.filter(h => h.insider === true).length;

  return {
    hhi:      parseFloat(hhi.toFixed(6)),
    top1:     top1 !== null ? parseFloat(top1.toFixed(4)) : null,
    top10:    parseFloat(top10.toFixed(4)),
    insiders,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const stats = {
  ok: 0,
  skipped: 0,   // error nebo "unable to generate report"
  rugged: 0,
  danger_risks: 0,
};

async function enrichMint(mint) {
  const url = `${RUGCHECK_URL}/${mint}/report`;

  let data;
  try {
    const res = await fetch(url, { timeout: TIMEOUT_MS });
    if (!res.ok) { stats.skipped++; return; }
    data = await res.json();
  } catch (_err) {
    stats.skipped++;
    return;
  }

  // RugCheck vrací {"error":"..."} pro neznámé tokeny
  if (data.error || !data.mint) {
    stats.skipped++;
    return;
  }

  // Holder metrics
  const { hhi, top1, top10, insiders } = computeHolderMetrics(data.topHolders);

  // Risk aggregation
  const risks    = Array.isArray(data.risks) ? data.risks : [];
  const dangers  = risks.filter(r => r.level === 'danger').length;
  const riskSum  = risks.reduce((s, r) => s + (r.score || 0), 0);
  const riskJson = risks.length > 0
    ? JSON.stringify(risks.map(r => ({ name: r.name, level: r.level, score: r.score })))
    : null;

  const row = {
    mint,
    rc_score:             data.score          ?? null,
    rc_rugged:            data.rugged         ? 1 : 0,
    rc_top1_pct:          top1,
    rc_top10_pct:         top10,
    rc_hhi:               hhi,
    rc_insider_count:     insiders,
    rc_total_holders:     data.totalHolders   ?? null,
    rc_total_liquidity:   data.totalMarketLiquidity ?? null,
    rc_risk_danger_count: dangers,
    rc_risk_score_total:  riskSum,
    rc_risks_json:        riskJson,
  };

  upsert.run(row);
  stats.ok++;
  if (data.rugged) stats.rugged++;
  stats.danger_risks += dangers;
}

async function main() {
  const t0    = Date.now();
  const total = mints.length;
  let   done  = 0;

  for (const mint of mints) {
    await sleep(DELAY_MS);
    await enrichMint(mint);
    done++;

    if (done % 50 === 0 || done === total) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const pct     = ((done / total) * 100).toFixed(1);
      console.error(
        `[iris-rugcheck] ${done}/${total} (${pct}%) — ` +
        `ok:${stats.ok} skip:${stats.skipped} — ${elapsed}s`
      );
    }
  }

  // ─── Agregované výsledky ─────────────────────────────────────────

  // Statistiky z DB pro finální report
  const dbStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN rc_enriched_at IS NOT NULL THEN 1 ELSE 0 END) as enriched,
      SUM(CASE WHEN rc_rugged = 1 THEN 1 ELSE 0 END) as rugged,
      AVG(rc_hhi) as avg_hhi,
      AVG(rc_top1_pct) as avg_top1,
      AVG(rc_top10_pct) as avg_top10,
      AVG(rc_risk_danger_count) as avg_dangers,
      AVG(rc_risk_score_total) as avg_risk_score,
      SUM(CASE WHEN rc_hhi > 0.5 THEN 1 ELSE 0 END) as hhi_over_50pct,
      SUM(CASE WHEN rc_top1_pct > 50 THEN 1 ELSE 0 END) as top1_over_50pct,
      SUM(CASE WHEN rc_top10_pct > 80 THEN 1 ELSE 0 END) as top10_over_80pct
    FROM iris_enrichment
    WHERE rc_enriched_at IS NOT NULL
  `).get();

  const enrichedCount = dbStats.enriched || stats.ok;

  const summary = {
    enriched_this_run:  stats.ok,
    skipped_this_run:   stats.skipped,
    total_in_db:        dbStats.total,
    total_enriched:     dbStats.enriched,
    rugged_flag_count:  dbStats.rugged,
    rugged_pct:         enrichedCount > 0
      ? ((dbStats.rugged / enrichedCount) * 100).toFixed(1) : 'n/a',
    holder_metrics: {
      avg_hhi:          dbStats.avg_hhi   ? parseFloat(dbStats.avg_hhi.toFixed(4))   : null,
      avg_top1_pct:     dbStats.avg_top1  ? parseFloat(dbStats.avg_top1.toFixed(2))  : null,
      avg_top10_pct:    dbStats.avg_top10 ? parseFloat(dbStats.avg_top10.toFixed(2)) : null,
      hhi_over_0_5:     dbStats.hhi_over_50pct,
      top1_over_50pct:  dbStats.top1_over_50pct,
      top10_over_80pct: dbStats.top10_over_80pct,
    },
    risk_metrics: {
      avg_danger_risks:   dbStats.avg_dangers
        ? parseFloat(dbStats.avg_dangers.toFixed(2)) : null,
      avg_risk_score_total: dbStats.avg_risk_score
        ? Math.round(dbStats.avg_risk_score) : null,
    },
    elapsed_s: ((Date.now() - t0) / 1000).toFixed(1),
  };

  console.log(JSON.stringify(summary, null, 2));

  console.error('\n[iris-rugcheck] DONE');
  console.error(`  Enriched       : ${stats.ok}`);
  console.error(`  Skipped/errors : ${stats.skipped}`);
  console.error(`  Rugged flag    : ${dbStats.rugged}`);
  console.error(`  Avg HHI        : ${summary.holder_metrics.avg_hhi}`);
  console.error(`  Avg top1 %     : ${summary.holder_metrics.avg_top1_pct}`);
  console.error(`  Avg top10 %    : ${summary.holder_metrics.avg_top10_pct}`);
  console.error(`  HHI > 0.5      : ${dbStats.hhi_over_50pct}`);
  console.error(`  top1 > 50%     : ${dbStats.top1_over_50pct}`);
  console.error(`  top10 > 80%    : ${dbStats.top10_over_80pct}`);
  console.error(`  Elapsed        : ${summary.elapsed_s}s`);

  db.close();
}

main().catch(err => {
  console.error('[iris-rugcheck] FATAL:', err.message);
  process.exit(1);
});
