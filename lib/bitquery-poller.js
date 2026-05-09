'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { fetchLiquidityChanges } = require('./bitquery-client');
const { transformPoolEventToLiquidityEvents } = require('./bitquery-event-transformer');
const { recordBatch } = require('./liquidity-event-processor');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'intmolt.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const DEX_ID = 'bitquery_dexpools';
// Free plan: 1000 pts/month. At ~8 pts/query with limit=500, 12h interval
// gives ~60 queries/month ≈ 480 pts. Adjust BITQUERY_POLL_INTERVAL_HOURS for paid plans.
const MAX_PAGES_PER_CYCLE = 5;
const PAGE_SIZE = parseInt(process.env.BITQUERY_PAGE_SIZE || '500', 10);

const stmtGetState = db.prepare(`SELECT last_seen_ts FROM polling_state WHERE dex_program_id = ?`);
const stmtUpdateState = db.prepare(`
  UPDATE polling_state
  SET last_seen_signature  = COALESCE(?, last_seen_signature),
      last_seen_ts         = ?,
      last_poll_ts         = ?,
      last_poll_tx_count   = ?,
      last_poll_credits_used = ?,
      total_polls          = total_polls + 1,
      total_credits_used   = total_credits_used + ?,
      total_tx_processed   = total_tx_processed + ?,
      last_error           = NULL,
      last_error_ts        = NULL
  WHERE dex_program_id = ?
`);
const stmtRecordError = db.prepare(`
  UPDATE polling_state
  SET last_error           = ?,
      last_error_ts        = ?,
      last_poll_credits_used = ?,
      total_credits_used   = total_credits_used + ?
  WHERE dex_program_id = ?
`);

async function pollBitquery() {
  const startTs = Date.now();
  let totalEvents = 0;
  let totalPages = 0;
  let creditsEstimate = 0;

  const state = stmtGetState.get(DEX_ID);
  // Default: 12 hours ago (safe for free plan; reduces duplicate processing)
  const defaultSince = startTs - 12 * 60 * 60 * 1000;
  let sinceMs = state?.last_seen_ts || defaultSince;
  let sinceIso = new Date(sinceMs).toISOString();

  let latestSeenTs = sinceMs;
  let latestSeenSignature = null;

  try {
    while (totalPages < MAX_PAGES_PER_CYCLE) {
      console.log(`[BITQUERY] Page ${totalPages + 1}, since=${sinceIso}`);
      const poolEvents = await fetchLiquidityChanges(sinceIso, PAGE_SIZE);
      creditsEstimate += 8; // refine after first real cycle

      if (!poolEvents || poolEvents.length === 0) break;

      const liquidityEvents = [];
      for (const poolEvent of poolEvents) {
        const eventTs = new Date(poolEvent.Block.Time).getTime();
        if (eventTs > latestSeenTs) {
          latestSeenTs = eventTs;
          latestSeenSignature = poolEvent.Transaction.Signature;
        }
        liquidityEvents.push(...transformPoolEventToLiquidityEvents(poolEvent));
      }

      if (liquidityEvents.length > 0) {
        recordBatch(liquidityEvents);
        totalEvents += liquidityEvents.length;
      }

      totalPages++;
      if (poolEvents.length < PAGE_SIZE) break;

      sinceIso = new Date(latestSeenTs + 1000).toISOString();
    }

    stmtUpdateState.run(
      latestSeenSignature,
      latestSeenTs,
      startTs,
      totalEvents,
      creditsEstimate,
      creditsEstimate,
      totalEvents,
      DEX_ID,
    );

    console.log(`[BITQUERY] Done: ${totalEvents} events, ~${creditsEstimate} pts, ${totalPages} pages`);
    return { success: true, totalEvents, totalPages, creditsEstimate };

  } catch (error) {
    console.error('[BITQUERY] Poll failed:', error.message);
    stmtRecordError.run(error.message.slice(0, 500), startTs, creditsEstimate, creditsEstimate, DEX_ID);
    return { success: false, error: error.message, totalEvents, creditsEstimate };
  }
}

module.exports = { pollBitquery };
