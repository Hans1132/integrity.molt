'use strict';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  validateErc8004Document,
  assessClaimVsReality,
  computeAgentScore,
  scoreToRisk,
} = require('../../src/enrichment/metaplex-agent');
const { validateUrl } = require('../../src/lib/url-validation');

// Exact ERC-8004 type string required by validateErc8004Document
const ERC8004_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

// Helper: minimal valid ERC-8004 doc (no validation errors)
function validDoc(overrides = {}) {
  return Object.assign({
    type:          ERC8004_TYPE,
    name:          'TestAgent',
    description:   'A test agent',
    image:         'https://example.com/agent.png',
    active:        true,
    supportedTrust: [],
    services: [{ id: 'svc-1', type: 'A2AService', serviceEndpoint: 'https://example.com/a2a' }],
  }, overrides);
}

// ── AS-23 ─────────────────────────────────────────────────────────────────────
test('AS-23: Forged URI + TEE attestation claim — tee_attestation_unverified finding', () => {
  const doc = validDoc({ supportedTrust: ['tee-attestation'] });

  // Recent wallet activity (now − 1 hour) — no stale claim
  const nowSec = Math.floor(Date.now() / 1000);
  const walletRecentActivity = [{ signature: 'sig1', timestamp: nowSec - 3600, type: 'TRANSFER', fee: 5000 }];

  const validation    = validateErc8004Document(doc);
  const claimReality  = assessClaimVsReality(doc, walletRecentActivity, doc.services);

  // tee_attestation_unverified must be flagged
  assert.ok(
    claimReality.findings.includes('tee_attestation_unverified'),
    `Expected tee_attestation_unverified in findings, got: ${JSON.stringify(claimReality.findings)}`
  );

  // Trust must NOT be validated when TEE claim is unverified
  assert.equal(claimReality.trustValidated, false, 'trustValidated should be false for unverified TEE');

  // Score > 0 — TEE finding adds 10 to the risk score
  const score = computeAgentScore(validation, null, claimReality, 'low');
  assert.ok(score > 0, `Expected score > 0 (tee adds 10), got ${score}`);
});

// ── AS-24 ─────────────────────────────────────────────────────────────────────
test('AS-24: Loopback service endpoint — SSRF block', () => {
  // Loopback: http://127.0.0.1 must be blocked
  const result127 = validateUrl('http://127.0.0.1:8080/a2a');
  assert.ok(result127 !== null, 'http://127.0.0.1:8080/a2a should be blocked (SSRF)');

  // localhost must be blocked
  const resultLocalhost = validateUrl('http://localhost/api');
  assert.ok(resultLocalhost !== null, 'http://localhost/api should be blocked (SSRF)');

  // Octal loopback 0177.0.0.1 must be blocked
  const resultOctal = validateUrl('http://0177.0.0.1/api');
  assert.ok(resultOctal !== null, 'http://0177.0.0.1/api (octal loopback) should be blocked (SSRF)');

  // A legitimate public endpoint must be allowed
  const resultSafe = validateUrl('https://example.com/a2a');
  assert.equal(resultSafe, null, 'https://example.com/a2a should be allowed (safe)');
});

// ── AS-25 ─────────────────────────────────────────────────────────────────────
test('AS-25: Drainer wallet — scam_hit escalates score to danger', () => {
  const doc = validDoc({ active: true });
  const validation = validateErc8004Document(doc);

  // Empty recent activity → stale_active_claim (+20)
  const walletRecentActivity = [];
  const claimReality = assessClaimVsReality(doc, walletRecentActivity, doc.services);

  const wallet = {
    address:          'SCAM_ADDR',
    balance_lamports: 0,
    recent_activity:  [],
    scam_hit:         { scam_type: 'rug_pull', confidence: 1.0 },
  };

  // scam_hit (+50) + stale_active_claim (+20) = 70 → danger threshold
  const score = computeAgentScore(validation, wallet, claimReality, 'low');

  assert.ok(score >= 50, `Expected score >= 50 (scam_hit contributes 50), got ${score}`);
  assert.equal(scoreToRisk(score), 'danger', `Expected 'danger' risk for score ${score}`);
});

// ── AS-26 ─────────────────────────────────────────────────────────────────────
test('AS-26: Stale active claim — >90 days without activity', () => {
  const doc = validDoc({ active: true });

  // Wallet activity older than 90 days (95 days back)
  const staleTimestamp = Math.floor(Date.now() / 1000) - (95 * 86400);
  const staleActivity  = [{ signature: 'sig-old', timestamp: staleTimestamp, type: 'TRANSFER', fee: 5000 }];

  const claimReality = assessClaimVsReality(doc, staleActivity, doc.services);

  assert.ok(
    claimReality.findings.includes('stale_active_claim'),
    `Expected stale_active_claim in findings (95-day-old tx), got: ${JSON.stringify(claimReality.findings)}`
  );
  assert.equal(claimReality.activeAligned, false, 'activeAligned should be false for stale claim');

  // Bonus: empty activity also triggers stale_active_claim
  const emptyActivity = [];
  const claimEmpty = assessClaimVsReality(doc, emptyActivity, doc.services);
  assert.ok(
    claimEmpty.findings.includes('stale_active_claim'),
    `Expected stale_active_claim for empty activity, got: ${JSON.stringify(claimEmpty.findings)}`
  );
});

// ── AS-27 ─────────────────────────────────────────────────────────────────────
test('AS-27: DNS rebinding defense — hostname validation blocks alternate loopback forms', () => {
  // Note: testuje validateUrl regex, ne live DNS resolution

  // Octal loopback (0177.0.0.1 = 127.0.0.1)
  const resultOctal = validateUrl('http://0177.0.0.1/api');
  assert.ok(resultOctal !== null, 'http://0177.0.0.1/api (octal) should be blocked');

  // Decimal integer loopback (2130706433 = 127.0.0.1)
  const resultDecimal = validateUrl('http://2130706433/api');
  assert.ok(resultDecimal !== null, 'http://2130706433/api (decimal IP) should be blocked');

  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)
  const resultIpv4Mapped = validateUrl('http://[::ffff:127.0.0.1]/api');
  assert.ok(resultIpv4Mapped !== null, 'http://[::ffff:127.0.0.1]/api (IPv4-mapped IPv6) should be blocked');

  // AWS metadata service (169.254.169.254)
  const resultAwsMeta = validateUrl('http://169.254.169.254/metadata');
  assert.ok(resultAwsMeta !== null, 'http://169.254.169.254/metadata (AWS metadata) should be blocked');
});
