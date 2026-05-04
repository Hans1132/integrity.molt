'use strict';
/**
 * tests/a2a-oracle.test.js — Unit tests for the A2A Oracle surface
 *
 * Coverage:
 *   POST /verify/v1/signed-receipt  — valid, invalid-sig, missing field, key_id mismatch,
 *                                     wrapped format, flat format round-trip
 *   GET  /scan/v1/:address          — valid address, invalid address (too short, non-base58)
 *   POST /monitor/v1/governance-change — no-Helius mock path, missing/invalid program_id
 *   GET  /feed/v1/new-spl-tokens    — no events file, ?since= valid and invalid
 *
 * Signing: uses node:crypto Ed25519 — same primitive as the endpoint itself.
 *   No tweetnacl or sign-report.py required; stubs replace asyncSign before the
 *   router module is loaded.
 *
 * Run: node tests/a2a-oracle.test.js
 *
 * Gaps (honest disclosure):
 *   - Helius live path in /monitor not exercised (no API key in unit env)
 *   - x402 requirePayment middleware NOT tested (router mounted bare, bypassed)
 *   - sign-report.py / asyncSign NOT exercised (stubbed with real crypto)
 *   - Real enrichment + scam-db APIs NOT exercised (stubbed)
 *   - Live /scan against real Solana data is smoke-script-only
 */

// ── Force in-memory DB to avoid touching production SQLite ──────────────────
process.env.SQLITE_DB_PATH = ':memory:';
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';
// Ensure Helius key is absent so /monitor falls back to deterministic mock
delete process.env.HELIUS_API_KEY;

const crypto = require('crypto');
const http   = require('http');
const path   = require('path');

// ── Ed25519 test keypair (per test-run, deterministic within a run) ──────────
const { privateKey: _testPrivKey, publicKey: _testPubKey } =
  crypto.generateKeyPairSync('ed25519');

/**
 * Sign a string with the test private key and return an asyncSign-compatible
 * envelope object (same shape as sign-report.py output).
 *
 * @param {string} text  Raw UTF-8 string to sign (the caller JSON.stringify()'d payload)
 */
function testSign(text) {
  const sig    = crypto.sign(null, Buffer.from(text, 'utf-8'), _testPrivKey);
  const pubDer = _testPubKey.export({ type: 'spki', format: 'der' });
  const rawPub = pubDer.slice(pubDer.length - 32); // last 32 bytes = raw Ed25519 pubkey
  const sigB64 = sig.toString('base64');
  const pubB64 = rawPub.toString('base64');
  return {
    report:     text,
    signature:  sigB64,
    verify_key: pubB64,
    key_id:     pubB64.slice(0, 16),
    signed_at:  new Date().toISOString(),
    signer:     'integrity.molt.test',
    algorithm:  'Ed25519',
  };
}

// ── Install require.cache stubs BEFORE loading the router ────────────────────
//
// The order matters: stubs must be in place before `require('../src/routes/a2a-oracle')`
// so none of the downstream modules are actually imported.

function stubModule(resolvedPath, exports) {
  require.cache[require.resolve(resolvedPath)] = {
    id:       resolvedPath,
    filename: resolvedPath,
    loaded:   true,
    exports,
    parent:   null,
    children: [],
    paths:    [],
  };
}

const BASE = path.resolve(__dirname, '..');

// Canonical JSON helper — must match src/crypto/sign.js canonicalJSON exactly.
// Inlined here so the stub doesn't depend on the module being tested.
function _canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {});
  return '{' + Object.keys(sorted).map(k =>
    JSON.stringify(k) + ':' + _canonicalJSON(sorted[k])
  ).join(',') + '}';
}

// 1. asyncSign stub — real Ed25519 via node:crypto, no sign-report.py invoked
stubModule(BASE + '/src/crypto/sign', {
  asyncSign:    (text) => Promise.resolve(testSign(text)),
  canonicalJSON: _canonicalJSON,
  SIGN_SCRIPT:  '/dev/null',
});

// 2. enrichScanResult stub — returns a predictable enrichment object
stubModule(BASE + '/src/enrichment', {
  enrichScanResult: (_addr) => Promise.resolve({
    rugcheck: { riskLevel: 'low', score: 10, risks: [] },
    solana_tracker: null,
    token_extensions: null,
  }),
});

