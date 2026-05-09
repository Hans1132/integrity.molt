'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { getRugCheckSummary, classifyVerdict } = require('./rugcheck-client');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const SEVEN_DAYS_MS   = 7  * 24 * 60 * 60 * 1000;
const SIX_MONTHS_MS   = 6  * 30 * 24 * 60 * 60 * 1000;
const MIN_CONFIDENCE  = 0.5;

// V4_START anchor: only process pool_activity rows written by Bitquery pipeline,
// preventing retroactive mislabelling of any V3 Helius-era rows.
const stmtMarkInactive = db.prepare(`
  UPDATE pool_activity
  SET inactivity_status = 'inactive',
      updated_at = ?
  WHERE inactivity_status = 'active'
    AND last_swap_ts IS NOT NULL
    AND last_swap_ts < ?
    AND last_liquidity_remove_ts IS NOT NULL
    AND last_swap_ts < last_liquidity_remove_ts
    AND created_at >= (SELECT created_at FROM polling_state WHERE dex_program_id = 'bitquery_dexpools')
`);

// Fetch inactive pools that haven't been flagged yet under hybrid_realtime source
const stmtGetCandidates = db.prepare(`
  SELECT
    pool_address, mint,
    total_added_liquidity, total_removed_liquidity,
    add_count, remove_count,
    first_activity_ts, last_activity_ts
  FROM pool_activity
  WHERE inactivity_status = 'inactive'
    AND total_removed_liquidity > 0
    AND last_activity_ts < ?
    AND created_at >= (SELECT created_at FROM polling_state WHERE dex_program_id = 'bitquery_dexpools')
    AND mint NOT IN (SELECT mint FROM known_scams WHERE source = 'hybrid_realtime')
`);

const stmtInWhitelist = db.prepare(`SELECT 1 FROM token_whitelist WHERE mint = ? LIMIT 1`);

const stmtInsertFlag = db.prepare(`
  INSERT OR IGNORE INTO known_scams
    (mint, source, scam_type, confidence, rug_pattern,
     add_to_remove_ratio, inactivity_days, flagged_at,
     rugcheck_verified, rugcheck_response_summary, flag_reasons)
  VALUES (?, 'hybrid_realtime', 'rug_pull', ?, 'inactive_pool',
          ?, ?, ?,
          ?, ?, ?)
`);

async function scanForInactivity() {
  const now    = Date.now();
  const cutoff = now - SEVEN_DAYS_MS;

  try {
    // 1. Bulk-mark inactive (synchronous SQL)
    const inactiveResult = stmtMarkInactive.run(now, cutoff);

    // 2. Fetch candidates for flagging
    const candidates = stmtGetCandidates.all(cutoff);

    let flagged  = 0;
    let skipped  = 0;

    for (const pool of candidates) {
      const reasons    = [];
      let confidence   = 0.5; // base

      // Guard 1: Jupiter strict-list whitelist — skip legitimate tokens
      if (stmtInWhitelist.get(pool.mint)) {
        skipped++;
        continue;
      }

      // Guard 2: Token age — tokens < 6 months old have higher FP rate
      const ageOk = pool.first_activity_ts && pool.first_activity_ts < (now - SIX_MONTHS_MS);
      if (!ageOk) {
        skipped++;
        continue;
      }
      reasons.push('age_ok');
      confidence += 0.10;

      // Inactivity severity bonus (double the 7-day threshold = stronger signal)
      const inactivityDays = Math.floor((now - pool.last_activity_ts) / 86400000);
      if (inactivityDays >= 14) {
        confidence += 0.15;
        reasons.push('long_inactivity');
      }

      // Liquidity drain ratio bonus (more was removed than added = drain pattern)
      const ratio = pool.total_removed_liquidity > 0
        ? pool.total_added_liquidity / pool.total_removed_liquidity
        : null;
      if (ratio !== null && ratio < 0.5) {
        confidence += 0.10;
        reasons.push('high_drain_ratio');
      }

      // Guard 3: RugCheck cross-check (async, rate-limited, in-memory cached)
      let rugcheckVerified = 0;
      let rugcheckSummaryStr = null;
      try {
        const summary = await getRugCheckSummary(pool.mint);
        const verdict = classifyVerdict(summary);
        rugcheckVerified = verdict.verified ? 1 : 0;

        if (verdict.verified) {
          rugcheckSummaryStr = `rugged=${verdict.rugged},risk=${verdict.risk_level},score=${verdict.score}`;
          if (verdict.rugged) {
            confidence += 0.25; // external confirmation
            reasons.push('rugcheck_confirmed');
          } else if (verdict.risk_level === 'good') {
            confidence -= 0.25; // RugCheck says clean — penalise
            reasons.push('rugcheck_clean_penalty');
          }
        }
      } catch (_) {
        // RugCheck unavailable — no modifier, proceed without it
      }

      if (confidence < MIN_CONFIDENCE) {
        skipped++;
        continue;
      }

      stmtInsertFlag.run(
        pool.mint,
        Math.min(1.0, Math.max(0.0, confidence)),
        ratio,
        inactivityDays,
        now,
        rugcheckVerified,
        rugcheckSummaryStr,
        JSON.stringify(reasons),
      );
      flagged++;
    }

    console.log(
      `[inactivity-scanner] inactive=${inactiveResult.changes} candidates=${candidates.length}` +
      ` flagged=${flagged} skipped=${skipped}`
    );
    return { poolsMarkedInactive: inactiveResult.changes, newRugPullsFlagged: flagged, skipped, timestamp: now };

  } catch (err) {
    console.error('[inactivity-scanner] Error:', err.message);
    return { poolsMarkedInactive: 0, newRugPullsFlagged: 0, skipped: 0, error: err.message, timestamp: now };
  }
}

module.exports = { scanForInactivity };
