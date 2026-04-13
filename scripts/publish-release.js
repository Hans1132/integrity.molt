#!/usr/bin/env node
/**
 * publish-release.js — generuje SEO blog post z CHANGELOG.md a broadcastuje Telegram
 *
 * Použití:
 *   node scripts/publish-release.js v0.5.0
 *
 * Co udělá:
 *   1. Načte sekci vX.Y.Z z CHANGELOG.md
 *   2. Zavolá Claude API → expanduje na plný SEO blog post HTML
 *   3. Zapíše do public/blog/{slug}.html
 *   4. Aktualizuje public/sitemap.xml
 *   5. Pošle Telegram broadcast všem subscriberům s telegram_chat_id
 *      + ADMIN_TELEGRAM_CHAT (pokud nastaven)
 */
'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ROOT    = path.join(__dirname, '..');
const BLOG    = path.join(ROOT, 'public', 'blog');
const SITEMAP = path.join(ROOT, 'public', 'sitemap.xml');

// ── Argument ──────────────────────────────────────────────────────────────────

const version = process.argv[2];
if (!version || !/^v\d+\.\d+\.\d+$/.test(version)) {
  console.error('Použití: node scripts/publish-release.js v0.5.0');
  process.exit(1);
}

// ── CHANGELOG parser ──────────────────────────────────────────────────────────

function parseChangelogSection(version) {
  const raw = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
  // Najdi sekci ## [vX.Y.Z]
  const escaped = version.replace(/\./g, '\\.');
  const re = new RegExp(`## \\[${escaped}\\][^\n]*\n([\\s\\S]*?)(?=\n## \\[|$)`);
  const m = raw.match(re);
  if (!m) throw new Error(`Verze ${version} nenalezena v CHANGELOG.md`);
  return m[1].trim();
}

// ── Claude API ────────────────────────────────────────────────────────────────

