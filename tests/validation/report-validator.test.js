'use strict';
/**
 * tests/validation/report-validator.test.js
 *
 * Unit tests for src/validation/report-validator.js
 * Covers: validateReport, applyCorrectionsToAuditResult, formatValidationStatus
 *
 * Pure function tests — no DB, no network, no env vars required.
 *
 * Run: node tests/validation/report-validator.test.js
 */

const assert = require('assert');
const {
  validateReport,
  applyCorrectionsToAuditResult,
  formatValidationStatus,
} = require('../../src/validation/report-validator');

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

function makeReport(overrides = {}) {
  return {
    mint_address: 'TestMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    risk_score:   25,
    category:     'SAFE',
    summary:      'Token appears safe.',
    findings:     [],
    db_matches:   [],
    ...overrides,
  };
}

function makeRaw(overrides = {}) {
  return {
    mint_address:  'TestMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    mint_info:     { mint_authority: null, freeze_authority: null, is_token_2022: false },
    extensions:    [],
    concentration: { top1_pct: 10, top3_pct: 20, top10_pct: 40 },
    top_holders:   [],
    ...overrides,
  };
}

async function run() {
  console.log('\n── Report Validator Tests ─────────────────────────────────────────────────────\n');

  await test('null llmReport returns valid:false with input_guard issue', async () => {
    const result = validateReport(null, {});
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.length > 0);
    assert.strictEqual(result.issues[0].check, 'input_guard');
  });

  await test('non-object llmReport returns valid:false with input_guard issue', async () => {
    const result = validateReport('not-an-object', {});
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.issues[0].check, 'input_guard');
  });

  await test('valid report with correct score and category passes all checks', async () => {
    const report = makeReport({ risk_score: 25, category: 'SAFE' });
    const raw    = makeRaw();
    const result = validateReport(report, raw);
    assert.strictEqual(result.valid, true, `expected valid, issues: ${JSON.stringify(result.issues)}`);
    assert.strictEqual(result.issues.length, 0);
  });

  await test('risk_score 101 is clamped to 100 with score_bounds issue', async () => {
    const report = makeReport({ risk_score: 101, category: 'DANGER' });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'score_bounds');
    assert.ok(issue, 'should have score_bounds issue');
    assert.strictEqual(issue.corrected_value, 100);
  });

  await test('risk_score -5 is clamped to 0', async () => {
    const report = makeReport({ risk_score: -5, category: 'SAFE' });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'score_bounds');
    assert.ok(issue, 'should have score_bounds issue');
    assert.strictEqual(issue.corrected_value, 0);
  });

  await test('score 50 with category SAFE: score_level_consistency issue corrects to CAUTION', async () => {
    const report = makeReport({ risk_score: 50, category: 'SAFE' });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'score_level_consistency');
    assert.ok(issue, 'should have score_level_consistency issue');
    assert.strictEqual(issue.corrected_field, 'category');
    assert.strictEqual(issue.corrected_value, 'CAUTION');
  });

  await test('score 70 with category SAFE: score_level_consistency corrects to DANGER', async () => {
    const report = makeReport({ risk_score: 70, category: 'SAFE' });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'score_level_consistency');
    assert.ok(issue, 'should have score_level_consistency issue');
    assert.strictEqual(issue.corrected_value, 'DANGER');
  });

  await test('active mint authority with score 20: corrected to minimum 40', async () => {
    const report = makeReport({
      risk_score: 20,
      category:   'SAFE',
      findings:   [{ category: 'mint-authority', label: 'Mint authority active', severity: 'high' }],
    });
    const raw = makeRaw({ mint_info: { mint_authority: 'ActiveMintKeyXXXXXXXXXXXXXXXXXXXXXXXXX', freeze_authority: null } });
    const result = validateReport(report, raw);
    const issue  = result.issues.find(i => i.check === 'mint_authority_consistency' && i.corrected_field === 'risk_score');
    assert.ok(issue, 'should have mint_authority_consistency correction');
    assert.strictEqual(issue.corrected_value, 40);
  });

  await test('active mint authority with no mint finding: escalate issue added', async () => {
    const report = makeReport({ risk_score: 45, category: 'CAUTION', findings: [] });
    const raw = makeRaw({ mint_info: { mint_authority: 'ActiveMintKeyXXXXXXXXXXXXXXXXXXXXXXXXX', freeze_authority: null } });
    const result = validateReport(report, raw);
    const escalation = result.issues.find(i => i.check === 'mint_authority_consistency' && i.action === 'escalate');
    assert.ok(escalation, 'should escalate when mint authority not mentioned in findings');
  });

  await test('known_scam db match with score 30: corrected to minimum 66', async () => {
    const report = makeReport({
      risk_score: 30,
      category:   'SAFE',
      db_matches: [{ source: 'known_scam', type: 'rug_pull' }],
    });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'scam_db_match_score');
    assert.ok(issue, 'should have scam_db_match_score issue');
    assert.strictEqual(issue.corrected_value, 66);
  });

  await test('rugcheck rugged db match with score 30: corrected to 66', async () => {
    const report = makeReport({
      risk_score: 30,
      category:   'SAFE',
      db_matches: [{ source: 'rugcheck', type: 'rugged' }],
    });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'scam_db_match_score');
    assert.ok(issue, 'should have scam_db_match_score issue for rugged type');
    assert.strictEqual(issue.corrected_value, 66);
  });

  await test('top1_pct > 80 with low score: holder_count_sanity floors to 50', async () => {
    const report = makeReport({ risk_score: 30, category: 'SAFE' });
    const raw    = makeRaw({ concentration: { top1_pct: 85, top3_pct: 90, top10_pct: 95 } });
    const result = validateReport(report, raw);
    const issue  = result.issues.find(i => i.check === 'holder_count_sanity');
    assert.ok(issue, 'should have holder_count_sanity issue');
    assert.strictEqual(issue.corrected_value, 50);
  });

  await test('EVM address in report body triggers fabricated_addresses escalation', async () => {
    const report = makeReport({
      summary: 'Contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 is safe.',
    });
    const result = validateReport(report, makeRaw());
    const issue  = result.issues.find(i => i.check === 'fabricated_addresses');
    assert.ok(issue, 'should detect EVM address in Solana report');
    assert.strictEqual(issue.action, 'escalate');
  });

  await test('mint_address mismatch triggers fabricated_addresses escalation', async () => {
    const report = makeReport({ mint_address: 'ReportMintAddressXXXXXXXXXXXXXXXXXXXXX' });
    const raw    = makeRaw({ mint_address: 'DifferentMintAddrXXXXXXXXXXXXXXXXXXXXX' });
    const result = validateReport(report, raw);
    const issue  = result.issues.find(i => i.check === 'fabricated_addresses');
    assert.ok(issue, 'should detect mint_address mismatch');
  });

  await test('applyCorrections: highest score correction wins (worst-case)', async () => {
    const auditResult = { risk_score: 20, category: 'SAFE' };
    const issues = [
      { action: 'correct', check: 'mint_authority_consistency', corrected_field: 'risk_score', corrected_value: 40 },
      { action: 'correct', check: 'scam_db_match_score',        corrected_field: 'risk_score', corrected_value: 66 },
    ];
    applyCorrectionsToAuditResult(auditResult, issues);
    assert.strictEqual(auditResult.risk_score, 66, 'highest correction should win');
    assert.strictEqual(auditResult.category, 'DANGER', 'category should be re-synced to DANGER for score 66');
  });

  await test('applyCorrections: re-syncs category after score correction', async () => {
    const auditResult = { risk_score: 20, category: 'SAFE' };
    const issues = [
      { action: 'correct', check: 'holder_count_sanity', corrected_field: 'risk_score', corrected_value: 50 },
    ];
    applyCorrectionsToAuditResult(auditResult, issues);
    assert.strictEqual(auditResult.risk_score, 50);
    assert.strictEqual(auditResult.category, 'CAUTION');
  });

  await test('applyCorrections: escalate issues are skipped (not applied)', async () => {
    const auditResult = { risk_score: 45, category: 'CAUTION' };
    const issues = [
      { action: 'escalate', check: 'fabricated_addresses' },
    ];
    const count = applyCorrectionsToAuditResult(auditResult, issues);
    assert.strictEqual(count, 0, 'escalate issues should not be counted as corrections');
    assert.strictEqual(auditResult.risk_score, 45, 'score should not change for escalate-only issues');
  });

  await test('formatValidationStatus: valid result returns "✅ Verified"', async () => {
    const status = formatValidationStatus({ valid: true, issues: [] }, 0);
    assert.strictEqual(status, '✅ Verified');
  });

  await test('formatValidationStatus: corrections applied returns auto-corrected string', async () => {
    const result = { valid: false, issues: [{ action: 'correct', check: 'score_bounds' }] };
    const status = formatValidationStatus(result, 1);
    assert.ok(status.includes('Auto-corrected'), `expected auto-corrected, got "${status}"`);
    assert.ok(status.includes('1 fix'), `expected "1 fix", got "${status}"`);
  });

  await test('formatValidationStatus: escalation present returns manual review message', async () => {
    const result = { valid: false, issues: [{ action: 'escalate', check: 'fabricated_addresses' }] };
    const status = formatValidationStatus(result, 0);
    assert.ok(status.includes('manual review'), `expected "manual review", got "${status}"`);
  });

  await test('formatValidationStatus: null input returns empty string', async () => {
    assert.strictEqual(formatValidationStatus(null, 0), '');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
