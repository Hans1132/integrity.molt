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

  const { checkFreeQuota, consumeFreeQuota, tryConsumeFreeQuota, getQuotaStatus, getClientIp } = createQuotaMiddleware(rawDb);
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
    const req = makeReq({ headers: { 'cf-connecting-ip': '10.0.0.1' } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'next() should be called');
    // Atomic check-and-consume: used reflects count BEFORE this request, remaining after
    assert.strictEqual(req.freeQuota.used, 0);
    assert.strictEqual(req.freeQuota.remaining, PER_IP_DAILY_LIMIT - 1);
  });

  await test('after 3 checkFreeQuota calls, 4th request returns 429', async () => {
    clearTables();
    const ip = '10.0.0.2';
    // Atomic check-and-consume: each checkFreeQuota call consumes 1 quota
    for (let i = 0; i < 3; i++) {
      const r = makeReq({ headers: { 'cf-connecting-ip': ip } });
      checkFreeQuota(r, makeRes(), () => {});
    }
    const req = makeReq({ headers: { 'cf-connecting-ip': ip } });
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
    // First call consumes 1 (atomic) — used=0, remaining=2
    const req1 = makeReq({ headers: { 'cf-connecting-ip': ip } });
    checkFreeQuota(req1, makeRes(), () => {});
    // Second call — used=1, remaining=1
    const req = makeReq({ headers: { 'cf-connecting-ip': ip } });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.freeQuota.used, 1);
    assert.strictEqual(req.freeQuota.remaining, PER_IP_DAILY_LIMIT - 2);
  });

  await test('global cap exhausted returns 429 with global_limit field', async () => {
    clearTables();
    rawDb.prepare(
      `INSERT INTO global_scan_stats (stat_date, free_count) VALUES (?, ?)
       ON CONFLICT(stat_date) DO UPDATE SET free_count = ?`
    ).run(today, GLOBAL_DAILY_CAP, GLOBAL_DAILY_CAP);
    const req = makeReq({ headers: { 'cf-connecting-ip': '10.0.0.4' } });
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

  await test('checkFreeQuota increments quota on repeated calls (ON CONFLICT DO UPDATE)', async () => {
    clearTables();
    const ip = '10.0.0.9';
    // Use a separate IP to not conflict with other tests via global cap
    // Call checkFreeQuota 2 times (within limit of 3)
    for (let i = 0; i < 2; i++) {
      const r = makeReq({ headers: { 'cf-connecting-ip': ip } });
      checkFreeQuota(r, makeRes(), () => {});
    }
    const status = getQuotaStatus(ip);
    assert.strictEqual(status.used, 2, `expected used=2, got ${status.used}`);
  });

  // ── tryConsumeFreeQuota (inline atomic consume for /scan/quick, /scan/free) ──

  await test('tryConsumeFreeQuota: increments quota atomically (not a no-op)', async () => {
    clearTables();
    const ip = '10.0.1.1';
    const r1 = tryConsumeFreeQuota(ip);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(getQuotaStatus(ip).used, 1, 'must actually consume, unlike consumeFreeQuota no-op');
    tryConsumeFreeQuota(ip);
    assert.strictEqual(getQuotaStatus(ip).used, 2);
  });

  await test('tryConsumeFreeQuota: returns denied:ip after PER_IP_DAILY_LIMIT reached', async () => {
    clearTables();
    const ip = '10.0.1.2';
    for (let i = 0; i < PER_IP_DAILY_LIMIT; i++) {
      assert.strictEqual(tryConsumeFreeQuota(ip).ok, true, `consume ${i} should succeed`);
    }
    const denied = tryConsumeFreeQuota(ip);
    assert.strictEqual(denied.denied, 'ip', 'next consume past the limit must be denied');
    assert.strictEqual(denied.ok, undefined);
    // Denied attempt must NOT increment further.
    assert.strictEqual(getQuotaStatus(ip).used, PER_IP_DAILY_LIMIT);
  });

  await test('tryConsumeFreeQuota: shares the per-IP budget with checkFreeQuota', async () => {
    clearTables();
    const ip = '10.0.1.3';
    // 2 via middleware, 1 via inline — 3rd inline consume exhausts, 4th denied.
    checkFreeQuota(makeReq({ headers: { 'cf-connecting-ip': ip } }), makeRes(), () => {});
    checkFreeQuota(makeReq({ headers: { 'cf-connecting-ip': ip } }), makeRes(), () => {});
    assert.strictEqual(tryConsumeFreeQuota(ip).ok, true, '3rd (inline) still allowed');
    assert.strictEqual(tryConsumeFreeQuota(ip).denied, 'ip', '4th across both paths denied');
  });

  await test('checkBlacklist: blacklisted IP returns 403 with reason field', async () => {
    clearTables();
    const ip = '10.0.0.10';
    addToBlacklist(ip, 'rate_abuse_auto_blocked', 24);
    const req = makeReq({ headers: { 'cf-connecting-ip': ip } });
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

  // ── CF-Connecting-IP header precedence (GAP-3) ─────────────────────────────

  console.log('\n── CF-Connecting-IP Header Precedence ─────────────────────────────────────────\n');

  await test('getClientIp: cf-connecting-ip takes precedence over x-forwarded-for', async () => {
    const req = makeReq({
      headers: {
        'cf-connecting-ip': '10.0.0.99',
        'x-forwarded-for':  '8.8.8.8',
      },
    });
    assert.strictEqual(getClientIp(req), '10.0.0.99', 'CF header must win over XFF');
  });

  await test('getClientIp: cf-connecting-ip takes precedence over socket.remoteAddress', async () => {
    const req = makeReq({
      socket:  { remoteAddress: '1.1.1.1' },
      headers: { 'cf-connecting-ip': '10.0.0.100' },
    });
    assert.strictEqual(getClientIp(req), '10.0.0.100', 'CF header must win over socket addr');
  });

  await test('getClientIp: falls back to loopback 127.0.0.1 when CF header absent', async () => {
    const req = makeReq({ socket: { remoteAddress: '172.16.0.1' }, headers: {} });
    assert.strictEqual(getClientIp(req), '127.0.0.1', 'must fall back to loopback when CF header absent');
  });

  await test('quota: banned CF IP is blocked even if XFF shows clean IP', async () => {
    clearTables();
    const bannedIp  = '10.5.5.5';
    const cleanIp   = '8.8.8.8';
    // Exhaust quota via checkFreeQuota (atomic — consumeFreeQuota is now no-op)
    for (let i = 0; i < 3; i++) {
      const r = makeReq({ headers: { 'cf-connecting-ip': bannedIp } });
      checkFreeQuota(r, makeRes(), () => {});
    }

    const req = makeReq({
      socket:  { remoteAddress: '1.1.1.1' }, // Cloudflare edge
      headers: {
        'cf-connecting-ip': bannedIp,
        'x-forwarded-for':  cleanIp,
      },
    });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'banned CF IP must be blocked, not let through via clean XFF');
    assert.strictEqual(res._statusCode, 429);
  });

  await test('quota: clean CF IP passes even if XFF shows exhausted IP', async () => {
    clearTables();
    const exhaustedIp = '10.5.5.6';
    const cleanCfIp   = '10.5.5.7';
    consumeFreeQuota(exhaustedIp, today);
    consumeFreeQuota(exhaustedIp, today);
    consumeFreeQuota(exhaustedIp, today);

    const req = makeReq({
      socket:  { remoteAddress: '1.1.1.1' },
      headers: {
        'cf-connecting-ip': cleanCfIp,
        'x-forwarded-for':  exhaustedIp,
      },
    });
    const res = makeRes();
    let nextCalled = false;
    checkFreeQuota(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'clean CF IP must pass through regardless of XFF');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
