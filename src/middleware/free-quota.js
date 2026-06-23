'use strict';

const { timingSafeEqual } = require('node:crypto');
function _safeStrEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const PER_IP_DAILY_LIMIT = 3;
const GLOBAL_DAILY_CAP   = 500;

const INTERNAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const INTERNAL_SECRET = process.env.INTERNAL_SCAN_SECRET;

function getClientIp(req) {
  // CF-Connecting-IP is the only trusted source per CLAUDE.md sharp edge #1.
  // Fallback to loopback — internal callers are caught by isInternalCall() first.
  return req.headers['cf-connecting-ip'] || '127.0.0.1';
}

function isInternalCall(req) {
  const ip = getClientIp(req);
  if (INTERNAL_IPS.has(ip)) return true;
  if (INTERNAL_SECRET && _safeStrEq(req.headers['x-internal-secret'] || '', INTERNAL_SECRET)) return true;
  return false;
}

function createQuotaMiddleware(db) {
  const stmtGlobal    = db.prepare('SELECT free_count FROM global_scan_stats WHERE stat_date = ?');
  const stmtIp        = db.prepare('SELECT count FROM free_scan_quota WHERE identifier = ? AND scan_date = ?');
  const stmtConsumeIp = db.prepare(`
    INSERT INTO free_scan_quota (identifier, scan_date, count)
    VALUES (?, ?, 1)
    ON CONFLICT(identifier, scan_date) DO UPDATE SET
      count = count + 1,
      last_scan_at = CURRENT_TIMESTAMP
  `);
  const stmtConsumeGlobal = db.prepare(`
    INSERT INTO global_scan_stats (stat_date, free_count)
    VALUES (?, 1)
    ON CONFLICT(stat_date) DO UPDATE SET free_count = free_count + 1
  `);

  // Atomická transakce: zkontroluj + spotřebuj v jednom kroku → eliminuje race condition
  const checkAndConsumeTx = db.transaction((ip, today) => {
    const globalRow  = stmtGlobal.get(today);
    const globalUsed = globalRow ? globalRow.free_count : 0;
    if (globalUsed >= GLOBAL_DAILY_CAP) return { denied: 'global', globalUsed };

    const ipRow = stmtIp.get(ip, today);
    const used  = ipRow ? ipRow.count : 0;
    if (used >= PER_IP_DAILY_LIMIT) return { denied: 'ip', used };

    stmtConsumeIp.run(ip, today);
    stmtConsumeGlobal.run(today);
    return { ok: true, used, remaining: PER_IP_DAILY_LIMIT - used - 1 };
  });

  const stmtLogAbuse = db.prepare(
    `INSERT INTO abuse_events (ip, event_type, details) VALUES (?, ?, ?)`
  );

  function checkFreeQuota(req, res, next) {
    if (isInternalCall(req)) return next();

    const ip    = getClientIp(req);
    const today = new Date().toISOString().slice(0, 10);
    let result;
    try { result = checkAndConsumeTx(ip, today); } catch { return next(); } // non-fatal DB error

    if (result.denied === 'global') {
      try { stmtLogAbuse.run(ip, 'global_cap_hit', JSON.stringify({ global_used: result.globalUsed })); } catch {}
      return res.status(429).json({
        error:        'Daily free scan capacity exhausted',
        message:      'Free tier limit reached globally. Try again tomorrow or upgrade for unlimited scans.',
        global_limit: GLOBAL_DAILY_CAP,
        global_used:  result.globalUsed,
        upgrade_url:  'https://intmolt.org/scan',
      });
    }
    if (result.denied === 'ip') {
      try { stmtLogAbuse.run(ip, 'quota_exceeded', JSON.stringify({ used: result.used, limit: PER_IP_DAILY_LIMIT })); } catch {}
      return res.status(429).json({
        error:       'Daily free scan limit reached',
        message:     `You've used ${result.used}/${PER_IP_DAILY_LIMIT} free scans today. Limit resets at midnight UTC.`,
        used:        result.used,
        limit:       PER_IP_DAILY_LIMIT,
        remaining:   0,
        resets_at:   'midnight UTC',
        upgrade_url: 'https://intmolt.org/scan',
      });
    }

    req.freeQuota = { ip, today, used: result.used, remaining: result.remaining };
    next();
  }

  // consumeFreeQuota zůstává jako no-op pro backward compat s callers
  // (transakce ji již spotřebovala v checkFreeQuota)
  function consumeFreeQuota(_ip, _today) {
    // no-op: quota již spotřebována atomicky v checkFreeQuota
  }

  // tryConsumeFreeQuota — atomický check+consume pro endpointy, které kvótu
  // vynucují inline (až PO vlastním paid/CAPTCHA/cache gatingu), ne přes
  // checkFreeQuota middleware. Vrací stejný tvar jako interní transakce:
  // { ok, used, remaining } nebo { denied: 'ip'|'global', used|globalUsed }.
  // Fail-OPEN při DB chybě (shoda s checkFreeQuota) — transientní chyba nikdy
  // neblokuje scan.
  function tryConsumeFreeQuota(ip) {
    const today = new Date().toISOString().slice(0, 10);
    try { return checkAndConsumeTx(ip, today); }
    catch { return { ok: true, dbError: true }; }
  }

  function getQuotaStatus(ip) {
    const today  = new Date().toISOString().slice(0, 10);
    const ipRow  = stmtIp.get(ip, today);
    const used   = ipRow ? ipRow.count : 0;
    const globalRow  = stmtGlobal.get(today);
    const globalUsed = globalRow ? globalRow.free_count : 0;
    return {
      limit:        PER_IP_DAILY_LIMIT,
      used,
      remaining:    Math.max(0, PER_IP_DAILY_LIMIT - used),
      resets_at:    'midnight UTC',
      global_used:  globalUsed,
      global_limit: GLOBAL_DAILY_CAP,
    };
  }

  return { checkFreeQuota, consumeFreeQuota, tryConsumeFreeQuota, getQuotaStatus, getClientIp, isInternalCall };
}

