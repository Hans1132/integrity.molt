'use strict';

const https = require('https');

// ── State pro rate limiting a deduplikaci ─────────────────────────────────────

/** Deduplikace: signature:rule → true */
const sentAlerts = new Map();

/** Rate limit per adresa: address → [timestamps] (hodinové okno) */
const rateWindows = new Map();

/** Telegram batch queue: chatId → [{ alert, timestamp }] */
const telegramBatchQueue = new Map();

const RATE_LIMIT_MAX    = 10;    // max alertů per adresa per hodinu
const RATE_LIMIT_WINDOW = 3600_000; // 1 hodina v ms
const BATCH_WINDOW      = 5 * 60_000; // 5 minut pro warning batching

// Severity order pro Telegram emoji a formátování
const SEVERITY_EMOJI = {
  critical: '🚨',
  high:     '⚠️',
  warning:  '⚡',
  info:     'ℹ️',
};

// ── Deduplikace ───────────────────────────────────────────────────────────────

function isDuplicate(alert) {
  if (!alert.tx_signature) return false;
  const key = `${alert.tx_signature}:${alert.rule}`;
  if (sentAlerts.has(key)) return true;
  sentAlerts.set(key, true);
  // Cleanup — udržuj map rozumně malý (max 10k záznamů)
  if (sentAlerts.size > 10_000) {
    const firstKey = sentAlerts.keys().next().value;
    sentAlerts.delete(firstKey);
  }
  return false;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function isRateLimited(address) {
  const now  = Date.now();
  const key  = address;
  const hits = (rateWindows.get(key) || []).filter(ts => now - ts < RATE_LIMIT_WINDOW);
  if (hits.length >= RATE_LIMIT_MAX) return true;
  hits.push(now);
  rateWindows.set(key, hits);
  return false;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

function getTelegramToken() {
  return process.env.TELEGRAM_BOT_TOKEN
    || (() => {
      try { return require('fs').readFileSync('/root/.secrets/telegram_bot_token', 'utf8').trim(); }
      catch { return null; }
    })();
}

async function sendTelegramMessage(chatId, text) {
  const token = getTelegramToken();
  if (!token || !chatId) {
    console.warn('[monitor/notifications] Telegram token or chatId missing');
    return;
  }
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function formatAlertMessage(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity] || '⚡';
  const sev   = alert.severity.toUpperCase();
  const txUrl = alert.tx_signature
    ? `\n🔗 <a href="https://solscan.io/tx/${alert.tx_signature}">View on Solscan</a>`
    : '';
  const scanUrl = alert.address
    ? `\n🔍 <a href="https://intmolt.org/scan?address=${alert.address}&amp;type=quick">Scan address</a>`
    : '';

  return `${emoji} <b>[${sev}] integrity.molt Alert</b>\n`
       + `${alert.message}\n`
       + `📍 Address: <code>${alert.address}</code>${txUrl}${scanUrl}`;
}

/**
 * Odešle Telegram zprávu ihned (pro critical/high).
 */
async function sendTelegramImmediate(chatId, alert) {
  try {
    await sendTelegramMessage(chatId, formatAlertMessage(alert));
    console.log(`[monitor/notifications] Telegram sent (${alert.severity}) to ${chatId}: ${alert.rule}`);
  } catch (e) {
    console.error('[monitor/notifications] Telegram send failed:', e.message);
  }
}

/**
 * Přidá warning alert do batch queue, odešle po 5 minutách.
 * Max 1 batch zpráva per chatId per 5 minut.
 */
function enqueueTelegramBatch(chatId, alert) {
  if (!telegramBatchQueue.has(chatId)) {
    telegramBatchQueue.set(chatId, []);
    // Naplánuj odeslání po 5 minutách
    setTimeout(() => flushTelegramBatch(chatId), BATCH_WINDOW);
  }
  telegramBatchQueue.get(chatId).push(alert);
}

async function flushTelegramBatch(chatId) {
  const queue = telegramBatchQueue.get(chatId) || [];
  telegramBatchQueue.delete(chatId);
  if (!queue.length) return;

  if (queue.length === 1) {
    await sendTelegramImmediate(chatId, queue[0]);
    return;
  }

  const lines = queue.map(a => {
    const emoji = SEVERITY_EMOJI[a.severity] || '⚡';
    return `${emoji} ${a.message}`;
  });

  const text = `⚡ <b>integrity.molt — ${queue.length} alerts</b>\n\n${lines.join('\n\n')}\n\n`
             + `🔍 <a href="https://intmolt.org">View dashboard</a>`;

  try {
    await sendTelegramMessage(chatId, text);
    console.log(`[monitor/notifications] Telegram batch sent to ${chatId}: ${queue.length} alerts`);
  } catch (e) {
    console.error('[monitor/notifications] Telegram batch failed:', e.message);
  }
}

// ── Email (stub — loguje, reálná implementace přes mailer.js) ─────────────────

async function sendEmailAlert(to, alert) {
  // Plná implementace přes SMTP/nodemailer bude přidána v dalším iteraci.
  // Zatím logujeme — mailer.js má sendEmail() ale pro watch alerts potřebuje HTML template.
  console.log(`[monitor/notifications] EMAIL (stub) → ${to}: [${alert.severity}] ${alert.message}`);

  // Zkus přes nodemailer pokud je k dispozici
  try {
    const nodemailer = require('nodemailer');
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: { user, pass },
    });

    const emoji = SEVERITY_EMOJI[alert.severity] || '⚡';
    const subject = `${emoji} [${alert.severity.toUpperCase()}] ${alert.rule.replace(/_/g, ' ')} — integrity.molt`;
    const txLink = alert.tx_signature
      ? `<a href="https://solscan.io/tx/${alert.tx_signature}">${alert.tx_signature.slice(0, 20)}…</a>`
      : 'N/A';

    const html = `
<div style="font-family:sans-serif;max-width:540px;margin:0 auto;background:#0f0f18;color:#d0d8e8;border:1px solid #1e1e2e;border-radius:10px;padding:28px">
  <h2 style="margin:0 0 16px;color:#fff;font-size:18px">${emoji} ${alert.message}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
    <tr><td style="color:#6a7490;padding:4px 0;width:120px">Severity</td>
        <td style="color:${alert.severity === 'critical' ? '#f85149' : alert.severity === 'high' ? '#d29922' : '#3fb950'};font-weight:700;text-transform:uppercase">${alert.severity}</td></tr>
    <tr><td style="color:#6a7490;padding:4px 0">Rule</td>
        <td>${alert.rule}</td></tr>
    <tr><td style="color:#6a7490;padding:4px 0">Address</td>
        <td style="font-family:monospace;word-break:break-all">${alert.address}</td></tr>
    <tr><td style="color:#6a7490;padding:4px 0">Transaction</td>
        <td style="font-family:monospace">${txLink}</td></tr>
    <tr><td style="color:#6a7490;padding:4px 0">Time</td>
        <td>${new Date(alert.timestamp).toISOString()}</td></tr>
  </table>
  <a href="https://intmolt.org/scan?address=${alert.address}&type=quick"
     style="display:inline-block;padding:10px 20px;background:#4da6ff;color:#000;font-weight:700;border-radius:6px;text-decoration:none;font-size:14px">
    Scan Address →
  </a>
</div>`;

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || user,
      to,
      subject,
      html,
    });
    console.log(`[monitor/notifications] Email sent to ${to}`);
  } catch (e) {
    console.error('[monitor/notifications] Email send failed:', e.message);
  }
}