function claudeRequest(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY
      || (() => { try { return fs.readFileSync('/root/.secrets/anthropic_api_key', 'utf8').trim(); } catch { return null; } })();

    if (!apiKey) throw new Error('ANTHROPIC_API_KEY chybí');

    const body = JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 8000,
      system:     systemPrompt,
      messages
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Šablona HTML (CSS je kopie z v040-release.html) ──────────────────────────

function buildHtml({ version, slug, date, title, ogTitle, ogDesc, keywords, tag, readTime, tldr, bodyHtml }) {
  const isoDate = new Date(date).toISOString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-WXYD5E5NWE"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-WXYD5E5NWE');
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | intmolt.org</title>
  <meta name="description" content="${ogDesc}">
  <meta name="keywords" content="${keywords}">
  <link rel="canonical" href="https://intmolt.org/blog/${slug}">

  <!-- Open Graph -->
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://intmolt.org/blog/${slug}">
  <meta property="og:image" content="https://intmolt.org/og-image.png">
  <meta property="article:published_time" content="${isoDate}">
  <meta property="article:author" content="integrity.molt">
  <meta property="article:section" content="Release Notes">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
  <meta name="twitter:image" content="https://intmolt.org/og-image.png">

  <!-- JSON-LD -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "${title}",
    "description": "${ogDesc}",
    "url": "https://intmolt.org/blog/${slug}",
    "datePublished": "${date}",
    "author": { "@type": "Organization", "name": "integrity.molt", "url": "https://intmolt.org" },
    "publisher": { "@type": "Organization", "name": "integrity.molt", "url": "https://intmolt.org" },
    "image": "https://intmolt.org/og-image.png",
    "keywords": "${keywords}"
  }
  </script>

  <style>
    :root {
      --bg: #0a0e14;
      --surface: #111820;
      --surface2: #1a2332;
      --border: #1e3050;
      --accent: #00ff88;
      --accent2: #4da6ff;
      --green: #22c55e;
      --yellow: #f59e0b;
      --red: #ef4444;
      --text: #e2e8f0;
      --muted: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.7; font-size: 16px; }
    nav { border-bottom: 1px solid var(--border); padding: 14px 0; background: var(--bg); position: sticky; top: 0; z-index: 100; }
    nav .inner { max-width: 900px; margin: 0 auto; padding: 0 24px; display: flex; justify-content: space-between; align-items: center; }
    nav .logo { font-family: monospace; font-size: 18px; color: var(--accent); text-decoration: none; font-weight: 700; }
    nav .links { display: flex; gap: 24px; }
    nav .links a { color: var(--muted); text-decoration: none; font-size: 14px; transition: color .2s; }
    nav .links a:hover { color: var(--text); }
    article { max-width: 820px; margin: 0 auto; padding: 60px 24px 80px; }
    .tag { display: inline-block; font-size: 11px; font-family: monospace; background: rgba(0,255,136,.1); color: var(--accent); border: 1px solid rgba(0,255,136,.2); padding: 3px 10px; border-radius: 4px; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 18px; }
    h1 { font-size: clamp(26px, 4vw, 40px); font-weight: 800; line-height: 1.2; margin-bottom: 16px; letter-spacing: -.01em; }
    .meta { color: var(--muted); font-size: 14px; margin-bottom: 40px; display: flex; gap: 20px; flex-wrap: wrap; align-items: center; }
    .version-badge { display: inline-block; font-family: monospace; font-size: 13px; background: rgba(0,255,136,.1); color: var(--accent); border: 1px solid rgba(0,255,136,.3); padding: 4px 14px; border-radius: 20px; margin-left: 10px; vertical-align: middle; }
    .tldr { background: var(--surface2); border-left: 3px solid var(--accent); padding: 20px 24px; border-radius: 0 8px 8px 0; margin-bottom: 48px; font-size: 15px; }
    .tldr strong { color: var(--accent); display: block; margin-bottom: 8px; font-family: monospace; font-size: 12px; letter-spacing: .1em; }
    h2 { font-size: 22px; font-weight: 700; margin-top: 56px; margin-bottom: 20px; color: var(--accent); font-family: monospace; }
    h2::before { content: "## "; opacity: .4; }
    h3 { font-size: 17px; font-weight: 600; margin-top: 32px; margin-bottom: 12px; color: var(--text); }
    p { margin-bottom: 18px; color: #c8d8e8; }
    ul, ol { padding-left: 24px; margin-bottom: 18px; }
    li { margin-bottom: 8px; color: #c8d8e8; }
    li strong { color: var(--text); }
    pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px 24px; overflow-x: auto; font-family: monospace; font-size: 13px; line-height: 1.7; margin: 24px 0; color: #a0b8d0; }
    code { font-family: monospace; font-size: 13px; background: var(--surface2); border: 1px solid var(--border); border-radius: 3px; padding: 1px 6px; color: var(--accent); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .callout { background: rgba(0,255,136,.05); border: 1px solid rgba(0,255,136,.15); border-radius: 8px; padding: 18px 22px; margin: 28px 0; font-size: 14px; }
    .callout strong { color: var(--accent); }
    .change-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 28px 0; }
    .change-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; }
    .change-card .label { font-family: monospace; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 10px; }
    .change-card .label.ux { color: #4da6ff; }
    .change-card .label.security { color: #f59e0b; }
    .change-card .label.infra { color: #a78bfa; }
    .change-card ul { padding-left: 16px; margin: 0; }
    .change-card li { font-size: 13px; color: var(--muted); margin-bottom: 5px; }
    footer { text-align: center; padding: 40px 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 14px; }
    footer a { color: var(--muted); margin: 0 8px; }
    footer a:hover { color: var(--text); }
    @media (max-width: 600px) { article { padding: 40px 16px 60px; } .change-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>

<nav>
  <div class="inner">
    <a href="/" class="logo">integrity.molt</a>
    <div class="links">
      <a href="/scan">Scanner</a>
      <a href="/#pricing">Pricing</a>
      <a href="/docs.html">API</a>
      <a href="/blog">Blog</a>
      <a href="https://t.me/intmolt_bot" target="_blank" rel="noopener">Telegram</a>
    </div>
  </div>
</nav>

<article>
  <div class="tag">${tag}</div>
  <h1>integrity.molt ${version} <span class="version-badge">${date}</span></h1>

  <div class="meta">
    <span>📅 ${new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
    <span>⏱ ${readTime} min read</span>
  </div>

  <div class="tldr">
    <strong>TL;DR</strong>
    ${tldr}
  </div>

  ${bodyHtml}

</article>

<footer>
  <p>
    <a href="/">integrity.molt</a>
    <a href="/blog">Blog</a>
    <a href="/scan">Scanner</a>
    <a href="/docs.html">API</a>
    <a href="https://t.me/intmolt_bot">Telegram</a>
  </p>
  <p style="margin-top:12px">© 2026 integrity.molt — AI-native Solana Security Scanner</p>
</footer>

</body>
</html>`;
}

// ── Sitemap update ────────────────────────────────────────────────────────────

function updateSitemap(slug, date) {
  let xml = fs.readFileSync(SITEMAP, 'utf-8');
  const entry = `  <url>
    <loc>https://intmolt.org/blog/${slug}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;

  // Pokud slug už existuje, přeskoč
  if (xml.includes(`/blog/${slug}`)) {
    console.log(`  sitemap: /blog/${slug} již existuje, přeskakuji`);
    return;
  }

  xml = xml.replace('</urlset>', `${entry}\n</urlset>`);
  fs.writeFileSync(SITEMAP, xml);
  console.log(`  sitemap: přidán /blog/${slug}`);
}

// ── Telegram broadcast ────────────────────────────────────────────────────────

function getTelegramToken() {
  return process.env.TELEGRAM_BOT_TOKEN
    || (() => { try { return fs.readFileSync('/root/.secrets/telegram_bot_token', 'utf8').trim(); } catch { return null; } })();
}

async function telegramSend(chatId, text) {
  const token = getTelegramToken();
  if (!token || !chatId) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', e => { console.warn('  telegram error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function broadcastTelegram(version, slug, tldr) {
  const token = getTelegramToken();
  if (!token) { console.log('  telegram: žádný token, přeskakuji'); return; }

  const text = `🚀 <b>integrity.molt ${version} is live</b>\n\n`
    + `${tldr}\n\n`
    + `📖 <a href="https://intmolt.org/blog/${slug}">Read the full release notes →</a>\n`
    + `🔍 <a href="https://intmolt.org/scan">Try the scanner</a>`;

  // Načti subscribers s telegram_chat_id z DB
  let chatIds = [];
  try {
    const Database = require('better-sqlite3');
    const dbPath = process.env.SQLITE_DB_PATH
      || path.join(ROOT, 'data', 'intmolt.db');

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT DISTINCT telegram_chat_id FROM subscriptions
      WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''
        AND status = 'active'
      UNION
      SELECT DISTINCT notify_telegram_chat FROM watchlist
      WHERE notify_telegram_chat IS NOT NULL AND notify_telegram_chat != ''
        AND active = 1
    `).all();
    db.close();
    chatIds = rows.map(r => r.telegram_chat_id || r.notify_telegram_chat).filter(Boolean);
  } catch (e) {
    console.warn('  DB chyba při načítání chat IDs:', e.message);
  }

  // Admin chat
  const adminChat = process.env.ADMIN_TELEGRAM_CHAT;
  if (adminChat && !chatIds.includes(adminChat)) chatIds.push(adminChat);

  if (!chatIds.length) { console.log('  telegram: žádní příjemci'); return; }

  console.log(`  telegram: odesílám ${chatIds.length} příjemcům...`);
  let sent = 0;
  for (const chatId of chatIds) {
    const code = await telegramSend(chatId, text);
    if (code === 200) sent++;
    await new Promise(r => setTimeout(r, 50)); // rate limit
  }
  console.log(`  telegram: odesláno ${sent}/${chatIds.length}`);
}

// ── Hlavní funkce ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📦 Publish release: ${version}\n`);

  // 1. Načti CHANGELOG sekci
  console.log('1. Parsuju CHANGELOG.md...');
  const changelogSection = parseChangelogSection(version);
  console.log(`   Nalezeno ${changelogSection.split('\n').length} řádků`);

  // 2. Vygeneruj blog post přes Claude API
  console.log('2. Generuji blog post (Claude API)...');

  const systemPrompt = `You are a technical writer for integrity.molt, an AI-native Solana security scanner.
Write release note blog posts that are:
- Technically precise and informative for crypto/DeFi developers and traders
- Written in English, professional but not dry
- SEO-optimized with natural keyword usage
- Structured with clear sections explaining the "why" behind each change, not just the "what"
- HTML body content only (no <html>/<head>/<body> tags — just the inner article content)

Use these HTML elements:
- <h2> for main sections
- <h3> for subsections
- <p> for paragraphs
- <ul>/<li> for lists
- <pre><code> for code examples
- <div class="callout"> for important callouts
- <div class="change-grid"><div class="change-card"> for feature grids (label classes: ux, security, infra)

Always start with a <h2>What changed</h2> section with a .change-grid overview, then expand each area.
Include internal links to https://intmolt.org/scan and https://intmolt.org/#plans where relevant.
Return ONLY a JSON object: { "title": "...", "ogTitle": "...", "ogDesc": "...", "keywords": "...", "tag": "...", "readTime": N, "tldr": "...", "bodyHtml": "..." }`;

  const userMessage = `Generate a blog post for integrity.molt ${version}.

CHANGELOG section:
${changelogSection}

Requirements:
- title: Full page title like "integrity.molt v0.5.0: Scam Database, Pro Trader Tier, EVM Detection"
- ogTitle: Shorter OG title (under 70 chars)
- ogDesc: Meta description (under 160 chars, includes primary keywords)
- keywords: 8-10 comma-separated SEO keywords including "Solana security scanner", "integrity.molt"
- tag: Category label like "Release Notes" or "Security Update"
- readTime: Estimated read time in minutes (integer)
- tldr: 2-3 sentence summary for the TL;DR box
- bodyHtml: Full article HTML body (start with change-grid, then expand sections)`;

  const raw = await claudeRequest([{ role: 'user', content: userMessage }], systemPrompt);

  // Parsuj JSON z odpovědi (může být wrapped v markdown fences)
  let meta;
  try {
    const jsonStr = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    meta = JSON.parse(jsonStr);
  } catch (e) {
    // Pokus o extrakci z { ... }
    const m = raw.match(/\{[\s\S]+\}/);
    if (!m) throw new Error('Claude nevrátil platný JSON: ' + raw.slice(0, 200));
    meta = JSON.parse(m[0]);
  }

  console.log(`   Titulek: ${meta.title}`);
  console.log(`   TL;DR: ${meta.tldr.slice(0, 80)}...`);

  // 3. Sestav slug a datum z CHANGELOG
  const dateMatch = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8')
    .match(new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\] — (\\d{4}-\\d{2}-\\d{2})`));
  const date  = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
  const slug  = `${version.replace(/\./g, '')}-release`; // e.g. v050-release

  // 4. Zapiš HTML
  console.log('3. Zapisuji HTML...');
  const html = buildHtml({ version, slug, date, ...meta });
  const outPath = path.join(BLOG, `${slug}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`   Zapsáno: public/blog/${slug}.html`);

  // 5. Aktualizuj sitemap
  console.log('4. Aktualizuji sitemap.xml...');
  updateSitemap(slug, date);

  // 6. Telegram broadcast
  console.log('5. Telegram broadcast...');
  await broadcastTelegram(version, slug, meta.tldr);

  console.log(`\n✅ Hotovo! Blog post: https://intmolt.org/blog/${slug}\n`);
}

main().catch(e => {
  console.error('\n❌ Chyba:', e.message);
  process.exit(1);
});
