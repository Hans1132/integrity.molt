'use strict';
// src/features/iris-score.js — IRIS v2.0
// 8 dimensions: Liquidity, Authority, Concentration, Lineage, Reputation, Trading, Honeypot, Age
// Per-dimension internal score 0-100, multiplied by weight from data/rules-v2.json.
// Soft floor + external oracle floor + soft whitelist applied AFTER weighted sum.
// Circuit breaker drops failed dimensions, weights renormalize over active set.
// See docs/superpowers/specs/2026-05-19-iris-v2-scope-a-plan.md + amendment-q3-3tier.md
// + amendment-v3-external-oracle-floor.md

const fs = require('fs');
const path = require('path');
const { classifyRisk } = require('../lib/risk-classification');

// ── Weights and thresholds — loaded once at module init (plain JSON, no json5 dep per Q6) ──
const _rulesPath = path.join(__dirname, '../../data/rules-v2.json');
const _rules = JSON.parse(fs.readFileSync(_rulesPath, 'utf8'));

// Invariant: weights must sum to 100
const _weightsSum = Object.values(_rules.weights).reduce((a, b) => a + b, 0);
if (_weightsSum !== 100) {
  throw new Error(`rules-v2.json weights sum to ${_weightsSum}, expected 100`);
}

const W = _rules.weights;
const T = _rules.thresholds;

// ── Helpers ───────────────────────────────────────────────────────────────────
// DEX program IDs / AMM pools — used to filter out LP holders from circulating
// supply concentration analysis (copied from v1 inline list).
const DEX_PROGRAM_IDS = new Set([
  '11111111111111111111111111111111',                            // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',                 // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',                 // Token-2022
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',                // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',                // Raydium CLMM
  'HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8',                // Raydium CPMM
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',                 // Raydium Router
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',                 // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',                // Orca v1
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',                 // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAR',                // Meteora Pools
  'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',                 // Meteora
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',                 // Phoenix DEX
  'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S',                // Lifinity
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',                 // Serum DEX v3
  'opnb2LAfJYbRMAHHvqjCwQxanZn7n1aFDpJh5oPaTth',                 // OpenBook
]);

