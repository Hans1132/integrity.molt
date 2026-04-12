#!/usr/bin/env node
// tests/e2e/captcha.test.js — HMAC-signed math CAPTCHA E2E tests
// Zero external dependencies: built-in http + crypto only

'use strict';

const http   = require('http');
const crypto = require('crypto'); // Node.js built-in

const BASE_URL = 'http://127.0.0.1:3402';
const DATE     = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const failures = [];

// ─── HTTP helper ────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      port:     Number(url.port) || 80,
      path:     url.pathname + (url.search || ''),
      method,
      headers: {}
    };

    let bodyStr;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      options.headers['Content-Type']   = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));

    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// ─── Assertion helper ────────────────────────────────────────────────────────

function ok(name, passed, detail) {
  if (passed) {
    console.log('  OK   ' + name);
    pass++;
  } else {
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
    fail++;
    failures.push(name + (detail ? ': ' + detail : ''));
  }
}

function isValidJSON(str) {
  try { JSON.parse(str); return true; } catch { return false; }
}

// ─── Forge an expired token (for TTL test) ──────────────────────────────────
// Server falls back to 'changeme-local-dev' when CAPTCHA_SECRET env is empty.

function forgeExpiredToken(answer, secret) {
  const ts = Date.now() - 20 * 60 * 1000; // 20 min ago (TTL = 15 min)
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${answer}:${ts}`)
    .digest('hex');
  return hmac + ':' + ts;
}

// ─── Test suite ─────────────────────────────────────────────────────────────

async function runTests() {
  console.log('');
  console.log('CAPTCHA E2E tests — ' + DATE);
  console.log('Target: ' + BASE_URL);
  console.log('');

  // ── TEST 1: GET /scan/captcha-challenge → 200 + valid JSON ────────────────
  // BUG DETECTION: server.js uses `crypto` without requiring the Node.js
  // built-in module. In Node.js v22 `crypto` is globalThis.crypto (Web Crypto
  // API) which does NOT have .createHmac(). This causes a 500 Internal Server
  // Error. Test must detect and report this clearly.
  let challengeRes;
  try {
    challengeRes = await request('GET', '/scan/captcha-challenge');
    ok('GET /scan/captcha-challenge → 200', challengeRes.status === 200,
       challengeRes.status === 500
         ? 'got 500 — BACKEND BUG: crypto not imported in server.js (missing require("node:crypto")); crypto.createHmac is not a function'
         : 'got ' + challengeRes.status);
  } catch (e) {
    ok('GET /scan/captcha-challenge → 200', false, e.message);
    console.log('');
    console.log('FATAL: cannot reach service, aborting remaining tests');
    reportAndExit();
  }

  if (challengeRes.status === 500) {
    console.log('');
    console.log('  NOTE: GET /scan/captcha-challenge returns 500.');
    console.log('  Root cause: server.js line ~2812 uses `crypto.createHmac()`');
    console.log('  but `crypto` is never imported via require("node:crypto").');
    console.log('  In Node.js v22, global `crypto` = Web Crypto API (no .createHmac).');
    console.log('  Fix required in server.js: add require("node:crypto") at top.');
    console.log('  All subsequent captcha tests will be SKIPPED.');
    console.log('');
    reportAndExit();
  }

  const jsonOk = isValidJSON(challengeRes.body);
  ok('GET /scan/captcha-challenge → valid JSON', jsonOk, jsonOk ? '' : challengeRes.body.slice(0, 80));

  let parsed;
  if (jsonOk) {
    parsed = JSON.parse(challengeRes.body);
  } else {
    console.log('');
    console.log('FATAL: response not JSON, cannot continue captcha tests');
    reportAndExit();
  }

  // ── TEST 2: Response has required fields ──────────────────────────────────
  const hasQuestion = typeof parsed.question === 'string' && /^\d+ \+ \d+$/.test(parsed.question);
  ok('captcha-challenge: question matches "N + N"', hasQuestion,
     hasQuestion ? '' : 'question: ' + JSON.stringify(parsed.question));

  const hasToken = typeof parsed.token === 'string' && parsed.token.includes(':');
  ok('captcha-challenge: token contains colon separator', hasToken,
     hasToken ? '' : 'token: ' + JSON.stringify(parsed.token));

  if (!hasQuestion || !hasToken) {
    console.log('');
    console.log('Cannot continue: challenge response malformed');
    reportAndExit();
  }

  // ── TEST 3: POST /scan/free with CORRECT answer → captcha passes (not 403) ─
  const [aPart, bPart] = parsed.question.split(' + ');
  const correctAnswer  = String(Number(aPart) + Number(bPart));

  try {
    const correctRes = await request('POST', '/scan/free', {
      address:        'So11111111111111111111111111111111111111112',
      type:           'quick',
      captcha_token:  parsed.token,
      captcha_answer: correctAnswer
    });
    // Any status except 403 means CAPTCHA passed (200, 402, 429, 400 are all valid)
    ok('POST /scan/free correct answer → not 403', correctRes.status !== 403,
       'got ' + correctRes.status + ' body: ' + correctRes.body.slice(0, 120));
  } catch (e) {
    ok('POST /scan/free correct answer → not 403', false, e.message);
  }

  // ── TEST 4: POST /scan/free with WRONG answer → 403 ──────────────────────
  // Fresh challenge for a clean token
  try {
    const ch2 = await request('GET', '/scan/captcha-challenge');
    const p2  = JSON.parse(ch2.body);

    const wrongRes = await request('POST', '/scan/free', {
      address:        'So11111111111111111111111111111111111111112',
      type:           'quick',
      captcha_token:  p2.token,
      captcha_answer: '999' // deliberately wrong
    });
    ok('POST /scan/free wrong answer → 403', wrongRes.status === 403,
       'got ' + wrongRes.status + ' body: ' + wrongRes.body.slice(0, 120));

    if (wrongRes.status === 403) {
      let body403;
      try { body403 = JSON.parse(wrongRes.body); } catch { body403 = {}; }
      ok('POST /scan/free wrong answer → body.captcha_required = true',
         body403.captcha_required === true,
         'body: ' + wrongRes.body.slice(0, 120));
    }
  } catch (e) {
    ok('POST /scan/free wrong answer → 403', false, e.message);
  }

  // ── TEST 5: POST /scan/free with EXPIRED token → 403 ─────────────────────
  // Uses fallback secret. If real secret is set, HMAC mismatch also → 403.
  try {
    const expiredToken = forgeExpiredToken('5', 'changeme-local-dev');
    const expiredRes   = await request('POST', '/scan/free', {
      address:        'So11111111111111111111111111111111111111112',
      type:           'quick',
      captcha_token:  expiredToken,
      captcha_answer: '5'
    });
    ok('POST /scan/free expired token → 403', expiredRes.status === 403,
       'got ' + expiredRes.status + ' body: ' + expiredRes.body.slice(0, 120));
  } catch (e) {
    ok('POST /scan/free expired token → 403', false, e.message);
  }

  // ── TEST 6: POST /scan/free with missing captcha fields → 403 ────────────
  try {
    const missingRes = await request('POST', '/scan/free', {
      address: 'So11111111111111111111111111111111111111112',
      type:    'quick'
      // no captcha_token, no captcha_answer
    });
    ok('POST /scan/free missing captcha fields → 403', missingRes.status === 403,
       'got ' + missingRes.status + ' body: ' + missingRes.body.slice(0, 120));
  } catch (e) {
    ok('POST /scan/free missing captcha fields → 403', false, e.message);
  }

  reportAndExit();
}

function reportAndExit() {
  console.log('');
  console.log('CAPTCHA [' + DATE + '] / ' + pass + ' pass / ' + fail + ' fail');

  if (fail > 0) {
    console.log('');
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