// 3. lookupScamDb stub — returns benign result
stubModule(BASE + '/src/scam-db/lookup', {
  lookupScamDb: (_addr) => Promise.resolve({
    known_scam: null,
    rugcheck:   null,
    db_match:   false,
  }),
});

// 4. webhook-receiver stub — evaluateTransaction returns no alerts
stubModule(BASE + '/src/monitor/webhook-receiver', {
  evaluateTransaction:    (_parsed, _programId) => [],
  parseEnhancedTransaction: (tx) => ({
    signature:      tx.signature || 'test-sig',
    timestamp:      tx.timestamp ? tx.timestamp * 1000 : Date.now(),
    type:           tx.type || 'UNKNOWN',
    fee:            tx.fee || 0,
    slot:           tx.slot || null,
    accounts:       (tx.accountData || []).map(a => a.account),
    nativeTransfers: tx.nativeTransfers || [],
    tokenTransfers:  tx.tokenTransfers  || [],
    instructions:    tx.instructions    || [],
    programs:        [],
    _raw:            tx,
  }),
});

// ── Load router + create test Express app ────────────────────────────────────
const express = require('express');
const router  = require(BASE + '/src/routes/a2a-oracle');

const app = express();
// In unit tests there is no requirePayment middleware, so we simulate payment verified
// for the governance endpoint (which asserts req.paymentVerified as defense-in-depth).
app.use('/monitor', (req, res, next) => { req.paymentVerified = true; next(); });
app.use(router);

// ── Start HTTP server on ephemeral port ──────────────────────────────────────
let _server;
let _baseUrl;

