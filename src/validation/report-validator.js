'use strict';
// src/validation/report-validator.js
// Structural validation layer for scan reports — catches LLM hallucinations
// before Ed25519 signing.
// PURE FUNCTIONS ONLY — no I/O, no RPC, no DB calls here.

// Score thresholds matching the system's 3-level scale
const SCORE_SAFE_MAX    = 30;
const SCORE_CAUTION_MAX = 65;

// ── Hlavní validační funkce ───────────────────────────────────────────────────

/**
 * Validates an LLM-derived report against deterministic on-chain data.
 *
 * @param {object} llmReport     — top-level fields from auditResult (LLM-derived)
 * @param {object} rawOnChainData — auditResult.detail subtree (deterministic)
 * @returns {{ valid: boolean, issues: Array<{check, action, message, corrected_field, corrected_value}> }}
 */
function validateReport(llmReport, rawOnChainData) {
  if (!llmReport || typeof llmReport !== 'object') {
    return { valid: false, issues: [{ check: 'input_guard', action: 'escalate', message: 'llmReport is null or not an object' }] };
  }
  const issues = [];

  _checkScoreBounds(llmReport, issues);
  _checkScoreLevelConsistency(llmReport, issues);
  _checkMintAuthorityConsistency(llmReport, rawOnChainData, issues);
  _checkTokenTypeConsistency(llmReport, rawOnChainData, issues);
  _checkScamDbMatchScore(llmReport, issues);
  _checkProxyDetection(llmReport, issues);
  _checkHolderCountSanity(llmReport, rawOnChainData, issues);
  _checkFabricatedAddresses(llmReport, rawOnChainData, issues);

  return { valid: issues.length === 0, issues };
}

// ── Check #1: Risk score bounds ───────────────────────────────────────────────

function _checkScoreBounds(report, issues) {
  const score = report.risk_score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    issues.push({
      check:           'score_bounds',
      action:          'correct',
      message:         `risk_score is not a finite number: ${score}`,
      corrected_field: 'risk_score',
      corrected_value: 50,
    });
    return;
  }
  if (score < 0 || score > 100) {
    const clamped = Math.round(Math.min(100, Math.max(0, score)));
    issues.push({
      check:           'score_bounds',
      action:          'correct',
      message:         `risk_score ${score} out of bounds [0–100], clamped to ${clamped}`,
      corrected_field: 'risk_score',
      corrected_value: clamped,
    });
  }
}

// ── Check #2: Score / level consistency ──────────────────────────────────────

function _checkScoreLevelConsistency(report, issues) {
  const score    = typeof report.risk_score === 'number' ? report.risk_score : null;
  const category = report.category;
  if (score === null || !category) return;

  const expected = _scoreToCategory(score);
  if (category !== expected) {
    issues.push({
      check:           'score_level_consistency',
      action:          'correct',
      message:         `category "${category}" inconsistent with risk_score ${score} (expected "${expected}")`,
      corrected_field: 'category',
      corrected_value: expected,
    });
  }
}

// ── Check #3: Mint authority consistency ─────────────────────────────────────

function _checkMintAuthorityConsistency(report, raw, issues) {
  if (!raw?.mint_info) return;

  const mintAuth  = raw.mint_info.mint_authority;
  const isActive  = mintAuth && mintAuth !== 'renounced' && mintAuth !== null;
  const score     = typeof report.risk_score === 'number' ? report.risk_score : null;

  if (isActive && score !== null && score < 40) {
    issues.push({
      check:           'mint_authority_consistency',
      action:          'correct',
      message:         `Mint authority is active (${mintAuth}) but risk_score is ${score} — minimum is 40`,
      corrected_field: 'risk_score',
      corrected_value: 40,
    });
  }

  // If active mint authority is not mentioned in findings at all → escalate
  const hasMintFinding = (report.findings || []).some(
    f => f.category === 'mint-authority' || (f.label || '').toLowerCase().includes('mint authority')
  );
  if (isActive && !hasMintFinding) {
    issues.push({
      check:   'mint_authority_consistency',
      action:  'escalate',
      message: `Mint authority is active (${mintAuth}) but no finding in report — possible hallucination`,
    });
  }
}

// ── Check #4: Token type consistency ─────────────────────────────────────────

