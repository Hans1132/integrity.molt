'use strict';

const fs   = require('fs');
const path = require('path');
const { syncWatchlistToWebhook, loadConfig, HeliusLimitError } = require('./webhook-manager');

// Circuit breaker — zabrání opakovaným pokusům při vyčerpaných kreditech.
// Pokud init selže s HeliusLimitError, zapíše timestamp a příštích 6 hodin přeskočí.
const BACKOFF_FILE = path.join(__dirname, '../../data/monitor/helius-backoff.json');
const BACKOFF_MS   = 6 * 60 * 60 * 1000; // 6 hodin

function isInBackoff() {
  try {
    const { until } = JSON.parse(fs.readFileSync(BACKOFF_FILE, 'utf8'));
    return Date.now() < until;
  } catch { return false; }
}

function setBackoff() {
  const until = Date.now() + BACKOFF_MS;
  try {
    fs.mkdirSync(path.dirname(BACKOFF_FILE), { recursive: true });
    fs.writeFileSync(BACKOFF_FILE, JSON.stringify({ until, set: new Date().toISOString() }));
  } catch {}
  console.warn(`[monitor] Circuit breaker aktivován — příští pokus ${new Date(until).toISOString()}`);
}

function clearBackoff() {
  try { fs.unlinkSync(BACKOFF_FILE); } catch {}
}

/**
 * Bootstrap monitoring systému při startu serveru.
 * Spouští se z server.js po inicializaci DB.
 *
 * Logika:
 * 1. Zkontroluj zda je HELIUS_API_KEY nastaven
 * 2. Zkontroluj circuit breaker — pokud platí backoff, přeskoč
 * 3. Načti webhook-config.json
 * 4. Pokud webhook neexistuje → vytvoř ho (setupWebhook)
 * 5. Synchronizuj adresy z DB watchlistu do webhooku
 *
 * Chyby jsou jen logovány — nevypnou server.
 */
async function initMonitor() {
  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    console.log('[monitor] HELIUS_API_KEY not configured — Live Runtime Monitoring disabled');
    return;
  }

  // Circuit breaker — nekontaktovat Helius pokud jsme nedávno dostali credit limit error
  if (isInBackoff()) {
    console.log('[monitor] Circuit breaker aktivní — Helius sync přeskočen (kredity vyčerpány, zkusit znovu za 6h)');
    return;
  }

  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[monitor] HELIUS_WEBHOOK_SECRET not set — webhook will accept unsigned requests');
  }

  const config = loadConfig();
  if (config.webhookId) {
    console.log(`[monitor] Existing webhook: ${config.webhookId} (${config.addressCount || 0} addresses)`);
  } else {
    console.log('[monitor] No existing webhook — will create on first sync');
  }

  try {
    await syncWatchlistToWebhook();
    clearBackoff(); // Úspěch — reset circuit breaker
    console.log('[monitor] Live Runtime Monitoring initialized');
  } catch (e) {
    if (e instanceof HeliusLimitError) {
      setBackoff();
    } else {
      console.error('[monitor] Init failed (non-fatal):', e.message);
    }
  }
}

module.exports = { initMonitor };