function createBlacklistMiddleware(db) {
  const stmtCheck = db.prepare(`
    SELECT reason, expires_at FROM ip_blacklist
    WHERE ip = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `);
  const stmtHit = db.prepare(`
    UPDATE ip_blacklist SET hit_count = hit_count + 1 WHERE ip = ?
  `);
  const stmtInsert = db.prepare(`
    INSERT INTO ip_blacklist (ip, reason, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      hit_count = hit_count + 1
  `);
  const stmtLogAbuse = db.prepare(`
    INSERT INTO abuse_events (ip, event_type, details) VALUES (?, ?, ?)
  `);

  function checkBlacklist(req, res, next) {
    const ip = getClientIp(req);
    if (INTERNAL_IPS.has(ip)) return next();

    const row = stmtCheck.get(ip);
    if (row) {
      try { stmtHit.run(ip); } catch {}
      return res.status(403).json({
        error:   'Access denied',
        reason:  'rate_abuse_auto_blocked',
        message: 'Your IP has been temporarily blocked due to abuse patterns. Contact support if you believe this is an error.',
      });
    }
    next();
  }

  function logAbuseEvent(ip, eventType, details = {}) {
    try { stmtLogAbuse.run(ip, eventType, JSON.stringify(details)); } catch {}
  }

  function addToBlacklist(ip, reason, durationHours = 24) {
    const expiresAt = new Date(Date.now() + durationHours * 3600 * 1000).toISOString();
    try { stmtInsert.run(ip, reason, expiresAt); } catch {}
  }

  return { checkBlacklist, logAbuseEvent, addToBlacklist };
}

module.exports = { createQuotaMiddleware, createBlacklistMiddleware, PER_IP_DAILY_LIMIT, GLOBAL_DAILY_CAP, getClientIp };