function _checkTokenTypeConsistency(report, raw, issues) {
  if (!raw?.mint_info) return;

  const isToken2022 = raw.mint_info.is_token_2022;
  const extensions  = raw.extensions || [];

  // If Token-2022 but no mention in findings AND transfer fee extensions present
  const hasTransferFee = extensions.some(e => e.name === 'transferFeeConfig' || e.name === 'transfer_fee_config');
  if (isToken2022 && hasTransferFee) {
    const hasFeeFinding = (report.findings || []).some(
      f => f.category === 'transfer-fee' || (f.label || '').toLowerCase().includes('transfer fee')
    );
    if (!hasFeeFinding) {
      issues.push({
        check:   'token_type_consistency',
        action:  'escalate',
        message: 'Token-2022 with transferFeeConfig extension but no transfer-fee finding in report',
      });
    }
  }

  // If summary explicitly says "not Token-2022" but is_token_2022 is true
  const summaryLower = (report.summary || '').toLowerCase();
  if (isToken2022 && summaryLower.includes('not token-2022')) {
    issues.push({
      check:   'token_type_consistency',
      action:  'escalate',
      message: 'Summary claims "not Token-2022" but on-chain data shows is_token_2022=true',
    });
  }
}

// ── Check #5: Known scam DB match → score floor ───────────────────────────────

function _checkScamDbMatchScore(report, issues) {
  const dbMatches = report.db_matches || [];
  const score     = typeof report.risk_score === 'number' ? report.risk_score : null;
  if (score === null) return;

  const hasKnownScam = dbMatches.some(m =>
    m.source === 'known_scam' ||
    (m.source === 'rugcheck' && m.type === 'rugged')
  );

  if (hasKnownScam && score <= SCORE_CAUTION_MAX) {
    issues.push({
      check:           'scam_db_match_score',
      action:          'correct',
      message:         `Token has known-scam DB match but risk_score is ${score} (must be > ${SCORE_CAUTION_MAX})`,
      corrected_field: 'risk_score',
      corrected_value: 66,
    });
  }

  const hasHighRisk = dbMatches.some(m =>
    m.source === 'rugcheck' && (m.type === 'danger' || m.type === 'high')
  );
  if (hasHighRisk && score < 50) {
    issues.push({
      check:           'scam_db_match_score',
      action:          'correct',
      message:         `Token has rugcheck high/danger match but risk_score is ${score} (minimum 50)`,
      corrected_field: 'risk_score',
      corrected_value: 50,
    });
  }
}

// ── Check #6: Proxy detection (EVM only — skip for Solana) ───────────────────

function _checkProxyDetection(report, issues) {
  // Solana tokeny proxy pattern detekci nemají — poznamenej ale neflaguj jako issue
  // EVM proxy check is irrelevant here; log as informational skip only in flags
  void report; // intentionally unused
}

// ── Check #7: Holder count sanity ────────────────────────────────────────────

function _checkHolderCountSanity(report, raw, issues) {
  const top1Pct = raw?.concentration?.top1_pct ?? null;
  const score   = typeof report.risk_score === 'number' ? report.risk_score : null;
  if (top1Pct === null || score === null) return;

  // Extreme concentration: top-1 > 80 % → minimum CAUTION + floor 50
  if (top1Pct > 80 && score < 50) {
    issues.push({
      check:           'holder_count_sanity',
      action:          'correct',
      message:         `Top-1 holder owns ${top1Pct}% of supply but risk_score is only ${score} (minimum 50)`,
      corrected_field: 'risk_score',
      corrected_value: 50,
    });
  }

  // Impossible holder count: top-1 pct > 100 or negative
  if (top1Pct > 100 || top1Pct < 0) {
    issues.push({
      check:   'holder_count_sanity',
      action:  'escalate',
      message: `top1_pct value ${top1Pct} is outside valid range [0–100] — data integrity issue`,
    });
  }
}

// ── Check #8: Fabricated addresses ────────────────────────────────────────────

