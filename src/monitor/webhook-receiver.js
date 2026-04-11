'use strict';

const fs   = require('fs');
const path = require('path');
const { evaluateTransaction } = require('./alerts');
const { sendAlert }           = require('./notifications');

const EVENTS_FILE    = path.join(__dirname, '../../data/monitor/events.jsonl');
const PAYMENTS_FILE  = path.join(__dirname, '../../data/monitor/wallet-payments.jsonl');
const NOTIFY_FILE    = path.join(__dirname, '../../data/monitor/new-payment.flag');
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || null;
const OWN_WALLET     = process.env.SOLANA_WALLET_ADDRESS || null;

// Re-scan fronta — adresy označené k okamžitému re-scanu po suspektní transakci
// Callback zaregistruje server.js při startu
let _rescanCallback = null;
function registerRescanCallback(fn) { _rescanCallback = fn; }

// Dedup cache — zabrání zpracování stejné signatury vícekrát (Helius retry, flood)
// Max 50 000 položek, TTL 1h; při překročení se smaže celý Set (jednoduchý GC)
const _dedupCache = new Set();
let _dedupClearedAt = Date.now();
function isDuplicate(sig) {
  if (!sig) return false;
  const now = Date.now();
  if (_dedupCache.size > 50000 || now - _dedupClearedAt > 3600_000) {
    _dedupCache.clear();
    _dedupClearedAt = now;
  }
  if (_dedupCache.has(sig)) return true;
  _dedupCache.add(sig);
  return false;
}

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
const EVENTS_MAX_BYTES = 50 * 1024 * 1024; // 50 MB cap — zabrání disk flood při extrémně aktivních adresách

function logEvent(parsed) {
  try {
    // Přeskoč logování pokud soubor přesáhl cap (kontrola max každých 100 volání)
    if (logEvent._callCount === undefined) logEvent._callCount = 0;
    if (++logEvent._callCount % 100 === 0) {
      try {
        const size = fs.statSync(EVENTS_FILE).size;
        if (size > EVENTS_MAX_BYTES) {
          console.warn(`[monitor] events.jsonl přesáhl ${EVENTS_MAX_BYTES / 1024 / 1024}MB — logování pozastaveno`);
          logEvent._paused = true;
        } else {
          logEvent._paused = false;
        }
      } catch { logEvent._paused = false; }
    }
    if (logEvent._paused) return;

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
 * Watchlist cache — aktualizuje se max 1x za 60s, ne na každý webhook.
 * Při 6M webhooks/den = 6M DB queries → 1440 queries/den (1x/min).
 */
let _watchlistCache = null;
let _watchlistCachedAt = 0;
const WATCHLIST_TTL = 60_000; // 60 sekund

async function getWatchedAddresses() {
  const now = Date.now();
  if (_watchlistCache && now - _watchlistCachedAt < WATCHLIST_TTL) {
    return _watchlistCache;
  }
  try {
    const db = require('../../db');
    const entries = await db.getActiveWatchlist();
    _watchlistCache = entries.map(e => ({ address: e.address, entry: e }));
    _watchlistCachedAt = now;
    return _watchlistCache;
  } catch (e) {
    console.error('[monitor] Cannot load watchlist:', e.message);
    return _watchlistCache || []; // při chybě vrať stará data
  }
}

/**
 * Detekuje příchozí platbu na vlastní wallet (monitor-wallet logika přes webhook).
 * Helius enhanced format obsahuje nativeTransfers přímo — žádné další RPC volání.
 */
function detectOwnWalletPayment(parsed) {
  if (!OWN_WALLET) return;

  const incoming = parsed.nativeTransfers.filter(
    t => t.to === OWN_WALLET && t.from !== OWN_WALLET && t.amount > 0
  );
  if (!incoming.length) return;

  const totalLamports = incoming.reduce((s, t) => s + t.amount, 0);
  const sol = (totalLamports / 1e9).toFixed(6);
  const blockTs = parsed.timestamp
    ? new Date(parsed.timestamp).toISOString()
    : new Date().toISOString();

  console.log(`[monitor] PAYMENT: sig=${parsed.signature?.slice(0,20)}... +${sol} SOL at ${blockTs}`);

  const entry = JSON.stringify({
    timestamp:   blockTs,
    recorded_at: new Date().toISOString(),
    source:      'helius_webhook',
    signature:   parsed.signature,
    lamports:    totalLamports,
    sol,
    verified:    true,
  }) + '\n';

  try {
    fs.mkdirSync(path.dirname(PAYMENTS_FILE), { recursive: true });
    fs.appendFileSync(PAYMENTS_FILE, entry, 'utf8');
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify({
      sig: parsed.signature, lamports: totalLamports, sol, at: blockTs
    }), 'utf8');
  } catch (e) {
    console.error('[monitor] Failed to write payment:', e.message);
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
      if (isDuplicate(parsed.signature)) continue;
      logEvent(parsed);

      // Detekce příchozí platby na vlastní wallet (bez RPC pollingu)
      detectOwnWalletPayment(parsed);

      // Najdi průnik mezi účty v tx a sledovanými adresami (zákaznický watchlist)
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

        // Suspektní transakce → okamžitý re-scan místo čekání na 24h interval
        const severity = alerts.map(a => a.severity || a.level || '').join(',').toLowerCase();
        if (alerts.length > 0 && /critical|high/.test(severity) && _rescanCallback) {
          console.log(`[monitor] Triggering re-scan for watchlist address ${addr} (suspicious tx)`);
          _rescanCallback(addr, entry).catch(e =>
            console.error('[monitor] Re-scan callback failed:', e.message)
          );
        }
      }
    } catch (e) {
      console.error('[monitor] Error processing tx:', e.message);
    }
  }
}

module.exports = { verifyWebhookAuth, handleHeliusWebhook, parseEnhancedTransaction, registerRescanCallback };
