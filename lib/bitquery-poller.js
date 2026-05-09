'use strict';

// Bitquery V4 poller — hybrid SolRPDS extension pipeline.
//
// Role in hybrid architecture:
//   Helius poller (V3): SWAP events → pool_activity.last_swap_ts
//   Bitquery poller (V4, this file): REMOVE_LIQUIDITY events → pool_activity.last_liquidity_remove_ts
//   Inactivity scanner: SolRPDS §4.3 — flags pool as rug pull when
//     last_swap_ts < (now-7d) AND last_swap_ts < last_liquidity_remove_ts
//
// Single page, no pagination — keeps credit cost at ~5 pts/poll.
// At 4h interval: 6 polls/day × 30 days × 5 pts = 900 pts/month (free plan: 1000 pts).

const Database = require('better-sqlite3');
const path = require('path');
const { fetchLiquidityRemovals } = require('./bitquery-client');
const { transformPoolEventToLiquidityEvents } = require('./bitquery-event-transformer');
const { recordBatch } = require('./liquidity-event-processor');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'intmolt.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const DEX_ID = 'bitquery_dexpools';

const stmtGetState = db.prepare(`SELECT last_seen_ts FROM polling_state WHERE dex_program_id = ?`);
const stmtUpdateState = db.prepare(`
  UPDATE polling_state
  SET last_seen_signature    = COALESCE(?, last_seen_signature),
      last_seen_ts           = ?,
      last_poll_ts           = ?,
      last_poll_tx_count     = ?,
      last_poll_credits_used = ?,
      total_polls            = total_polls + 1,
      total_credits_used     = total_credits_used + ?,
      total_tx_processed     = total_tx_processed + ?,
      last_error             = NULL,
      last_error_ts          = NULL
  WHERE dex_program_id = ?
`);
const stmtRecordError = db.prepare(`
  UPDATE polling_state
  SET last_error             = ?,
      last_error_ts          = ?,
      last_poll_credits_used = ?,
      total_credits_used     = total_credits_used + ?
  WHERE dex_program_id = ?
`);

async function pollBitquery() {
  const startTs = Date.now();
  const credits = 5; // ~5 pts per single filtered query

  const state = stmtGetState.get(DEX_ID);
  const sinceMs = state?.last_seen_ts || (startTs - 4 * 60 * 60 * 1000);
  const sinceIso = new Date(sinceMs).toISOString();

  let latestSeenTs = sinceMs;
  let latestSeenSig = null;

  try {
    console.log(`[BITQUERY-V4] Fetching removals since=${sinceIso}`);
    const poolEvents = await fetchLiquidityRemovals(sinceIso);

    const removalEvents = [];
    for (const poolEvent of poolEvents) {
      const ts = new Date(poolEvent.Block.Time).getTime();
      if (ts > latestSeenTs) {
        latestSeenTs = ts;
        latestSeenSig = poolEvent.Transaction.Signature;
      }

      // Only record REMOVE_LIQUIDITY events — SWAPs are handled by Helius V3 poller
      for (const ev of transformPoolEventToLiquidityEvents(poolEvent)) {
        if (ev.eventType === 'REMOVE_LIQUIDITY') removalEvents.push(ev);
      }
    }

    if (removalEvents.length > 0) recordBatch(removalEvents);

    stmtUpdateState.run(latestSeenSig, latestSeenTs, startTs,
      removalEvents.length, credits, credits, removalEvents.length, DEX_ID);

    console.log(`[BITQUERY-V4] Done: ${poolEvents.length} raw, ${removalEvents.length} removals recorded`);
    return { success: true, rawEvents: poolEvents.length, removalEvents: removalEvents.length, credits };

  } catch (err) {
    console.error('[BITQUERY-V4] Poll failed:', err.message);
    stmtRecordError.run(err.message.slice(0, 500), startTs, credits, credits, DEX_ID);
    return { success: false, error: err.message, credits };
  }
}

module.exports = { pollBitquery };
