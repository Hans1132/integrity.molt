'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs').promises;
const path      = require('path');

let browser = null;
const cache   = new Map(); // address -> { buffer, timestamp }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const CIRC = 2 * Math.PI * 130; // r=130 → 816.81

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  return browser;
}

// Pre-warms the browser so first OG request doesn't cold-start
async function warmBrowser() {
  try { await getBrowser(); } catch (e) { /* non-fatal */ }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function buildFactorsHtml(data) {
  const factors = Array.isArray(data.risk_factors) ? data.risk_factors : [];

  if (factors.length === 0 && data.scam_db?.whitelisted) {
    return `
      <div class="factor-item"><div class="factor-dot" style="background:#22c55e"></div>Verified legitimate token</div>
      <div class="factor-item"><div class="factor-dot" style="background:#22c55e"></div>No critical issues detected</div>
    `;
  }
  if (factors.length === 0) {
    return `<div class="factor-item"><div class="factor-dot" style="background:#22c55e"></div>No critical risk factors</div>`;
  }

  return factors.slice(0, 3).map(f => {
    const text = String(f).length > 60 ? String(f).slice(0, 57) + '...' : String(f);
    return `<div class="factor-item"><div class="factor-dot"></div>${escapeHtml(text)}</div>`;
  }).join('\n');
}

function buildHtml(template, data, address) {
  const score = typeof data.iris?.score === 'number' ? data.iris.score : (data.risk_score ?? 0);
  const grade = (data.iris?.grade ?? data.risk_level ?? 'UNKNOWN').toUpperCase();

  const riskClass =
    grade === 'LOW'    || grade === 'SAFE'    ? 'low'      :
    grade === 'MEDIUM' || grade === 'CAUTION' ? 'medium'   :
    grade === 'HIGH'                          ? 'high'     :
    grade === 'CRITICAL' || grade === 'DANGER'? 'critical' : 'low';

  const offset       = CIRC - (score / 100) * CIRC;
  const addressShort = address.length > 20
    ? `${address.slice(0, 8)}...${address.slice(-6)}`
    : address;

  return template
    .replaceAll('{{SCORE}}',        String(score))
    .replaceAll('{{RISK_LEVEL}}',   grade)
    .replaceAll('{{RISK_CLASS}}',   riskClass)
    .replaceAll('{{ADDRESS_SHORT}}', escapeHtml(addressShort))
    .replaceAll('{{CIRCUMFERENCE}}', CIRC.toFixed(2))
    .replaceAll('{{RING_OFFSET}}',  offset.toFixed(2))
    .replaceAll('{{FACTORS_HTML}}', buildFactorsHtml(data));
}

async function generateOgImage(address) {
  const cached = cache.get(address);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.buffer;
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let irisData;
  try {
    const res = await fetch('http://127.0.0.1:3402/scan/iris', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address }),
      signal:  ctrl.signal,
    });
    irisData = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const templatePath = path.join(__dirname, '..', '..', 'public', 'og-template.html');
  const template     = await fs.readFile(templatePath, 'utf8');
  const html         = buildHtml(template, irisData, address);

  const br   = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 10000 });
    const shot = await page.screenshot({
      type:            'png',
      clip:            { x: 0, y: 0, width: 1200, height: 630 },
      omitBackground:  false,
    });
    const buffer = Buffer.from(shot);

    cache.set(address, { buffer, timestamp: Date.now() });
    // Evict oldest when cache exceeds 100 entries
    if (cache.size > 100) {
      const [oldest] = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      cache.delete(oldest[0]);
    }

    return buffer;
  } finally {
    await page.close();
  }
}

async function shutdown() {
  if (browser && browser.connected) {
    await browser.close();
    browser = null;
  }
}

module.exports = { generateOgImage, warmBrowser, shutdown };
