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

// Marks swap rows as inactive when ANY row for the same mint has a removal
// that post-dates the last swap — allows Helius (SWAP) and Bitquery (REMOVAL)
// to write different pool_address values for the same mint (bug_033).
const stmtMarkInactive = db.prepare(`
  UPDATE pool_activity
  SET inactivity_status = 'inactive',
      updated_at = ?
  WHERE inactivity_status = 'active'
    AND last_swap_ts IS NOT NULL
    AND last_swap_ts < ?
    AND created_at >= ?
    AND EXISTS (
      SELECT 1 FROM pool_activity sub
      WHERE sub.mint = pool_activity.mint
        AND sub.last_liquidity_remove_ts IS NOT NULL
        AND pool_activity.last_swap_ts < sub.last_liquidity_remove_ts
    )
`);

// Aggregates liquidity across all rows per mint so Helius swap rows and
// Bitquery removal rows (different pool_address) contribute to one candidate.
const stmtGetCandidates = db.prepare(`
  SELECT
    MIN(pa.pool_address) AS pool_address,
    pa.mint,
    COALESCE(agg.total_added_liquidity, 0) AS total_added_liquidity,
    COALESCE(agg.total_removed_liquidity, 0) AS total_removed_liquidity,
    COALESCE(agg.add_count, 0) AS add_count,
    COALESCE(agg.remove_count, 0) AS remove_count,
    MIN(pa.first_activity_ts) AS first_activity_ts,
    MAX(pa.last_activity_ts) AS last_activity_ts,
    MAX(pa.last_swap_ts) AS last_swap_ts
  FROM pool_activity pa
  JOIN (
    SELECT mint,
      SUM(total_added_liquidity) AS total_added_liquidity,
      SUM(total_removed_liquidity) AS total_removed_liquidity,
      SUM(add_count) AS add_count,
      SUM(remove_count) AS remove_count
    FROM pool_activity
    GROUP BY mint
    HAVING SUM(total_removed_liquidity) > 0
  ) agg ON agg.mint = pa.mint
  WHERE pa.inactivity_status = 'inactive'
    AND pa.last_swap_ts < ?
    AND pa.created_at >= ?
    AND pa.mint NOT IN (SELECT mint FROM known_scams)
  GROUP BY pa.mint
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

let _inProgress = false;

async function scanForInactivity() {
  if (_inProgress) {
    console.warn('[inactivity-scanner] previous scan still running — skipping');
    return { poolsMarkedInactive: 0, newRugPullsFlagged: 0, skipped: 0, skippedRun: true, timestamp: Date.now() };
  }
  _inProgress = true;

  const now    = Date.now();
  const cutoff = now - SEVEN_DAYS_MS;

  try {
    // Lazy anchor lookup — recovers from missing row without PM2 restart
    const anchorRow = db.prepare(
      `SELECT created_at FROM polling_state WHERE dex_program_id = 'bitquery_dexpools'`
    ).get();
    if (!anchorRow) {
      console.error('[inactivity-scanner] ERROR: bitquery_dexpools row missing from polling_state — scanner disabled');
      return { poolsMarkedInactive: 0, newRugPullsFlagged: 0, skipped: 0, error: 'V4 anchor missing', timestamp: now };
    }
    const v4AnchorMs = anchorRow.created_at;

    // 1. Bulk-mark inactive (synchronous SQL)
    const inactiveResult = stmtMarkInactive.run(now, cutoff, v4AnchorMs);

    // 2. Fetch candidates for flagging
    const candidates = stmtGetCandidates.all(cutoff, v4AnchorMs);

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

      // Guard 2: Age filter — skip tokens pipeline has observed for > 6 months.
      // first_activity_ts is pipeline-first-seen, not on-chain creation time.
      // Tokens observed > 6 months ago are likely stable projects, not active rugs.
      // TODO: rewire to on-chain creation time via Helius/RugCheck for accuracy (bug_010).
      const ageOk = pool.first_activity_ts && pool.first_activity_ts > (now - SIX_MONTHS_MS);
      if (!ageOk) {
        skipped++;
        continue;
      }
      reasons.push('age_ok');
      confidence += 0.10;

      // Inactivity severity bonus (≥ 14 days = double the threshold)
      const inactivityDays = Math.floor((now - pool.last_swap_ts) / 86400000);
      if (inactivityDays >= 14) {
        confidence += 0.15;
        reasons.push('long_inactivity');
      }

      // Liquidity drain ratio bonus
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
            confidence += 0.25;
            reasons.push('rugcheck_confirmed');
          } else if (verdict.risk_level === 'good') {
            confidence -= 0.25;
            reasons.push('rugcheck_clean_penalty');
          }
        }
      } catch (err) {
        console.warn('[inactivity-scanner] RugCheck unavailable for %s: %s', pool.mint.slice(0, 12), err.message);
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
  } finally {
    _inProgress = false;
  }
}

module.exports = { scanForInactivity };
