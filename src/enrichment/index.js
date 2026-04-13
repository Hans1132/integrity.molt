'use strict';
/**
 * src/enrichment/index.js
 *
 * Enrichment orchestrátor — volá všechny externe zdroje PARALELNĚ
 * a agreguje výsledky do jednotného objektu.
 *
 * Použití:
 *   const { enrichScanResult } = require('./src/enrichment');
 *   const enrichment = await enrichScanResult(mintAddress);
 *
 * Pokud některý zdroj selže → pokračuje s ostatními.
 * Celý scan NIKDY nefailuje kvůli enrichmentu.
 */

const { getRugCheckReport }    = require('./rugcheck');
const { getSolanaTrackerData } = require('./solana-tracker');
const { checkTokenExtensions } = require('./token-extensions');

// ── Aggregated risk scoring ───────────────────────────────────────────────────
//
// Vlastní logika kombinující signály z externích zdrojů.
// Výsledné score 0–100 (vyšší = riskovější).
// Thresholds: 0-24 LOW | 25-49 MEDIUM | 50-74 HIGH | 75-100 CRITICAL

function calculateAggregatedRisk(rugcheck, tracker, extensions) {
  let score = 0;
  const flags = [];

  // ── Token-2022 extensions (nejvyšší priorita) ─────────────────────────────
  if (extensions?.is_token_2022) {
    for (const ext of extensions.extensions || []) {
      switch (ext.name) {
        case 'PermanentDelegate':
          if (ext.delegate_address) {
            // Aktivní delegát — CRITICAL
            score = Math.max(score, 90);
            flags.push('permanent_delegate_active');
          } else {
            // Extension přítomna ale delegát null
            score += 5;
            flags.push('permanent_delegate_unset');
          }
          break;
        case 'TransferHook':
          if (ext.hook_program_id) {
            score += 25;
            flags.push('transfer_hook_active');
          } else {
            score += 5;
            flags.push('transfer_hook_unset');
          }
          break;
        case 'TransferFeeConfig':
          score += 10;
          flags.push('transfer_fee');
          if ((ext.newer_fee_basis_points || 0) > 500) {
            // >5% transfer fee — agresivní
            score += 10;
            flags.push('high_transfer_fee');
          }
          break;
        case 'DefaultAccountState':
          if (ext.default_state === 'frozen') {
            score += 15;
            flags.push('default_frozen');
          }
          break;
        case 'MintCloseAuthority':
          if (ext.close_authority) {
            score += 10;
            flags.push('mint_close_authority');
          }
          break;
      }
    }
  }

  // ── RugCheck signály ──────────────────────────────────────────────────────
  if (rugcheck) {
    if (rugcheck.rugged) {
      score = Math.max(score, 92);
      flags.push('rugged');
    }

    // RugCheck raw score >10000 = HIGH přes jejich metriku
    if ((rugcheck.score || 0) > 10_000) {
      score = Math.max(score, 70);
      flags.push('rugcheck_score_high');
    } else if ((rugcheck.score || 0) > 5_000) {
      score = Math.max(score, 50);
      flags.push('rugcheck_score_medium');
    }

    // Insider network
    if ((rugcheck.insiders_detected || 0) > 20) {
      score += 25;
      flags.push('many_insiders');
    } else if ((rugcheck.insiders_detected || 0) > 5) {
      score += 15;
      flags.push('insiders_detected');
    }

    // Aktivní autority
    if (rugcheck.freeze_authority) {
      score += 15;
      flags.push('freeze_authority_active');
    }
    if (rugcheck.mint_authority) {
      score += 20;
      flags.push('mint_authority_active');
    }

    // Top holder koncentrace
    const topHolder = rugcheck.top_holders?.[0];
    if (topHolder?.pct > 70) {
      score += 20;
      flags.push('top_holder_critical');
    } else if (topHolder?.pct > 50) {
      score += 15;
      flags.push('top_holder_high');
    } else if (topHolder?.pct > 30) {
      score += 8;
      flags.push('top_holder_medium');
    }

    // Danger risks z RugCheck
    const dangerCount = (rugcheck.risks || []).filter(r => r.level === 'danger').length;
    const warnCount   = (rugcheck.risks || []).filter(r => r.level === 'warn').length;
    if (dangerCount > 0) {
      score += dangerCount * 10;
      flags.push(`rugcheck_danger_risks_${dangerCount}`);
    } else if (warnCount > 2) {
      score += warnCount * 3;
      flags.push(`rugcheck_warn_risks_${warnCount}`);
    }

    // Verifikovaný token
    if (rugcheck.verified) {
      score = Math.max(0, score - 10);
      flags.push('verified');
    }
  }

  // ── Solana Tracker signály ────────────────────────────────────────────────
  if (tracker) {
    if (tracker.risk?.rugged) {
      score = Math.max(score, 92);
      flags.push('tracker_rugged');
    }

    // LP burn
    if (tracker.lp_burn_pct !== null && tracker.lp_burn_pct < 50) {
      score += 10;
      flags.push('low_lp_burn');
    }

    // Věk tokenu
    if (tracker.age_hours !== null) {
      if (tracker.age_hours < 24) {
        score += 10;
        flags.push('very_new_token');
      } else if (tracker.age_hours < 168) {
        score += 5;
        flags.push('new_token');
      }
    }

    // Obchodní aktivita — extrémně nízká likvidita
    if (tracker.liquidity_usd !== null && tracker.liquidity_usd < 1000) {
      score += 10;
      flags.push('very_low_liquidity');
    }
  }

  score = Math.min(100, Math.max(0, score));

  let risk_level;
  if      (score >= 75) risk_level = 'CRITICAL';
  else if (score >= 50) risk_level = 'HIGH';
  else if (score >= 25) risk_level = 'MEDIUM';
  else                  risk_level = 'LOW';

  return { score, risk_level, flags };
}

