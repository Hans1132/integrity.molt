'use strict';

require('dotenv').config({ path: '/root/x402-server/.env' });

const Database = require('better-sqlite3');
const path = require('path');
const { recordBatch } = require('./liquidity-event-processor');

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, '..', 'data', 'intmolt.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const DEX_PROGRAMS = [
  { id: 'raydium_amm',    name: 'Raydium AMM v4',  programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' },
  { id: 'raydium_cpmm',   name: 'Raydium CPMM',     programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' },
  { id: 'orca_whirlpool', name: 'Orca Whirlpool',   programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'  },
  { id: 'pumpfun',        name: 'Pump.fun',          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'  },
  { id: 'meteora_dlmm',   name: 'Meteora DLMM',      programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'  },
];

const MAX_PAGES = 50;

function parseTransaction(tx) {
  const events = [];
  const txTimestamp = (tx.timestamp || 0) * 1000;
  const signature = tx.signature;

  const typeMap = {
    'ADD_LIQUIDITY':    'ADD_LIQUIDITY',
    'REMOVE_LIQUIDITY': 'REMOVE_LIQUIDITY',
    'WITHDRAW':         'REMOVE_LIQUIDITY',
    'SWAP':             'SWAP',
  };

  const eventType = typeMap[tx.type];
  if (!eventType) return [];

  try {
    if (eventType === 'SWAP' && tx.events?.swap) {
      const swap = tx.events.swap;
      const poolAddress = swap.innerSwaps?.[0]?.programInfo?.account
        || tx.accountData?.[0]?.account
        || 'unknown';

      const inputs = swap.tokenInputs || [];
      if (inputs.length > 0) {
        for (const input of inputs) {
          if (!input.mint) continue;
          events.push({
            eventType: 'SWAP',
            poolAddress,
            mint: input.mint,
            amount: parseFloat(input.tokenAmount) || 0,
            timestamp: txTimestamp,
            txHash: signature,
          });
        }
      } else {
        for (const t of (tx.tokenTransfers || [])) {
          if (!t.mint) continue;
          events.push({
            eventType: 'SWAP',
            poolAddress: t.toUserAccount || t.fromUserAccount || 'unknown',
            mint: t.mint,
            amount: parseFloat(t.tokenAmount) || 0,
            timestamp: txTimestamp,
            txHash: signature,
          });
        }
      }
      return events;
    }

    for (const transfer of (tx.tokenTransfers || [])) {
      if (!transfer.mint) continue;
      events.push({
        eventType,
        poolAddress: transfer.toUserAccount || transfer.fromUserAccount || 'unknown',
        mint: transfer.mint,
        amount: parseFloat(transfer.tokenAmount) || 0,
        timestamp: txTimestamp,
        txHash: signature,
      });
    }
  } catch (err) {
    console.warn(`[helius-poller] parseTransaction error on ${signature}: ${err.message}`);
  }

  return events;
}

async function pollSingleDex(dex) {
  const startTs = Date.now();
  let creditsUsed = 0;
  let txProcessed = 0;
  let pageBefore = null;
  let totalPages = 0;

  const state = db.prepare(
    'SELECT last_seen_signature, last_seen_ts FROM polling_state WHERE dex_program_id = ?'
  ).get(dex.programId);

  const stopAtSignature = state?.last_seen_signature || null;
  const stopAtTs = state?.last_seen_ts || 0;

  let firstSignatureThisCycle = null;
  let firstTimestampThisCycle = null;

  try {
    while (totalPages < MAX_PAGES) {
      const url = new URL(`https://api.helius.xyz/v0/addresses/${dex.programId}/transactions`);
      url.searchParams.set('api-key', process.env.HELIUS_API_KEY);
      url.searchParams.set('limit', '100');
      ['ADD_LIQUIDITY', 'REMOVE_LIQUIDITY', 'WITHDRAW', 'SWAP'].forEach(t =>
        url.searchParams.append('type', t)
      );
      if (pageBefore) url.searchParams.set('before', pageBefore);

      const response = await fetch(url.toString());
      creditsUsed++;

      if (!response.ok) {
        if (response.status === 404) {
          console.warn(`[helius-poller] DEX ${dex.name} returned 404, skipping`);
          return { success: false, reason: 'not_found', creditsUsed, txProcessed };
        }
        const body = await response.text();
        throw new Error(`Helius API ${response.status}: ${body.slice(0, 200)}`);
      }

      const transactions = await response.json();
      if (!Array.isArray(transactions) || transactions.length === 0) break;

      if (!firstSignatureThisCycle) {
        firstSignatureThisCycle = transactions[0].signature;
        firstTimestampThisCycle = (transactions[0].timestamp || 0) * 1000;
      }

      const events = [];
      let reachedKnownTx = false;

      for (const tx of transactions) {
        if (stopAtSignature && tx.signature === stopAtSignature) {
          reachedKnownTx = true;
          break;
        }
        if (stopAtTs && ((tx.timestamp || 0) * 1000) <= stopAtTs) {
          reachedKnownTx = true;
          break;
        }

        const parsed = parseTransaction(tx);
        if (parsed.length > 0) {
          events.push(...parsed);
          txProcessed++;
        }
      }

      if (events.length > 0) {
        recordBatch(events);
      }

      if (reachedKnownTx) break;

      pageBefore = transactions[transactions.length - 1].signature;
      totalPages++;

      if (transactions.length < 100) break;
    }

    if (firstSignatureThisCycle) {
      db.prepare(`
        UPDATE polling_state
        SET last_seen_signature   = ?,
            last_seen_ts          = ?,
            last_poll_ts          = ?,
            last_poll_tx_count    = ?,
            last_poll_credits_used = ?,
            total_polls           = total_polls + 1,
            total_credits_used    = total_credits_used + ?,
            total_tx_processed    = total_tx_processed + ?,
            last_error            = NULL,
            last_error_ts         = NULL
        WHERE dex_program_id = ?
      `).run(
        firstSignatureThisCycle, firstTimestampThisCycle,
        startTs, txProcessed, creditsUsed,
        creditsUsed, txProcessed,
        dex.programId
      );
    } else {
      db.prepare(`
        UPDATE polling_state
        SET last_poll_ts           = ?,
            last_poll_tx_count     = 0,
            last_poll_credits_used = ?,
            total_polls            = total_polls + 1,
            total_credits_used     = total_credits_used + ?
        WHERE dex_program_id = ?
      `).run(startTs, creditsUsed, creditsUsed, dex.programId);
    }

    return { success: true, creditsUsed, txProcessed, pages: totalPages };

  } catch (error) {
    console.error(`[helius-poller] Poll failed for ${dex.name}:`, error.message);
    db.prepare(`
      UPDATE polling_state
      SET last_error             = ?,
          last_error_ts          = ?,
          last_poll_credits_used = ?,
          total_credits_used     = total_credits_used + ?
      WHERE dex_program_id = ?
    `).run(error.message.slice(0, 500), startTs, creditsUsed, creditsUsed, dex.programId);
    return { success: false, reason: error.message, creditsUsed, txProcessed };
  }
}

async function pollAllDexes() {
  const results = [];
  for (const dex of DEX_PROGRAMS) {
    const result = await pollSingleDex(dex);
    results.push({ dex: dex.name, ...result });
    await new Promise(r => setTimeout(r, 1000));
  }

  const totalCredits = results.reduce((sum, r) => sum + (r.creditsUsed || 0), 0);
  const totalTx = results.reduce((sum, r) => sum + (r.txProcessed || 0), 0);
  console.log(`[helius-poller] Cycle complete: ${totalTx} txs, ${totalCredits} credits`);
  return results;
}

module.exports = { pollAllDexes, pollSingleDex, DEX_PROGRAMS };
