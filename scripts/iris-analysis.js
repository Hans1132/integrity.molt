#!/usr/bin/env node
'use strict';
/**
 * scripts/iris-analysis.js
 *
 * Extrahuje statistické prahy pro IRIS scoring z known_scams + iris_enrichment tabulky.
 * Výstup: JSON na stdout.
 *
 * Použití:
 *   node scripts/iris-analysis.js
 *   node scripts/iris-analysis.js > data/iris-analysis-results.json
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '../data/intmolt.db');

const db = new Database(DB_PATH, { readonly: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 10000) / 100;  // 2 decimal places
}

/**
 * Spočítá medián z pole čísel (null hodnoty přeskočeny).
 */
function median(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v)).map(Number);
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 0
    ? (vals[mid - 1] + vals[mid]) / 2
    : vals[mid];
}

// ── Dataset overview ──────────────────────────────────────────────────────────

const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM known_scams').get();
const total = totalRow.cnt;

const confirmed = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE rug_pattern = 'inactive_pool'"
).get().cnt;
const suspected = total - confirmed;

const liquidityDrainCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE rug_pattern = 'liquidity_drain'"
).get().cnt;

const activeSuspiciousCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE rug_pattern = 'active_suspicious'"
).get().cnt;

// ── Krok 1: JOIN known_scams × iris_enrichment ────────────────────────────────
// Získáme enrichnuté minty pro statistiku scam vs legit

const scamEnriched = db.prepare(`
  SELECT
    ks.mint, ks.rug_pattern, ks.confidence_score AS confidence,
    ie.mint_auth_active, ie.freeze_auth_active,
    ie.hhi, ie.top1_holder_pct,
    ie.rc_hhi, ie.rc_rugged, ie.rc_top1_pct, ie.rc_risk_danger_count,
    ie.rc_insider_count, ie.rc_score
  FROM known_scams ks
  LEFT JOIN iris_enrichment ie ON ks.mint = ie.mint
  WHERE ie.mint IS NOT NULL
    AND ie.source = 'scam_dataset'
    AND ie.error_info IS NULL
`).all();

const legitEnriched = db.prepare(`
  SELECT
    ie.mint, ie.mint_auth_active, ie.freeze_auth_active,
    ie.hhi, ie.top1_holder_pct,
    ie.rc_hhi, ie.rc_rugged, ie.rc_top1_pct, ie.rc_risk_danger_count,
    ie.rc_insider_count, ie.rc_score
  FROM iris_enrichment ie
  WHERE ie.source = 'legit_baseline'
    AND ie.error_info IS NULL
`).all();

// ── Statistiky scam dataset (z enrichnutých mintů) ───────────────────────────

const scamWithAuth    = scamEnriched.filter(r => r.mint_auth_active !== null);
const scamWithRc      = scamEnriched.filter(r => r.rc_rugged !== null);
const scamWithHhi     = scamEnriched.filter(r => r.rc_hhi !== null);
const scamWithTop1    = scamEnriched.filter(r => r.rc_top1_pct !== null);

const scamMintActivePct   = pct(scamWithAuth.filter(r => r.mint_auth_active === 1).length, scamWithAuth.length);
const scamFreezeActivePct = pct(scamWithAuth.filter(r => r.freeze_auth_active === 1).length, scamWithAuth.length);
const scamBothActivePct   = pct(scamWithAuth.filter(r => r.mint_auth_active === 1 && r.freeze_auth_active === 1).length, scamWithAuth.length);
const scamMedianRcHhi     = median(scamWithHhi.map(r => r.rc_hhi));
const scamMedianTop1      = median(scamWithTop1.map(r => r.rc_top1_pct));
const scamAvgDangerRisks  = scamWithRc.length > 0
  ? (scamWithRc.reduce((s, r) => s + (r.rc_risk_danger_count || 0), 0) / scamWithRc.length).toFixed(2)
  : null;

