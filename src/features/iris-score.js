'use strict';
/**
 * src/features/iris-score.js
 *
 * IRIS v1.0 — Inflows + Rights + Imbalance + Speed
 * Každá dimenze 0-25 bodů, celkem 0-100.
 * Vyšší skóre = vyšší riziko.
 *
 * Vstupy:
 *   - enrichmentData: výstup z enrichScanResult() (rugcheck, solana_tracker, token_extensions)
 *   - scamDbData:     výstup z lookupScamDb() (known_scam, rugcheck cache hit)
 *
 * Metodika: intmolt.org/iris
 *
 * Zdroje prahů:
 *   - SolRPDS dataset (Alhaidari et al. 2025, arXiv:2504.07132) — 33 359 potvrzených rug pullů
 *   - data/iris-analysis-results.json — statistická analýza DB
 *   - RugCheck API normalizace (src/enrichment/rugcheck.js)
 *   - Solana Tracker normalizace (src/enrichment/solana-tracker.js)
 */

// ── I — Inflows thresholds ────────────────────────────────────────────────────
// Zdroj: obecné threshold z enrichment analýzy; LP burn je klíčový rug signál.

const INFLOWS = {
  // Likvidita — extrémně nízká likvidita → snadný exit pro tvůrce
  liquidity_very_low_usd:  1_000,   // <$1k: CRITICAL signal (src: enrichment/index.js empirical)
  liquidity_low_usd:       10_000,  // <$10k: HIGH signal
  liquidity_medium_usd:    50_000,  // <$50k: MEDIUM signal

  // LP burn — nezamčená likvidita = snadný rug
  lp_burn_critical_pct:    0,       // 0% burn = max risk
  lp_burn_high_pct:        20,      // <20% burn: HIGH risk
  lp_burn_medium_pct:      50,      // <50% burn: MEDIUM risk

  // Buy/sell tlak — dump pattern
  sell_pressure_ratio:     2.0,     // sells > 2× buys: podezřelé
};

// ── R — Rights thresholds ─────────────────────────────────────────────────────
// Zdroj: SolRPDS neobsahuje data autorit přímo; prahy z RugCheck API interpretace.
// Mint + freeze authority jsou klíčové rug vektory.

// (žádné numerické prahy — binary flags z RugCheck + Token-2022 extensions)

// ── I — Imbalance thresholds ──────────────────────────────────────────────────
// Zdroj: iris-analysis-results.json, thresholds_derived
//   liquidity_drain_threshold: "removed_liquidity > 1.2 × added_liquidity"
//   inactive_pool_pct: 57.78% scam poolů je inactive (full liquidity removal)
//   serial_deployer_flag: creator_wallet with scam_count >= 2

const IMBALANCE = {
  // Top holder koncentrace — HHI proxy
  top_holder_critical_pct: 70,     // >70%: CRITICAL — jeden wallet drží většinu supply
  top_holder_high_pct:     50,     // >50%: HIGH
  top_holder_medium_pct:   30,     // >30%: MEDIUM

  // Insider sítě z RugCheck
  insiders_critical:       20,     // >20 insiders: CRITICAL
  insiders_high:           5,      // >5 insiders: HIGH

  // Rug pattern z scam-db (SolRPDS kategorie)
  // "inactive_pool": 57.78% scam poolů (zdroj: iris-analysis Q4, finding_4_rug_pattern_dominance)
  // "liquidity_drain": 21.36% (drain ratio > 1.2×)
  rug_pattern_inactive_score:       20,  // scam-db hit: inactive_pool pattern
  rug_pattern_liquidity_drain_score: 15, // scam-db hit: liquidity_drain pattern
  rug_pattern_active_suspicious:    10,  // scam-db hit: active_suspicious pattern
};