let _legitMints = null;
function getLegitMints() {
  if (_legitMints) return _legitMints;
  try {
    const data = require(path.join(__dirname, '../../data/legit-tokens.json'));
    _legitMints = new Set((data.tokens || []).map(t => t.mint));
  } catch {
    _legitMints = new Set();
  }
  return _legitMints;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ── Per-dimension scoring functions ───────────────────────────────────────────
// Each returns { score: 0-100, signals: [{name, score}], source_health: 'ok'|'partial'|'circuit_breaker_open' }

function scoreLiquidity(enrichment) {
  const tracker = enrichment?.external_sources?.solana_tracker || null;
  const rugcheck = enrichment?.external_sources?.rugcheck || null;
  let s = 0;
  const signals = [];

  const liq = tracker?.liquidity_usd ?? rugcheck?.total_liquidity_usd ?? null;
  if (liq !== null) {
    if (liq < 1_000)        { s += 30; signals.push({ name: 'liquidity_usd_critical_low', score: 30 }); }
    else if (liq < 10_000)  { s += 20; signals.push({ name: 'liquidity_usd_low', score: 20 }); }
    else if (liq < 50_000)  { s += 10; signals.push({ name: 'liquidity_usd_medium', score: 10 }); }
  }

  const lpBurn = tracker?.lp_burn_pct ?? null;
  if (lpBurn !== null) {
    if (lpBurn === 0)       { s += 25; signals.push({ name: 'lp_burn_zero', score: 25 }); }
    else if (lpBurn < 20)   { s += 15; signals.push({ name: 'lp_burn_low', score: 15 }); }
    else if (lpBurn < 50)   { s += 5;  signals.push({ name: 'lp_burn_medium', score: 5 }); }
  }

  const lpLocked = rugcheck?.lp_locked_pct ?? null;
  if (lpLocked !== null && lpLocked > 80 && (lpBurn === null || lpBurn < 50)) {
    s += 10; signals.push({ name: 'lp_locked_only', score: 10 });
  }

  // lp_concentration — top LP token holder concentration (DEX address with high pct)
  if (rugcheck?.top_holders) {
    const lpHolder = rugcheck.top_holders.find(h => DEX_PROGRAM_IDS.has(h.address) && h.pct > 50);
    if (lpHolder) {
      s += 10; signals.push({ name: 'lp_concentration_high', score: 10 });
    }
  }

  const score = clamp(s, 0, 100);
  const source_health = (liq === null && lpBurn === null) ? 'partial' : 'ok';
  return { score, signals, source_health };
}

function scoreAuthority(enrichment) {
  const rugcheck = enrichment?.external_sources?.rugcheck || null;
  const tracker  = enrichment?.external_sources?.solana_tracker || null;
  const ext      = enrichment?.token_extensions || null;
  const mint     = enrichment?.mint || null;
  let s = 0;
  const signals = [];

  if (rugcheck?.mint_authority) {
    const ageHours = tracker?.age_hours ?? null;
    const isNew    = ageHours !== null && ageHours < 168;
    const holders  = (rugcheck.top_holders || []).filter(h => !DEX_PROGRAM_IDS.has(h.address));
    const hhi      = holders.reduce((sum, h) => sum + ((h.pct || 0) / 100) ** 2, 0);
    const isConc   = hhi > 0.25;
    const isLegit  = mint && getLegitMints().has(mint);
    if (isNew || isConc || !isLegit) {
      s += 30; signals.push({ name: 'mint_authority_active_nonlegit', score: 30 });
    } else {
      s += 5;  signals.push({ name: 'mint_authority_active_legit_context', score: 5 });
    }
  }

  if (rugcheck?.freeze_authority) {
    s += 20; signals.push({ name: 'freeze_authority_active', score: 20 });
  }

  if (rugcheck?.verification?.metadata_mutable === true) {
    s += 10; signals.push({ name: 'metadata_mutable', score: 10 });
  }

  if (ext?.is_token_2022 && Array.isArray(ext.extensions)) {
    for (const e of ext.extensions) {
      switch (e.name) {
        case 'PermanentDelegate':
          if (e.delegate_address) { s += 15; signals.push({ name: 'permanent_delegate_set', score: 15 }); }
          break;
        case 'TransferHook':
          if (e.hook_program_id)  { s += 10; signals.push({ name: 'transfer_hook_active', score: 10 }); }
          break;
        case 'DefaultAccountState':
          if (e.default_state === 'frozen') { s += 10; signals.push({ name: 'default_account_state_frozen', score: 10 }); }
          break;
        case 'MintCloseAuthority':
          if (e.close_authority) { s += 5; signals.push({ name: 'mint_close_authority_set', score: 5 }); }
          break;
      }
    }
  }

  const score = clamp(s, 0, 100);
  const source_health = !rugcheck && !ext ? 'circuit_breaker_open' : 'ok';
  return { score, signals, source_health };
}

function scoreConcentration(enrichment) {
  const rugcheck = enrichment?.external_sources?.rugcheck || null;
  const tracker  = enrichment?.external_sources?.solana_tracker || null;
  let s = 0;
  const signals = [];

  const filtered = (rugcheck?.top_holders || []).filter(h => !DEX_PROGRAM_IDS.has(h.address));
  const top = filtered[0] ?? null;
  if (top?.pct != null) {
    if (top.pct > 70)      { s += 35; signals.push({ name: 'top_holder_critical', score: 35 }); }
    else if (top.pct > 50) { s += 25; signals.push({ name: 'top_holder_high', score: 25 }); }
    else if (top.pct > 30) { s += 10; signals.push({ name: 'top_holder_medium', score: 10 }); }
  }

  const top10Sum = filtered.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0);
  if (top10Sum > 90)       { s += 20; signals.push({ name: 'top10_pct_critical', score: 20 }); }
  else if (top10Sum > 70)  { s += 10; signals.push({ name: 'top10_pct_high', score: 10 }); }

  const hhi = filtered.reduce((sum, h) => sum + ((h.pct || 0) / 100) ** 2, 0);
  if (hhi > 0.4) { s += 15; signals.push({ name: 'hhi_critical', score: 15 }); }

  const insiders = rugcheck?.insiders_detected ?? 0;
  if (insiders > 20)      { s += 20; signals.push({ name: 'insiders_critical', score: 20 }); }
  else if (insiders > 5)  { s += 10; signals.push({ name: 'insiders_high', score: 10 }); }

  const holderCount = tracker?.holders ?? null;
  if (holderCount !== null && holderCount < 50) {
    s += 15; signals.push({ name: 'holder_count_anemic', score: 15 });
  }

  // dev_wallet_held: creator still in top holders >5%
  const creator = rugcheck?.creator || null;
  if (creator) {
    const creatorHolder = filtered.find(h => h.address === creator);
    if (creatorHolder?.pct > 5) {
      s += 15; signals.push({ name: 'dev_wallet_held', score: 15 });
    }
  }

  const score = clamp(s, 0, 100);
  const source_health = !rugcheck && !tracker ? 'circuit_breaker_open' : 'ok';
  return { score, signals, source_health };
}

