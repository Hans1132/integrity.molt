'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/monitor/webhook-config.json');
const HELIUS_BASE = 'https://api-mainnet.helius-rpc.com/v0';

// Webhook URL kterou Helius bude volat
const WEBHOOK_URL = 'https://intmolt.org/api/v2/webhook/helius';

// Pouze bezpečnostně relevantní typy — filtruje běžné swappy a DeFi txs na Helius straně.
// 'ANY' by způsobilo miliony notifikací u aktivních adres (DEX pooly, AMM programy).
const SECURITY_TX_TYPES = [
  'SET_AUTHORITY',
  'UPGRADE_PROGRAM_INSTRUCTION',
  'CLOSE_ACCOUNT',
  'BURN',
  'BURN_NFT',
  'TRANSFER',
  'TRANSFER_CHECKED',
  'MINT_TO',
  'INITIALIZE_MINT',
];

function getApiKey() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set in environment');
  return key;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Helius API volání — obaluje fetch s error handling.
 */
class HeliusLimitError extends Error {
  constructor() { super('Helius credit limit reached — webhook sync skipped until credits reset'); this.name = 'HeliusLimitError'; }
}

async function heliusRequest(method, path, body) {
  const apiKey = getApiKey();
  const url    = `${HELIUS_BASE}${path}?api-key=${apiKey}`;
  const opts   = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  // Helius -32429 = credit limit exhausted — graceful skip, don't spam retries
  if (json?.error?.code === -32429 || json?.error?.message === 'max usage reached') {
    throw new HeliusLimitError();
  }

  if (!res.ok) {
    throw new Error(`Helius API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

/**
 * Vytvoří nový Helius webhook a uloží jeho ID do konfigurace.
 * @param {string[]} addresses — Solana adresy ke sledování
 * @returns {object} Helius webhook objekt
 */
async function setupWebhook(addresses = []) {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[monitor] HELIUS_WEBHOOK_SECRET not set — webhook bude bez autentizace');
  }

  const payload = {
    webhookURL:       WEBHOOK_URL,
    transactionTypes: SECURITY_TX_TYPES,
    accountAddresses: addresses,
    webhookType:      'enhanced',
    authHeader:       secret || undefined,
  };

  console.log('[monitor] Creating Helius webhook...');
  const result = await heliusRequest('POST', '/webhooks', payload);

  const config = {
    webhookId:   result.webhookID || result.webhookId || result.id,
    webhookUrl:  WEBHOOK_URL,
    createdAt:   new Date().toISOString(),
    addressCount: addresses.length,
  };
  saveConfig(config);

  console.log(`[monitor] Webhook created: ${config.webhookId} (${addresses.length} addresses)`);
  return result;
}

/**
 * Přidá adresy k existujícímu webhooku.
 * Helius webhooks jsou update-only (PUT s plným listem adres).
 * @param {string} webhookId
 * @param {string[]} newAddresses
 */
async function addAddresses(webhookId, newAddresses) {
  // Načti aktuální stav webhooku
  const current = await getWebhookStatus(webhookId);
  const existing = current.accountAddresses || [];
  const merged   = [...new Set([...existing, ...newAddresses])];

  await heliusRequest('PUT', `/webhooks/${webhookId}`, {
    webhookURL:       WEBHOOK_URL,
    transactionTypes: SECURITY_TX_TYPES,
    accountAddresses: merged,
    webhookType:      'enhanced',
    authHeader:       process.env.HELIUS_WEBHOOK_SECRET || undefined,
  });

  // Aktualizuj config
  const config = loadConfig();
  config.addressCount = merged.length;
  config.updatedAt    = new Date().toISOString();
  saveConfig(config);

  console.log(`[monitor] Webhook ${webhookId}: added ${newAddresses.length} addresses (total: ${merged.length})`);
  return merged.length;
}

/**
 * Odebere adresy z webhooku.
 * @param {string} webhookId
 * @param {string[]} toRemove
 */
async function removeAddresses(webhookId, toRemove) {
  const current = await getWebhookStatus(webhookId);
  const existing = current.accountAddresses || [];
  const removeSet = new Set(toRemove);
  const remaining = existing.filter(a => !removeSet.has(a));

  await heliusRequest('PUT', `/webhooks/${webhookId}`, {
    webhookURL:       WEBHOOK_URL,
    transactionTypes: SECURITY_TX_TYPES,
    accountAddresses: remaining,
    webhookType:      'enhanced',
    authHeader:       process.env.HELIUS_WEBHOOK_SECRET || undefined,
  });

  const config = loadConfig();
  config.addressCount = remaining.length;
  config.updatedAt    = new Date().toISOString();
  saveConfig(config);

  console.log(`[monitor] Webhook ${webhookId}: removed ${toRemove.length} addresses (remaining: ${remaining.length})`);
  return remaining.length;
}

/**
 * Vrátí aktuální stav webhooku z Helius API.
 * @param {string} webhookId
 */
async function getWebhookStatus(webhookId) {
  return heliusRequest('GET', `/webhooks/${webhookId}`);
}

/**
 * Synchronizuje adresy z watchlistu DB do Helius webhooku.
 * Pokud webhook neexistuje, vytvoří ho.
 */
async function syncWatchlistToWebhook() {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.warn('[monitor] HELIUS_API_KEY not set — skipping webhook sync');
    return;
  }

  let db;
  try { db = require('../../db'); } catch (e) {
    console.error('[monitor] Cannot load db:', e.message); return;
  }

  let entries;
  try { entries = await db.getActiveWatchlist(); } catch (e) {
    console.error('[monitor] Cannot load watchlist:', e.message); return;
  }

  // Vlastní wallet vždy sledujeme — detekce příchozích plateb bez pollingu
  const ownWallet = process.env.SOLANA_WALLET_ADDRESS;
  const baseAddresses = entries.map(e => e.address);
  if (ownWallet && !baseAddresses.includes(ownWallet)) baseAddresses.push(ownWallet);
  const addresses = [...new Set(baseAddresses)];
  const config    = loadConfig();

  if (!config.webhookId) {
    if (addresses.length === 0) {
      console.log('[monitor] No addresses in watchlist — webhook will be created when first address is added');
      return;
    }
    // První spuštění — vytvoř webhook
    try {
      await setupWebhook(addresses);
    } catch (e) {
      if (e instanceof HeliusLimitError) {
        console.warn(`[monitor] ${e.message}`);
      } else {
        console.error('[monitor] Failed to create webhook:', e.message);
      }
    }
    return;
  }

  // Synchronizuj adresy
  try {
    const current = await getWebhookStatus(config.webhookId);
    const currentAddresses = new Set(current.accountAddresses || []);
    const toAdd    = addresses.filter(a => !currentAddresses.has(a));
    const toRemove = [...currentAddresses].filter(a => !addresses.includes(a));

    if (toAdd.length > 0 || toRemove.length > 0) {
      console.log(`[monitor] Syncing: +${toAdd.length} / -${toRemove.length} addresses`);
      await heliusRequest('PUT', `/webhooks/${config.webhookId}`, {
        webhookURL:       WEBHOOK_URL,
        transactionTypes: SECURITY_TX_TYPES,
        accountAddresses: addresses,
        webhookType:      'enhanced',
        authHeader:       process.env.HELIUS_WEBHOOK_SECRET || undefined,
      });
      config.addressCount = addresses.length;
      config.updatedAt    = new Date().toISOString();
      saveConfig(config);
      console.log(`[monitor] Webhook synced: ${addresses.length} addresses`);
    } else {
      console.log(`[monitor] Webhook already in sync (${addresses.length} addresses)`);
    }
  } catch (e) {
    if (e instanceof HeliusLimitError) {
      console.warn(`[monitor] ${e.message}`);
    } else {
      console.error('[monitor] Webhook sync failed:', e.message);
    }
  }
}

module.exports = {
  setupWebhook,
  addAddresses,
  removeAddresses,
  getWebhookStatus,
  syncWatchlistToWebhook,
  loadConfig,
  HeliusLimitError,
};