// ── Kombinace vlastního score s enrichment score ──────────────────────────────

/**
 * Kombinuje vlastní scan score s enrichment aggregated score.
 * Výsledek je vážený průměr: vlastní 60%, enrichment 40%.
 * Pokud enrichment signalizuje CRITICAL flag (permanent_delegate, rugged) → přepsání.
 *
 * @param {number} ownScore        — vlastní deterministic score (0–100)
 * @param {object} aggregatedRisk  — výsledek calculateAggregatedRisk
 * @returns {number}               — kombinované score (0–100)
 */
function combineScores(ownScore, aggregatedRisk) {
  if (!aggregatedRisk) return ownScore;

  // Absolutní override pro kritické signály
  const criticalFlags = ['permanent_delegate_active', 'rugged', 'tracker_rugged'];
  if (aggregatedRisk.flags.some(f => criticalFlags.includes(f))) {
    return Math.max(ownScore, 90);
  }

  // Vážený průměr: vlastní 60% + enrichment 40%
  const combined = Math.round(ownScore * 0.6 + aggregatedRisk.score * 0.4);
  return Math.min(100, combined);
}

// ── Hlavní export ─────────────────────────────────────────────────────────────

/**
 * Spustí všechny enrichment zdroje paralelně a vrátí sloučený výsledek.
 * Pokud celý enrichment selže (timeout, error), vrátí prázdný objekt — nikdy nehodí.
 *
 * @param {string} mintAddress
 * @returns {Promise<object>}
 */
async function enrichScanResult(mintAddress) {
  const t0 = Date.now();

  let rugcheckRes, trackerRes, extensionsRes;

  try {
    [rugcheckRes, trackerRes, extensionsRes] = await Promise.allSettled([
      getRugCheckReport(mintAddress),
      getSolanaTrackerData(mintAddress),
      checkTokenExtensions(mintAddress)
    ]);
  } catch (e) {
    // Nemělo by nastat (allSettled nikdy nehodí), ale pro jistotu
    console.error('[enrichment] unexpected error:', e.message);
    return { _error: 'enrichment orchestration failed' };
  }

  const rugcheck   = rugcheckRes.status   === 'fulfilled' ? rugcheckRes.value   : null;
  const tracker    = trackerRes.status    === 'fulfilled' ? trackerRes.value    : null;
  const extensions = extensionsRes.status === 'fulfilled' ? extensionsRes.value : null;

  const sourcesResponded = [rugcheck, tracker, extensions].filter(Boolean).length;

  const aggregatedRisk = calculateAggregatedRisk(rugcheck, tracker, extensions);

  if (rugcheckRes.status === 'rejected') {
    console.warn('[enrichment] rugcheck failed:', rugcheckRes.reason?.message);
  }
  if (trackerRes.status === 'rejected') {
    console.warn('[enrichment] solana-tracker failed:', trackerRes.reason?.message);
  }
  if (extensionsRes.status === 'rejected') {
    console.warn('[enrichment] token-extensions failed:', extensionsRes.reason?.message);
  }

  return {
    external_sources: {
      rugcheck: rugcheck  || null,
      solana_tracker: tracker || null
    },
    token_extensions: extensions || null,
    aggregated_risk:  aggregatedRisk,
    data_confidence: {
      sources_queried:   3,
      sources_responded: sourcesResponded,
      timestamp:         new Date().toISOString(),
      enrich_ms:         Date.now() - t0
    }
  };
}

module.exports = { enrichScanResult, combineScores, calculateAggregatedRisk };