function startServer() {
  return new Promise((resolve) => {
    _server = http.createServer(app);
    _server.listen(0, '127.0.0.1', () => {
      const { port } = _server.address();
      _baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => _server.close(resolve));
}

// ── Minimal HTTP helpers ──────────────────────────────────────────────────────
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(_baseUrl + urlPath);
    const opts = {
      hostname: url.hostname,
      port:     Number(url.port),
      path:     url.pathname + (url.search || ''),
      method,
      headers:  {},
    };
    if (body !== undefined) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Type']   = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Test harness ─────────────────────────────────────────────────────────────
let _pass = 0;
let _fail = 0;

function ok(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
    _pass++;
  } else {
    console.error('  FAIL  ' + label + (detail ? '  →  ' + detail : ''));
    _fail++;
  }
}

// ── Helper: build a valid flat scan-like envelope with real Ed25519 signature ──
// Must use _canonicalJSON to match what the router signs via canonicalJSON(reportPayload).
function buildValidFlatEnvelope(payload) {
  const text = _canonicalJSON(payload);
  const env  = testSign(text);
  return { ...payload, ...env };
}

// ── Test suites ──────────────────────────────────────────────────────────────

// ── Suite 1: POST /verify/v1/signed-receipt ──────────────────────────────────
async function testVerifyEndpoint() {
  console.log('\n── Suite 1: POST /verify/v1/signed-receipt ─────────────────────────────────\n');

  // 1a. Missing envelope field entirely → valid: false, reason: missing_envelope
  {
    const res = await request('POST', '/verify/v1/signed-receipt', {});
    ok('1a missing envelope → valid:false', res.status === 200 && res.body.valid === false);
    ok('1a reason = missing_envelope', res.body.reason === 'missing_envelope',
       'got ' + res.body.reason);
  }

  // 1b. Envelope present but missing signature + verify_key → valid:false
  {
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload: { foo: 'bar' } },
    });
    ok('1b missing sig+key → valid:false', res.status === 200 && res.body.valid === false);
    ok('1b reason = missing_signature_or_verify_key',
       res.body.reason === 'missing_signature_or_verify_key', 'got ' + res.body.reason);
  }

  // 1c. Unsupported algorithm → valid:false, reason: unsupported_algorithm
  {
    const dummyPub = Buffer.alloc(32).toString('base64');
    const dummySig = Buffer.alloc(64).toString('base64');
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: {
        payload:    { x: 1 },
        signature:  dummySig,
        verify_key: dummyPub,
        algorithm:  'rsa256',
      },
    });
    ok('1c unsupported algorithm → valid:false', res.status === 200 && res.body.valid === false);
    ok('1c reason = unsupported_algorithm', res.body.reason === 'unsupported_algorithm',
       'got ' + res.body.reason);
  }

  // 1d. key_id mismatch → valid:false, reason: key_id_mismatch
  {
    const payload = { check: 'key_id_mismatch' };
    const env = testSign(JSON.stringify(payload));
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: {
        payload,
        signature:  env.signature,
        verify_key: env.verify_key,
        key_id:     'ZZZZZZZZZZZZZZZZ', // wrong key_id
        signed_at:  env.signed_at,
        algorithm:  'ed25519',
      },
    });
    ok('1d key_id mismatch → valid:false', res.status === 200 && res.body.valid === false);
    ok('1d reason = key_id_mismatch', res.body.reason === 'key_id_mismatch',
       'got ' + res.body.reason);
  }

  // 1e. Invalid signature bytes (tampered payload) → valid:false
  {
    const payload = { tamper: 'test' };
    const env = testSign(JSON.stringify(payload));
    // Flip a byte in the signature
    const sigBytes = Buffer.from(env.signature, 'base64');
    sigBytes[0] ^= 0xFF;
    const tamperedSig = sigBytes.toString('base64');

    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: {
        payload,
        signature:  tamperedSig,
        verify_key: env.verify_key,
        key_id:     env.key_id,
        signed_at:  env.signed_at,
        algorithm:  'ed25519',
      },
    });
    ok('1e tampered signature → valid:false', res.status === 200 && res.body.valid === false);
    ok('1e reason = invalid_signature', res.body.reason === 'invalid_signature',
       'got ' + res.body.reason);
  }

  // 1f. WRAPPED format — valid signature with non-server key → mathematically_valid:true, key_not_pinned
  // In the test environment verify_key.bin is absent → keyPinned=false → valid:false.
  // Downstream agents must check key_pinned to distinguish oracle receipts from self-signed ones.
  {
    const payload  = { address: 'So11111111111111111111111111111111111111112', score: 42 };
    const env      = testSign(_canonicalJSON(payload));
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: {
        payload,
        signature:  env.signature,
        verify_key: env.verify_key,
        key_id:     env.key_id,
        signed_at:  env.signed_at,
        signer:     'integrity.molt.test',
        algorithm:  'Ed25519',
      },
    });
    ok('1f wrapped valid sig → valid:false (key_not_pinned in test env)',
       res.status === 200 && res.body.valid === false,
       JSON.stringify(res.body).slice(0, 120));
    ok('1f wrapped → mathematically_valid:true', res.body.mathematically_valid === true,
       'got ' + res.body.mathematically_valid);
    ok('1f wrapped → key_pinned:false',     res.body.key_pinned === false);
    ok('1f wrapped → reason = key_not_pinned', res.body.reason === 'key_not_pinned',
       'got ' + res.body.reason);
    ok('1f wrapped → key_id present',       typeof res.body.key_id    === 'string');
    ok('1f wrapped → signed_at present',    typeof res.body.signed_at === 'string');
    ok('1f wrapped → issuer present',       typeof res.body.issuer    === 'string');
  }

  // 1g. FLAT format round-trip — mimics what /scan/v1 actually returns.
  // Key insight: /verify/v1 strips metadata fields to recover payload, rebuilds
  // canonical JSON using sorted keys, then verifies Ed25519 math.
  // In test env (no verify_key.bin) → key_not_pinned → valid:false, mathematically_valid:true.
  {
    const reportPayload = {
      address:        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      iris_score:     15,
      risk_level:     'low',
      risk_factors:   [],
      iris_breakdown: null,
    };
    const flatEnvelope = buildValidFlatEnvelope(reportPayload);

    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: flatEnvelope,
    });
    ok('1g flat format round-trip → valid:false (key_not_pinned in test env)',
       res.status === 200 && res.body.valid === false,
       JSON.stringify(res.body).slice(0, 120));
    ok('1g flat → mathematically_valid:true', res.body.mathematically_valid === true,
       'got ' + res.body.mathematically_valid);
    ok('1g flat → reason = key_not_pinned', res.body.reason === 'key_not_pinned',
       'got ' + res.body.reason);
  }

  // 1h. verify_key wrong length (not 32 bytes) → valid:false, reason: invalid_verify_key_length
  {
    const shortKey = Buffer.alloc(16).toString('base64'); // 16 bytes, not 32
    const sig      = Buffer.alloc(64).toString('base64');
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload: { x: 1 }, signature: sig, verify_key: shortKey },
    });
    ok('1h short verify_key → valid:false', res.status === 200 && res.body.valid === false);
    ok('1h reason = invalid_verify_key_length', res.body.reason === 'invalid_verify_key_length',
       'got ' + res.body.reason);
  }

  // 1i. signature wrong length (not 64 bytes) → valid:false, reason: invalid_signature_length
  {
    const pubDer = _testPubKey.export({ type: 'spki', format: 'der' });
    const rawPub = pubDer.slice(pubDer.length - 32);
    const pubB64 = rawPub.toString('base64');
    const shortSig = Buffer.alloc(32).toString('base64'); // 32 bytes, not 64
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload: { x: 1 }, signature: shortSig, verify_key: pubB64 },
    });
    ok('1i short signature → valid:false', res.status === 200 && res.body.valid === false);
    ok('1i reason = invalid_signature_length', res.body.reason === 'invalid_signature_length',
       'got ' + res.body.reason);
  }
}

