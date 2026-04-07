'use strict';
/**
 * mailer.js — Automatický weekly digest pro předplatitele integrity.molt
 *
 * Spouštěno ze server.js každých 7 dní (nebo manuálně GET /admin/digest/run).
 * Předplatitelé dostanou email s:
 *   - Stav watchlistu (risk level každé sledované adresy)
 *   - Přehled scanů za posledních 7 dní
 *   - Reminder na nevyužité deep audity
 */

const nodemailer = require('nodemailer');
const { Pool }   = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Email transporter ──────────────────────────────────────────────────────────

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user, pass }
  });
}

const FROM = () => process.env.SMTP_FROM || process.env.SMTP_USER || 'alerts@intmolt.org';

// ── DB queries pro digest ──────────────────────────────────────────────────────

async function getActiveSubscribers() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (email) email, tier, current_period_end
    FROM subscriptions
    WHERE status = 'active'
      AND (current_period_end IS NULL OR current_period_end > now())
      AND digest_unsubscribed = FALSE
    ORDER BY email, current_period_end DESC
  `);
  return rows;
}

async function getSubscriberWatchlist(email) {
  const { rows } = await pool.query(`
    SELECT address, label, last_risk_level, last_risk_score, last_checked_at
    FROM watchlist
    WHERE notify_email = $1 AND active = TRUE
    ORDER BY last_risk_score DESC NULLS LAST, created_at
  `, [email]);
  return rows;
}

async function getWeeklyScanSummary(email) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                             AS total_scans,
      COUNT(*) FILTER (WHERE risk_level = 'high')         AS high_risk,
      COUNT(*) FILTER (WHERE risk_level = 'critical')     AS critical_risk,
      COUNT(*) FILTER (WHERE risk_level = 'medium')       AS medium_risk,
      COUNT(*) FILTER (WHERE scan_type  = 'deep')         AS deep_scans,
      MAX(risk_score)                                      AS max_score,
      COUNT(DISTINCT address)                              AS unique_addresses
    FROM scan_history
    WHERE email = $1
      AND created_at >= now() - INTERVAL '7 days'
  `, [email]);
  return rows[0] || {};
}

async function getDigestAd() {
  const { rows } = await pool.query(`
    SELECT id, advertiser, headline, tagline, cta_text, cta_url, image_url, cpm_usd
    FROM ads
    WHERE active = TRUE AND (placement = 'digest' OR placement = 'all')
      AND (expires_at IS NULL OR expires_at > now())
      AND (budget_usd IS NULL OR spent_usd < budget_usd)
    ORDER BY impressions ASC, RANDOM()
    LIMIT 1
  `);
  return rows[0] || null;
}

async function trackDigestAdImpression(ad) {
  const cpm = parseFloat(ad.cpm_usd || 0);
  await pool.query(
    `UPDATE ads SET impressions = impressions + 1, spent_usd = spent_usd + $2 WHERE id = $1`,
    [ad.id, cpm / 1000]
  );
}