function scoreLineage(enrichment, scamCreators) {
  const rugcheck = enrichment?.external_sources?.rugcheck || null;
  const creator = rugcheck?.creator || null;
  let s = 0;
  const signals = [];

  if (!creator) {
    return { score: 0, signals: [], source_health: 'partial' };
  }

  // scamCreators shape: { isKnownScammer: bool, scamCount: number, patterns: string[] } | null
  if (scamCreators?.isKnownScammer) {
    if (scamCreators.scamCount >= 2) {
      s += 50; signals.push({ name: 'creator_known_scammer', score: 50 });
    } else {
      s += 30; signals.push({ name: 'creator_recent_scam', score: 30 });
    }
  }

  // creator_new_wallet, creator_funded_just_before — require Helius (Scope B). Skip in v2.0.
  const score = clamp(s, 0, 100);
  return { score, signals, source_health: 'partial' };
}

function scoreReputation(enrichment, scamDb, goplus) {
  const rugcheck = enrichment?.external_sources?.rugcheck || null;
  let s = 0;
  const signals = [];

  if (rugcheck?.rugged === true) {
    s += 50; signals.push({ name: 'rugcheck_rugged_flag', score: 50 });
  }
  const rcScore = rugcheck?.score_normalised ?? null;
  if (rcScore !== null) {
    if (rcScore < 25)      { s += 30; signals.push({ name: 'rugcheck_score_norm_critical', score: 30 }); }
    else if (rcScore < 50) { s += 15; signals.push({ name: 'rugcheck_score_norm_warn', score: 15 }); }
  }
  if (goplus?.source_health === 'ok') {
    if (goplus.is_malicious === 1) {
      s += 25; signals.push({ name: 'goplus_risk_high', score: 25 });
    } else if (goplus.risk_count > 0) {
      s += 10; signals.push({ name: 'goplus_risk_warn', score: 10 });
    }
  }
  if (scamDb?.known_scam) {
    const conf = scamDb.known_scam.confidence_score ?? scamDb.known_scam.confidence ?? 0;
    // 0.5 = uninformative base prior z bulk SolRPDS importu (žádná korroborace);
    // direct hit vyžaduje confidence STRIKTNĚ nad prior (proto >, ne >=)
    if (conf > 0.5) {
      s += 35; signals.push({ name: 'scam_db_direct_hit', score: 35 });
    }
  }
  if (rugcheck?.verified === false && (enrichment?.external_sources?.solana_tracker?.age_hours ?? 0) > 720) {
    s += 5; signals.push({ name: 'not_jup_verified', score: 5 });
  }
  if (scamDb?.ottersec_verified) {
    s -= 15; signals.push({ name: 'ottersec_verified_program', score: -15 });
  }
  const score = clamp(s, 0, 100);
  const source_health = !rugcheck && goplus?.source_health !== 'ok' ? 'partial' : 'ok';
  return { score, signals, source_health };
}

function scoreTrading(enrichment) {
  const tracker = enrichment?.external_sources?.solana_tracker || null;
  let s = 0;
  const signals = [];
  if (!tracker) return { score: 0, signals: [], source_health: 'circuit_breaker_open' };

  const buys = tracker.buys_24h ?? 0;
  const sells = tracker.sells_24h ?? 0;
  if (buys > 0 && sells / buys > 2.0) {
    s += 25; signals.push({ name: 'sell_pressure_high', score: 25 });
  }
  const liq = tracker.liquidity_usd ?? null;
  const vol = tracker.volume_24h_usd ?? null;
  if (liq !== null && vol !== null && liq > 0) {
    const ratio = vol / liq;
    if (ratio > 100)        { s += 20; signals.push({ name: 'volume_to_liquidity_extreme', score: 20 }); }
    else if (ratio < 0.1)   { s += 15; signals.push({ name: 'volume_to_liquidity_low', score: 15 }); }
  }
  if ((buys + sells) === 0 && (tracker.age_hours ?? 0) > 24) {
    s += 30; signals.push({ name: 'volume_zero_24h', score: 30 });
  }
  const hourNow = new Date().getUTCHours();
  if ([15,16,17,18,19].includes(hourNow)) {
    s += 10; signals.push({ name: 'peak_attack_hour', score: 10 });
  }
  if (sells === 0 && buys > 100 && (tracker.age_hours ?? 999) < 6) {
    s += 10; signals.push({ name: 'buys_dominant_late', score: 10 });
  }
  const score = clamp(s, 0, 100);
  return { score, signals, source_health: 'ok' };
}

