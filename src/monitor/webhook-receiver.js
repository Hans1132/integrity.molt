'use strict';

const fs   = require('fs');
const path = require('path');
const { evaluateTransaction } = require('./alerts');
const { sendAlert }           = require('./notifications');

const EVENTS_FILE = path.join(__dirname, '../../data/monitor/events.jsonl');
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || null;

// Zajisti existence log souboru
if (!fs.existsSync(path.dirname(EVENTS_FILE))) {
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
}

/**
 * Express middleware — ověření Helius webhook secret.
 * Helius posílá secret v Authorization headeru jako plain string (ne "Bearer ").
 * Pokud HELIUS_WEBHOOK_SECRET není nastaven, přijímá vše (dev mode).
 */
function verifyWebhookAuth(req, res, next) {
  if (!WEBHOOK_SECRET) {
    console.warn('[monitor] HELIUS_WEBHOOK_SECRET not set — accepting all webhook requests');
    return next();
  }
  const auth = req.headers['authorization'] || '';
  if (auth !== WEBHOOK_SECRET) {
    console.warn('[monitor] Webhook auth mismatch, rejecting');
    // Vrátíme 200 aby Helius neretryoval s neplatnými požadavky
    return res.status(200).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

/**
 * Parsuje Helius enhanced transaction a extrahuje strukturovaná data.
 * Helius vrací pole transakcí v enhanced formátu.
 * Docs: https://docs.helius.dev/webhooks-and-websockets/enhanced-transactions-api
 */
function parseEnhancedTransaction(tx) {
  const parsed = {
    signature:    tx.signature || tx.transaction?.signatures?.[0] || null,
    timestamp:    tx.timestamp ? tx.timestamp * 1000 : Date.now(),
    type:         tx.type || 'UNKNOWN',
    fee:          tx.fee || 0,
    slot:         tx.slot || null,
    source:       tx.feePayer || null,

    // Zúčastněné adresy
    accounts:     tx.accountData?.map(a => a.account) || [],
    feePayer:     tx.feePayer || null,

    // Native token transfery (SOL)
    nativeTransfers: (tx.nativeTransfers || []).map(t => ({
      from:   t.fromUserAccount,
      to:     t.toUserAccount,
      amount: t.amount, // lamports
    })),

    // SPL token transfery
    tokenTransfers: (tx.tokenTransfers || []).map(t => ({
      from:       t.fromUserAccount,
      to:         t.toUserAccount,
      mint:       t.mint,
      amount:     t.tokenAmount,
      decimals:   t.decimals,
    })),

    // Instrukce (programy volané v tx)
    instructions: extractInstructions(tx),

    // Programy
    programs: extractPrograms(tx),

    // Raw pro alert engine
    _raw: tx,
  };

  return parsed;
}

function extractInstructions(tx) {
  const instructions = [];

  // Z innerInstructions
  const inner = tx.instructions || tx.transaction?.message?.instructions || [];
  for (const ix of inner) {
    instructions.push({
      program:    ix.programId || ix.program,
      data:       ix.data,
      accounts:   ix.accounts || [],
      parsed:     ix.parsed || null,
    });
  }

  // Helius events — authority changes, mints, atd.
  if (tx.events) {
    if (tx.events.setAuthority) {
      instructions.push({ _event: 'set_authority', ...tx.events.setAuthority });
    }
  }

  return instructions;
}

function extractPrograms(tx) {
  const programs = new Set();
  const instructions = tx.instructions || tx.transaction?.message?.instructions || [];
  for (const ix of instructions) {
    const prog = ix.programId || ix.program;
    if (prog) programs.add(prog);
  }
  // Helius accountData obsahuje programy
  if (tx.accountData) {
    for (const acc of tx.accountData) {
      if (acc.owner) programs.add(acc.owner);
    }
  }
  return [...programs];
}

/**
 * Append transakce do JSONL logu (append-only, jeden JSON per řádek).
 */
function logEvent(parsed) {
  try {
    const line = JSON.stringify({
      sig:       parsed.signature,
      ts:        parsed.timestamp,
      type:      parsed.type,
      accounts:  parsed.accounts.slice(0, 10), // limituj pro úsporu místa
      programs:  parsed.programs,
    }) + '\n';
    fs.appendFileSync(EVENTS_FILE, line, 'utf8');
  } catch (e) {
    console.error('[monitor] Failed to log event:', e.message);
  }
}

/**
 * Načte watchlist adresy z DB a vrátí Set pro rychlé vyhledávání.
 * Lazy import db aby se předešlo cirkulárním závislostem.
 */
async function getWatchedAddresses() {
  try {
    const db = require('../../db');
    const entries = await db.getActiveWatchlist();
    return entries.map(e => ({ address: e.address, entry: e }));
  } catch (e) {
    console.error('[monitor] Cannot load watchlist:', e.message);
    return [];
  }
}

/**
 * Hlavní handler pro Helius webhook.
 * Helius posílá POST s polem transakcí (enhanced format).
 */
async function handleHeliusWebhook(req, res) {
  // Vždy odpovedz 200 — Helius retryuje při non-200
  res.status(200).json({ ok: true });

  const body = req.body;
  if (!body) return;

  // Helius posílá buď pole přímo, nebo objekt s transactions polem
  const txList = Array.isArray(body) ? body : (body.transactions || [body]);

  if (!txList.length) return;

  // Načti watchlist pro korelaci
  const watched = await getWatchedAddresses();
  const watchedSet = new Map(watched.map(w => [w.address, w.entry]));

  for (const rawTx of txList) {
    try {
      const parsed = parseEnhancedTransaction(rawTx);
      logEvent(parsed);

      // Najdi průnik mezi účty v tx a sledovanými adresami
      const relevantAddresses = parsed.accounts.filter(a => watchedSet.has(a));

      for (const addr of relevantAddresses) {
        const entry = watchedSet.get(addr);
        const alerts = evaluateTransaction(parsed, addr);

        for (const alert of alerts) {
          const channels = [];
          if (entry.notify_telegram_chat) {
            channels.push({ type: 'telegram', chatId: entry.notify_telegram_chat });
          }
          if (entry.notify_email) {
            channels.push({ type: 'email', to: entry.notify_email });
          }
          if (entry.webhook_url) {
            channels.push({ type: 'webhook', url: entry.webhook_url });
          }
          await sendAlert(alert, channels);
        }
      }
    } catch (e) {
      console.error('[monitor] Error processing tx:', e.message);
    }
  }
}

module.exports = { verifyWebhookAuth, handleHeliusWebhook, parseEnhancedTransaction };
