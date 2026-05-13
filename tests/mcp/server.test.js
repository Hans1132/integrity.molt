'use strict';
// tests/mcp/server.test.js — Unit testy pro MCP server (client + tool handlers)
// Run: node tests/mcp/server.test.js
// Spouští mock HTTP server místo produkčního backendu.

// Required for INTEGRITY_MOLT_TEST_VERIFY_KEY override in verifier.js (C1 security fix).
process.env.NODE_ENV = 'test';

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ── Mock HTTP server ──────────────────────────────────────────────────────────

const MOCK_RESPONSES = {
  'GET /scan/v1/So11111111111111111111111111111111111111112': {
    status: 200,
    body: { iris_score: 10, risk_level: 'low', risk_factors: [], signature: 'abc123' },
  },
  'GET /scan/v1/FAKE_NONEXISTENT_ADDRESS_XYZ': {
    status: 404,
    body: { error: 'not found' },
  },
  'POST /verify/v1/signed-receipt': {
    status: 200,
    body: { valid: true },
  },
  'GET /feed/v1/new-spl-tokens': {
    status: 200,
    body: { tokens: [], count: 0 },
  },
  'POST /scan/iris': {
    status: 200,
    body: { iris_score: 30, risk_level: 'low', risk_factors: [] },
  },
  'GET /monitor/v1/program-verification/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': {
    status: 200,
    body: { is_verified: true, repo_url: 'https://github.com/solana-labs/solana-program-library', cache_age_s: 120 },
  },
};

let mockServer;
let mockPort;

async function startMockServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => {
        // Match on method + path (strip query string)
        const key = `${req.method} ${req.url.split('?')[0]}`;
        const match = MOCK_RESPONSES[key];
        if (match) {
          res.writeHead(match.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(match.body));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `no mock for ${key}` }));
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      process.env.INTEGRITY_MOLT_BASE_URL = `http://127.0.0.1:${mockPort}`;
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => mockServer.close(resolve));
}

// ── Run all tests ─────────────────────────────────────────────────────────────

console.log('\ntests/mcp/server.test.js\n');

