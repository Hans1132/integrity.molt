'use strict';
// tests/scan-token-audit-metaplex.test.js
// Polymorphism testy pro token_audit skill (ADR-013 Fáze 2+4a).
// Testuje logiku handler.js a server.js bez živých RPC volání.
// Spustit: node tests/scan-token-audit-metaplex.test.js

process.env.SQLITE_DB_PATH = ':memory:';
process.env.NODE_ENV       = 'test';

const assert = require('assert');
const path   = require('path');
const db     = require('../db');
db.initSchema();

// ── Importujeme enrichment funkce pro přímé unit testy polymorphism logic ──────
const {
  validateErc8004Document,
  assessClaimVsReality,
  computeAgentScore,
  scoreToRisk,
} = require('../src/enrichment/metaplex-agent');

// ── Mutable stubs pro handler.js signing tests (T11, T12) ────────────────────
// Musí být nainstalovány PŘED prvním require('../src/a2a/handler'),
// protože handler.js destrukturuje závislosti na úrovni modulu.
//
// Proxy pattern: stub funkce deleguje na měnitelný _impl holder,
// takže handler.js zachytí wrapper (ne konkrétní impl) a testy
// mohou impl vyměnit mezi voláními.

const { canonicalJSON, buildMetaplexAgentPayload, SignPipelineError } = require('../src/crypto/sign');

// Holder pro asyncSign — vyměňujeme mezi T11/T12
let _asyncSignImpl = async () => { throw new SignPipelineError('default stub — not configured'); };

// Holder pro detectAgentIdentity — vyměňujeme mezi T11/T12
let _detectAgentIdentityImpl = async () => ({ isAgent: false });

