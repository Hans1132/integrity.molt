'use strict';
// Nastav env PŘED jakýmkoliv require modulu který sahá na DB nebo notifications
process.env.SQLITE_DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { initSchema } = require('../../db');
initSchema();

const notifications = require('../../src/monitor/notifications');

async function run() {
  const LRU_CAP = 1000;

  // ── Test 1: sentAlerts cap ────────────────────────────────────────────────
  // isDuplicate() zapisuje do sentAlerts; každý unikátní tx_signature+rule = nový klíč
  for (let i = 0; i <= LRU_CAP; i++) {
    notifications.isDuplicate({
      tx_signature: `sig-${i}`,
      rule:         `rule-${i}`,
      address:      `addr-${i}`,
    });
  }

  const assert = require('assert');
  const sentSize = notifications._sentAlerts.size;
  assert.ok(
    sentSize <= LRU_CAP,
    `sentAlerts.size=${sentSize} překročil cap ${LRU_CAP}`
  );
  console.log(`  ✓ sentAlerts LRU cap: size=${sentSize} <= ${LRU_CAP}`);

  // ── Test 2: rateWindows cap ───────────────────────────────────────────────
  // isRateLimited() zapisuje do rateWindows per unikátní adresu
  // Nejdřív vyčisti stav z předchozího testu
  notifications._rateWindows.clear();

  for (let i = 0; i <= LRU_CAP; i++) {
    notifications.isRateLimited(`addr-lru-${i}`);
  }

  const rateSize = notifications._rateWindows.size;
  assert.ok(
    rateSize <= LRU_CAP,
    `rateWindows.size=${rateSize} překročil cap ${LRU_CAP}`
  );
  console.log(`  ✓ rateWindows LRU cap: size=${rateSize} <= ${LRU_CAP}`);

  console.log('\n2 tests: 2 passed, 0 failed');
}

run().catch(e => { console.error(e); process.exit(1); });
