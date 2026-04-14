'use strict';
/**
 * src/a2a/autopilot.js — AutoPilot co-signing rules engine
 *
 * Enforces per-transaction and daily USDC spending limits for autonomous
 * AI agent (OpenClaw / .molt domain token) transactions. All decisions
 * are logged to the autopilot_spending SQLite table.
 *
 * Rules (checked in order):
 *   1. AutoPilot must be enabled (AUTOPILOT_ENABLED env)
 *   2. amountUsdc <= maxTxUsdc (per-transaction cap)
 *   3. skillId must be in allowedSkills list (if list is defined)
 *   4. dailySpent + amountUsdc <= maxDailyUsdc (rolling daily cap per agent mint)
 *
 * All limits are configured via .env — never hardcoded.
 */

const { db } = require('../../db');
const config  = require('../../config/autopilot');

// ── Schema init ───────────────────────────────────────────────────────────────

function initAutopilotSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_spending (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_mint       TEXT    NOT NULL,
      skill_id         TEXT    NOT NULL,
      amount_usdc      REAL    NOT NULL,
      tx_sig           TEXT,
      decision         TEXT    NOT NULL,   -- 'approved' | 'rejected'
      rejection_reason TEXT,
      created_at       INTEGER NOT NULL    -- unix ms
    );
    CREATE INDEX IF NOT EXISTS autopilot_spending_mint_day
      ON autopilot_spending (agent_mint, created_at DESC);
    CREATE INDEX IF NOT EXISTS autopilot_spending_decision
      ON autopilot_spending (decision, created_at DESC);
  `);
}

// Self-initialize when module is first required (better-sqlite3 is synchronous).
initAutopilotSchema();

// ── Core decision logic ───────────────────────────────────────────────────────

/**
 * canAutoSign — evaluate whether an agent transaction may be auto-signed.
 *
 * @param {string} agentMint  Mint address of the .molt agent token
 * @param {string} skillId    Skill being invoked (e.g. 'quick_scan', 'token_audit')
 * @param {number} amountUsdc Transaction cost in USDC (float, e.g. 0.75)
 * @returns {{ approved: boolean, reason?: string }}
 */
function canAutoSign(agentMint, skillId, amountUsdc) {
  // 1. AutoPilot must be enabled
  if (!config.enabled) {
    return { approved: false, reason: 'AutoPilot is disabled' };
  }

  // 2. Per-transaction cap
  if (amountUsdc > config.maxTxUsdc) {
    return {
      approved: false,
      reason: `Transaction amount ${amountUsdc} USDC exceeds per-tx limit ${config.maxTxUsdc} USDC`,
    };
  }

  // 3. Skill whitelist (null = all allowed)
  if (config.allowedSkills !== null && !config.allowedSkills.includes(skillId)) {
    return {
      approved: false,
      reason: `Skill '${skillId}' is not in AutoPilot allowedSkills list`,
    };
  }

  // 4. Daily spending cap per agent mint
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_usdc), 0) AS daily_spent,
           COUNT(*)                       AS tx_count
    FROM autopilot_spending
    WHERE agent_mint = ?
      AND decision   = 'approved'
      AND created_at >= ?
  `).get(agentMint, todayMs);

  const dailySpent = row?.daily_spent ?? 0;

  if (dailySpent + amountUsdc > config.maxDailyUsdc) {
    return {
      approved: false,
      reason: `Daily limit exceeded: spent ${dailySpent.toFixed(6)} USDC, limit ${config.maxDailyUsdc} USDC`,
    };
  }

  return { approved: true };
}

// ── Logging ───────────────────────────────────────────────────────────────────

/**
 * logAutoSignDecision — persist every AutoPilot decision to SQLite.
 *
 * @param {string}      agentMint  Mint address of the agent token
 * @param {string}      skillId    Skill that was requested
 * @param {number}      amountUsdc Cost in USDC (float)
 * @param {'approved'|'rejected'} decision
 * @param {string|null} [txSig]    On-chain transaction signature (approved only)
 * @param {string|null} [reason]   Rejection reason (rejected only)
 */
function logAutoSignDecision(agentMint, skillId, amountUsdc, decision, txSig = null, reason = null) {
  db.prepare(`
    INSERT INTO autopilot_spending
      (agent_mint, skill_id, amount_usdc, tx_sig, decision, rejection_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(agentMint, skillId, amountUsdc, txSig || null, decision, reason || null, Date.now());
}

// ── Spending query ────────────────────────────────────────────────────────────

/**
 * getAgentDailySpending — return today's spending summary for an agent mint.
 *
 * @param {string} agentMint
 * @returns {{ spent_usdc: number, limit_usdc: number, remaining_usdc: number, tx_count: number }}
 */
function getAgentDailySpending(agentMint) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_usdc), 0) AS spent_usdc,
           COUNT(*)                       AS tx_count
    FROM autopilot_spending
    WHERE agent_mint = ?
      AND decision   = 'approved'
      AND created_at >= ?
  `).get(agentMint, todayMs);

  const spentUsdc    = row?.spent_usdc ?? 0;
  const limitUsdc    = config.maxDailyUsdc;
  const remainingUsdc = Math.max(0, limitUsdc - spentUsdc);

  return {
    spent_usdc:     spentUsdc,
    limit_usdc:     limitUsdc,
    remaining_usdc: remainingUsdc,
    tx_count:       row?.tx_count ?? 0,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initAutopilotSchema,
  canAutoSign,
  logAutoSignDecision,
  getAgentDailySpending,
};
