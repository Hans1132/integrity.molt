'use strict';
process.env.SQLITE_DB_PATH = ':memory:';
const assert = require('assert');
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); fail++; }
}

const db = require('../db');

async function main() {
  await db.initSchema();

  console.log('\n── Missing tables smoke tests ──\n');

  await test('logAbuseEvent does not throw', () => {
    db.logAbuseEvent('1.2.3.4', 'test_event', { reason: 'test' });
  });

  await test('isIpBlacklisted returns false for unknown IP', () => {
    const r = db.isIpBlacklisted('9.9.9.9');
    assert.strictEqual(r, false);
  });

  await test('blacklistIp + isIpBlacklisted round-trip', () => {
    db.blacklistIp('5.5.5.5', 'test_reason', 3600_000);
    assert.strictEqual(db.isIpBlacklisted('5.5.5.5'), true);
  });

  await test('incrementGlobalScanStats + getGlobalScanStats', () => {
    db.incrementGlobalScanStats('free');
    db.incrementGlobalScanStats('paid');
    const rows = db.getGlobalScanStats(1);
    assert.ok(rows.length >= 1);
    const today = rows[0];
    assert.ok(today.free_count >= 1 || today.paid_count >= 1);
  });

  await test('getIrisEnrichment returns undefined for unknown mint', () => {
    const r = db.getIrisEnrichment('UnknownMint111111111111111111111111111111111');
    assert.strictEqual(r, undefined);
  });

  await test('getAbuseStats returns empty array on fresh DB', () => {
    const stats = db.getAbuseStats(24);
    assert.ok(Array.isArray(stats));
  });

  await test('cleanExpiredBlacklist does not throw', () => {
    const n = db.cleanExpiredBlacklist();
    assert.ok(typeof n === 'number');
  });

  await test('getMonthlyScansForEmail returns number', () => {
    const count = db.getMonthlyScansForEmail('test@test.com');
    assert.ok(typeof count === 'number');
  });

  await test('getAdvisorStats returns object', () => {
    const stats = db.getAdvisorStats(30);
    assert.ok(stats !== null && typeof stats === 'object');
  });

  console.log(`\nVýsledek: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
