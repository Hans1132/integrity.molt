'use strict';
/**
 * tests/middleware/free-quota.test.js
 *
 * Unit tests for src/middleware/free-quota.js
 * Covers: checkFreeQuota, consumeFreeQuota, getQuotaStatus, checkBlacklist, addToBlacklist
 *
 * NOTE: The four quota tables are NOT created by db.initSchema() — this test
 * creates them manually before instantiating the middleware, because better-sqlite3
 * prepares statements eagerly on createQuotaMiddleware() call.
 *
 * Run: node tests/middleware/free-quota.test.js
 */

process.env.SQLITE_DB_PATH = ':memory:';
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';
process.env.INTERNAL_SCAN_SECRET = 'test-secret-xyz';

const assert = require('assert');
const { db: rawDb, initSchema } = require('../../db');
const {
  createQuotaMiddleware,
  createBlacklistMiddleware,
  PER_IP_DAILY_LIMIT,
  GLOBAL_DAILY_CAP,
} = require('../../src/middleware/free-quota');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

function makeReq(overrides = {}) {
  return {
    socket: { remoteAddress: '1.2.3.4' },
    headers: {},
    ...overrides,
  };
}

function makeRes() {
  return {
    _statusCode: null,
    _body: null,
    status(code) { this._statusCode = code; return this; },
    json(data) { this._body = data; },
  };
}