// ── Webhook callback ──────────────────────────────────────────────────────────

async function sendWebhookCallback(url, alert) {
  try {
    const body = JSON.stringify(alert);
    await new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        port:     parsed.port || 443,
        path:     parsed.pathname + (parsed.search || ''),
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    });
    console.log(`[monitor/notifications] Webhook callback sent to ${url}`);
  } catch (e) {
    console.error(`[monitor/notifications] Webhook callback failed (${url}):`, e.message);
  }
}

// ── Hlavní dispatcher ─────────────────────────────────────────────────────────

/**
 * Odešle alert přes všechny zadané kanály.
 * Channels: [{ type: 'telegram', chatId }, { type: 'email', to }, { type: 'webhook', url }]
 */
async function sendAlert(alert, channels = []) {
  // 1. Deduplikace
  if (isDuplicate(alert)) {
    console.log(`[monitor/notifications] Duplicate alert skipped: ${alert.id}`);
    return;
  }

  // 2. Rate limit
  if (isRateLimited(alert.address)) {
    console.log(`[monitor/notifications] Rate limit hit for ${alert.address}`);
    return;
  }

  // 3. Odeslání per kanál
  const promises = [];

  for (const ch of channels) {
    if (ch.type === 'telegram') {
      // Critical a high → okamžitě; warning → batch
      if (alert.severity === 'critical' || alert.severity === 'high') {
        promises.push(sendTelegramImmediate(ch.chatId, alert));
      } else {
        enqueueTelegramBatch(ch.chatId, alert);
      }
    } else if (ch.type === 'email') {
      promises.push(sendEmailAlert(ch.to, alert));
    } else if (ch.type === 'webhook') {
      promises.push(sendWebhookCallback(ch.url, alert));
    }
  }

  await Promise.allSettled(promises);
}

module.exports = {
  sendAlert,
  // Export pro testování
  isDuplicate,
  isRateLimited,
  formatAlertMessage,
  _sentAlerts:   sentAlerts,
  _rateWindows:  rateWindows,
};
