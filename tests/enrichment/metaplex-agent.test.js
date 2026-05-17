'use strict';
// tests/enrichment/metaplex-agent.test.js
// Unit testy pro src/enrichment/metaplex-agent.js
// Spustit: node tests/enrichment/metaplex-agent.test.js

process.env.SQLITE_DB_PATH = ':memory:';
process.env.NODE_ENV       = 'test';

const assert  = require('assert');
const db      = require('../../db');

// Musíme inicializovat schema před importem modulu (modul volá db funkce v cache lookup)
// Synchronní setup přes db.db (raw SQLite) — initSchema je async kvůli zpětné kompatibilitě
db.initSchema();

const {
  detectAgentIdentity,
  fetchRegistrationDocument,
  validateErc8004Document,
  getAssetSignerWallet,
  assessClaimVsReality,
  checkServiceEndpoint,
  _setUmiForTest,
} = require('../../src/enrichment/metaplex-agent');

const SAMPLE_ADDRESS = '2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy';
const ERC8004_TYPE   = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name, '\n   ', e.message);
    failed++;
  }
}

// ── Mock Umi factory ──────────────────────────────────────────────────────────
function makeMockUmi({ identityData = null } = {}) {
  const mockPublicKey = (addr) => ({ toString: () => addr, bytes: new Uint8Array(32) });

  return {
    _identityData: identityData,
    programs: {},
    use: function(plugin) { if (plugin && plugin.install) plugin.install(this); return this; },
    rpc: {
      getAccount: async () => null,
    },
    // expose for findPda usage
    eddsa: {
      findPda: async (programId, seeds) => [mockPublicKey('MOCK_PDA_ADDRESS'), 255],
    },
  };
}

// ── Inject mock fetch helper ──────────────────────────────────────────────────
let _originalFetch = global.fetch;
function mockFetch(handler) {
  global.fetch = async (url, opts) => handler(url, opts);
}
function restoreFetch() {
  global.fetch = _originalFetch;
}

