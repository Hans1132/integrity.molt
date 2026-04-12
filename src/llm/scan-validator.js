'use strict';
// src/llm/scan-validator.js
// Validates and corrects LLM output against deterministic scan data.
// ŽÁDNÁ RPC VOLÁNÍ. ŽÁDNÉ I/O. Pure functions only.

const MAX_DRIFT_BELOW_DETERMINISTIC = 20; // LLM nesmí snížit skóre o víc než 20 bodů

/**
 * Validates LLM risk_score against deterministic rawScore.
 * Silently corrects violations and records them in flags[].
 *
 * @param {number} rawScore  - Deterministické skóre (0–100)
 * @param {object} llm       - LLM výstup { risk_score, category, summary, ... }
 * @param {object} auditData - Plná audit data z pipeline (žádné RPC)
 * @returns {{ corrected: object, flags: string[] }}
 */
function validateLLMScore(rawScore, llm, auditData) {
  if (!llm || typeof llm.risk_score !== 'number') {
    return { corrected: llm, flags: ['llm_score_missing'] };
  }

  const flags = [];
  let score = llm.risk_score;

  // Pravidlo 1: drift limit — LLM nesmí snížit skóre o více než MAX_DRIFT_BELOW_DETERMINISTIC
  const drift = rawScore - score;
  if (drift > MAX_DRIFT_BELOW_DETERMINISTIC) {
    score = rawScore - MAX_DRIFT_BELOW_DETERMINISTIC;
    flags.push(`llm_score_corrected_drift:${Math.round(drift)}`);
  }

  // Pravidlo 2: aktivní mint authority → score >= 40
  const mintAuthority = auditData?.mint_info?.mint_authority;
  const mintActive = mintAuthority && mintAuthority !== 'renounced' && mintAuthority !== null;
  if (mintActive && score < 40) {
    score = 40;
    flags.push('llm_score_corrected_mint_authority_active');
  }

  // Pravidlo 3: aktivní freeze authority → score >= 35
  const freezeAuthority = auditData?.mint_info?.freeze_authority;
  const freezeActive = freezeAuthority != null && freezeAuthority !== 'renounced';
  if (freezeActive && score < 35) {
    score = 35;
    flags.push('llm_score_corrected_freeze_authority_active');
  }

  // Pravidlo 4: top-1 holder > 50 % supply → score >= 31 (min CAUTION)
  const top1Pct = auditData?.concentration?.top1_pct ?? 0;
  if (top1Pct > 50 && score < 31) {
    score = 31;
    flags.push(`llm_score_corrected_concentration:top1=${top1Pct}%`);
  }

  // Pravidlo 5: critical/high findings → score >= 31
  const hasDanger = (auditData?.findings || [])
    .some(f => f.severity === 'critical' || f.severity === 'high');
  if (hasDanger && score < 31) {
    score = 31;
    flags.push('llm_score_corrected_danger_findings_present');
  }

  // Pravidlo 6: LLM nesmí přehodit kategorii z DANGER na SAFE/CAUTION při rawScore > 65
  if (rawScore > 65 && llm.category && llm.category !== 'DANGER') {
    flags.push(`llm_category_overridden:${llm.category}->DANGER`);
  }

  score = Math.round(Math.min(100, Math.max(0, score)));
  const finalCategory = rawScore > 65 ? 'DANGER' : scoreToCategory(score);
  const corrected = { ...llm, risk_score: score, category: finalCategory };
  return { corrected, flags };
}

/**
 * Validates adversarial simulation result against deterministic context.
 * Adds llm_validation_flags to result. Does NOT block execution.
 *
 * @param {object} adversarialResult
 * @param {object} deterministicContext  { rawScore, findings }
 * @returns {object} adversarialResult enriched with llm_validation_flags
 */
function validateAdversarialResult(adversarialResult, deterministicContext) {
  if (!adversarialResult || !deterministicContext) return adversarialResult;

  const flags = [];
  const { rawScore, findings } = deterministicContext;
  const reportedScore = adversarialResult.risk_score ?? adversarialResult.score;

  if (typeof reportedScore === 'number' && typeof rawScore === 'number') {
    const drift = rawScore - reportedScore;
    if (drift > MAX_DRIFT_BELOW_DETERMINISTIC) {
      flags.push(`adversarial_score_drift:${Math.round(drift)}`);
    }
  }

  // Verdict SAFE + critical findings = konflikt
  const hasCritical = (findings || []).some(f => f.severity === 'critical');
  if (hasCritical && adversarialResult.verdict === 'SAFE') {
    flags.push('adversarial_verdict_conflicts_critical_findings');
  }

  // Confidence příliš nízká pro silné verdikty
  const confidence = adversarialResult.confidence ?? 100;
  if (adversarialResult.verdict === 'VULNERABLE' && confidence < 40) {
    flags.push('adversarial_low_confidence_vulnerable');
  }

  if (!flags.length) return adversarialResult;
  return { ...adversarialResult, llm_validation_flags: flags };
}

function scoreToCategory(score) {
  if (score <= 30) return 'SAFE';
  if (score <= 65) return 'CAUTION';
  return 'DANGER';
}

module.exports = { validateLLMScore, validateAdversarialResult };