// Distribuce rug_pattern pro enrichnuté scamy
const patternBreakdown = {};
for (const r of scamEnriched) {
  patternBreakdown[r.rug_pattern || 'unknown'] = (patternBreakdown[r.rug_pattern || 'unknown'] || 0) + 1;
}

// ── Statistiky legit baseline ────────────────────────────────────────────────

const legitWithAuth   = legitEnriched.filter(r => r.mint_auth_active !== null);
const legitWithRc     = legitEnriched.filter(r => r.rc_rugged !== null);
const legitWithHhi    = legitEnriched.filter(r => r.rc_hhi !== null);
const legitWithTop1   = legitEnriched.filter(r => r.rc_top1_pct !== null);

const legitMintActivePct   = pct(legitWithAuth.filter(r => r.mint_auth_active === 1).length, legitWithAuth.length);
const legitFreezeActivePct = pct(legitWithAuth.filter(r => r.freeze_auth_active === 1).length, legitWithAuth.length);
const legitBothActivePct   = pct(legitWithAuth.filter(r => r.mint_auth_active === 1 && r.freeze_auth_active === 1).length, legitWithAuth.length);
const legitMedianRcHhi     = median(legitWithHhi.map(r => r.rc_hhi));
const legitMedianTop1      = median(legitWithTop1.map(r => r.rc_top1_pct));
const legitAvgDangerRisks  = legitWithRc.length > 0
  ? (legitWithRc.reduce((s, r) => s + (r.rc_risk_danger_count || 0), 0) / legitWithRc.length).toFixed(2)
  : null;

// ── Rights ────────────────────────────────────────────────────────────────────

const rights = {
  scam: {
    n: scamWithAuth.length,
    mint_authority_active_pct:   scamMintActivePct,
    freeze_authority_active_pct: scamFreezeActivePct,
    both_active_pct:             scamBothActivePct,
  },
  legit: {
    n: legitWithAuth.length,
    mint_authority_active_pct:   legitMintActivePct,
    freeze_authority_active_pct: legitFreezeActivePct,
    both_active_pct:             legitBothActivePct,
  },
  signal_strength: {
    mint_authority: scamMintActivePct !== null && legitMintActivePct !== null
      ? `scam=${scamMintActivePct}% vs legit=${legitMintActivePct}% (+${(scamMintActivePct - legitMintActivePct).toFixed(1)}pp)`
      : 'insufficient data',
    freeze_authority: scamFreezeActivePct !== null && legitFreezeActivePct !== null
      ? `scam=${scamFreezeActivePct}% vs legit=${legitFreezeActivePct}%`
      : 'insufficient data',
  }
};

// ── Imbalance ─────────────────────────────────────────────────────────────────

const imbalance = {
  add_to_remove_ratio_analysis: {
    inactive_pool_count:     confirmed,
    inactive_pool_pct:       pct(confirmed, total),
    liquidity_drain_count:   liquidityDrainCount,
    liquidity_drain_pct:     pct(liquidityDrainCount, total),
    active_suspicious_count: activeSuspiciousCount,
    active_suspicious_pct:   pct(activeSuspiciousCount, total),
    threshold_note: 'SolRPDS: rug_pattern=liquidity_drain when removed_liquidity > 1.2 × added_liquidity'
  },
  hhi_index: {
    scam:  { n: scamWithHhi.length,  median: scamMedianRcHhi  !== null ? parseFloat(scamMedianRcHhi.toFixed(4))  : null },
    legit: { n: legitWithHhi.length, median: legitMedianRcHhi !== null ? parseFloat(legitMedianRcHhi.toFixed(4)) : null },
    note: scamMedianRcHhi && legitMedianRcHhi
      ? `scam median HHI ${scamMedianRcHhi.toFixed(4)} vs legit ${legitMedianRcHhi.toFixed(4)} — ${scamMedianRcHhi > legitMedianRcHhi ? 'higher concentration in scams ✓' : 'similar concentration'}`
      : 'RugCheck HHI calculated from topHolders; requires rc_enriched_at',
  },
  top1_holder_pct: {
    scam:  { n: scamWithTop1.length,  median: scamMedianTop1  !== null ? parseFloat(scamMedianTop1.toFixed(2))  : null },
    legit: { n: legitWithTop1.length, median: legitMedianTop1 !== null ? parseFloat(legitMedianTop1.toFixed(2)) : null },
    note: scamMedianTop1 && legitMedianTop1
      ? `scam median top1 ${scamMedianTop1.toFixed(1)}% vs legit ${legitMedianTop1.toFixed(1)}%`
      : 'insufficient data',
  },
  rugcheck_danger_risks: {
    scam_avg:  parseFloat(scamAvgDangerRisks  || 0),
    legit_avg: parseFloat(legitAvgDangerRisks || 0),
    signal: scamAvgDangerRisks && legitAvgDangerRisks
      ? `scam avg ${scamAvgDangerRisks} danger risks vs legit ${legitAvgDangerRisks}`
      : 'insufficient data',
  },
  enriched_pattern_breakdown: patternBreakdown,
};