function scoreHoneypot(goplus, enrichment) {
  // Dimension is GoPlus-dependent. If GoPlus open, drop dim and renormalize.
  if (!goplus || goplus.source_health !== 'ok') {
    return { score: 0, signals: [], source_health: 'circuit_breaker_open' };
  }
  let s = 0;
  const signals = [];

  if (goplus.cannot_sell_all === 1) {
    s += 60; signals.push({ name: 'cannot_sell', score: 60 });
  }
  if (goplus.can_buy === 0) {
    s += 40; signals.push({ name: 'can_buy_false', score: 40 });
  }
  const fee = goplus.transfer_fee ?? null;
  let feeCounted = false;
  if (fee !== null) {
    if (fee > 0.10)       { s += 35; signals.push({ name: 'transfer_fee_extreme', score: 35 }); feeCounted = true; }
    else if (fee > 0.05)  { s += 20; signals.push({ name: 'transfer_fee_high', score: 20 }); feeCounted = true; }
  }

  // Token-2022 transfer fee fallback (when goplus doesn't catch SPL-2022 specifics)
  const ext = enrichment?.token_extensions;
  const tfe = ext?.extensions?.find(e => e.name === 'TransferFeeConfig');
  if (tfe && (tfe.newer_fee_basis_points || 0) > 1000) {
    if (!feeCounted) {
      s += 35; signals.push({ name: 'transfer_fee_extreme', score: 35 });
    }
  }

  if (goplus.blacklist_function === 1) {
    s += 25; signals.push({ name: 'blacklist_function_exists', score: 25 });
  }
  if (goplus.slippage_modifiable === 1) {
    s += 15; signals.push({ name: 'slippage_modifiable', score: 15 });
  }

  const score = clamp(s, 0, 100);
  return { score, signals, source_health: 'ok' };
}

function scoreAge(enrichment) {
  const tracker = enrichment?.external_sources?.solana_tracker || null;
  let s = 0;
  const signals = [];

  const ageHours = tracker?.age_hours ?? null;
  if (ageHours === null) {
    return { score: 0, signals: [], source_health: 'partial' };
  }
  if (ageHours < 1)         { s += 60; signals.push({ name: 'age_minutes', score: 60 }); }
  else if (ageHours < 24)   { s += 40; signals.push({ name: 'age_hours_1_24', score: 40 }); }
  else if (ageHours < 168)  { s += 20; signals.push({ name: 'age_days_1_7', score: 20 }); }
  else if (ageHours < 720)  { s += 5;  signals.push({ name: 'age_days_7_30', score: 5 }); }
  // age > 720 → 0 (mature)
  const score = clamp(s, 0, 100);
  return { score, signals, source_health: 'ok' };
}

// ── v1 import (Decision 3 alias flip — 5 paid paths default to v1) ─────────
const { calculateIRIS_v1, formatIrisForLLM_v1 } = require('./iris-score-v1');

