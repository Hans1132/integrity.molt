'use strict';
// tests/routes/scan-quick-degradation.test.js
// Standalone Node.js test against live server at http://127.0.0.1:3402
// Run: node tests/routes/scan-quick-degradation.test.js

const http = require('http');
const path = require('path');

// Known live Solana address (USDC mint — always exists on-chain)
const TEST_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let pass = 0;
let fail = 0;

function request(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: 3402,
      path: reqPath,
      method,
      headers: { ...headers },
    };
    if (body) {
      const str = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(str);
    }
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ok(name, passed, detail) {
  if (passed) {
    console.log('  OK  ' + name);
    pass++;
  } else {
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
    fail++;
  }
}

function skip(name, reason) {
  console.log('  SKIP ' + name + (reason ? ' — ' + reason : ''));
}

async function main() {
  console.log('\nscan-quick degradation tests\n');

  // ── Test 1: Free tier — no auth ───────────────────────────────────────────
  {
    let res;
    try {
      res = await request('POST', '/scan/quick', { address: TEST_ADDRESS });
    } catch (e) {
      ok('T1: free tier returns 200 with IRIS (no auth)', false, 'request error: ' + e.message);
      goto_summary();
      return;
    }
    ok('T1: free tier status 200', res.status === 200,
      `expected 200, got ${res.status}`);
    ok('T1: free tier body.tier === "free"', res.body?.tier === 'free',
      `got tier=${JSON.stringify(res.body?.tier)}`);
    ok('T1: free tier has iris.score as number', typeof res.body?.iris?.score === 'number',
      `iris.score=${JSON.stringify(res.body?.iris?.score)}`);
    ok('T1: free tier has no report field', res.body?.report === undefined,
      `report=${JSON.stringify(res.body?.report)}`);
    ok('T1: free tier has upgrade_hint', typeof res.body?.upgrade_hint === 'string',
      `upgrade_hint=${JSON.stringify(res.body?.upgrade_hint)}`);
  }

  // ── Test 2: Invalid x402 payment → 402 ───────────────────────────────────
  {
    // base64("invalid") = "aW52YWxpZA=="
    const invalidPayment = Buffer.from('invalid').toString('base64');
    let res;
    try {
      res = await request('POST', '/scan/quick', { address: TEST_ADDRESS }, {
        'x-payment': invalidPayment,
      });
    } catch (e) {
      ok('T2: invalid payment returns 402', false, 'request error: ' + e.message);
      goto_summary();
      return;
    }
    ok('T2: invalid payment returns 402', res.status === 402,
      `expected 402, got ${res.status}`);
    ok('T2: x402Version === 1', res.body?.x402Version === 1,
      `x402Version=${JSON.stringify(res.body?.x402Version)}`);
  }

  // ── Test 3: API key paid tier ─────────────────────────────────────────────
  // Requires DB module. Creates a test key, calls the endpoint, revokes the key.
  {
    let dbModule;
    try {
      dbModule = require(path.join(__dirname, '../../db.js'));
    } catch (e) {
      skip('T3: API key paid tier', `Cannot load db.js: ${e.message}`);
    }

    if (dbModule) {
      let keyRecord;
      try {
        keyRecord = await dbModule.createApiKey({
          email: 'test-degradation@intmolt-test.invalid',
          tier: 'basic',
          label: 'scan-quick-degradation-test',
        });
      } catch (e) {
        skip('T3: API key paid tier', `createApiKey failed: ${e.message}`);
        keyRecord = null;
      }

      if (keyRecord) {
        let res;
        try {
          res = await request('POST', '/scan/quick', { address: TEST_ADDRESS }, {
            'Authorization': `Bearer ${keyRecord.rawKey}`,
          });
        } catch (e) {
          ok('T3: API key paid tier returns 200', false, 'request error: ' + e.message);
          res = null;
        }

        if (res) {
          ok('T3: paid tier status 200', res.status === 200,
            `expected 200, got ${res.status} — body: ${JSON.stringify(res.body).slice(0, 200)}`);
          ok('T3: paid tier body.tier === "paid"', res.body?.tier === 'paid',
            `got tier=${JSON.stringify(res.body?.tier)}`);
          ok('T3: paid tier has report field', res.body?.report !== undefined,
            `report field missing`);
        }

        // Revoke test key
        try {
          await dbModule.revokeApiKey(keyRecord.id, keyRecord.email);
        } catch (e) {
          console.warn('  WARN T3: failed to revoke test key id=' + keyRecord.id + ': ' + e.message);
        }
      }
    }
  }

  // ── Test 4: Rate limit exhaustion (free tier) ─────────────────────────────
  // NOTE: _freeScanRL is an in-process Map shared with /scan/iris.
  // If the live server has already received requests from 127.0.0.1 (loopback), those
  // are exempt from rate limiting (localhost bypass). This test uses a fake IP via
  // X-Forwarded-For if available, but since server reads CF-Connecting-IP / req.ip,
  // we cannot inject a spoofed IP from outside. The test therefore verifies only that
  // the rate limit header/logic exists by sending 12 rapid requests from the same
  // loopback address — loopback IS exempt, so we expect all 200s. If the server is
  // running behind Cloudflare in production, a real IP would trigger the limit.
  // Skipping assertive rate-limit exhaustion as it is non-deterministic in test env.
  {
    skip('T4: rate limit exhaustion',
      'Rate limit uses in-memory Map, shares state with /scan/iris; loopback 127.0.0.1 is exempt — ' +
      'cannot inject spoofed non-loopback IP from test. Non-deterministic in CI. Manual verification required.');
  }

  goto_summary();
}

function goto_summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