// ── S — Speed thresholds ──────────────────────────────────────────────────────
// Zdroj: iris-analysis-results.json, speed sekce
//   peak_attack_hours_utc: [17,18,16,19,15] UTC (source: iris-analysis Q speed)
//   yoy_growth_rate_2021_2024: 164× (40× YoY)
// Pozn: deploy_to_rug_median_hours je null v DB (vyžaduje Helius webhook enrichment)
// Proxy: age_hours z Solana Tracker (věk tokenu v době scanu)

const SPEED = {
  // Věk tokenu — nové tokeny mají vyšší riziko
  age_critical_hours:  1,    // <1h: CRITICAL — pump-and-dump window
  age_high_hours:      24,   // <24h: HIGH
  age_medium_hours:    168,  // <7 dní: MEDIUM

  // Peak útočné hodiny UTC (zdroj: iris-analysis peak_attack_hours_utc, top 5)
  // 15, 16, 17, 18, 19 UTC — koordinované pump-and-dump okno
  peak_attack_hours_utc: new Set([15, 16, 17, 18, 19]),
};

// ── Scoring funkce ────────────────────────────────────────────────────────────

/**
 * I — Inflows dimension (0-25)
 * Hodnotí likviditu, LP burn a buy/sell pressure.
 */
function scoreInflows(enrichment) {
  const tracker = enrichment?.external_sources?.solana_tracker || null;
  const rugcheck = enrichment?.external_sources?.rugcheck || null;

  let score = 0;
  const details = [];

  // Likvidita (0-10)
  const liq = tracker?.liquidity_usd ?? rugcheck?.total_liquidity_usd ?? null;
  if (liq !== null) {
    if (liq < INFLOWS.liquidity_very_low_usd) {
      score += 10;
      details.push(`liquidity_critical (<$${INFLOWS.liquidity_very_low_usd.toLocaleString()})`);
    } else if (liq < INFLOWS.liquidity_low_usd) {
      score += 7;
      details.push(`liquidity_low (<$${INFLOWS.liquidity_low_usd.toLocaleString()})`);
    } else if (liq < INFLOWS.liquidity_medium_usd) {
      score += 3;
      details.push(`liquidity_medium (<$${INFLOWS.liquidity_medium_usd.toLocaleString()})`);
    }
  }

  // LP burn (0-10)
  const lpBurn = tracker?.lp_burn_pct ?? null;
  if (lpBurn !== null) {
    if (lpBurn <= INFLOWS.lp_burn_critical_pct) {
      score += 10;
      details.push('lp_unburned (0%)');
    } else if (lpBurn < INFLOWS.lp_burn_high_pct) {
      score += 7;
      details.push(`lp_burn_low (${lpBurn}%)`);
    } else if (lpBurn < INFLOWS.lp_burn_medium_pct) {
      score += 3;
      details.push(`lp_burn_medium (${lpBurn}%)`);
    }
  }

  // Buy/sell pressure (0-5)
  const buys  = tracker?.buys_24h  ?? 0;
  const sells = tracker?.sells_24h ?? 0;
  if (buys > 0 && sells / buys > INFLOWS.sell_pressure_ratio) {
    score += 5;
    details.push(`sell_pressure (sells:buys=${(sells/buys).toFixed(1)}x)`);
  }

  return { score: Math.min(25, score), details };
}

/**
 * R — Rights dimension (0-25)
 * Hodnotí mint/freeze authority a Token-2022 extension rizika.
 */
