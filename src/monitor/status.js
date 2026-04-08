'use strict';

const fs   = require('fs');
const path = require('path');
const { getWebhookStatus } = require('./webhook-manager');

const EVENTS_FILE       = path.join(__dirname, '../../data/monitor/events.jsonl');
const WATCHLIST_DIR     = path.join(__dirname, '../../data/watchlist');
const WEBHOOK_CFG_FILE  = path.join(__dirname, '../../data/monitor/webhook-config.json');

// ── helpers ───────────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Vypočítá příští spuštění pro daný cron výraz (jen pro naše jednoduché vzory).
 * Podporuje: "0 2 * * *" (daily hour), "0 3 * * 0" (weekly sunday), "0 * * * *" (hourly), "0 9 * * *"
 */
function nextCronRun(cronExpr) {
  const [minPart, hourPart, , , dowPart] = cronExpr.trim().split(/\s+/);
  const now = new Date();
  const next = new Date(now);

  // Resetuj sekundy/ms
  next.setSeconds(0);
  next.setMilliseconds(0);

  if (minPart === '*') {
    // Každou minutu — nepoužíváme, ale pro jistotu
    next.setMinutes(now.getMinutes() + 1);
    return next.toISOString();
  }

  const minute = parseInt(minPart, 10);
  const hour   = hourPart === '*' ? null : parseInt(hourPart, 10);

  if (hour === null) {
    // "0 * * * *" — každou hodinu v minutě 0
    next.setMinutes(minute);
    if (next <= now) next.setHours(next.getHours() + 1);
    next.setMinutes(minute);
    return next.toISOString();
  }

  if (dowPart !== undefined && dowPart !== '*') {
    // Týdenní — "0 3 * * 0" (neděle = 0)
    const targetDow = parseInt(dowPart, 10);
    next.setHours(hour, minute, 0, 0);
    const curDow = next.getDay();
    let daysAhead = (targetDow - curDow + 7) % 7;
    if (daysAhead === 0 && next <= now) daysAhead = 7;
    next.setDate(next.getDate() + daysAhead);
    return next.toISOString();
  }

  // Denní — "0 2 * * *"
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// ── watchlist stats ───────────────────────────────────────────────────────────

function getWatchlistStats() {
  const stats = { total: 0, by_tier: { free: 0, basic: 0, pro: 0 }, total_addresses: 0 };

  if (!fs.existsSync(WATCHLIST_DIR)) return stats;

  const files = fs.readdirSync(WATCHLIST_DIR).filter(f =>
    f.endsWith('.json') && f !== 'index.json' && f !== 'stripe-config.json'
  );

  stats.total = files.length;

  for (const file of files) {
    try {
      const wl = JSON.parse(fs.readFileSync(path.join(WATCHLIST_DIR, file), 'utf8'));
      const tier = wl?.plan?.tier || 'free';
      if (tier in stats.by_tier) stats.by_tier[tier]++;
      else stats.by_tier.free++;
      stats.total_addresses += Array.isArray(wl?.addresses) ? wl.addresses.length : 0;
    } catch { /* poškozený soubor — přeskoč */ }
  }

  return stats;
}

// ── alert stats z events.jsonl ────────────────────────────────────────────────

function getAlertStats() {
  const result = {
    last_24h: 0,
    last_event: null,
    by_severity: { critical: 0, high: 0, warning: 0 }
  };

  if (!fs.existsSync(EVENTS_FILE)) return result;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  // Čti odzadu — max 10000 řádků
  const MAX_LINES = 10000;
  const fd = fs.openSync(EVENTS_FILE, 'r');
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;

  if (fileSize === 0) { fs.closeSync(fd); return result; }

  // Načteme posledních ~2MB (dostatečné pro 10k řádků)
  const readSize = Math.min(fileSize, 2 * 1024 * 1024);
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, fileSize - readSize);
  fs.closeSync(fd);

  const text  = buf.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim());
  // Pokud jsme nepočítali od začátku, první řádek může být neúplný — přeskoč
  const start = fileSize > readSize ? 1 : 0;
  const slice = lines.slice(start, start + MAX_LINES);

  let lastTs = null;

  for (const line of slice) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    const ts = ev.ts || ev.timestamp;
    if (!ts) continue;

    const tsMs = typeof ts === 'number'
      ? (ts > 1e12 ? ts : ts * 1000)   // unix seconds nebo millis
      : new Date(ts).getTime();

    if (lastTs === null || tsMs > lastTs) lastTs = tsMs;

    if (tsMs >= cutoff) {
      result.last_24h++;
      const sev = (ev.severity || ev.level || '').toLowerCase();
      if (sev === 'critical') result.by_severity.critical++;
      else if (sev === 'high') result.by_severity.high++;
      else if (sev === 'warning' || sev === 'warn') result.by_severity.warning++;
    }
  }

  if (lastTs !== null) result.last_event = new Date(lastTs).toISOString();

  return result;
}

// ── webhook info ──────────────────────────────────────────────────────────────

async function getWebhookInfo() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(WEBHOOK_CFG_FILE, 'utf8')); } catch { /* nový soubor */ }

  const webhookId = cfg.webhookId || null;

  if (!webhookId) {
    return { id: null, active: false, tracked_addresses: 0, url: 'https://intmolt.org/api/v2/webhook/helius' };
  }

  try {
    const wh = await getWebhookStatus(webhookId);
    return {
      id: webhookId,
      active: !!(wh && wh.webhookURL),
      tracked_addresses: Array.isArray(wh?.accountAddresses) ? wh.accountAddresses.length : (cfg.addressCount || 0),
      url: wh?.webhookURL || 'https://intmolt.org/api/v2/webhook/helius'
    };
  } catch {
    // Helius nedostupný nebo limit — vrátíme data z configu
    return {
      id: webhookId,
      active: null,   // unknown
      tracked_addresses: cfg.addressCount || 0,
      url: 'https://intmolt.org/api/v2/webhook/helius'
    };
  }
}

// ── admin middleware ──────────────────────────────────────────────────────────

function requireAdminKey(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return res.status(503).json({ error: 'ADMIN_API_KEY not configured' });
  if (req.headers['x-admin-key'] !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── main handler ──────────────────────────────────────────────────────────────

async function handleMonitorStatus(req, res) {
  try {
    const [webhookInfo, alertStats] = await Promise.all([
      getWebhookInfo(),
      Promise.resolve(getAlertStats())
    ]);

    const watchlistStats = getWatchlistStats();

    res.json({
      webhook: webhookInfo,
      watchlists: watchlistStats,
      alerts: alertStats,
      scheduler: {
        next_pro_scan:         nextCronRun('0 2 * * *'),
        next_basic_scan:       nextCronRun('0 3 * * 0'),
        next_expiration_check: nextCronRun('0 * * * *')
      },
      uptime: formatUptime(Math.floor(process.uptime()))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = { requireAdminKey, handleMonitorStatus };
