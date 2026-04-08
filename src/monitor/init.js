'use strict';

const { syncWatchlistToWebhook, loadConfig } = require('./webhook-manager');

/**
 * Bootstrap monitoring systému při startu serveru.
 * Spouští se z server.js po inicializaci DB.
 *
 * Logika:
 * 1. Zkontroluj zda je HELIUS_API_KEY nastaven
 * 2. Načti webhook-config.json
 * 3. Pokud webhook neexistuje → vytvoř ho (setupWebhook)
 * 4. Synchronizuj adresy z DB watchlistu do webhooku
 *
 * Chyby jsou jen logovány — nevypnou server.
 */
async function initMonitor() {
  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    console.log('[monitor] HELIUS_API_KEY not configured — Live Runtime Monitoring disabled');
    console.log('[monitor] Add HELIUS_API_KEY and HELIUS_WEBHOOK_SECRET to .env to enable');
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
    console.log('[monitor] Live Runtime Monitoring initialized');
  } catch (e) {
    console.error('[monitor] Init failed (non-fatal):', e.message);
  }
}

module.exports = { initMonitor };