// ── Aggregate ─────────────────────────────────────────────────────────────────
function calculateIRIS_v2(enrichment, scamDb, goplus) {
  const dims = {
    liquidity:     scoreLiquidity(enrichment),
    authority:     scoreAuthority(enrichment),
    concentration: scoreConcentration(enrichment),
    lineage:       scoreLineage(enrichment, scamDb?.scam_creators || null),
    reputation:    scoreReputation(enrichment, scamDb, goplus),
    trading:       scoreTrading(enrichment),
    honeypot:      scoreHoneypot(goplus, enrichment),
    age:           scoreAge(enrichment),
  };

  const failedEntries = Object.entries(dims).filter(([, d]) => d.source_health === 'circuit_breaker_open');
  const activeEntries = Object.entries(dims).filter(([, d]) => d.source_health !== 'circuit_breaker_open');

  // ≥3 failures → insufficient data, return null score
  if (failedEntries.length >= 3) {
    return {
      score: null,
      risk_level: 'unknown',
      risk_factors: [],
      breakdown: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, {
        score: v.source_health === 'circuit_breaker_open' ? null : v.score,
        weight: W[k],
        weighted_contribution: 0,
        signals: v.signals,
        source_health: v.source_health,
      }])),
      confidence_level: 'insufficient',
      renormalized: true,
      weights_version: _rules.version,
      methodology: 'IRIS v2.0 — intmolt.org/iris',
    };
  }

  // Renormalize weights over active dimensions
  const sumActiveWeights = activeEntries.reduce((s, [k]) => s + W[k], 0);
  const renormFactor = failedEntries.length > 0 ? 100 / sumActiveWeights : 1;

  // Weighted sum + breakdown
  let total = 0;
  const breakdown = {};
  for (const [k, d] of Object.entries(dims)) {
    const w = d.source_health === 'circuit_breaker_open' ? 0 : W[k] * renormFactor;
    const contribution = (d.score / 100) * w;
    total += contribution;
    breakdown[k] = {
      score: d.source_health === 'circuit_breaker_open' ? null : Math.round(d.score),
      weight: Math.round(w * 10) / 10,
      weighted_contribution: Math.round(contribution * 10) / 10,
      signals: d.signals,
      source_health: d.source_health,
    };
  }

  // Collect risk_factors from per-dim signals (must happen before floor logic so floors can mutate)
  const riskFactors = Object.values(breakdown)
    .flatMap(d => (d.signals || []).map(s => s.name))
    .filter(Boolean);

  // Floor 1: known_scam soft floor — only if scam_db_confidence STRICTLY > min_confidence.
  // min_confidence (0.5) = uninformative base prior z bulk SolRPDS importu (nulová korroborace);
  // floor vyžaduje confidence striktně nad prior, proto >, ne >= (G1 boundary fix 2026-06-12).
  const knownScam = scamDb?.known_scam || null;
  const confidence = knownScam?.confidence_score ?? knownScam?.confidence ?? 0;
  const hasHighConfidenceKnownScam = (knownScam != null && confidence > T.soft_floor_min_confidence);
  if (confidence > T.soft_floor_min_confidence) {
    const floor = T.soft_floor_offset + confidence * T.soft_floor_scale;
    if (total < floor) total = floor;
  }

  // Floor 2: External oracle danger floor (Amendment v3, 2026-05-19)
  // Applied when external oracle (RugCheck) classifies token as danger with high score_normalised
  // AND internal known_scams lacks high-confidence matching entry. Bridges ingest lag between
  // RC danger flag and SolRPDS poller catching up to known_scams DB.
  const rcRiskLevel = enrichment?.external_sources?.rugcheck?.risk_level || null;
  const rcScoreNorm = enrichment?.external_sources?.rugcheck?.score_normalised ?? null;
  if (rcRiskLevel === 'danger'
      && rcScoreNorm !== null
      && rcScoreNorm >= T.external_oracle_floor_min_score_norm
      && !hasHighConfidenceKnownScam) {
    const externalFloor = T.external_oracle_floor_offset +
      Math.max(0, rcScoreNorm - T.external_oracle_floor_min_score_norm) *
      T.external_oracle_floor_scale;
    if (total < externalFloor) {
      total = externalFloor;
      if (!riskFactors.includes('external_oracle_danger_floor_applied')) {
        riskFactors.push('external_oracle_danger_floor_applied');
      }
    }
  }

  // Soft whitelist
  const whitelist_strength = scamDb?.whitelisted ? (scamDb?.whitelist_meta?.tier === 1 ? 1.0 : 0.7) : 0;
  if (whitelist_strength > 0) {
    total = total * (1 - whitelist_strength * T.soft_whitelist_reduction);
  }

  total = Math.round(clamp(total, 0, 100));
  const risk_level = classifyRisk(total);

  const confidenceMap = { 0: 'high', 1: 'medium', 2: 'low' };

  return {
    score: total,
    risk_level,
    risk_factors: riskFactors,
    breakdown,
    confidence_level: confidenceMap[failedEntries.length] || 'high',
    renormalized: failedEntries.length > 0,
    weights_version: _rules.version,
    methodology: 'IRIS v2.0 — intmolt.org/iris',
  };
}

// ── Decision 3 (Hansova 2026-05-21): default alias points to v1 for 5 paid paths
// /scan/v1/ + token_audit call calculateIRIS_v2 explicitly. Scope B will migrate rest.
const calculateIRIS = calculateIRIS_v1;
const formatIrisForLLM = formatIrisForLLM_v1;

// ── v2 formatter (used by token_audit + /scan/v1/ paths) ──────────────────────
function formatIrisForLLM_v2(iris) {
  if (!iris) return '';
  const lines = [`Token IRIS Score: ${iris.score}/100 (${iris.risk_level})`, 'Breakdown:'];
  for (const [name, d] of Object.entries(iris.breakdown || {})) {
    const sigs = (d.signals || []).map(s => s.name).join(', ') || 'no signals';
    lines.push(`  ${name}: ${d.score}/100 (weight ${d.weight}, contribution ${d.weighted_contribution}) — ${sigs}`);
  }
  return lines.join('\n');
}

module.exports = { calculateIRIS_v1, calculateIRIS_v2, calculateIRIS, formatIrisForLLM, formatIrisForLLM_v1, formatIrisForLLM_v2 };