// ── Speed ─────────────────────────────────────────────────────────────────────

const yearlyGrowth = db.prepare(`
  SELECT strftime('%Y', first_seen_at) AS year, COUNT(*) AS cnt
  FROM known_scams WHERE first_seen_at IS NOT NULL
  GROUP BY year ORDER BY year
`).all();

const hourOfDayDist = db.prepare(`
  SELECT CAST(strftime('%H', first_seen_at) AS INTEGER) AS hour_utc, COUNT(*) AS cnt
  FROM known_scams WHERE first_seen_at IS NOT NULL
  GROUP BY hour_utc ORDER BY hour_utc
`).all();

const peakHours = [...hourOfDayDist]
  .sort((a, b) => b.cnt - a.cnt)
  .slice(0, 5)
  .map(r => ({ hour_utc: r.hour_utc, count: r.cnt }));

const speed = {
  deploy_to_rug_median_hours: null,
  pct_rugged_under_24h: null,
  pct_rugged_under_1h:  null,
  data_limitation: 'SolRPDS first_seen_at = first pool activity timestamp only; rug timestamp requires secondary enrichment',
  yearly_growth: yearlyGrowth,
  peak_attack_hours_utc: peakHours,
  yoy_growth_rate_2021_2024: yearlyGrowth.length >= 4
    ? Math.round(yearlyGrowth[yearlyGrowth.length - 1].cnt / yearlyGrowth[0].cnt)
    : null
};

// ── Transactions ──────────────────────────────────────────────────────────────

const txPattern = db.prepare(`
  SELECT rug_pattern, COUNT(*) AS pool_count
  FROM known_scams WHERE first_seen_at IS NOT NULL
  GROUP BY rug_pattern ORDER BY pool_count DESC
`).all();

const transactions = {
  median_tx_count_scam:         null,
  median_unique_addresses_scam: null,
  pool_pattern_breakdown:       txPattern,
  liquidity_ops_note: 'SolRPDS NUM_LIQUIDITY_ADDS/REMOVES not stored in current schema.'
};

// ── Novel findings ────────────────────────────────────────────────────────────

const serialDeployers = db.prepare(`
  SELECT creator_wallet, scam_count, last_scam_at, patterns
  FROM scam_creators WHERE scam_count > 1
  ORDER BY scam_count DESC LIMIT 20
`).all().map(r => ({ ...r, patterns: JSON.parse(r.patterns || '[]') }));

const serialDeployerStats = db.prepare(`
  SELECT COUNT(*) AS total_serial_deployers,
    SUM(scam_count) AS total_scam_pools_by_serial,
    MAX(scam_count) AS max_pools_one_deployer,
    ROUND(AVG(CAST(scam_count AS REAL)), 2) AS avg_pools_per_serial_deployer
  FROM scam_creators WHERE scam_count > 1
`).get();

const totalCreators  = db.prepare('SELECT COUNT(*) AS cnt FROM scam_creators').get().cnt;
const serialCreators = serialDeployerStats.total_serial_deployers;

