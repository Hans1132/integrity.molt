'use strict';

require('dotenv').config({ path: '/root/x402-server/.env' });
const cron = require('node-cron');
const { pollBitquery } = require('../lib/bitquery-poller');
const { scanForInactivity } = require('../lib/inactivity-scanner');

// Poll interval: 12h default for free plan (1000 pts/month).
// Set BITQUERY_POLL_INTERVAL_HOURS=1 for Developer plan (100k pts/month).
const intervalHours = parseInt(process.env.BITQUERY_POLL_INTERVAL_HOURS || '12', 10);

console.log(`[BITQUERY-CRON] SolRPDS extension poller V4 starting (interval: ${intervalHours}h)`);

if (!process.env.BITQUERY_API_KEY) {
  console.error('[BITQUERY-CRON] FATAL: BITQUERY_API_KEY not set. Add it to .env and restart.');
  process.exit(1);
}

// Schedule poll based on interval hours
// 12h → '0 */12 * * *', 6h → '0 */6 * * *', 1h → '0 * * * *'
const pollCron = intervalHours >= 12 ? '0 */12 * * *'
               : intervalHours >= 6  ? '0 */6 * * *'
               : intervalHours >= 4  ? '0 */4 * * *'
               : '0 * * * *';

cron.schedule(pollCron, async () => {
  console.log('[BITQUERY-CRON] Starting scheduled poll');
  try {
    const result = await pollBitquery();
    console.log('[BITQUERY-CRON] Poll complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[BITQUERY-CRON] Poll exception:', err.message);
  }
});

// Inactivity scanner: 30 min after poll offset
// 12h → '30 */12 * * *', otherwise 30 min past each hour
const scanCron = intervalHours >= 12 ? '30 */12 * * *' : '30 * * * *';

cron.schedule(scanCron, () => {
  console.log('[BITQUERY-CRON] Starting inactivity scan');
  try {
    const result = scanForInactivity();
    console.log('[BITQUERY-CRON] Scan complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[BITQUERY-CRON] Scan exception:', err.message);
  }
});

// Initial poll after 30s warmup (let PM2 finish startup)
setTimeout(async () => {
  console.log('[BITQUERY-CRON] Initial poll on startup');
  try {
    const result = await pollBitquery();
    console.log('[BITQUERY-CRON] Initial poll complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[BITQUERY-CRON] Initial poll exception:', err.message);
  }
}, 30000);

console.log(`[BITQUERY-CRON] Scheduled: poll ${pollCron}, scan ${scanCron}`);