const QUOTA_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS free_scan_quota (
    identifier  TEXT NOT NULL,
    scan_date   TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    last_scan_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (identifier, scan_date)
  );
  CREATE TABLE IF NOT EXISTS global_scan_stats (
    stat_date  TEXT PRIMARY KEY,
    free_count INTEGER NOT NULL DEFAULT 0,
    paid_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ip_blacklist (
    ip         TEXT PRIMARY KEY,
    reason     TEXT,
    added_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    hit_count  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS abuse_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip          TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    details     TEXT,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

async function run() {
  await initSchema();
  rawDb.exec(QUOTA_TABLES_DDL);

  const { checkFreeQuota, consumeFreeQuota, getQuotaStatus } = createQuotaMiddleware(rawDb);
  const { checkBlacklist, addToBlacklist } = createBlacklistMiddleware(rawDb);

  const today = new Date().toISOString().slice(0, 10);

  function clearTables() {
    rawDb.prepare('DELETE FROM free_scan_quota').run();
    rawDb.prepare('DELETE FROM global_scan_stats').run();
    rawDb.prepare('DELETE FROM ip_blacklist').run();
    rawDb.prepare('DELETE FROM abuse_events').run();
  }

  console.log('\n── Free Quota Middleware Tests ────────────────────────────────────────────────\n');

  await test('first request under limit: calls next() and sets freeQuota on req', async () => {
    clearTables();
    const req = makeReq({ socket: { remoteAddress: '10.0.0.1' } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'next() should be called');
    assert.strictEqual(req.freeQuota.used, 0);
    assert.strictEqual(req.freeQuota.remaining, PER_IP_DAILY_LIMIT);
  });

  await test('after 3 consumeFreeQuota calls, 4th request returns 429', async () => {
    clearTables();
    const ip = '10.0.0.2';
    consumeFreeQuota(ip, today);
    consumeFreeQuota(ip, today);
    consumeFreeQuota(ip, today);
    const req = makeReq({ socket: { remoteAddress: ip } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'next() must NOT be called after limit');
    assert.strictEqual(res._statusCode, 429);
    assert.ok(res._body.error.includes('limit reached'), `body.error should mention "limit reached", got "${res._body.error}"`);
  });

  await test('quota response has correct used/remaining counts after 1 use', async () => {
    clearTables();
    const ip = '10.0.0.3';
    consumeFreeQuota(ip, today);
    const req = makeReq({ socket: { remoteAddress: ip } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.freeQuota.used, 1);
    assert.strictEqual(req.freeQuota.remaining, PER_IP_DAILY_LIMIT - 1);
  });

  await test('global cap exhausted returns 429 with global_limit field', async () => {
    clearTables();
    rawDb.prepare(
      `INSERT INTO global_scan_stats (stat_date, free_count) VALUES (?, ?)
       ON CONFLICT(stat_date) DO UPDATE SET free_count = ?`
    ).run(today, GLOBAL_DAILY_CAP, GLOBAL_DAILY_CAP);
    const req = makeReq({ socket: { remoteAddress: '10.0.0.4' } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res._statusCode, 429);
    assert.strictEqual(res._body.global_limit, GLOBAL_DAILY_CAP);
  });

  await test('internal IP 127.0.0.1 bypasses quota entirely', async () => {
    clearTables();
    // Exhaust quota so a normal IP would be blocked
    const ip = '10.0.0.5';
    consumeFreeQuota(ip, today);
    consumeFreeQuota(ip, today);
    consumeFreeQuota(ip, today);
    const req = makeReq({ socket: { remoteAddress: '127.0.0.1' } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, '127.0.0.1 must bypass quota');
    assert.strictEqual(res._statusCode, null, 'no status should be set for internal IP');
  });

  await test('X-Forwarded-For header: first IP is used as client identifier', async () => {
    clearTables();
    const realIp = '10.0.0.6';
    consumeFreeQuota(realIp, today);
    consumeFreeQuota(realIp, today);
    consumeFreeQuota(realIp, today);
    const req = makeReq({
      socket: { remoteAddress: '192.168.1.1' },
      headers: { 'x-forwarded-for': `${realIp}, 192.168.1.100` },
    });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'should pick up real IP from X-Forwarded-For');
    assert.strictEqual(res._statusCode, 429);
  });

  await test('x-internal-secret header bypasses quota', async () => {
    clearTables();
    const ip = '10.0.0.7';
    consumeFreeQuota(ip, today);
    consumeFreeQuota(ip, today);
    consumeFreeQuota(ip, today);
    const req = makeReq({
      socket: { remoteAddress: ip },
      headers: { 'x-internal-secret': 'test-secret-xyz' },
    });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'internal secret must bypass quota');
  });

  await test('getQuotaStatus returns correct structure before any use', async () => {
    clearTables();
    const status = getQuotaStatus('10.0.0.8');
    assert.strictEqual(status.limit, PER_IP_DAILY_LIMIT);
    assert.strictEqual(status.used, 0);
    assert.strictEqual(status.remaining, PER_IP_DAILY_LIMIT);
    assert.strictEqual(status.resets_at, 'midnight UTC');
    assert.strictEqual(status.global_used, 0);
    assert.strictEqual(status.global_limit, GLOBAL_DAILY_CAP);
  });

  await test('consumeFreeQuota increments on repeated calls (ON CONFLICT DO UPDATE)', async () => {
    clearTables();
    const ip = '10.0.0.9';
    for (let i = 0; i < 5; i++) consumeFreeQuota(ip, today);
    const status = getQuotaStatus(ip);
    assert.strictEqual(status.used, 5, `expected used=5, got ${status.used}`);
  });

  await test('checkBlacklist: blacklisted IP returns 403 with reason field', async () => {
    clearTables();
    const ip = '10.0.0.10';
    addToBlacklist(ip, 'rate_abuse_auto_blocked', 24);
    const req = makeReq({ socket: { remoteAddress: ip } });
    const res = makeRes();
    let nextCalled = false;
    checkBlacklist(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res._statusCode, 403);
    assert.strictEqual(res._body.reason, 'rate_abuse_auto_blocked');
  });

  await test('checkBlacklist: non-blacklisted IP calls next()', async () => {
    clearTables();
    const req = makeReq({ socket: { remoteAddress: '10.0.0.11' } });
    const res = makeRes();
    let nextCalled = false;
    checkBlacklist(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
