'use strict';
require('dotenv').config({ path: '/root/x402-server/.env' });

const cron = require('node-cron');
const { pollAllDexes } = require('../lib/helius-poller');
const { scanForInactivity } = require('../lib/inactivity-scanner');

console.log('[solrpds-poller] Starting SolRPDS extension poller...');

// Hourly Helius poll at :00
cron.schedule('0 * * * *', async () => {
  console.log('[POLL] Starting hourly Helius poll cycle');
  try {
    const results = await pollAllDexes();
    console.log('[POLL] Cycle complete:', JSON.stringify(results));
  } catch (err) {
    console.error('[POLL] Cycle failed:', err.message);
  }
});

// Hourly inactivity scan at :30 (offset from poll)
cron.schedule('30 * * * *', async () => {
  console.log('[SCAN] Starting hourly inactivity scan');
  try {
    const result = scanForInactivity();
    console.log('[SCAN] Scan complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[SCAN] Scan failed:', err.message);
  }
});

// Initial runs after 30s warm-up delay
setTimeout(async () => {
  console.log('[POLL] Initial poll cycle on startup');
  try {
    await pollAllDexes();
  } catch (err) {
    console.error('[POLL] Initial poll failed:', err.message);
  }
}, 30000);

console.log('[solrpds-poller] Scheduled: Helius poll at :00, inactivity scan at :30');