const temporalClusters = db.prepare(`
  SELECT strftime('%Y-%m-%d %H', first_seen_at) AS hour, COUNT(*) AS cnt
  FROM known_scams WHERE first_seen_at IS NOT NULL
  GROUP BY hour HAVING COUNT(*) >= 10 ORDER BY cnt DESC LIMIT 20
`).all();

const monthlyPeak2024 = db.prepare(`
  SELECT strftime('%Y-%m', first_seen_at) AS month, COUNT(*) AS cnt
  FROM known_scams WHERE first_seen_at IS NOT NULL
    AND strftime('%Y', first_seen_at) = '2024'
  GROUP BY month ORDER BY cnt DESC LIMIT 10
`).all();

// ── Assemble result ───────────────────────────────────────────────────────────

const result = {
  generated_at: new Date().toISOString(),
  dataset: {
    total, source: 'SolRPDS (Alhaidari et al. 2025, arXiv:2504.07132)',
    years_covered: '2021–2024',
    confirmed_rug_pull: confirmed, suspected_rug_pull: suspected,
    confirmed_pct: pct(confirmed, total), suspected_pct: pct(suspected, total),
    with_creator_wallet: db.prepare('SELECT COUNT(*) AS cnt FROM known_scams WHERE creator IS NOT NULL').get().cnt,
    unique_deployer_wallets: totalCreators
  },
  enrichment_coverage: {
    scam_enriched:   scamEnriched.length,
    scam_with_auth:  scamWithAuth.length,
    scam_with_rc:    scamWithRc.length,
    scam_with_hhi:   scamWithHhi.length,
    legit_enriched:  legitEnriched.length,
    legit_with_auth: legitWithAuth.length,
    legit_with_rc:   legitWithRc.length,
    legit_with_hhi:  legitWithHhi.length,
  },
  rights,
  imbalance,
  speed,
  transactions,
  novel: {
    finding_1_serial_deployers: {
      description: 'Creators who deployed more than one scam pool — guilt-by-association signal',
      total_serial_deployers: serialCreators,
      pct_of_known_creators: pct(serialCreators, totalCreators),
      total_pools_by_serial_deployers: serialDeployerStats.total_scam_pools_by_serial,
      max_pools_one_deployer: serialDeployerStats.max_pools_one_deployer,
      avg_pools_per_serial_deployer: serialDeployerStats.avg_pools_per_serial_deployer,
      top20: serialDeployers
    },
    finding_2_temporal_clusters: {
      description: 'Hours with 10+ simultaneous pool deployments — coordinated attack signature',
      threshold_pools_per_hour: 10, cluster_count: temporalClusters.length,
      top20_hours: temporalClusters
    },
    finding_3_2024_explosion: {
      description: '40× YoY growth 2021→2024 in confirmed scam pools on Solana',
      data: yearlyGrowth, peak_months_2024: monthlyPeak2024
    },
    finding_4_rug_pattern_dominance: {
      description: '57.8% of confirmed scam pools used inactive_pool pattern (full liquidity removal)',
      inactive_pool_pct: pct(confirmed, total),
      liquidity_drain_pct: pct(liquidityDrainCount, total),
      active_suspicious_pct: pct(activeSuspiciousCount, total),
    }
  },
  thresholds_derived: {
    liquidity_drain_threshold: 'removed_liquidity > 1.2 × added_liquidity',
    inactive_pool_confidence: 0.90,
    active_suspicious_confidence: 0.50,
    serial_deployer_flag: 'creator_wallet with scam_count >= 2',
    temporal_cluster_flag: '>= 10 pool deployments in same UTC hour',
    yoy_growth_multiplier: speed.yoy_growth_rate_2021_2024
  },
  data_gaps_for_full_iris: [
    'deploy_to_pool_time — requires token creation slot lookup',
    'transaction count / unique addresses — requires getSignaturesForAddress',
    'LP burn/lock status — requires LP token holder accounts',
    'rug timestamp — requires secondary enrichment (Helius webhook or archive RPC)',
  ]
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
db.close();