// ── Suite 2: GET /scan/v1/:address ───────────────────────────────────────────
async function testScanEndpoint() {
  console.log('\n── Suite 2: GET /scan/v1/:address ──────────────────────────────────────────\n');

  const VALID_ADDR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  // 2a. Valid Solana address → 200, structured signed response
  {
    const res = await request('GET', '/scan/v1/' + VALID_ADDR);
    ok('2a valid address → 200', res.status === 200, 'got ' + res.status);
    ok('2a response.address = requested addr', res.body.address === VALID_ADDR);
    ok('2a iris_score is number', typeof res.body.iris_score === 'number');
    ok('2a risk_level is string', typeof res.body.risk_level === 'string');
    ok('2a risk_factors is array', Array.isArray(res.body.risk_factors));
    ok('2a signed_at is string',  typeof res.body.signed_at  === 'string');
    ok('2a signer is string',     typeof res.body.signer     === 'string');
    ok('2a algorithm is string',  typeof res.body.algorithm  === 'string');
    // signature may be null if asyncSign stub was not called (it is stubbed and real)
    ok('2a signature is string',  typeof res.body.signature  === 'string',
       'got ' + typeof res.body.signature);
    ok('2a verify_key is string', typeof res.body.verify_key === 'string',
       'got ' + typeof res.body.verify_key);
    ok('2a key_id is string',     typeof res.body.key_id     === 'string',
       'got ' + typeof res.body.key_id);
  }

  // 2b. Address too short → 400 + error field
  {
    const res = await request('GET', '/scan/v1/short');
    ok('2b too-short address → 400', res.status === 400, 'got ' + res.status);
    ok('2b error field present', res.body && (res.body.error || res.body.message));
  }

  // 2c. EVM-looking address (0x...) → 400
  {
    const res = await request('GET', '/scan/v1/0x71C7656EC7ab88b098defB751B7401B5f6d8976F');
    ok('2c EVM address → 400', res.status === 400, 'got ' + res.status);
  }

  // 2d. Non-base58 characters → 400
  {
    // '0' and 'O' are excluded from base58; pad to reach length threshold
    const notBase58 = '0000000000000000000000000000000000000000000';
    const res = await request('GET', '/scan/v1/' + notBase58);
    ok('2d non-base58 chars → 400', res.status === 400, 'got ' + res.status);
  }

  // 2e. Round-trip: scan result is mathematically_valid in /verify/v1/signed-receipt.
  // In test env the scan endpoint's asyncSign stub uses the test keypair, not verify_key.bin,
  // so key_pinned=false → valid:false. The contract we verify here is that the Ed25519 math
  // round-trips correctly (mathematically_valid:true) — production will have key_pinned:true.
  {
    const scanRes = await request('GET', '/scan/v1/' + VALID_ADDR);
    if (scanRes.status === 200 && typeof scanRes.body.signature === 'string') {
      const verifyRes = await request('POST', '/verify/v1/signed-receipt', {
        envelope: scanRes.body,
      });
      ok('2e scan result → mathematically_valid:true', verifyRes.body.mathematically_valid === true,
         JSON.stringify(verifyRes.body).slice(0, 120));
      ok('2e scan result → reason key_not_pinned or signature_valid',
         ['key_not_pinned', 'signature_valid'].includes(verifyRes.body.reason),
         'got ' + verifyRes.body.reason);
    } else {
      ok('2e scan result verifies → skipped (no signature in scan response)',
         false, 'scan status=' + scanRes.status);
    }
  }
}