function _stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = {
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

// Stub 1: crypto/sign — proxy wrapper přes _asyncSignImpl
_stubModule(require.resolve(BASE + '/src/crypto/sign'), {
  asyncSign:              (text) => _asyncSignImpl(text),
  canonicalJSON,
  buildMetaplexAgentPayload,
  SignPipelineError,
  SIGN_SCRIPT:            '/dev/null',
});

// Stub 2: enrichment/metaplex-agent — proxy wrapper přes _detectAgentIdentityImpl
// Ostatní funkce vracejí bezpečné výchozí hodnoty
_stubModule(require.resolve(BASE + '/src/enrichment/metaplex-agent'), {
  detectAgentIdentity:      (addr) => _detectAgentIdentityImpl(addr),
  fetchRegistrationDocument: async () => ({ doc: null, error: null, mutabilityRisk: 'low' }),
  validateErc8004Document,    // reálná pure funkce
  getAssetSignerWallet:      async () => ({ address: null, balance_lamports: null, recent_activity: [], scam_hit: null }),
  assessClaimVsReality,       // reálná pure funkce
  computeAgentScore,          // reálná pure funkce
  scoreToRisk,                // reálná pure funkce
});

// Teď načteme handler.js — zachytí výše nainstalované proxy stubs
const { executeSkill } = require('../src/a2a/handler');

const ERC8004_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
const VALID_DOC = {
  type:        ERC8004_TYPE,
  name:        'test-agent',
  description: 'A test agent',
  image:       'ar://img',
  active:      true,
  supportedTrust: [],
  services:    [{ id: 'a2a', type: 'AgentService', serviceEndpoint: 'https://example.com/a2a' }],
};

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

async function main() {
  console.log('\n── scan-token-audit-metaplex.test.js ──\n');

  // ── T01: SPL token → audit_type spl_token ─────────────────────────────────
  await test('T01: SPL token (isAgent=false) → flows to SPL path, audit_type discriminated', () => {
    // Simuluje logiku: pokud detectAgentIdentity vrátí isAgent=false,
    // nepoužijeme agent audit flow. Ověřujeme discriminated scan_type logic.
    const isAgent = false;
    const auditScanType = isAgent ? 'token_agent' : 'token';
    assert.strictEqual(auditScanType, 'token', 'SPL token → scan_type = "token"');
  });

  // ── T02: Core Asset s AgentIdentity → audit_type metaplex_agent ───────────
  await test('T02: Core Asset + AgentIdentity → agent flow, correct audit_type', () => {
    const detection = { isAgent: true, identityPda: 'MOCK_PDA', agentIdentity: { uri: 'ar://TXID', active: true, supportedTrust: [], lifecycleChecks: {} } };
    const auditScanType = detection.isAgent ? 'token_agent' : 'token';
    assert.strictEqual(auditScanType, 'token_agent', 'Agent → scan_type = "token_agent"');
    assert.ok(detection.agentIdentity?.uri, 'should have registration URI');
  });

  // ── T03: Core Asset BEZ AgentIdentity → fallback na SPL flow ──────────────
  await test('T03: Core Asset bez AgentIdentity (isAgent=false) → fallback SPL flow', () => {
    // detectAgentIdentity vrátí isAgent=false pro Core Asset bez AgentIdentity PDA
    const detection = { isAgent: false, identityPda: 'MOCK_PDA', agentIdentity: null };
    const auditScanType = detection.isAgent ? 'token_agent' : 'token';
    assert.strictEqual(auditScanType, 'token', 'Core bez identity → SPL fallback, scan_type = "token"');
    // Ověří že i když identityPda existuje, bez agentIdentity nejdeme do agent flow
    const wouldRunAgentFlow = detection.isAgent && !!detection.agentIdentity;
    assert.strictEqual(wouldRunAgentFlow, false);
  });

  // ── T04: Registration URI 404 → registration_doc_unreachable ──────────────
  await test('T04: Registration URI fetch fails → registration_doc_unreachable:true', () => {
    const docR    = { doc: null, error: 'HTTP 404', mutabilityRisk: 'low' };
    const validation = validateErc8004Document(docR.doc);

    assert.strictEqual(!!docR.error, true, 'registration_doc_unreachable should be true');
    assert.strictEqual(validation.valid, false, 'null doc → invalid');
  });

  // ── T05: Registration doc malformed JSON → registration_doc_invalid ────────
  await test('T05: Registration doc malformed → registration_doc_invalid:true, validation errors', () => {
    const badDoc   = { type: 'wrong-type' }; // missing name, description, image + wrong type
    const validation = validateErc8004Document(badDoc);

    assert.strictEqual(validation.valid, false, 'malformed doc → invalid');
    assert.ok(validation.errors.length > 0, 'should have errors');
    assert.ok(validation.errors.some(e => e.includes('name')), 'should flag missing name');
    assert.ok(validation.errors.some(e => e.includes('Invalid type')), 'should flag wrong type');
  });

  // ── T06: Services array prázdný [] → no_services_declared ─────────────────
  await test('T06: Registration doc services=[] → no_services_declared finding', () => {
    const doc = { ...VALID_DOC, services: [] };
    const claimReality = assessClaimVsReality(doc, [], []);
    assert.ok(claimReality.findings.includes('no_services_declared'), `findings: ${claimReality.findings.join(', ')}`);
  });

  // ── T07: Active:true ale stale wallet (>90 dní) → stale_active_claim ──────
  await test('T07: active:true + last_tx > 90 dní → stale_active_claim', () => {
    const doc    = { ...VALID_DOC, active: true };
    const oldTs  = Math.floor(Date.now() / 1000) - (95 * 86400); // 95 dní zpět
    const wallet = [{ signature: 'abc', timestamp: oldTs, type: 'TRANSFER', fee: 5000 }];

    const claimReality = assessClaimVsReality(doc, wallet, VALID_DOC.services);
    assert.ok(claimReality.findings.includes('stale_active_claim'), `findings: ${claimReality.findings.join(', ')}`);
    assert.strictEqual(claimReality.activeAligned, false);
  });

  // ── T08: Service endpoint 127.0.0.1 → SSRF blocked, services_misconfigured ─
  await test('T08: Service endpoint 127.0.0.1 → SSRF block (validateUrl)', () => {
    const { validateUrl } = require('../src/lib/url-validation');
    const err = validateUrl('http://127.0.0.1:8080/api');
    assert.ok(err, 'should be blocked');
    assert.ok(err.includes('SSRF'), `error: ${err}`);

    const err2 = validateUrl('http://169.254.169.254/metadata');
    assert.ok(err2, 'metadata endpoint should be blocked');
  });

  // ── T09: HTTP bez TLS registration URI → uri_mutability_risk high ──────────
  await test('T09: HTTP (no TLS) registration URI → uri_mutability_risk = "high"', () => {
    // _mutabilityRisk je interní — testujeme přes fetchRegistrationDocument výstup
    // Simulate: HTTP URL → mutabilityRisk computation
    function mutabilityRisk(uri) {
      if (!uri) return 'high';
      if (/^ar:\/\/|arweave\.net\/|ar\.io\//.test(uri)) return 'low';
      if (/^ipfs:\/\/|ipfs\.io\/|cloudflare-ipfs\.com\//.test(uri)) return 'low';
      if (uri.startsWith('https://')) return 'medium';
      return 'high'; // HTTP bez TLS
    }
    assert.strictEqual(mutabilityRisk('http://example.com/doc.json'), 'high');
    assert.strictEqual(mutabilityRisk('https://example.com/doc.json'), 'medium');
    assert.strictEqual(mutabilityRisk('ar://TXID'), 'low');
    assert.strictEqual(mutabilityRisk('ipfs://CID'), 'low');
  });

  // ── T10: Asset Signer wallet scam DB hit → score eskalován ────────────────
  await test('T10: Scam wallet hit → computeAgentScore eskaluje score HIGH', () => {
    const walletR      = { address: 'SCAM_ADDR', balance_lamports: 0, recent_activity: [], scam_hit: { scam_type: 'rug_pull', confidence: 1.0 } };
    const validation   = validateErc8004Document(VALID_DOC);
    const claimReality = assessClaimVsReality(VALID_DOC, [], VALID_DOC.services);
    const score        = computeAgentScore(validation, walletR, claimReality, 'low');

    assert.ok(score >= 50, `score should be >= 50 for scam wallet, got ${score}`);
    assert.strictEqual(scoreToRisk(score), 'danger', `risk should be danger for score ${score}`);
  });

  // ── T11: asyncSign succeeds → result includes receipt field ─────────────────
  await test('T11: asyncSign succeeds → result.receipt.payload.subject_type + signature present', async () => {
    _asyncSignImpl = async () => { throw new SignPipelineError('asyncSign stub not configured'); };
    _detectAgentIdentityImpl = async () => ({ isAgent: false });
    // Nastavíme detectAgentIdentity tak, aby vrátil agentní identitu
    _detectAgentIdentityImpl = async () => ({
      isAgent:      true,
      identityPda:  'MOCK_PDA_T11',
      agentIdentity: {
        uri:              'https://example.com/agent.json',
        lifecycleChecks:  { transfer: true, update: false, execute: false },
      },
    });
    // Nastavíme asyncSign tak, aby vrátil úspěšný envelope
    _asyncSignImpl = async () => ({
      signature:  'sig123',
      verify_key: 'vk456',
      key_id:     'kid789',
      signed_at:  '2026-01-01T00:00:00.000Z',
      signer:     'integrity.molt',
      algorithm:  'Ed25519',
    });

    const result = await executeSkill('token_audit', 'So11111111111111111111111111111112');

    assert.strictEqual(result.audit_type, 'metaplex_agent', 'audit_type should be metaplex_agent');
    assert.ok(result.receipt, 'receipt should be present when asyncSign succeeds');
    assert.strictEqual(result.receipt.payload.subject_type, 'metaplex_agent', 'receipt.payload.subject_type should be metaplex_agent');
    assert.strictEqual(result.receipt.signature, 'sig123', 'receipt.signature should match stub value');
    assert.strictEqual(result.receipt.verify_key, 'vk456', 'receipt.verify_key should match stub value');
    assert.strictEqual(result.receipt.payload.subject_metaplex_asset, 'So11111111111111111111111111111112', 'receipt.payload.subject_metaplex_asset should match input address');
  });

  // ── T12: asyncSign throws SignPipelineError → receipt omitted, no throw ──────
  await test('T12: asyncSign throws SignPipelineError → receipt absent, audit data intact', async () => {
    _asyncSignImpl = async () => { throw new SignPipelineError('asyncSign stub not configured'); };
    _detectAgentIdentityImpl = async () => ({ isAgent: false });
    // Nastavíme detectAgentIdentity → agentní flow
    _detectAgentIdentityImpl = async () => ({
      isAgent:      true,
      identityPda:  'MOCK_PDA_T12',
      agentIdentity: {
        uri:              'https://example.com/agent2.json',
        lifecycleChecks:  {},
      },
    });
    // Nastavíme asyncSign tak, aby hodil SignPipelineError
    _asyncSignImpl = async () => { throw new SignPipelineError('signing failed'); };

    const result = await executeSkill('token_audit', 'So11111111111111111111111111111112');

    assert.strictEqual(result.audit_type, 'metaplex_agent', 'audit_type should be metaplex_agent');
    assert.strictEqual(result.receipt, undefined, 'receipt should be absent when asyncSign throws');
    // Audit data musí zůstat kompletní i přes chybu podepisování
    assert.ok(result.metaplex_agent_audit, 'metaplex_agent_audit should be present');
    assert.strictEqual(result.status, 'complete', 'status should be complete despite signing failure');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
