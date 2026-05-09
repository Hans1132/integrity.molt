'use strict';

require('dotenv').config({ path: '/root/x402-server/.env' });
const cron = require('node-cron');
const { pollBitquery } = require('../lib/bitquery-poller');
const { scanForInactivity } = require('../lib/inactivity-scanner');

console.log('[BITQUERY-V4] Hybrid SolRPDS poller starting (removal events, 4h interval)');

if (!process.env.BITQUERY_API_KEY) {
  console.error('[BITQUERY-V4] FATAL: BITQUERY_API_KEY not set');
  process.exit(1);
}

// Every 4 hours — 6 polls/day × 5 pts = 30 pts/day, 900 pts/month (free plan safe)
cron.schedule('0 */4 * * *', async () => {
  console.log('[BITQUERY-V4] Starting scheduled removal poll');
  try {
    const result = await pollBitquery();
    console.log('[BITQUERY-V4] Poll complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[BITQUERY-V4] Poll exception:', err.message);
  }
});

// Inactivity scanner at :35 past each 4h mark (offset from poll at :00 AND from
// V3 Helius scanner at :30 to prevent concurrent RugCheck calls between processes)
cron.schedule('35 */4 * * *', async () => {
  console.log('[BITQUERY-V4] Starting inactivity scan');
  try {
    const result = await scanForInactivity();
    console.log('[BITQUERY-V4] Scan complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[BITQUERY-V4] Scan exception:', err.message);
  }
});

// Initial poll after 15s warmup
setTimeout(async () => {
  console.log('[BITQUERY-V4] Initial removal poll on startup');
  try {
    const result = await pollBitquery();
    console.log('[BITQUERY-V4] Initial poll complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[BITQUERY-V4] Initial poll exception:', err.message);
  }
}, 15000);

console.log('[BITQUERY-V4] Scheduled: poll 0 */4 * * *, scan 35 */4 * * *');