// ── Suite 3: POST /monitor/v1/governance-change ──────────────────────────────
async function testGovernanceEndpoint() {
  console.log('\n── Suite 3: POST /monitor/v1/governance-change ─────────────────────────────\n');

  const VALID_PROGRAM = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf';

  // 3a. Missing program_id → 400
  {
    const res = await request('POST', '/monitor/v1/governance-change', {});
    ok('3a missing program_id → 400', res.status === 400, 'got ' + res.status);
    ok('3a error = missing_program_id', res.body.error === 'missing_program_id',
       'got ' + res.body.error);
  }

  // 3b. Invalid program_id (EVM address) → 400
  {
    const res = await request('POST', '/monitor/v1/governance-change', {
      program_id: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    });
    ok('3b invalid program_id → 400', res.status === 400, 'got ' + res.status);
    ok('3b error = invalid_solana_address', res.body.error === 'invalid_solana_address',
       'got ' + res.body.error);
  }

  // 3c. Valid program_id, no HELIUS_API_KEY → Alchemy fallback (or mock if Alchemy also absent)
  //   Expected: data_source in {alchemy_rpc, mock_error_fallback}, verdict='clean', signed envelope
  {
    const res = await request('POST', '/monitor/v1/governance-change', {
      program_id: VALID_PROGRAM,
    });
    ok('3c valid program_id → 200', res.status === 200, 'got ' + res.status);
    ok('3c data_source is fallback',
       ['alchemy_rpc', 'mock_error_fallback', 'helius'].includes(res.body.data_source),
       'got ' + res.body.data_source);
    ok('3c findings is array',       Array.isArray(res.body.findings));
    ok('3c verdict is string',       typeof res.body.verdict === 'string');
    ok('3c verdict = clean (no data)', res.body.verdict === 'clean',
       'got ' + res.body.verdict);
    ok('3c program_id echoed back',  res.body.program_id === VALID_PROGRAM);
    ok('3c signed_at present',       typeof res.body.signed_at  === 'string');
    ok('3c signature present',       typeof res.body.signature  === 'string');
    ok('3c verify_key present',      typeof res.body.verify_key === 'string');
  }

  // 3d. window_slots clamping: send 999 → should clamp to 200
  {
    const res = await request('POST', '/monitor/v1/governance-change', {
      program_id:   VALID_PROGRAM,
      window_slots: 999,
    });
    ok('3d window_slots clamped to 200', res.status === 200 && res.body.window_slots === 200,
       'got ' + res.body.window_slots);
  }

  // 3e. window_slots negative/invalid → defaults to 50
  {
    const res = await request('POST', '/monitor/v1/governance-change', {
      program_id:   VALID_PROGRAM,
      window_slots: -5,
    });
    // Math.max(1, ...) means it becomes 1 for negative parsed int
    ok('3e negative window_slots → clamped >= 1',
       res.status === 200 && res.body.window_slots >= 1,
       'got ' + res.body.window_slots);
  }
}