function _checkFabricatedAddresses(report, raw, issues) {
  // Mint address in report must match raw on-chain data
  const reportMint = report.mint_address;
  const rawMint    = raw?.mint_address;
  if (reportMint && rawMint && reportMint !== rawMint) {
    issues.push({
      check:   'fabricated_addresses',
      action:  'escalate',
      message: `mint_address mismatch: report has "${reportMint}", raw data has "${rawMint}"`,
    });
  }

  // No EVM-style 0x addresses should appear in a Solana report
  const allText = JSON.stringify(report);
  const evmPattern = /\b0x[0-9a-fA-F]{40}\b/;
  if (evmPattern.test(allText)) {
    const matches = allText.match(/0x[0-9a-fA-F]{40}/g) || [];
    issues.push({
      check:   'fabricated_addresses',
      action:  'escalate',
      message: `EVM-style address(es) found in Solana report: ${[...new Set(matches)].slice(0, 3).join(', ')}`,
    });
  }
}

// ── Corrections ───────────────────────────────────────────────────────────────

/**
 * Applies corrections in-place to auditResult.
 * Only applies issues where action === 'correct'.
 * Returns the count of corrections applied.
 *
 * @param {object} auditResult — full result object from auditToken()
 * @param {Array}  issues      — from validateReport()
 * @returns {number} corrections applied
 */
function applyCorrectionsToAuditResult(auditResult, issues) {
  let count = 0;
  for (const issue of issues) {
    if (issue.action !== 'correct') continue;
    if (!issue.corrected_field) continue;

    if (issue.corrected_field === 'risk_score') {
      // Apply the highest corrected score (worst-case wins)
      const current = auditResult.risk_score ?? 0;
      if (issue.corrected_value > current) {
        auditResult.risk_score = issue.corrected_value;
        count++;
      }
    } else if (issue.corrected_field === 'category') {
      auditResult.category = issue.corrected_value;
      count++;
    }
  }

  // Re-sync category after all score corrections
  if (typeof auditResult.risk_score === 'number') {
    const correctCategory = _scoreToCategory(auditResult.risk_score);
    if (auditResult.category !== correctCategory) {
      auditResult.category = correctCategory;
    }
  }

  return count;
}

// ── Adapter helpers ───────────────────────────────────────────────────────────

/**
 * Extracts the LLM-derived fields from a full auditResult.
 * These are the fields that can be hallucinated.
 */
function buildLLMReportFromAuditResult(auditResult) {
  return {
    mint_address:    auditResult.mint_address,
    risk_score:      auditResult.risk_score,
    category:        auditResult.category,
    summary:         auditResult.summary,
    key_risks:       auditResult.key_risks,
    recommendations: auditResult.recommendations,
    findings:        auditResult.findings,
    db_matches:      auditResult.db_matches,
  };
}

/**
 * Extracts raw deterministic on-chain data from auditResult.detail.
 * This is the ground truth used for cross-checking.
 */
function buildRawDataFromAuditResult(auditResult) {
  const d = auditResult.detail || {};
  return {
    mint_address:  auditResult.mint_address,
    mint_info:     d.mint_info     || null,
    extensions:    d.extensions    || [],
    concentration: d.concentration || null,
    top_holders:   d.top_holders   || [],
    metadata:      d.metadata      || null,
    treasury:      d.treasury      || null,
  };
}

// ── Telegram / response formatting ────────────────────────────────────────────

/**
 * Returns a short validation status string for Telegram messages.
 *
 * @param {{ valid: boolean, issues: Array }} validationResult
 * @param {number} correctionsApplied
 * @returns {string}
 */
function formatValidationStatus(validationResult, correctionsApplied) {
  if (!validationResult) return '';
  const { valid, issues } = validationResult;
  const escalations = issues.filter(i => i.action === 'escalate').length;

  if (valid) return '✅ Verified';
  if (correctionsApplied > 0 && escalations === 0) return `⚠️ Auto-corrected (${correctionsApplied} fix${correctionsApplied !== 1 ? 'es' : ''})`;
  if (escalations > 0) return '🔴 Validation failed — manual review needed';
  return `⚠️ Auto-corrected (${correctionsApplied} fixes)`;
}

// ── Util ──────────────────────────────────────────────────────────────────────

function _scoreToCategory(score) {
  if (score <= SCORE_SAFE_MAX)    return 'SAFE';
  if (score <= SCORE_CAUTION_MAX) return 'CAUTION';
  return 'DANGER';
}

module.exports = {
  validateReport,
  applyCorrectionsToAuditResult,
  buildLLMReportFromAuditResult,
  buildRawDataFromAuditResult,
  formatValidationStatus,
};
