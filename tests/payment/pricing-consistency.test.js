'use strict';
/**
 * tests/payment/pricing-consistency.test.js
 *
 * Regression tests covering three known audit bugs:
 *   1. SOL/USDC unit mixing (lamports vs micro-units)
 *   2. /api/v1/stats endpoint returning no data (getLiveStats regression)
 *   3. Pricing inconsistency across config/pricing.js, endpoint-spec.js, x402 discovery
 *
 * Also tests the anti-replay DB layer (same tx_sig cannot be used twice).
 *
 * Run: node tests/payment/pricing-consistency.test.js
 */

process.env.SQLITE_DB_PATH = ':memory:';
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';

const assert = require('assert');
const { db: rawDb, initSchema, getLiveStats } = require('../../db');
const { PRICING, PRICING_DISPLAY }            = require('../../config/pricing');
const { ENDPOINT_SPEC }                        = require('../../src/docs/endpoint-spec');
const { generateX402Discovery }                = require('../../src/docs/generate-x402-discovery');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

const FAKE_ATA = 'FakeATAaddr111111111111111111111111111111111';

async function run() {
  await initSchema();

  console.log('\n── Pricing Consistency & Regression Tests ────────────────────────────────────\n');

  // ── SOL / USDC unit guard ─────────────────────────────────────────────────────

  await test('PRICING: all values are positive integers (micro-USDC, not lamports)', async () => {
    for (const [key, value] of Object.entries(PRICING)) {
      assert.ok(Number.isInteger(value) && value > 0, `PRICING.${key} should be a positive integer, got ${value}`);
      // SOL lamport amounts for even 0.50 SOL would be 500_000_000 — far above any USDC price
      assert.ok(value < 1_000_000_000, `PRICING.${key}=${value} looks like SOL lamports, not USDC micro-units`);
    }
  });

  await test('PRICING.quick === 500_000 (0.50 USDC, not 0.50 SOL = 500_000_000 lamports)', async () => {
    assert.strictEqual(PRICING.quick, 500_000);
    assert.ok(PRICING.quick < 1_000_000_000, 'quick price must not be in SOL lamports');
  });

  await test('PRICING.deep === 5_000_000 (5.00 USDC, not 5 SOL = 5_000_000_000 lamports)', async () => {
    assert.strictEqual(PRICING.deep, 5_000_000);
    assert.ok(PRICING.deep < 1_000_000_000, 'deep price must not be in SOL lamports');
  });

  await test('PRICING.adversarial === 4_000_000 (4.00 USDC, under AutoPilot 5 USDC cap)', async () => {
    assert.strictEqual(PRICING.adversarial, 4_000_000);
    // AutoPilot per-tx limit is 5 USDC = 5_000_000 micro-USDC
    assert.ok(PRICING.adversarial < 5_000_000, 'adversarial price must be below AutoPilot 5 USDC limit');
  });

  // ── PRICING_DISPLAY derivation ────────────────────────────────────────────────

  await test('PRICING_DISPLAY is derived from PRICING (no manual sync drift)', async () => {
    for (const [key, micro] of Object.entries(PRICING)) {
      const expected = `${(micro / 1_000_000).toFixed(2)} USDC`;
      assert.strictEqual(PRICING_DISPLAY[key], expected,
        `PRICING_DISPLAY.${key} drift: expected "${expected}", got "${PRICING_DISPLAY[key]}"`);
    }
  });

  await test('PRICING_DISPLAY has same keys as PRICING', async () => {
    const pricingKeys = Object.keys(PRICING).sort();
    const displayKeys = Object.keys(PRICING_DISPLAY).sort();
    assert.deepStrictEqual(displayKeys, pricingKeys);
  });

  // ── Endpoint spec / x402 consistency ─────────────────────────────────────────

  await test('ENDPOINT_SPEC: every non-null pricingKey exists in PRICING', async () => {
    for (const spec of ENDPOINT_SPEC) {
      if (!spec.pricingKey) continue; // null = free endpoint, no pricing entry required
      assert.ok(PRICING[spec.pricingKey] !== undefined,
        `ENDPOINT_SPEC entry "${spec.path}" has pricingKey "${spec.pricingKey}" not found in PRICING`);
    }
  });

  await test('generateX402Discovery: returns object with services array', async () => {
    const doc = generateX402Discovery(FAKE_ATA);
    assert.ok(doc.x402 === true, 'should have x402: true');
    assert.ok(Array.isArray(doc.services), 'should have services array');
    assert.ok(doc.services.length > 0, 'services array should not be empty');
  });

  await test('generateX402Discovery: every service micro_usdc matches PRICING via ENDPOINT_SPEC', async () => {
    const doc = generateX402Discovery(FAKE_ATA);
    for (const service of doc.services) {
      const spec = ENDPOINT_SPEC.find(s => {
        const displayPath = `/api/v1${s.path.replace(/\{(\w+)\}/g, ':$1')}`.replace('/api/v1/api/', '/api/');
        return displayPath === service.path;
      });
      if (!spec) continue; // skip if path transform doesn't match exactly
      const expectedMicro = PRICING[spec.pricingKey];
      assert.strictEqual(service.micro_usdc, expectedMicro,
        `service ${service.path}: micro_usdc ${service.micro_usdc} !== PRICING.${spec.pricingKey} ${expectedMicro}`);
    }
  });

  await test('generateX402Discovery: no paid service (non-null pricingKey) has micro_usdc of 0', async () => {
    const doc = generateX402Discovery(FAKE_ATA);
    const paidSpecs = ENDPOINT_SPEC.filter(s => s.pricingKey != null);
    for (const service of doc.services) {
      const spec = paidSpecs.find(s => {
        const displayPath = `/api/v1${s.path.replace(/\{(\w+)\}/g, ':$1')}`.replace('/api/v1/api/', '/api/');
        return displayPath === service.path;
      });
      if (!spec) continue; // free endpoint — skip
      assert.ok(service.micro_usdc > 0,
        `paid service ${service.path} has micro_usdc=0 — must have a positive price`);
    }
  });

  await test('generateX402Discovery: payTo is set to the provided ATA address', async () => {
    const doc = generateX402Discovery(FAKE_ATA);
    for (const service of doc.services) {
      assert.strictEqual(service.payTo, FAKE_ATA,
        `service ${service.path} payTo should be the provided ATA`);
    }
  });

  await test('generateX402Discovery: throws when usdcAta is missing', async () => {
    let threw = false;
    try { generateX402Discovery(null); } catch { threw = true; }
    assert.ok(threw, 'generateX402Discovery should throw when usdcAta is null');
  });

  // ── getLiveStats regression (known bug: stats endpoint returned no data) ──────

  await test('getLiveStats on empty DB returns zero counts without throwing', async () => {
    const stats = await getLiveStats();
    assert.strictEqual(typeof stats, 'object', 'getLiveStats should return an object');
    assert.strictEqual(stats.total_scans, 0, `expected total_scans=0, got ${stats.total_scans}`);
    assert.strictEqual(stats.scans_today, 0, `expected scans_today=0, got ${stats.scans_today}`);
    assert.strictEqual(stats.success_rate_pct, 0, `expected success_rate_pct=0, got ${stats.success_rate_pct}`);
    assert.ok('total_payments' in stats, 'stats should have total_payments key');
  });

  await test('getLiveStats: total_scans increments after inserting a scan_history row', async () => {
    rawDb.prepare(`
      INSERT INTO scan_history (address, scan_type, risk_score, created_at)
      VALUES ('TestAddr111', 'quick', 25, datetime('now'))
    `).run();
    const stats = await getLiveStats();
    assert.ok(stats.total_scans >= 1, `expected total_scans >= 1, got ${stats.total_scans}`);
  });

  // ── Anti-replay regression (SOL/USDC sig cannot be re-used) ──────────────────

  await test('anti-replay: same tx_sig cannot be marked used twice (second returns false)', async () => {
    const sig = `test_sig_pricing_${Date.now()}_abc`.padEnd(88, '0');
    // Column is "sig", not "tx_sig" — using INSERT OR IGNORE (same as db.markSignatureUsed)
    const markUsed = rawDb.prepare(`INSERT OR IGNORE INTO used_signatures (sig) VALUES (?)`);
    const r1 = markUsed.run(sig);
    const r2 = markUsed.run(sig);
    assert.strictEqual(r1.changes, 1, 'first insert should succeed (changes=1)');
    assert.strictEqual(r2.changes, 0, 'second insert should be a no-op (changes=0) — replay blocked');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