function scoreRights(enrichment) {
  const rugcheck   = enrichment?.external_sources?.rugcheck || null;
  const extensions = enrichment?.token_extensions || null;

  let score = 0;
  const details = [];

  // Mint authority aktivní (0-10)
  if (rugcheck?.mint_authority) {
    score += 10;
    details.push('mint_authority_active');
  }

  // Freeze authority aktivní (0-8)
  if (rugcheck?.freeze_authority) {
    score += 8;
    details.push('freeze_authority_active');
  }

  // Token-2022 extensions (0-7)
  if (extensions?.is_token_2022 && extensions.extensions?.length > 0) {
    for (const ext of extensions.extensions) {
      switch (ext.name) {
        case 'PermanentDelegate':
          if (ext.delegate_address) {
            score += 7;
            details.push('permanent_delegate_active');
          }
          break;
        case 'TransferHook':
          if (ext.hook_program_id) {
            score += 5;
            details.push('transfer_hook_active');
          }
          break;
        case 'DefaultAccountState':
          if (ext.default_state === 'frozen') {
            score += 3;
            details.push('default_account_frozen');
          }
          break;
        case 'MintCloseAuthority':
          if (ext.close_authority) {
            score += 2;
            details.push('mint_close_authority');
          }
          break;
        case 'TransferFeeConfig':
          if ((ext.newer_fee_basis_points || 0) > 500) {
            score += 2;
            details.push(`high_transfer_fee (${ext.newer_fee_basis_points}bps)`);
          }
          break;
      }
    }
  }

  // RugCheck CRITICAL risks (override)
  if (rugcheck?.rugged) {
    score = Math.max(score, 20);
    details.push('confirmed_rugged');
  }

  return { score: Math.min(25, score), details };
}

/**
 * I — Imbalance dimension (0-25)
 * Hodnotí koncentraci holderů, insider sítě a rug patterny.
 */
function scoreImbalance(enrichment, scamDb) {
  const rugcheck = enrichment?.external_sources?.rugcheck || null;

  let score = 0;
  const details = [];

  // Top holder koncentrace (0-10)
  const topHolder = rugcheck?.top_holders?.[0];
  if (topHolder?.pct != null) {
    if (topHolder.pct > IMBALANCE.top_holder_critical_pct) {
      score += 10;
      details.push(`top_holder_critical (${topHolder.pct.toFixed(1)}%)`);
    } else if (topHolder.pct > IMBALANCE.top_holder_high_pct) {
      score += 7;
      details.push(`top_holder_high (${topHolder.pct.toFixed(1)}%)`);
    } else if (topHolder.pct > IMBALANCE.top_holder_medium_pct) {
      score += 3;
      details.push(`top_holder_medium (${topHolder.pct.toFixed(1)}%)`);
    }
  }

  // Insider sítě (0-8)
  const insiders = rugcheck?.insiders_detected ?? 0;
  if (insiders > IMBALANCE.insiders_critical) {
    score += 8;
    details.push(`insiders_critical (${insiders})`);
  } else if (insiders > IMBALANCE.insiders_high) {
    score += 5;
    details.push(`insiders_high (${insiders})`);
  } else if (insiders > 0) {
    score += 2;
    details.push(`insiders_detected (${insiders})`);
  }

  // Rug pattern z scam-db (0-7)
  // Zdroj: SolRPDS rug_pattern field, iris-analysis finding_4_rug_pattern_dominance
  const rugPattern = scamDb?.known_scam?.rug_pattern || null;
  const isKnownScam = scamDb?.known_scam != null;

  if (isKnownScam) {
    if (rugPattern === 'inactive_pool') {
      score += IMBALANCE.rug_pattern_inactive_score;
      details.push('known_scam:inactive_pool');
    } else if (rugPattern === 'liquidity_drain') {
      score += IMBALANCE.rug_pattern_liquidity_drain_score;
      details.push('known_scam:liquidity_drain');
    } else if (rugPattern === 'active_suspicious') {
      score += IMBALANCE.rug_pattern_active_suspicious;
      details.push('known_scam:active_suspicious');
    } else {
      // known scam but pattern unknown
      score += 10;
      details.push('known_scam:unknown_pattern');
    }
  }

  return { score: Math.min(25, score), details };
}

/**
 * S — Speed dimension (0-25)
 * Hodnotí věk tokenu a časové signály.
 */