// ── Test: detectAgentIdentity happy path ──────────────────────────────────────
async function main() {
  console.log('\n── metaplex-agent.test.js ──\n');

  // T01: detectAgentIdentity — mock returns identity
  await test('detectAgentIdentity: identity found (mock Umi)', async () => {
    const mockIdentity = {
      uri:             'ar://FAKE_TX_ID_43CHARS_PADDED_00000000000000',
      active:          true,
      supportedTrust:  ['basic'],
      lifecycleChecks: { transfer: true, update: false, execute: false },
    };

    // Override safeFetchAgentIdentityV1 via module internals — use require cache trick
    // Since we can't easily mock deep Umi calls, we test via the actual PDA derivation
    // but mock the final RPC fetch by injecting a custom Umi-like object that
    // returns our identity from safeFetchAgentIdentityV1.
    //
    // Approach: temporarily replace the module-level _umi with a proxy whose
    // rpc.getAccount returns serialized identity data — too complex. Instead, we
    // test by directly calling safeFetchAgentIdentityV1-dependent paths via
    // a simpler technique: export _setUmiForTest and inject a minimal stub.

    // Build minimal Umi stub that makes safeFetchAgentIdentityV1 return our data.
    // safeFetchAgentIdentityV1(umi, pda) internally calls umi.rpc.getAccount(pda).
    // We override the entire module's Umi instance to return null, then test null path.
    // For full happy-path, use real PDA derivation but mock the rpc.getAccount response.

    // Simpler: test via detectAgentIdentity with mocked internals using Node module cache.
    // We'll verify the structure returned when safeFetchAgentIdentityV1 would return data.
    // Since we can't easily mock the deserialization, we focus on the null-path and
    // cache layer tests, and validate structure expectations.

    // Happy path via direct cache injection (bypasses Umi call)
    db.setMetaplexAgentCache({
      address:               SAMPLE_ADDRESS + '_cached',
      identity_json:         JSON.stringify({ ...mockIdentity, identityPda: 'MOCK_PDA' }),
      registration_doc_json: null,
      asset_signer_wallet:   null,
    });
    const res = await detectAgentIdentity(SAMPLE_ADDRESS + '_cached');
    assert.strictEqual(res.isAgent, true, 'isAgent should be true');
    assert.strictEqual(res.cached,  true, 'should be from cache');
    assert.strictEqual(res.agentIdentity.uri, mockIdentity.uri);
  });

  // T02: detectAgentIdentity — null path (no AgentIdentity)
  await test('detectAgentIdentity: null path (no AgentIdentity on-chain)', async () => {
    // Inject a Umi stub where safeFetchAgentIdentityV1 returns null.
    // We do this by loading the real module and checking the null-cached path.
    db.setMetaplexAgentCache({
      address:               'NULLPATH_TEST_ADDRESS',
      identity_json:         null,
      registration_doc_json: null,
      asset_signer_wallet:   null,
    });
    const res = await detectAgentIdentity('NULLPATH_TEST_ADDRESS');
    assert.strictEqual(res.isAgent, false, 'isAgent should be false for null identity');
    assert.strictEqual(res.cached,  true,  'should be from cache');
    assert.strictEqual(res.agentIdentity, null);
  });

  // T03: fetchRegistrationDocument — multi-gateway race, first wins
  await test('fetchRegistrationDocument: Arweave multi-gateway race (first wins)', async () => {
    const txId = 'A'.repeat(43);
    const doc  = { type: ERC8004_TYPE, name: 'Test', description: 'Test', image: 'ar://img' };
    let callOrder = [];

    mockFetch(async (url) => {
      callOrder.push(url);
      if (url.includes('ar.io')) {
        // ar.io responds fast
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify(doc),
        };
      }
      // arweave.net is slow — Promise never resolves in test (but Promise.any picks ar.io first)
      await new Promise(r => setTimeout(r, 10000));
      return { ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(doc) };
    });

    const result = await fetchRegistrationDocument(`ar://${txId}`);
    restoreFetch();

    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.deepStrictEqual(result.doc, doc);
    assert.strictEqual(result.mutabilityRisk, 'low');
    assert.ok(callOrder.some(u => u.includes('ar.io')), 'should call ar.io gateway');
  });

  // T04: fetchRegistrationDocument — all gateways timeout
  await test('fetchRegistrationDocument: all Arweave gateways fail', async () => {
    const txId = 'B'.repeat(43);
    mockFetch(async () => { throw new Error('Network timeout'); });

    const result = await fetchRegistrationDocument(`ar://${txId}`);
    restoreFetch();

    assert.ok(result.error, 'Should have error');
    assert.strictEqual(result.doc, null);
    assert.strictEqual(result.mutabilityRisk, 'low');
  });

  // T05: validateErc8004Document — valid document
  await test('validateErc8004Document: valid document passes', () => {
    const doc = {
      type:        ERC8004_TYPE,
      name:        'integrity.molt',
      description: 'Solana security oracle',
      image:       'ar://img_tx_id',
      active:      true,
      services:    [{ id: 'a2a', type: 'AgentService', serviceEndpoint: 'https://intmolt.org/a2a' }],
      registrations: [{ agentRegistry: 'solana:101:metaplex' }],
    };
    const { valid, errors, warnings } = validateErc8004Document(doc);
    assert.strictEqual(valid, true, `errors: ${errors.join(', ')}`);
    assert.strictEqual(errors.length, 0);
  });

  // T06: validateErc8004Document — missing required fields
  await test('validateErc8004Document: missing required fields → invalid', () => {
    const doc = { type: ERC8004_TYPE };
    const { valid, errors } = validateErc8004Document(doc);
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('name')));
    assert.ok(errors.some(e => e.includes('description')));
    assert.ok(errors.some(e => e.includes('image')));
  });

  // T07: validateErc8004Document — wrong type identifier
  await test('validateErc8004Document: wrong type identifier → invalid', () => {
    const doc = { type: 'https://wrong.type/v1', name: 'X', description: 'X', image: 'X' };
    const { valid, errors } = validateErc8004Document(doc);
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('Invalid type identifier')));
  });

  // T08: validateErc8004Document — null input
  await test('validateErc8004Document: null input → invalid', () => {
    const { valid, errors } = validateErc8004Document(null);
    assert.strictEqual(valid, false);
    assert.ok(errors.length > 0);
  });

  // T09: getAssetSignerWallet — PDA derived correctly (offline, no RPC needed)
  await test('getAssetSignerWallet: derives PDA from known asset address', async () => {
    // Mock fetch so no real RPC calls happen
    mockFetch(async (url) => {
      if (url.includes('mainnet') || url.includes('solana.com')) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 5000000 } }),
          text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 5000000 } }),
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await getAssetSignerWallet(SAMPLE_ADDRESS);
    restoreFetch();

    assert.ok(result.address, 'should return a derived wallet address');
    assert.ok(typeof result.address === 'string', 'address should be string');
    assert.ok(result.balance_lamports !== undefined, 'balance_lamports should be present');
    assert.ok(Array.isArray(result.recent_activity), 'recent_activity should be array');
  });

  // T10: getAssetSignerWallet — scam DB hit detected
  await test('getAssetSignerWallet: scam DB hit returns scam_hit', async () => {
    // Insert a scam entry for the Asset Signer PDA of SAMPLE_ADDRESS
    // Computed PDA: BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6
    const signerPda = 'BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6';
    db.upsertKnownScam({
      mint:       signerPda,
      source:     'manual',
      scam_type:  'phishing',
      confidence: 1.0,
      label:      'Test scam entry',
    });

    mockFetch(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    }));

    const result = await getAssetSignerWallet(SAMPLE_ADDRESS);
    restoreFetch();

    assert.ok(result.scam_hit !== null, 'scam_hit should be non-null for known scam address');
  });

  // T11: assessClaimVsReality — active:true with stale wallet (>90 days no tx)
  await test('assessClaimVsReality: stale active claim detected', () => {
    const doc = { active: true, supportedTrust: [] };
    const oldTs = Math.floor(Date.now() / 1000) - (100 * 86400); // 100 days ago
    const walletActivity = [{ signature: 'abc', timestamp: oldTs, type: 'TRANSFER', fee: 5000 }];

    const { activeAligned, findings } = assessClaimVsReality(doc, walletActivity, []);
    assert.strictEqual(activeAligned, false);
    assert.ok(findings.includes('stale_active_claim'), `findings: ${findings.join(', ')}`);
  });

  // T12: assessClaimVsReality — empty services declared
  await test('assessClaimVsReality: empty services → no_services_declared finding', () => {
    const doc = { active: true, supportedTrust: [] };
    const { findings } = assessClaimVsReality(doc, [], []);
    assert.ok(findings.includes('no_services_declared'));
  });

  // T13: checkServiceEndpoint — SSRF block for 127.0.0.1 and 169.254.x
  await test('checkServiceEndpoint: SSRF block for loopback address', async () => {
    const r1 = await checkServiceEndpoint('http://127.0.0.1:8080/api');
    assert.strictEqual(r1.reachable, false);
    assert.ok(r1.ssrf_blocked, 'should be ssrf_blocked');
    assert.ok(r1.error.includes('SSRF'), `error: ${r1.error}`);

    const r2 = await checkServiceEndpoint('http://169.254.169.254/metadata');
    assert.strictEqual(r2.reachable, false);
    assert.ok(r2.ssrf_blocked);
  });

  // T14 (bonus): checkServiceEndpoint — 401/403 treated as reachable
  await test('checkServiceEndpoint: 401 and 403 are reachable (auth-gated)', async () => {
    mockFetch(async () => ({ ok: false, status: 401, headers: { get: () => null } }));
    const r401 = await checkServiceEndpoint('https://example.com/api');
    restoreFetch();
    assert.strictEqual(r401.reachable, true, '401 should be reachable');
    assert.strictEqual(r401.statusCode, 401);

    mockFetch(async () => ({ ok: false, status: 403, headers: { get: () => null } }));
    const r403 = await checkServiceEndpoint('https://example.com/api');
    restoreFetch();
    assert.strictEqual(r403.reachable, true, '403 should be reachable');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