async function getRecentHighRiskScans(email) {
  const { rows } = await pool.query(`
    SELECT address, scan_type, risk_score, risk_level, summary, created_at
    FROM scan_history
    WHERE email = $1
      AND risk_level IN ('high', 'critical')
      AND created_at >= now() - INTERVAL '7 days'
    ORDER BY risk_score DESC, created_at DESC
    LIMIT 5
  `, [email]);
  return rows;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

const RISK_COLOR = { low: '#3fb950', medium: '#d29922', high: '#f85149', critical: '#ff4444', unknown: '#6a7490' };
const RISK_BG    = { low: 'rgba(63,185,80,.15)', medium: 'rgba(210,153,34,.15)', high: 'rgba(248,81,73,.15)', critical: 'rgba(255,68,68,.2)', unknown: 'rgba(106,116,144,.1)' };

function riskBadge(level, score) {
  const c = RISK_COLOR[level] || RISK_COLOR.unknown;
  const bg = RISK_BG[level]  || RISK_BG.unknown;
  const label = score != null ? `${score}` : (level || 'unknown').toUpperCase();
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${bg};color:${c};font-weight:700;font-size:12px;font-family:monospace">${label}</span>`;
}

function shortAddr(addr) {
  return addr ? addr.slice(0, 8) + '…' + addr.slice(-4) : '—';
}

function buildDigestHtml({ email, tier, watchlist, summary, highRiskScans, periodEnd, sponsoredAd }) {
  const periodStr = periodEnd ? new Date(periodEnd).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const tierLabel = tier === 'team' ? 'Team' : 'Builder';
  const scanUrl   = 'https://intmolt.org/scan';
  const dashUrl   = 'https://intmolt.org/dashboard';

  // Watchlist sekce
  let watchlistHtml = '';
  if (watchlist.length === 0) {
    watchlistHtml = `<p style="color:#6a7490;font-size:13px">Nemáte žádné adresy ve watchlistu. <a href="${dashUrl}" style="color:#4da6ff">Přidejte je v dashboardu →</a></p>`;
  } else {
    watchlistHtml = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="border-bottom:1px solid #1e1e2e">
          <th style="text-align:left;padding:6px 0;color:#6a7490;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Adresa</th>
          <th style="text-align:left;padding:6px 0;color:#6a7490;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Label</th>
          <th style="text-align:center;padding:6px 0;color:#6a7490;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Risk</th>
        </tr>
        ${watchlist.map(w => `
        <tr style="border-bottom:1px solid #12121e">
          <td style="padding:9px 0;font-family:monospace;color:#4da6ff">
            <a href="${scanUrl}?address=${w.address}&type=quick" style="color:#4da6ff;text-decoration:none">${shortAddr(w.address)}</a>
          </td>
          <td style="padding:9px 0;color:#8b95b0">${w.label || '—'}</td>
          <td style="padding:9px 0;text-align:center">${riskBadge(w.last_risk_level, w.last_risk_score)}</td>
        </tr>`).join('')}
      </table>`;
  }

  // High risk scan sekce
  let highRiskHtml = '';
  if (highRiskScans.length > 0) {
    highRiskHtml = `
      <div style="margin-top:24px">
        <h3 style="margin:0 0 12px;color:#f85149;font-size:15px">⚠️ High risk nálezy tento týden</h3>
        ${highRiskScans.map(s => `
        <div style="background:#1a0a0a;border:1px solid #f8514933;border-radius:6px;padding:12px 16px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <a href="${scanUrl}?address=${s.address}&type=quick" style="color:#4da6ff;font-family:monospace;font-size:13px;text-decoration:none">${shortAddr(s.address)}</a>
            ${riskBadge(s.risk_level, s.risk_score)}
          </div>
          ${s.summary ? `<p style="margin:6px 0 0;color:#8b95b0;font-size:12px">${s.summary.slice(0, 120)}${s.summary.length > 120 ? '…' : ''}</p>` : ''}
        </div>`).join('')}
      </div>`;
  }

  // Reminder na deep audit
  const deepReminder = tier === 'builder' && (summary.deep_scans ?? 0) === 0
    ? `<div style="margin-top:20px;background:#0d1520;border:1px solid #1e3a5f;border-radius:8px;padding:14px 18px">
        <p style="margin:0;color:#4da6ff;font-size:13px">💡 <strong>Tip:</strong> Váš Builder plán zahrnuje 20 deep auditů/měsíc — tento týden jste žádný nevyužili. <a href="${scanUrl}" style="color:#4da6ff">Spustit deep audit →</a></p>
       </div>`
    : '';

  return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:580px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="text-align:center;padding:20px 0 28px">
    <span style="font-family:monospace;font-size:20px;font-weight:700;color:#fff">integrity<span style="color:#4da6ff">.</span>molt</span>
    <p style="margin:6px 0 0;color:#6a7490;font-size:12px">Weekly security digest — ${new Date().toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
  </div>

  <!-- Subscription badge -->
  <div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:10px;padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
    <div>
      <span style="font-size:13px;color:#d0d8e8">Plán: <strong style="color:#4da6ff">${tierLabel}</strong></span>
      ${periodStr ? `<span style="font-size:12px;color:#6a7490;margin-left:12px">platnost do ${periodStr}</span>` : ''}
    </div>
    <a href="${dashUrl}" style="font-size:12px;color:#4da6ff;text-decoration:none">Dashboard →</a>
  </div>

  <!-- Scan summary -->
  <div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;color:#fff;font-size:16px">📊 Přehled za posledních 7 dní</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
      <div style="background:#12121e;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#4da6ff">${summary.total_scans ?? 0}</div>
        <div style="font-size:11px;color:#6a7490;margin-top:2px">Celkem scanů</div>
      </div>
      <div style="background:#12121e;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#f85149">${(parseInt(summary.high_risk ?? 0) + parseInt(summary.critical_risk ?? 0))}</div>
        <div style="font-size:11px;color:#6a7490;margin-top:2px">High/Critical</div>
      </div>
      <div style="background:#12121e;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#d0d8e8">${summary.unique_addresses ?? 0}</div>
        <div style="font-size:11px;color:#6a7490;margin-top:2px">Unikátních adres</div>
      </div>
    </div>
  </div>

  <!-- Watchlist -->
  <div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <h2 style="margin:0 0 16px;color:#fff;font-size:16px">👁 Váš watchlist</h2>
    ${watchlistHtml}
  </div>

  ${highRiskHtml}
  ${deepReminder}

  ${sponsoredAd ? `
  <!-- Sponsored -->
  <div style="margin-top:24px;border:1px solid #2a2a3a;border-radius:8px;background:#0c0c18;overflow:hidden">
    <div style="padding:4px 12px;font-size:10px;font-family:monospace;color:#3a3f54;text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid #1a1a2a">Sponsored</div>
    <div style="padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      ${sponsoredAd.image_url ? `<img src="${sponsoredAd.image_url}" alt="${sponsoredAd.advertiser}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0">` : ''}
      <div style="flex:1;min-width:140px">
        <div style="font-size:14px;font-weight:600;color:#d0d8e8">${sponsoredAd.headline}</div>
        ${sponsoredAd.tagline ? `<div style="font-size:12px;color:#8b95b0;margin-top:3px">${sponsoredAd.tagline}</div>` : ''}
      </div>
      <a href="https://intmolt.org/ads/click/${sponsoredAd.id}" style="padding:8px 16px;border:1px solid #4da6ff;color:#4da6ff;font-size:12px;font-weight:600;border-radius:5px;text-decoration:none;white-space:nowrap;flex-shrink:0">${sponsoredAd.cta_text || 'Learn more'} →</a>
    </div>
  </div>` : ''}

  <!-- CTA -->
  <div style="text-align:center;margin:28px 0 20px">
    <a href="${scanUrl}" style="display:inline-block;padding:12px 28px;background:#4da6ff;color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:14px">Spustit nový scan →</a>
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid #1e1e2e;padding-top:16px;text-align:center">
    <p style="margin:0;font-size:11px;color:#3a3f54">
      integrity.molt · AI-native Solana security ·
      <a href="${dashUrl}" style="color:#6a7490">dashboard</a> ·
      <a href="https://intmolt.org/unsubscribe?email=${encodeURIComponent(email)}" style="color:#6a7490">odhlásit digest</a>
    </p>
  </div>

</div>
</body></html>`;
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runWeeklyDigests() {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[mailer] SMTP není nakonfigurováno — weekly digest přeskočen');
    return;
  }

  const subscribers = await getActiveSubscribers();
  console.log(`[mailer] weekly digest: ${subscribers.length} aktivních předplatitelů`);

  // Načíst sponsored ad jednou pro všechny (stejný pro celý batch)
  const sponsoredAd = await getDigestAd().catch(() => null);
  if (sponsoredAd) {
    await trackDigestAdImpression(sponsoredAd).catch(() => {});
    console.log(`[mailer] sponsored ad: "${sponsoredAd.headline}" (id=${sponsoredAd.id})`);
  }

  let sent = 0, failed = 0;
  for (const sub of subscribers) {
    try {
      const [watchlist, summary, highRiskScans] = await Promise.all([
        getSubscriberWatchlist(sub.email),
        getWeeklyScanSummary(sub.email),
        getRecentHighRiskScans(sub.email)
      ]);

      const html = buildDigestHtml({
        email:        sub.email,
        tier:         sub.tier,
        watchlist,
        summary,
        highRiskScans,
        periodEnd:    sub.current_period_end,
        sponsoredAd
      });

      await transporter.sendMail({
        from:    FROM(),
        to:      sub.email,
        subject: `[integrity.molt] Váš weekly security digest — ${new Date().toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long' })}`,
        html
      });

      sent++;
      console.log(`[mailer] digest sent to ${sub.email} (${sub.tier})`);
    } catch (e) {
      failed++;
      console.error(`[mailer] digest failed for ${sub.email}:`, e.message);
    }

    // Krátká pauza mezi emaily — nezahltit SMTP
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[mailer] weekly digest done: ${sent} sent, ${failed} failed`);
  return { sent, failed, total: subscribers.length };
}

// ── Welcome email ──────────────────────────────────────────────────────────────

function buildWelcomeHtml({ email, tier }) {
  const tierLabel  = tier === 'team' ? 'Team' : 'Builder';
  const scanUrl    = 'https://intmolt.org/scan';
  const dashUrl    = 'https://intmolt.org/dashboard';
  const docsUrl    = 'https://intmolt.org/docs.html';
  const deepLimit  = tier === 'team' ? 'unlimited' : '20/měsíc';

  return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">

  <!-- Header -->
  <div style="text-align:center;padding:0 0 32px">
    <span style="font-family:monospace;font-size:22px;font-weight:700;color:#fff">integrity<span style="color:#4da6ff">.</span>molt</span>
  </div>

  <!-- Hero -->
  <div style="background:#0f0f18;border:1px solid #1e3a5f;border-radius:12px;padding:28px 28px 24px;margin-bottom:20px;text-align:center">
    <div style="font-size:36px;margin-bottom:12px">✓</div>
    <h1 style="margin:0 0 8px;color:#fff;font-size:22px;font-weight:700">Vítejte v integrity.molt</h1>
    <p style="margin:0;color:#6a7490;font-size:14px">Plán <strong style="color:#4da6ff">${tierLabel}</strong> je aktivní. Váš účet je připraven.</p>
  </div>

  <!-- Co máte k dispozici -->
  <div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:10px;padding:20px 24px;margin-bottom:16px">
    <h2 style="margin:0 0 14px;color:#fff;font-size:15px">Co máte k dispozici</h2>
    <table style="width:100%;border-collapse:collapse">
      ${[
        ['Unlimited quick/token/wallet/pool scany', '✓'],
        [`Deep Audit (full AI swarm)`, deepLimit],
        ['API klíč pro CI/CD integraci', '✓'],
        ['Ed25519 podepsané reporty', '✓'],
        ['Weekly security digest', '✓'],
        tier === 'team' ? ['Watchlist — 100 adres, Slack/Telegram alerty', '✓'] : ['Watchlist — základní monitorování', '✓'],
      ].map(([feat, val]) => `
      <tr style="border-bottom:1px solid #12121e">
        <td style="padding:9px 0;color:#8b95b0;font-size:13px">${feat}</td>
        <td style="padding:9px 0;color:#3fb950;font-family:monospace;font-size:13px;font-weight:700;text-align:right;white-space:nowrap">${val}</td>
      </tr>`).join('')}
    </table>
  </div>

  <!-- 3 kroky -->
  <div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <h2 style="margin:0 0 14px;color:#fff;font-size:15px">Začněte za 3 minuty</h2>
    ${[
      ['1', 'Spusťte první scan', `Vložte libovolnou Solana nebo EVM adresu na <a href="${scanUrl}" style="color:#4da6ff">scan stránce</a>.`],
      ['2', 'Přidejte adresy do watchlistu', `V <a href="${dashUrl}" style="color:#4da6ff">dashboardu</a> sledujte adresy a dostávejte weekly report.`],
      ['3', 'Integrujte API (v2)', `Váš API klíč je v <a href="${dashUrl}" style="color:#4da6ff">dashboardu</a> pod "API Key". Base URL: <code style="background:#12121e;padding:1px 5px;border-radius:3px;font-size:11px">https://intmolt.org/api/v2/</code> — <a href="${docsUrl}" style="color:#4da6ff">dokumentace</a>`],
    ].map(([num, title, desc]) => `
    <div style="display:flex;gap:14px;margin-bottom:14px;align-items:flex-start">
      <div style="width:26px;height:26px;border-radius:50%;background:#0d1520;border:1px solid #1e3a5f;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:monospace;font-size:12px;color:#4da6ff;font-weight:700;margin-top:1px">${num}</div>
      <div>
        <div style="color:#d0d8e8;font-size:13px;font-weight:600;margin-bottom:2px">${title}</div>
        <div style="color:#6a7490;font-size:12px;line-height:1.5">${desc}</div>
      </div>
    </div>`).join('')}
  </div>

  <!-- CTA -->
  <div style="text-align:center;margin-bottom:28px">
    <a href="${scanUrl}" style="display:inline-block;padding:13px 32px;background:#4da6ff;color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:14px">Spustit první scan →</a>
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid #1e1e2e;padding-top:16px;text-align:center">
    <p style="margin:0;font-size:11px;color:#3a3f54">
      integrity.molt · AI-native Solana security ·
      <a href="${dashUrl}" style="color:#6a7490">dashboard</a> ·
      <a href="https://intmolt.org/unsubscribe?email=${encodeURIComponent(email)}" style="color:#6a7490">odhlásit se</a>
    </p>
    <p style="margin:8px 0 0;font-size:11px;color:#3a3f54">Tento email byl odeslán na ${email} protože jste si zakoupili plán ${tierLabel}.</p>
  </div>

</div>
</body></html>`;
}

async function sendWelcomeEmail({ email, tier }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[mailer] SMTP není nakonfigurováno — welcome email přeskočen pro ${email}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from:    FROM(),
      to:      email,
      subject: `Vítejte v integrity.molt — váš ${tier === 'team' ? 'Team' : 'Builder'} plán je aktivní`,
      html:    buildWelcomeHtml({ email, tier })
    });
    console.log(`[mailer] welcome email sent to ${email} (${tier})`);
    return true;
  } catch (e) {
    console.error(`[mailer] welcome email failed for ${email}:`, e.message);
    return false;
  }
}

module.exports = { runWeeklyDigests, getActiveSubscribers, sendWelcomeEmail };