// ── Suite 4: GET /feed/v1/new-spl-tokens ─────────────────────────────────────
async function testFeedEndpoint() {
  console.log('\n── Suite 4: GET /feed/v1/new-spl-tokens ────────────────────────────────────\n');

  // 4a. GET without params → 200, mints is array, signed envelope fields present
  //   (No events.jsonl in test env → empty array is the expected valid response)
  {
    const res = await request('GET', '/feed/v1/new-spl-tokens');
    ok('4a no params → 200',           res.status === 200, 'got ' + res.status);
    ok('4a mints is array',            Array.isArray(res.body.mints));
    ok('4a count is number',           typeof res.body.count === 'number');
    ok('4a since is string',           typeof res.body.since === 'string');
    ok('4a count matches mints.length', res.body.count === res.body.mints.length,
       `count=${res.body.count} mints.length=${res.body.mints.length}`);
    ok('4a signed_at present',         typeof res.body.signed_at  === 'string');
    ok('4a signature present (or null)',
       typeof res.body.signature === 'string' || res.body.signature === null);
  }

  // 4b. ?since= valid ISO8601 → 200
  {
    const iso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request('GET', '/feed/v1/new-spl-tokens?since=' + encodeURIComponent(iso));
    ok('4b ?since= ISO8601 → 200', res.status === 200, 'got ' + res.status);
    ok('4b mints is array', Array.isArray(res.body.mints));
    ok('4b since field reflects query param',
       typeof res.body.since === 'string' && res.body.since.startsWith('202'));
  }

  // 4c. ?since= invalid value → 400 with error field
  {
    const res = await request('GET', '/feed/v1/new-spl-tokens?since=not-a-date');
    ok('4c invalid ?since= → 400', res.status === 400, 'got ' + res.status);
    ok('4c error = invalid_since_param', res.body.error === 'invalid_since_param',
       'got ' + res.body.error);
  }

  // 4d. ?since= far future → 200 with empty mints (nothing newer than future date)
  {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request('GET', '/feed/v1/new-spl-tokens?since=' + encodeURIComponent(future));
    ok('4d future since → 200', res.status === 200, 'got ' + res.status);
    ok('4d future since → mints is array', Array.isArray(res.body.mints));
  }
}

// ── Helper: raw HTTP request to arbitrary base URL (for 5a bare-server test) ──
function rawRequest(baseUrl, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + urlPath);
    const opts = {
      hostname: url.hostname,
      port:     Number(url.port),
      path:     url.pathname + (url.search || ''),
      method,
      headers:  {},
    };
    if (body !== undefined) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Type']   = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Suite 5: Adversarial edge cases ──────────────────────────────────────────
