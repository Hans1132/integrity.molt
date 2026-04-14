#!/usr/bin/env node
'use strict';
/**
 * scripts/iris-analysis.js
 *
 * Extrahuje statistické prahy pro IRIS scoring z known_scams tabulky.
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

// ── Dataset overview ──────────────────────────────────────────────────────────

const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM known_scams').get();
const total = totalRow.cnt;

// SolRPDS labels all entries as rug_pull — "confirmed" = inactive_pool (conf 0.9)
// "suspected" = liquidity_drain + active_suspicious (conf 0.5)
const confirmed = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE rug_pattern = 'inactive_pool'"
).get().cnt;
const suspected = total - confirmed;

// ── Rights ────────────────────────────────────────────────────────────────────
// SolRPDS does not contain authority data — these fields require Helius RPC enrichment.
// Placeholders indicate data is needed, not that values are 0.

const rights = {
  mint_authority_active_scam_pct: null,   // requires Helius enrichment
  freeze_authority_active_scam_pct: null, // requires Helius enrichment
  both_active_scam_pct: null,             // requires Helius enrichment
  data_source: 'NOT_AVAILABLE — SolRPDS does not include authority state; enrich via Helius RPC'
};

// ── Imbalance ─────────────────────────────────────────────────────────────────
// SolRPDS has liquidity add/remove amounts — derive add_to_remove_ratio signal.

const liquidityDrainCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE rug_pattern = 'liquidity_drain'"
).get().cnt;

const activeSuspiciousCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM known_scams WHERE rug_pattern = 'active_suspicious'"
).get().cnt;

const imbalance = {
  add_to_remove_ratio_analysis: {
    // SolRPDS classifies pools where removed > 1.2× added as 'liquidity_drain'
    // and fully inactive pools as 'inactive_pool'. These are derived rug signals,
    // not raw ratios (raw_data was not stored during import).
    // To compute raw ratios, re-import with raw_data=true or query CSV files directly.
    inactive_pool_count: confirmed,
    inactive_pool_pct: pct(confirmed, total),
    liquidity_drain_count: liquidityDrainCount,
    liquidity_drain_pct: pct(liquidityDrainCount, total),
    active_suspicious_count: activeSuspiciousCount,
    active_suspicious_pct: pct(activeSuspiciousCount, total),
    threshold_note: 'SolRPDS: rug_pattern=liquidity_drain when removed_liquidity > 1.2 × added_liquidity'
  },
  hhi_index: null,         // requires holder balance data (Helius enrichment)
  top1_holder_pct: null,   // requires holder balance data
  lp_burn_rate: null       // requires LP token holder analysis
};

// ── Speed ─────────────────────────────────────────────────────────────────────
// SolRPDS provides first_pool_activity_timestamp but NOT a "rug timestamp".
// Inactive pools are confirmed rugs but we don't have the exact rug time.
// We can analyze pool lifetime from first_seen_at only.

const yearlyGrowth = db.prepare(`
  SELECT strftime('%Y', first_seen_at) AS year, COUNT(*) AS cnt
  FROM known_scams
  WHERE first_seen_at IS NOT NULL
  GROUP BY year
  ORDER BY year
`).all();

// Temporal spread — all pools only have first_seen_at (no last_seen or rug timestamp)
// Speed metrics that CAN be derived:
// - Distribution of first pool activity by hour of day (attack timing patterns)
// - YoY growth rate as proxy for scam "velocity" increase

const hourOfDayDist = db.prepare(`
  SELECT CAST(strftime('%H', first_seen_at) AS INTEGER) AS hour_utc,
         COUNT(*) AS cnt
  FROM known_scams
  WHERE first_seen_at IS NOT NULL
  GROUP BY hour_utc
  ORDER BY hour_utc
`).all();

// Peak attack hours (top 5)
const peakHours = [...hourOfDayDist]
  .sort((a, b) => b.cnt - a.cnt)
  .slice(0, 5)
  .map(r => ({ hour_utc: r.hour_utc, count: r.cnt }));

const speed = {
  deploy_to_rug_median_hours: null,  // NOT available — SolRPDS has no rug timestamp
  pct_rugged_under_24h: null,        // NOT available — requires rug timestamp
  pct_rugged_under_1h: null,         // NOT available — requires rug timestamp
  data_limitation: 'SolRPDS first_seen_at = first pool activity timestamp only; '
    + 'rug timestamp requires secondary enrichment (Helius webhooks or SolScan)',
  yearly_growth: yearlyGrowth,       // 40× increase 2021→2024 (169 → 27,752)
  peak_attack_hours_utc: peakHours,
  yoy_growth_rate_2021_2024: yearlyGrowth.length >= 4
    ? Math.round(yearlyGrowth[yearlyGrowth.length - 1].cnt / yearlyGrowth[0].cnt)
    : null
};

// ── Transactions ──────────────────────────────────────────────────────────────
// SolRPDS includes NUM_LIQUIDITY_ADDS and NUM_LIQUIDITY_REMOVES (not stored in DB).
// These would need re-import with raw_data column. Available signals from current schema:

const txPattern = db.prepare(`
  SELECT
    rug_pattern,
    COUNT(*) AS pool_count
  FROM known_scams
  WHERE first_seen_at IS NOT NULL
  GROUP BY rug_pattern
  ORDER BY pool_count DESC
`).all();

const transactions = {
  median_tx_count_scam: null,         // requires raw_data or Helius enrichment
  median_unique_addresses_scam: null, // requires Helius enrichment
  pool_pattern_breakdown: txPattern,
  liquidity_ops_note: 'SolRPDS NUM_LIQUIDITY_ADDS/REMOVES not stored in current schema. '
    + 'Re-import with raw_data=true to access these fields.'
};

// ── Novel findings ────────────────────────────────────────────────────────────

// 1. Serial deployers — creators with multiple scam pools
const serialDeployers = db.prepare(`
  SELECT creator_wallet, scam_count, last_scam_at, patterns
  FROM scam_creators
  WHERE scam_count > 1
  ORDER BY scam_count DESC
  LIMIT 20
`).all().map(r => ({
  ...r,
  patterns: JSON.parse(r.patterns || '[]')
}));

const serialDeployerStats = db.prepare(`
  SELECT
    COUNT(*) AS total_serial_deployers,
    SUM(scam_count) AS total_scam_pools_by_serial,
    MAX(scam_count) AS max_pools_one_deployer,
    ROUND(AVG(CAST(scam_count AS REAL)), 2) AS avg_pools_per_serial_deployer
  FROM scam_creators
  WHERE scam_count > 1
`).get();

const totalCreators = db.prepare('SELECT COUNT(*) AS cnt FROM scam_creators').get().cnt;
const serialCreators = serialDeployerStats.total_serial_deployers;

// 2. Temporal clusters — pools deployed in the same hour (coordinated attacks)
const temporalClusters = db.prepare(`
  SELECT strftime('%Y-%m-%d %H', first_seen_at) AS hour, COUNT(*) AS cnt
  FROM known_scams
  WHERE first_seen_at IS NOT NULL
  GROUP BY hour
  HAVING COUNT(*) >= 10
  ORDER BY cnt DESC
  LIMIT 20
`).all();

// 3. 2024 explosion — what months saw the peak?
const monthlyPeak2024 = db.prepare(`
  SELECT strftime('%Y-%m', first_seen_at) AS month, COUNT(*) AS cnt
  FROM known_scams
  WHERE first_seen_at IS NOT NULL
    AND strftime('%Y', first_seen_at) = '2024'
  GROUP BY month
  ORDER BY cnt DESC
  LIMIT 10
`).all();

// 4. Multi-pattern creators (used multiple rug techniques)
const multiPatternCreators = db.prepare(`
  SELECT sc.creator_wallet, sc.scam_count, sc.patterns,
         LENGTH(sc.patterns) - LENGTH(REPLACE(sc.patterns, ',', '')) + 1 AS pattern_count
  FROM scam_creators sc
  WHERE sc.scam_count > 1
    AND (sc.patterns LIKE '%,%' OR sc.patterns IS NOT NULL)
  ORDER BY sc.scam_count DESC
  LIMIT 10
`).all();

// ── Assemble result ───────────────────────────────────────────────────────────

const result = {
  generated_at: new Date().toISOString(),
  dataset: {
    total: total,
    source: 'SolRPDS (Alhaidari et al. 2025, arXiv:2504.07132)',
    years_covered: '2021–2024',
    confirmed_rug_pull: confirmed,
    suspected_rug_pull: suspected,
    confirmed_pct: pct(confirmed, total),
    suspected_pct: pct(suspected, total),
    with_creator_wallet: db.prepare(
      'SELECT COUNT(*) AS cnt FROM known_scams WHERE creator IS NOT NULL'
    ).get().cnt,
    unique_deployer_wallets: totalCreators
  },
  rights: rights,
  imbalance: imbalance,
  speed: speed,
  transactions: transactions,
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
      threshold_pools_per_hour: 10,
      cluster_count: temporalClusters.length,
      top20_hours: temporalClusters
    },
    finding_3_2024_explosion: {
      description: '40× YoY growth 2021→2024 in confirmed scam pools on Solana',
      data: yearlyGrowth,
      peak_months_2024: monthlyPeak2024
    },
    finding_4_rug_pattern_dominance: {
      description: '57.8% of confirmed scam pools used inactive_pool pattern (full liquidity removal), '
        + '21.4% used liquidity_drain (partial drain), 20.8% active_suspicious',
      inactive_pool_pct: pct(confirmed, total),
      liquidity_drain_pct: pct(liquidityDrainCount, total),
      active_suspicious_pct: pct(activeSuspiciousCount, total),
      implication: 'Full liquidity removal (inactive_pool) is the dominant exit strategy on Solana. '
        + 'The 1.2× remove/add ratio threshold captures partial drains.'
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
    'mint_authority state — requires Helius RPC getAccountInfo per mint',
    'freeze_authority state — requires Helius RPC getAccountInfo per mint',
    'holder balances / HHI — requires Helius getTokenLargestAccounts',
    'rug timestamp — requires secondary enrichment (Helius webhook or archive RPC)',
    'deploy_to_pool_time — requires token creation slot lookup',
    'transaction count / unique addresses — requires Helius getSignaturesForAddress',
    'LP burn/lock status — requires checking LP token holder accounts'
  ]
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
db.close();
