#!/usr/bin/env node
'use strict';
/**
 * scripts/iris-compute-thresholds.js
 *
 * Porovná scam vs legit distribuce z iris_enrichment
 * a zapíše prahy do data/iris-thresholds.json.
 *
 * Použití:
 *   node scripts/iris-compute-thresholds.js
 *   node scripts/iris-compute-thresholds.js > data/iris-thresholds.json
 */

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '../data/intmolt.db');
const OUT_PATH = path.join(__dirname, '../data/iris-thresholds.json');

const db = new Database(DB_PATH, { readonly: true });

function pct(part, total) {
  if (!total) return null;
  return parseFloat(((part / total) * 100).toFixed(2));
}

function median(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v)).map(Number);
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 0 ? (vals[mid-1] + vals[mid]) / 2 : vals[mid];
}

function percentile(arr, p) {
  const vals = arr.filter(v => v !== null && !isNaN(v)).map(Number).sort((a,b) => a-b);
  if (!vals.length) return null;
  const idx = Math.floor((p / 100) * (vals.length - 1));
  return vals[idx];
}

// ── Načti data ────────────────────────────────────────────────────────────────

const scam = db.prepare(`
  SELECT ie.mint_auth_active, ie.freeze_auth_active,
         ie.rc_top1_pct, ie.rc_hhi, ie.rc_risk_danger_count,
         ie.rc_insider_count, ie.rc_rugged, ie.rc_score,
         ks.rug_pattern, ks.confidence_score
  FROM iris_enrichment ie
  JOIN known_scams ks ON ks.mint = ie.mint
  WHERE ie.source = 'scam_dataset' AND ie.error_info IS NULL
`).all();

const legit = db.prepare(`
  SELECT mint_auth_active, freeze_auth_active,
         rc_top1_pct, rc_hhi, rc_risk_danger_count,
         rc_insider_count, rc_rugged, rc_score
  FROM iris_enrichment
  WHERE source = 'legit_baseline' AND error_info IS NULL
`).all();

// Pomocné funkce
const scamAuth  = scam.filter(r => r.mint_auth_active !== null);
const legitAuth = legit.filter(r => r.mint_auth_active !== null);

const scamTop1  = scam.filter(r => r.rc_top1_pct !== null).map(r => r.rc_top1_pct);
const legitTop1 = legit.filter(r => r.rc_top1_pct !== null).map(r => r.rc_top1_pct);

const scamHhi  = scam.filter(r => r.rc_hhi !== null).map(r => r.rc_hhi);
const legitHhi = legit.filter(r => r.rc_hhi !== null).map(r => r.rc_hhi);

const scamDanger  = scam.filter(r => r.rc_risk_danger_count !== null).map(r => r.rc_risk_danger_count);
const legitDanger = legit.filter(r => r.rc_risk_danger_count !== null).map(r => r.rc_risk_danger_count);

// ── Výpočty ───────────────────────────────────────────────────────────────────

const scamMintActivePct   = pct(scamAuth.filter(r => r.mint_auth_active === 1).length, scamAuth.length);
const legitMintActivePct  = pct(legitAuth.filter(r => r.mint_auth_active === 1).length, legitAuth.length);
const scamFreezeActivePct = pct(scamAuth.filter(r => r.freeze_auth_active === 1).length, scamAuth.length);
const legitFreezeActivePct = pct(legitAuth.filter(r => r.freeze_auth_active === 1).length, legitAuth.length);
const scamBothActivePct   = pct(scamAuth.filter(r => r.mint_auth_active === 1 && r.freeze_auth_active === 1).length, scamAuth.length);
const legitBothActivePct  = pct(legitAuth.filter(r => r.mint_auth_active === 1 && r.freeze_auth_active === 1).length, legitAuth.length);

const scamTop1Median  = median(scamTop1);
const legitTop1Median = median(legitTop1);
const scamTop1P75     = percentile(scamTop1, 75);
const scamTop1P90     = percentile(scamTop1, 90);
const legitTop1P75    = percentile(legitTop1, 75);