function scoreSpeed(enrichment) {
  const tracker = enrichment?.external_sources?.solana_tracker || null;

  let score = 0;
  const details = [];

  // Věk tokenu (0-20)
  // Zdroj: proxy za deploy_to_rug_median_hours (null v DB — vyžaduje Helius)
  // Nové tokeny mají dramaticky vyšší rug pravděpodobnost.
  const ageHours = tracker?.age_hours ?? null;
  if (ageHours !== null) {
    if (ageHours < SPEED.age_critical_hours) {
      score += 20;
      details.push(`age_critical (${ageHours}h)`);
    } else if (ageHours < SPEED.age_high_hours) {
      score += 13;
      details.push(`age_high (${ageHours}h)`);
    } else if (ageHours < SPEED.age_medium_hours) {
      score += 6;
      details.push(`age_medium (${ageHours}h)`);
    }
  }

  // Peak útočné hodiny UTC (0-5)
  // Zdroj: iris-analysis peak_attack_hours_utc — 15-19 UTC je koordinované pump-and-dump okno
  const hourNow = new Date().getUTCHours();
  if (SPEED.peak_attack_hours_utc.has(hourNow)) {
    score += 5;
    details.push(`peak_attack_hour_utc (${hourNow}h)`);
  }

  return { score: Math.min(25, score), details };
}

// ── Hlavní export ─────────────────────────────────────────────────────────────

/**
 * Vypočítá IRIS skóre 0-100 z enrichment + scamDb dat.
 *
 * @param {object|null} enrichmentData  — výstup z enrichScanResult()
 * @param {object|null} scamDbData      — výstup z lookupScamDb()
 * @returns {object}                    — { score, grade, breakdown, methodology }
 */
function calculateIRIS(enrichmentData, scamDbData) {
  const enrichment = enrichmentData || {};
  const scamDb     = scamDbData     || {};

  const inflowsResult  = scoreInflows(enrichment);
  const rightsResult   = scoreRights(enrichment);
  const imbalanceResult = scoreImbalance(enrichment, scamDb);
  const speedResult    = scoreSpeed(enrichment);

  const total = inflowsResult.score + rightsResult.score + imbalanceResult.score + speedResult.score;

  const grade =
    total >= 75 ? 'CRITICAL' :
    total >= 50 ? 'HIGH'     :
    total >= 25 ? 'MEDIUM'   : 'LOW';

  return {
    score: total,
    grade,
    breakdown: {
      inflows:   { score: inflowsResult.score,   max: 25, details: inflowsResult.details   },
      rights:    { score: rightsResult.score,    max: 25, details: rightsResult.details    },
      imbalance: { score: imbalanceResult.score, max: 25, details: imbalanceResult.details },
      speed:     { score: speedResult.score,     max: 25, details: speedResult.details     }
    },
    methodology: 'IRIS v1.0 — intmolt.org/iris'
  };
}

/**
 * Formátuje IRIS výsledek pro LLM prompt.
 *
 * @param {object} iris  — výstup z calculateIRIS()
 * @returns {string}
 */
function formatIrisForLLM(iris) {
  if (!iris) return '';

  const { score, grade, breakdown } = iris;

  const fmtDetails = (d) => d.length > 0 ? d.join(', ') : 'no signals';

  return [
    `Token IRIS Score: ${score}/100 (${grade})`,
    'Breakdown:',
    `  I — Inflows:   ${breakdown.inflows.score}/25   — ${fmtDetails(breakdown.inflows.details)}`,
    `  R — Rights:    ${breakdown.rights.score}/25   — ${fmtDetails(breakdown.rights.details)}`,
    `  I — Imbalance: ${breakdown.imbalance.score}/25   — ${fmtDetails(breakdown.imbalance.details)}`,
    `  S — Speed:     ${breakdown.speed.score}/25   — ${fmtDetails(breakdown.speed.details)}`,
    '',
    'Vysvětli toto IRIS skóre uživateli srozumitelně. Popiš které dimenze jsou nejvíce rizikové a proč.'
  ].join('\n');
}

module.exports = { calculateIRIS, formatIrisForLLM };
