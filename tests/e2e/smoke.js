#!/usr/bin/env node
// tests/e2e/smoke.js — E2E smoke test suite
// Zero dependencies: uses built-in http module only

'use strict';

const http = require('http');

const BASE_URL = 'http://127.0.0.1:3402';
const DATE = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const failures = [];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method: method,
      headers: {}
    };

    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
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
    failures.push(name + (detail ? ': ' + detail : ''));
  }
}

function isValidJSON(str) {
  try {
    JSON.parse(str);
    return true;
  } catch (e) {
    return false;
  }
}

async function runTests() {
  console.log('');
  console.log('E2E smoke tests — ' + DATE);
  console.log('Target: ' + BASE_URL);
  console.log('');

  // 1. GET / → 200
  try {
    const res = await request('GET', '/');
    ok('GET / → 200', res.status === 200, 'got ' + res.status);
  } catch (e) {
    ok('GET / → 200', false, e.message);
  }

  // 2. GET /health → 200
  try {
    const res = await request('GET', '/health');
    ok('GET /health → 200', res.status === 200, 'got ' + res.status);
  } catch (e) {
    ok('GET /health → 200', false, e.message);
  }

  // 3. GET /api/v1/stats → 200 + valid JSON
  try {
    const res = await request('GET', '/api/v1/stats');
    const statusOk = res.status === 200;
    const jsonOk = isValidJSON(res.body);
    ok('GET /api/v1/stats → 200', statusOk, 'got ' + res.status);
    ok('GET /api/v1/stats → valid JSON', jsonOk, jsonOk ? '' : 'body: ' + res.body.slice(0, 80));
  } catch (e) {
    ok('GET /api/v1/stats → 200', false, e.message);
    ok('GET /api/v1/stats → valid JSON', false, e.message);
  }

  // 4. POST /scan/quick bez platby → 402
  try {
    const res = await request('POST', '/scan/quick', { address: 'So11111111111111111111111111111111111111112' });
    ok('POST /scan/quick bez platby → 402', res.status === 402, 'got ' + res.status);
  } catch (e) {
    ok('POST /scan/quick bez platby → 402', false, e.message);
  }

  // 5. GET /.well-known/x402.json → 200 + valid JSON
  try {
    const res = await request('GET', '/.well-known/x402.json');
    const statusOk = res.status === 200;
    const jsonOk = isValidJSON(res.body);
    ok('GET /.well-known/x402.json → 200', statusOk, 'got ' + res.status);
    ok('GET /.well-known/x402.json → valid JSON', jsonOk, jsonOk ? '' : 'body: ' + res.body.slice(0, 80));
  } catch (e) {
    ok('GET /.well-known/x402.json → 200', false, e.message);
    ok('GET /.well-known/x402.json → valid JSON', false, e.message);
  }

  // Summary
  console.log('');
  console.log('TEST [' + DATE + '] / ' + pass + ' pass / ' + fail + ' fail');

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