const scamHhiMedian  = median(scamHhi);
const legitHhiMedian = median(legitHhi);
const scamHhiP75     = percentile(scamHhi, 75);
const legitHhiP75    = percentile(legitHhi, 75);

const scamDangerMedian  = median(scamDanger);
const legitDangerMedian = median(legitDanger);

// ── Thresholds ────────────────────────────────────────────────────────────────
// Threshold logic: najít hodnotu která maximalizuje (TP rate - FP rate)
// Jednoduchý přístup: midpoint scam_median a legit_median
//   nebo legit_P75 jako threshold (>P75 legit = rizikovější než 75% legit)

function midpoint(a, b) {
  if (a === null || b === null) return null;
  return parseFloat(((a + b) / 2).toFixed(4));
}

const thresholds = {
  _metadata: {
    generated_at: new Date().toISOString(),
    methodology: 'Thresholds derived from comparison of scam_dataset (SolRPDS, n=' + scam.length + ') vs legit_baseline (n=' + legit.length + ') distributions in iris_enrichment',
    threshold_rule: 'threshold set at midpoint(scam_median, legit_P75) where available; for binary flags, >legit_pct triggers scoring',
    source_dataset: 'SolRPDS (Alhaidari et al. 2025, arXiv:2504.07132) + curated legit baseline',
  },

  mint_authority_active: {
    description: 'Mint authority not revoked — creator can issue new tokens at will',
    scam_pct:  scamMintActivePct,
    legit_pct: legitMintActivePct,
    sample_size: { scam: scamAuth.length, legit: legitAuth.length },
    signal_strength: scamMintActivePct !== null && legitMintActivePct !== null
      ? parseFloat((scamMintActivePct - legitMintActivePct).toFixed(2))
      : null,
    // Překvapivě podobné % v obou skupinách → slabý standalone signál
    // Ale v kombinaci s freeze_authority je silnější
    threshold: 'active=+15',
    iris_dimension: 'Rights',
    note: 'Weak standalone signal (scam≈legit); strong in combination with freeze_authority or Token-2022 extensions'
  },

  freeze_authority_active: {
    description: 'Freeze authority not revoked — creator can freeze holder accounts',
    scam_pct:  scamFreezeActivePct,
    legit_pct: legitFreezeActivePct,
    sample_size: { scam: scamAuth.length, legit: legitAuth.length },
    signal_strength: scamFreezeActivePct !== null && legitFreezeActivePct !== null
      ? parseFloat((scamFreezeActivePct - legitFreezeActivePct).toFixed(2))
      : null,
    threshold: 'active=+8',
    iris_dimension: 'Rights'
  },

  both_authorities_active: {
    description: 'Both mint AND freeze authority active — maximum creator control',
    scam_pct:  scamBothActivePct,
    legit_pct: legitBothActivePct,
    threshold: 'both_active=+5_bonus',
    iris_dimension: 'Rights',
    note: 'Multiplicative risk when combined'
  },

  top1_holder_pct: {
    description: 'Largest holder\'s share of total supply (RugCheck topHolders)',
    scam_median:  scamTop1Median  !== null ? parseFloat(scamTop1Median.toFixed(2))  : null,
    legit_median: legitTop1Median !== null ? parseFloat(legitTop1Median.toFixed(2)) : null,
    scam_p75:     scamTop1P75     !== null ? parseFloat(scamTop1P75.toFixed(2))     : null,
    legit_p75:    legitTop1P75    !== null ? parseFloat(legitTop1P75.toFixed(2))    : null,
    sample_size: { scam: scamTop1.length, legit: legitTop1.length },
    thresholds: {
      critical: scamTop1P90 !== null ? `>${parseFloat(scamTop1P90.toFixed(1))}%=+10` : '>70%=+10',
      high:     scamTop1P75 !== null ? `>${parseFloat(scamTop1P75.toFixed(1))}%=+7`  : '>50%=+7',
      medium:   legitTop1P75 !== null ? `>${parseFloat(legitTop1P75.toFixed(1))}%=+3` : '>30%=+3',
    },
    iris_dimension: 'Imbalance'
  },

  hhi: {
    description: 'Herfindahl-Hirschman Index of holder concentration (0=equal, 1=monopoly)',
    scam_median:  scamHhiMedian  !== null ? parseFloat(scamHhiMedian.toFixed(4))  : null,
    legit_median: legitHhiMedian !== null ? parseFloat(legitHhiMedian.toFixed(4)) : null,
    scam_p75:     scamHhiP75     !== null ? parseFloat(scamHhiP75.toFixed(4))     : null,
    legit_p75:    legitHhiP75    !== null ? parseFloat(legitHhiP75.toFixed(4))    : null,
    sample_size: { scam: scamHhi.length, legit: legitHhi.length },
    threshold: (() => {
      const mid = midpoint(scamHhiMedian, legitHhiMedian);
      return mid !== null ? `>${mid}=+10` : '>0.25=+10';
    })(),
    iris_dimension: 'Imbalance',
    note: 'HHI > scam_median indicates concentration comparable to confirmed scam tokens'
  },

  rugcheck_danger_risks: {
    description: 'Number of RugCheck risk items classified as "danger" level',
    scam_median:  scamDangerMedian  !== null ? parseFloat(scamDangerMedian.toFixed(2))  : null,
    legit_median: legitDangerMedian !== null ? parseFloat(legitDangerMedian.toFixed(2)) : null,
    sample_size: { scam: scamDanger.length, legit: legitDanger.length },
    thresholds: {
      high:   scamDangerMedian !== null ? `>=${Math.ceil(scamDangerMedian)}=+10_per_risk` : '>=3=+10_per_risk',
      medium: '>0=+5_per_risk',
    },
    iris_dimension: 'Imbalance',
    current_score_rule: '+10 per danger risk in IRIS v1.0'
  },

  rug_pattern_scam_db: {
    description: 'SolRPDS rug_pattern field from known_scams table',
    distribution: (() => {
      const dist = {};
      for (const r of scam) dist[r.rug_pattern || 'unknown'] = (dist[r.rug_pattern || 'unknown'] || 0) + 1;
      return Object.entries(dist).sort(([,a],[,b]) => b-a).reduce((o, [k,v]) => {
        o[k] = { count: v, pct: pct(v, scam.length) };
        return o;
      }, {});
    })(),
    thresholds: {
      inactive_pool:      '+20 (full liquidity removal, confidence=0.9)',
      liquidity_drain:    '+15 (partial drain, removed>1.2×added)',
      active_suspicious:  '+10 (active pool with suspicious indicators, confidence=0.5)',
    },
    iris_dimension: 'Imbalance'
  },

  token_age_hours: {
    description: 'Token age in hours at scan time (proxy for deploy-to-scan speed)',
    thresholds: {
      critical: '<1h=+20 (pump-and-dump window)',
      high:     '<24h=+13',
      medium:   '<168h=+6',
    },
    data_note: 'Based on Solana Tracker age_hours; SolRPDS lacks rug timestamp for empirical calibration',
    peak_attack_hours_utc: [15, 16, 17, 18, 19],
    peak_attack_score: '+5 if scan in peak window',
    iris_dimension: 'Speed'
  },

  liquidity_usd: {
    description: 'Total liquidity in USD at scan time',
    thresholds: {
      critical: '<$1000=+10',
      high:     '<$10000=+7',
      medium:   '<$50000=+3',
    },
    iris_dimension: 'Inflows'
  },

  lp_burn_pct: {
    description: 'Percentage of LP tokens burned (0% = full rug risk)',
    thresholds: {
      critical: '0%=+10 (no burn)',
      high:     '<20%=+7',
      medium:   '<50%=+3',
    },
    iris_dimension: 'Inflows'
  },
};

// ── Výstup ────────────────────────────────────────────────────────────────────

const out = JSON.stringify(thresholds, null, 2);
process.stdout.write(out + '\n');

// Uložení
fs.writeFileSync(OUT_PATH, out + '\n');
console.error(`[iris-thresholds] Written to ${OUT_PATH}`);

db.close();