(async () => {
  await startMockServer();

  // ── Client tests ────────────────────────────────────────────────────────────
  console.log('── client ──');

  const { get, post } = require('../../mcp/lib/client');

  await testAsync('get() vrátí JSON při 200', async () => {
    const data = await get('/scan/v1/So11111111111111111111111111111111111111112');
    assert.strictEqual(data.risk_level, 'low');
    assert.strictEqual(data.iris_score, 10);
  });

  await testAsync('get() hodí Error při 404', async () => {
    try {
      await get('/scan/v1/FAKE_NONEXISTENT_ADDRESS_XYZ');
      assert.fail('mělo hodit Error');
    } catch (e) {
      assert.ok(e.message, 'Error musí mít message');
      assert.strictEqual(e.status, 404);
    }
  });

  await testAsync('post() vrátí JSON při 200', async () => {
    const data = await post('/verify/v1/signed-receipt', { envelope: { sig: 'test' } });
    assert.strictEqual(data.valid, true);
  });

  await testAsync('get() hodí při RPC down (ECONNREFUSED)', async () => {
    const saved = process.env.INTEGRITY_MOLT_BASE_URL;
    process.env.INTEGRITY_MOLT_BASE_URL = 'http://127.0.0.1:19999'; // nothing listening
    try {
      await get('/scan/v1/test');
      assert.fail('mělo hodit Error');
    } catch (e) {
      assert.ok(e.message, 'Error při connection refused');
    } finally {
      process.env.INTEGRITY_MOLT_BASE_URL = saved;
    }
  });

  // ── Tool handler tests ──────────────────────────────────────────────────────
  console.log('\n── tool handlers ──');

  const { TOOLS, handleTool } = require('../../mcp/lib/tools');

  test('TOOLS obsahuje 5 definic', () => {
    assert.strictEqual(TOOLS.length, 5);
    const names = TOOLS.map(t => t.name);
    assert.ok(names.includes('scan_solana_address'), 'scan_solana_address chybí');
    assert.ok(names.includes('verify_signed_receipt'), 'verify_signed_receipt chybí');
    assert.ok(names.includes('get_new_spl_tokens'), 'get_new_spl_tokens chybí');
    assert.ok(names.includes('quick_scan'), 'quick_scan chybí');
    assert.ok(names.includes('check_program_verification'), 'check_program_verification chybí');
  });

  test('každý tool má inputSchema.type=object', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.inputSchema, `${tool.name}: chybí inputSchema`);
      assert.strictEqual(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type není object`);
    }
  });

  await testAsync('scan_solana_address — platná adresa vrátí risk_level', async () => {
    const result = await handleTool('scan_solana_address', {
      address: 'So11111111111111111111111111111111111111112',
    });
    assert.ok(result.content, 'result.content chybí');
    assert.strictEqual(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    assert.ok('risk_level' in data, 'risk_level chybí v odpovědi');
  });

  await testAsync('scan_solana_address — prázdná adresa vrátí isError', async () => {
    const result = await handleTool('scan_solana_address', { address: '' });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('required'));
  });

  await testAsync('verify_signed_receipt — platný envelope vrátí valid:true', async () => {
    const result = await handleTool('verify_signed_receipt', {
      envelope: { payload: 'test', signature: 'abc' },
    });
    assert.strictEqual(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.strictEqual(data.valid, true);
  });

  await testAsync('verify_signed_receipt — chybějící envelope vrátí isError', async () => {
    const result = await handleTool('verify_signed_receipt', {});
    assert.strictEqual(result.isError, true);
  });

  await testAsync('get_new_spl_tokens — bez since vrátí tokens array', async () => {
    const result = await handleTool('get_new_spl_tokens', {});
    assert.strictEqual(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.tokens), 'tokens není array');
  });

  await testAsync('get_new_spl_tokens — s since param vrátí tokens array', async () => {
    const result = await handleTool('get_new_spl_tokens', { since: '2026-05-01T00:00:00Z' });
    assert.strictEqual(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.tokens), 'tokens není array');
  });

  await testAsync('quick_scan — platná adresa vrátí iris_score', async () => {
    const result = await handleTool('quick_scan', {
      address: 'So11111111111111111111111111111111111111112',
    });
    assert.strictEqual(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.ok(typeof data.iris_score === 'number', 'iris_score není number');
  });

  await testAsync('quick_scan — prázdná adresa vrátí isError', async () => {
    const result = await handleTool('quick_scan', { address: '' });
    assert.strictEqual(result.isError, true);
  });

  await testAsync('check_program_verification — platný program_id vrátí is_verified', async () => {
    const result = await handleTool('check_program_verification', {
      program_id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    });
    assert.strictEqual(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.ok('is_verified' in data, 'is_verified chybí');
  });

  await testAsync('check_program_verification — prázdný program_id vrátí isError', async () => {
    const result = await handleTool('check_program_verification', { program_id: '' });
    assert.strictEqual(result.isError, true);
  });

  await testAsync('neznámý tool name vrátí isError', async () => {
    const result = await handleTool('nonexistent_tool', {});
    assert.strictEqual(result.isError, true);
  });

  await testAsync('scan_solana_address — 404 vrátí isError', async () => {
    const result = await handleTool('scan_solana_address', {
      address: 'FAKE_NONEXISTENT_ADDRESS_XYZ',
    });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.startsWith('Error:'));
  });

  // ── Security regression tests (bugs confirmed by audit) ─────────────────────

  await testAsync('verify_signed_receipt — array jako envelope vrátí isError (regression H5)', async () => {
    const result = await handleTool('verify_signed_receipt', { envelope: [] });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('plain object'), 'chybí plain object hint: ' + result.content[0].text);
  });

  await testAsync('scan_solana_address — číslo jako address vrátí isError bez interního TypeError (regression H6)', async () => {
    const result = await handleTool('scan_solana_address', { address: 12345 });
    assert.strictEqual(result.isError, true);
    assert.ok(!result.content[0].text.includes('.trim is not a function'), 'nesmí leakovat interní JS error');
    assert.ok(result.content[0].text.startsWith('Error:'));
  });

  await testAsync('quick_scan — array jako address vrátí isError bez interního TypeError (regression H6)', async () => {
    const result = await handleTool('quick_scan', { address: ['inject'] });
    assert.strictEqual(result.isError, true);
    assert.ok(!result.content[0].text.includes('.trim is not a function'), 'nesmí leakovat interní JS error');
  });

  await testAsync('get_new_spl_tokens — since jako objekt vrátí isError (regression H6)', async () => {
    const result = await handleTool('get_new_spl_tokens', { since: { bad: true } });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('ISO8601'));
  });

  await testAsync('scan_solana_address — base58 validace odmítne krátký string', async () => {
    const result = await handleTool('scan_solana_address', { address: 'tooshort' });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('base58'));
  });

  // ── Local Ed25519 verifier tests (ADR-012) ──────────────────────────────────
  console.log('\n── local verifier (ADR-012) ──');

  const { verifyLocally, canonicalJSON, PINNED_KID } = require('../../mcp/lib/verifier');

  // Helper: generate test Ed25519 keypair + create signed flat-format envelope
  function makeTestEnvelope(payload, { useAsPinned = false } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const keyBytes = spkiDer.subarray(12); // strip 12-byte DER header → raw 32-byte key
    const keyB64 = keyBytes.toString('base64');
    if (useAsPinned) {
      process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY = keyBytes.toString('base64url');
    }
    const canonicalText = canonicalJSON(payload);
    const sig = crypto.sign(null, Buffer.from(canonicalText, 'utf-8'), privateKey);
    return {
      ...payload,
      signature: sig.toString('base64'),
      verify_key: keyB64,
      key_id: keyB64.slice(0, 16),
      signer: 'test-oracle',
      algorithm: 'Ed25519',
      signed_at: new Date().toISOString(),
    };
  }

  const TEST_PAYLOAD = { address: 'So11111111111111111111111111111111111111112', iris_score: 5, risk_level: 'low' };

  test('verifyLocally — platný podpis + pinned key → valid:true', () => {
    const envelope = makeTestEnvelope(TEST_PAYLOAD, { useAsPinned: true });
    const result = verifyLocally(envelope);
    assert.strictEqual(result.valid, true, 'valid musí být true');
    assert.strictEqual(result.key_pinned, true, 'key_pinned musí být true');
    assert.strictEqual(result.mathematically_valid, true);
    assert.strictEqual(result.verified_locally, true);
    assert.strictEqual(result.local_verify_kid, PINNED_KID);
    delete process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY;
  });

  test('verifyLocally — platný podpis ale cizí klíč → valid:false, key_not_pinned', () => {
    delete process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY;
    const envelope = makeTestEnvelope(TEST_PAYLOAD, { useAsPinned: false });
    const result = verifyLocally(envelope);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.key_pinned, false);
    assert.strictEqual(result.mathematically_valid, true, 'matematicky validní');
    assert.strictEqual(result.reason, 'key_not_pinned');
  });

  test('verifyLocally — pozměněný payload → invalid_signature', () => {
    const envelope = makeTestEnvelope(TEST_PAYLOAD, { useAsPinned: true });
    // Tamper with payload after signing
    const tampered = { ...envelope, iris_score: 99 };
    const result = verifyLocally(tampered);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.mathematically_valid, false);
    assert.strictEqual(result.reason, 'invalid_signature');
    delete process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY;
  });

  test('verifyLocally — chybějící signature → missing_signature_or_verify_key', () => {
    const result = verifyLocally({ verify_key: 'abc' });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'missing_signature_or_verify_key');
  });

  test('verifyLocally — neplatný base64 → invalid_base64_encoding', () => {
    const result = verifyLocally({ signature: '!!!', verify_key: '###' });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'invalid_base64_encoding');
  });

  test('verifyLocally — wrapped format (payload field) funguje', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const keyBytes = spkiDer.subarray(12);
    process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY = keyBytes.toString('base64url');
    const inner = { address: 'So11111111111111111111111111111111111111112', iris_score: 3 };
    const sig = crypto.sign(null, Buffer.from(canonicalJSON(inner), 'utf-8'), privateKey);
    const envelope = {
      payload: inner,
      signature: sig.toString('base64'),
      verify_key: keyBytes.toString('base64'),
      algorithm: 'Ed25519',
    };
    const result = verifyLocally(envelope);
    assert.strictEqual(result.valid, true, 'wrapped format musí projít');
    assert.strictEqual(result.verified_locally, true);
    delete process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY;
  });

  await testAsync('handleTool verify_signed_receipt — INTEGRITY_MOLT_LOCAL_VERIFY=1 vrátí verified_locally', async () => {
    const envelope = makeTestEnvelope(TEST_PAYLOAD, { useAsPinned: true });
    process.env.INTEGRITY_MOLT_LOCAL_VERIFY = '1';
    try {
      const result = await handleTool('verify_signed_receipt', { envelope });
      assert.strictEqual(result.isError, undefined, 'nesmí být isError');
      const data = JSON.parse(result.content[0].text);
      assert.strictEqual(data.verified_locally, true);
      assert.strictEqual(data.valid, true);
    } finally {
      process.env.INTEGRITY_MOLT_LOCAL_VERIFY = undefined;
      delete process.env.INTEGRITY_MOLT_LOCAL_VERIFY;
      delete process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY;
    }
  });

  await testAsync('handleTool verify_signed_receipt — bez LOCAL_VERIFY volá backend (mock)', async () => {
    delete process.env.INTEGRITY_MOLT_LOCAL_VERIFY;
    const result = await handleTool('verify_signed_receipt', { envelope: { payload: 'test', signature: 'abc' } });
    assert.strictEqual(result.isError, undefined, 'mock backend vrátí valid:true');
    const data = JSON.parse(result.content[0].text);
    assert.strictEqual(data.valid, true);
    assert.strictEqual(data.verified_locally, undefined, 'backend response nemá verified_locally');
  });

  await stopMockServer();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('Test runner crashed:', err.message);
  process.exit(1);
});
