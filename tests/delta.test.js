'use strict';
// tests/delta.test.js — Unit tests for the delta diff engine
// Run with: node tests/delta.test.js

const assert = require('assert');

// ── Minimal inline reimplementation of diff logic for testing ──────────────────
// (We test the module directly; mock only the LLM call so tests are offline.)

// Patch OPENROUTER_API_KEY to empty before requiring diff so LLM is skipped.
process.env.OPENROUTER_API_KEY = '';

const { computeDelta } = require('../src/delta/diff');

// Helper to build a minimal snapshot object.
function makeSnap(data, opts = {}) {
  return {
    version:     1,
    address:     opts.address     || 'TestAddress1111111111111111111111111111111',
    scanType:    opts.scanType    || 'token-audit',
    timestamp:   opts.timestamp   || new Date().toISOString(),
    contentHash: opts.contentHash || 'deadbeef',
    data
  };
}

async function main() {
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ── Test suite ─────────────────────────────────────────────────────────────────

console.log('\ndelta.test.js\n');

// 1. Identical reports → empty diff
await test('identical reports produce zero changes', async () => {
  const data = {
    risk_score: 25,
    category:   'CAUTION',
    findings:   [{ category: 'mint', label: 'Mint authority active', severity: 'high' }],
    detail:     { mint_info: { mint_authority: 'SomeKey111', freeze_authority: null, supply: '1000000', decimals: 9 } }
  };
  const snap = makeSnap(data);
  const changes = await computeDelta(snap, snap);
  assert.strictEqual(changes.length, 0, `Expected 0 changes, got ${changes.length}: ${JSON.stringify(changes.map(c => c.field))}`);
});

// 2. Mint authority renounced → authority_changes category, severity info
await test('mint authority renounced → authority_changes info', async () => {
  const old = makeSnap({
    risk_score: 50,
    category:   'CAUTION',
    findings:   [],
    detail:     { mint_info: { mint_authority: 'SomeKey111', freeze_authority: null } }
  });
  const cur = makeSnap({
    risk_score: 50,
    category:   'CAUTION',
    findings:   [],
    detail:     { mint_info: { mint_authority: null, freeze_authority: null } }
  });
  const changes = await computeDelta(old, cur);
  const authChange = changes.find(c => c.category === 'authority_changes' && c.field === 'Mint Authority');
  assert.ok(authChange, 'Expected an authority_changes entry for Mint Authority');
  assert.strictEqual(authChange.severity, 'info', `Expected severity=info for renounced authority, got ${authChange.severity}`);
  assert.strictEqual(authChange.new_value, 'null');
});

// 3. Mint authority re-enabled (null → address) → critical
await test('mint authority re-enabled → authority_changes critical', async () => {
  const old = makeSnap({
    risk_score: 20,
    category:   'SAFE',
    findings:   [],
    detail:     { mint_info: { mint_authority: null } }
  });
  const cur = makeSnap({
    risk_score: 20,
    category:   'SAFE',
    findings:   [],
    detail:     { mint_info: { mint_authority: 'DangerousKey222' } }
  });
  const changes = await computeDelta(old, cur);
  const authChange = changes.find(c => c.category === 'authority_changes' && c.field === 'Mint Authority');
  assert.ok(authChange, 'Expected an authority_changes entry for Mint Authority');
  assert.strictEqual(authChange.severity, 'critical', `Expected severity=critical, got ${authChange.severity}`);
});

// 4. New finding added → new_instructions category
await test('new critical finding → new_instructions critical', async () => {
  const old = makeSnap({
    risk_score: 20,
    category:   'SAFE',
    findings:   []
  });
  const cur = makeSnap({
    risk_score: 55,
    category:   'CAUTION',
    findings:   [{ category: 'security', label: 'Reentrancy vulnerability detected', severity: 'critical' }]
  });
  const changes = await computeDelta(old, cur);
  const instr = changes.find(c => c.category === 'new_instructions');
  assert.ok(instr, 'Expected a new_instructions entry');
  assert.strictEqual(instr.severity, 'critical');
  assert.ok(instr.field.includes('Reentrancy'), `Field should mention finding label, got: ${instr.field}`);
});

// 5. Risk score increase → risk_score_change, appropriate severity
await test('large risk score increase → risk_score_change critical', async () => {
  const old = makeSnap({ risk_score: 10, category: 'SAFE',   findings: [] });
  const cur = makeSnap({ risk_score: 75, category: 'DANGER', findings: [] });
  const changes = await computeDelta(old, cur);
  const rsc = changes.find(c => c.category === 'risk_score_change');
  assert.ok(rsc, 'Expected risk_score_change');
  assert.strictEqual(rsc.severity, 'critical', `Expected critical for 65-point jump, got ${rsc.severity}`);
  assert.strictEqual(rsc.old_value, '10');
  assert.strictEqual(rsc.new_value, '75');
});

// 6. Small risk score change → risk_score_change info
await test('small risk score change → risk_score_change info', async () => {
  const old = makeSnap({ risk_score: 30, findings: [] });
  const cur = makeSnap({ risk_score: 33, findings: [] });
  const changes = await computeDelta(old, cur);
  const rsc = changes.find(c => c.category === 'risk_score_change');
  assert.ok(rsc, 'Expected risk_score_change');
  assert.strictEqual(rsc.severity, 'info');
});

// 7. Finding removed → removed_checks category
await test('finding removed → removed_checks entry', async () => {
  const old = makeSnap({
    risk_score: 40,
    findings:   [{ category: 'access', label: 'No access control on admin function', severity: 'high' }]
  });
  const cur = makeSnap({
    risk_score: 40,
    findings:   []
  });
  const changes = await computeDelta(old, cur);
  const removed = changes.find(c => c.category === 'removed_checks');
  assert.ok(removed, 'Expected a removed_checks entry');
  assert.ok(removed.field.includes('No access control'), `Field should mention removed finding, got: ${removed.field}`);
});

// 8. Token supply change → token_config_changes warning
await test('supply change → token_config_changes warning', async () => {
  const old = makeSnap({ findings: [], detail: { mint_info: { supply: '1000000000' } } });
  const cur = makeSnap({ findings: [], detail: { mint_info: { supply: '9999999999' } } });
  const changes = await computeDelta(old, cur);
  const tc = changes.find(c => c.category === 'token_config_changes' && c.field === 'Token Supply');
  assert.ok(tc, 'Expected token_config_changes for Token Supply');
  assert.strictEqual(tc.severity, 'warning');
});

// 9. No-change on null authority fields (both null) → no authority change emitted
await test('both authorities null → no authority change', async () => {
  const data = { findings: [], detail: { mint_info: { mint_authority: null, freeze_authority: null } } };
  const snap = makeSnap(data);
  const changes = await computeDelta(snap, snap);
  const authChanges = changes.filter(c => c.category === 'authority_changes');
  assert.strictEqual(authChanges.length, 0, `Expected 0 authority changes, got ${authChanges.length}`);
});

// 10. category field changes → generic_changes
await test('risk category change → generic_changes or risk_score_change', async () => {
  const old = makeSnap({ category: 'SAFE',   findings: [] });
  const cur = makeSnap({ category: 'DANGER', findings: [] });
  const changes = await computeDelta(old, cur);
  const cat = changes.find(c => c.field === 'Risk Category');
  assert.ok(cat, 'Expected a change for Risk Category');
  assert.ok(['generic_changes', 'risk_score_change'].includes(cat.category), `Unexpected category: ${cat.category}`);
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
} // end main

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
