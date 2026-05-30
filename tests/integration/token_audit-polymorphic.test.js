'use strict';
// tests/integration/token_audit-polymorphic.test.js
// Asserts SPL token + Metaplex agent flows return identical risk_level enum domain.
//
// Spec: docs/superpowers/specs/2026-05-19-iris-v2-amendment-q3-3tier.md §9 item 4
//       (mini-call ratify — polymorphic token_audit integration test).
//
// Until backend Phase 2A lands the lowercase 3-tier enum on the live service,
// SPL branch returns legacy `risk_level: "low"` and metaplex agent endpoint's
// OpenAPI advertises uppercase enum. SPL test will report mismatch as RED;
// Metaplex test skips on 402 (paid endpoint). Documented Phase 2B RED state.

const test = require('node:test');
const assert = require('node:assert/strict');

const SCAN_URL = process.env.SCAN_URL_BASE || 'http://localhost:3402';
const VALID_RISK_LEVELS = new Set(['safe', 'caution', 'danger', 'unknown']);

// Reference mints
const SPL_TOKEN_MINT      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC, SPL branch
const METAPLEX_AGENT_MINT = process.env.METAPLEX_AGENT_TEST_MINT
  || 'TbZxxFunCqgvLDejxnZi4LkmFnHJyrXBzMcArpcWmEr'; // Moltbook agent core asset (memory.md project_moltbook_identity)

test('SPL branch risk_level uses lowercase 3-tier + unknown', { timeout: 15_000 }, async () => {
  const res = await fetch(`${SCAN_URL}/scan/v1/${SPL_TOKEN_MINT}`);
  assert.ok(res.ok, `expected 2xx, got ${res.status}`);
  const j = await res.json();
  assert.ok(
    VALID_RISK_LEVELS.has(j.risk_level),
    `SPL risk_level not in valid set: ${JSON.stringify(j.risk_level)} (expected one of ${[...VALID_RISK_LEVELS].join(',')})`,
  );
});

test('Metaplex agent branch risk_level uses same enum domain', { timeout: 15_000 }, async () => {
  const res = await fetch(`${SCAN_URL}/api/v1/scan/agent-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mint: METAPLEX_AGENT_MINT }),
  });
  if (res.status === 402) {
    // Paid endpoint requires x402 signing. Skip without failing the gate.
    console.warn('SKIP: /api/v1/scan/agent-token returned 402 (paid; x402 signing not configured for qa-calibration caller)');
    return;
  }
  if (res.status === 404) {
    console.warn(`SKIP: metaplex agent mint ${METAPLEX_AGENT_MINT} not found (404)`);
    return;
  }
  assert.ok(res.ok, `expected 2xx, got ${res.status}`);
  const j = await res.json();
  // metaplex_agent response shape: { ..., risk_level } at top level
  assert.ok(
    VALID_RISK_LEVELS.has(j.risk_level),
    `Metaplex risk_level not in valid set: ${JSON.stringify(j.risk_level)}`,
  );
});

test('SPL response JSON contains no uppercase risk_level enum values', { timeout: 15_000 }, async () => {
  const res = await fetch(`${SCAN_URL}/scan/v1/${SPL_TOKEN_MINT}`);
  assert.ok(res.ok, `expected 2xx, got ${res.status}`);
  const text = await res.text();
  // Light guard against regression — asserts no uppercase enum slipped through
  // in the response body. Excludes attack-severity enum (`src/adversarial/runner.js`)
  // which is unrelated; that enum only surfaces from adversarial endpoints, not /scan/v1.
  for (const upper of ['"LOW"', '"MEDIUM"', '"HIGH"', '"CRITICAL"', '"UNKNOWN"']) {
    assert.equal(
      text.indexOf(upper), -1,
      `uppercase ${upper} found in /scan/v1 response (uppercase eradication regression)`,
    );
  }
});