async function testAdversarial() {
  console.log('\n── Suite 5: Adversarial edge cases ─────────────────────────────────────────\n');

  // 5a. Governance WITHOUT paymentVerified flag → must return 402 (defense-in-depth guard).
  // Spin up a fresh app with NO payment simulation middleware to hit the guard directly.
  {
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use(router); // no req.paymentVerified = true
    let bareBase;
    const bareServer = await new Promise(resolve => {
      const s = http.createServer(bareApp);
      s.listen(0, '127.0.0.1', () => {
        bareBase = `http://127.0.0.1:${s.address().port}`;
        resolve(s);
      });
    });
    try {
      const res = await rawRequest(bareBase, 'POST', '/monitor/v1/governance-change', {
        program_id: 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf',
      });
      ok('5a governance without payment → 402', res.status === 402, 'got ' + res.status);
      ok('5a error = payment_required', res.body.error === 'payment_required',
         'got ' + res.body.error);
    } finally {
      await new Promise(r => bareServer.close(r));
    }
  }

  // 5b. Tampered payload (change field AFTER signing) → invalid_signature.
  // Different from 1e which tampers the signature bytes; here the payload changes.
  {
    const originalPayload = { address: 'So11111111111111111111111111111111111111112', score: 42 };
    const env = testSign(_canonicalJSON(originalPayload));
    const tamperedPayload = { ...originalPayload, score: 999 }; // same key, changed value
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload: tamperedPayload, ...env },
    });
    ok('5b tampered payload → valid:false', res.status === 200 && res.body.valid === false);
    ok('5b reason = invalid_signature', res.body.reason === 'invalid_signature',
       'got ' + res.body.reason);
    ok('5b mathematically_valid:false', res.body.mathematically_valid === false);
  }

  // 5c. null signature → valid:false (falsy check catches null)
  {
    const goodPub = Buffer.alloc(32).toString('base64');
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload: { x: 1 }, signature: null, verify_key: goodPub },
    });
    ok('5c null signature → valid:false', res.status === 200 && res.body.valid === false);
  }

  // 5d. null verify_key → valid:false (falsy check catches null)
  {
    const goodSig = Buffer.alloc(64).toString('base64');
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload: { x: 1 }, signature: goodSig, verify_key: null },
    });
    ok('5d null verify_key → valid:false', res.status === 200 && res.body.valid === false);
  }

  // 5e. Path traversal characters in scan address → 400 (not a valid Solana base58 address)
  {
    const res = await request('GET', '/scan/v1/' + encodeURIComponent('../../../etc/passwd'));
    ok('5e path traversal addr → 400', res.status === 400, 'got ' + res.status);
  }

  // 5f. Envelope contains only metadata fields (no report data) → no_verifiable_payload
  {
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: {
        signature:  Buffer.alloc(64).toString('base64'),
        verify_key: Buffer.alloc(32).toString('base64'),
        signed_at:  new Date().toISOString(),
        signer:     'test',
        algorithm:  'Ed25519',
      },
    });
    ok('5f metadata-only → valid:false', res.status === 200 && res.body.valid === false);
    ok('5f reason = no_verifiable_payload', res.body.reason === 'no_verifiable_payload',
       'got ' + res.body.reason);
  }

  // 5g. Integer verify_key (type coercion attack) → valid:false (Buffer.from throws, caught)
  {
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: {
        payload:    { x: 1 },
        signature:  Buffer.alloc(64).toString('base64'),
        verify_key: 12345,
      },
    });
    ok('5g integer verify_key → valid:false', res.status === 200 && res.body.valid === false);
  }

  // 5h. Replay: submit the exact same envelope twice → consistent result (oracle is idempotent)
  {
    const payload = { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', score: 77 };
    const env = testSign(_canonicalJSON(payload));
    const body = { envelope: { payload, ...env } };
    const res1 = await request('POST', '/verify/v1/signed-receipt', body);
    const res2 = await request('POST', '/verify/v1/signed-receipt', body);
    ok('5h replay → same HTTP status', res1.status === res2.status);
    ok('5h replay → same valid field',  res1.body.valid  === res2.body.valid);
    ok('5h replay → same reason',       res1.body.reason === res2.body.reason);
  }

  // 5i. Scan: iris_score is a number in the valid range [0, 100]
  {
    const res = await request('GET', '/scan/v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    ok('5i iris_score >= 0', res.status === 200 &&
       typeof res.body.iris_score === 'number' && res.body.iris_score >= 0);
    ok('5i iris_score <= 100', res.body.iris_score <= 100, 'got ' + res.body.iris_score);
  }

  // 5j. signed_at far in past → oracle still reports mathematically_valid (no time-bound check)
  {
    const payload = { data: 'ancient', ts: '2020-01-01' };
    const env = testSign(_canonicalJSON(payload));
    const staleEnv = { ...env, signed_at: '2020-01-01T00:00:00.000Z' };
    const res = await request('POST', '/verify/v1/signed-receipt', {
      envelope: { payload, ...staleEnv },
    });
    ok('5j stale signed_at → still mathematically_valid',
       res.status === 200 && res.body.mathematically_valid === true,
       'got ' + res.body.mathematically_valid);
  }

  // 5k. Governance with integer program_id (type injection) → 400 or error
  {
    const res = await request('POST', '/monitor/v1/governance-change', {
      program_id: 99999,
    });
    ok('5k integer program_id → 400', res.status === 400, 'got ' + res.status);
  }

  // 5l. Feed response includes signed_at (ISO-format string) and signature field
  {
    const res = await request('GET', '/feed/v1/new-spl-tokens');
    ok('5l feed signed_at is string', res.status === 200 && typeof res.body.signed_at === 'string');
    ok('5l feed signature type is string or null',
       typeof res.body.signature === 'string' || res.body.signature === null);
  }

  // 5m. Governance: extra unknown fields in body → 200 (unknown fields silently ignored)
  {
    const res = await request('POST', '/monitor/v1/governance-change', {
      program_id:     'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf',
      unknown_field:  'ignored',
      another_extra:  12345,
    });
    ok('5m extra body fields → 200', res.status === 200, 'got ' + res.status);
  }
}

// ── Main runner ───────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log('\n═══ A2A Oracle Unit Tests ═══════════════════════════════════════════════════');
  console.log('Ed25519 via node:crypto (same primitive as endpoint, no sign-report.py)');

  await startServer();
  console.log('Test server started at ' + _baseUrl);

  try {
    await testVerifyEndpoint();
    await testScanEndpoint();
    await testGovernanceEndpoint();
    await testFeedEndpoint();
    await testAdversarial();
  } finally {
    await stopServer();
  }

  const elapsed = Date.now() - t0;
  console.log('\n═══ Results ═════════════════════════════════════════════════════════════════');
  console.log(`  ${_pass} passed, ${_fail} failed  (${elapsed} ms)`);

  if (_fail > 0) process.exit(1);
}

run().catch(e => { console.error('[FATAL]', e); process.exit(1); });
