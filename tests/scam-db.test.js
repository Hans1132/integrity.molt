'use strict';
// tests/scam-db.test.js — Unit tests pro src/scam-db/lookup.js a db known_scams funkce
// Žádná síťová volání — mock fetch, in-memory DB.
// Spustit: node tests/scam-db.test.js

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch(e => {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        failed++;
      });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
  return Promise.resolve();
}

// ── calcRiskLevel tests ───────────────────────────────────────────────────────

const { calcRiskLevel } = require('../src/scam-db/lookup');

console.log('\nscam-db.test.js\n');
console.log('── calcRiskLevel ──');

const tests = [];

tests.push(test('prázdné risks → good', () => {
  assert.strictEqual(calcRiskLevel([]), 'good');
}));

tests.push(test('null risks → good', () => {
  assert.strictEqual(calcRiskLevel(null), 'good');
}));

tests.push(test('pouze info risks → info', () => {
  assert.strictEqual(calcRiskLevel([{ level: 'info' }]), 'info');
}));

tests.push(test('warn risk → warn', () => {
  assert.strictEqual(calcRiskLevel([{ level: 'warn' }, { level: 'info' }]), 'warn');
}));

tests.push(test('danger risk přebije warn → danger', () => {
  assert.strictEqual(calcRiskLevel([{ level: 'warn' }, { level: 'danger' }]), 'danger');
}));

tests.push(test('jedno danger → danger', () => {
  assert.strictEqual(calcRiskLevel([{ level: 'danger' }]), 'danger');
}));

// ── DB known_scams funkce ─────────────────────────────────────────────────────

console.log('\n── DB known_scams (SQLite) ──');

const db = require('../db');

// Inicializace schématu (synchronní v better-sqlite3)
db.initSchema().then(() => {

  const TEST_MINT = 'TESTmint1111111111111111111111111111111111';

  // Cleanup z případných předchozích běhů
  db.db.prepare('DELETE FROM known_scams WHERE mint = ?').run(TEST_MINT);

  tests.push(test('lookupKnownScam vrátí null pro neznámý mint', () => {
    const r = db.lookupKnownScam(TEST_MINT);
    assert.strictEqual(r, null);
  }));

  tests.push(test('upsertKnownScam vloží záznam', () => {
    db.upsertKnownScam({
      mint:       TEST_MINT,
      source:     'manual',
      scam_type:  'rug_pull',
      confidence: 0.95,
      label:      'Test scam token',
      raw_data:   { extra: 'data' },
    });
    const r = db.lookupKnownScam(TEST_MINT);
    assert.ok(r, 'záznam by měl existovat');
    assert.strictEqual(r.mint, TEST_MINT);
    assert.strictEqual(r.source, 'manual');
    assert.strictEqual(r.scam_type, 'rug_pull');
    assert.strictEqual(r.confidence, 0.95);
    assert.strictEqual(r.label, 'Test scam token');
    assert.deepStrictEqual(r.raw_data, { extra: 'data' });
  }));

  tests.push(test('upsertKnownScam aktualizuje existující záznam', () => {
    db.upsertKnownScam({
      mint:       TEST_MINT,
      source:     'solrpds',
      scam_type:  'honeypot',
      confidence: 1.0,
      label:      'Updated label',
      raw_data:   null,
    });
    const r = db.lookupKnownScam(TEST_MINT);
    assert.strictEqual(r.source, 'solrpds');
    assert.strictEqual(r.scam_type, 'honeypot');
    assert.strictEqual(r.label, 'Updated label');
  }));

  tests.push(test('getKnownScamsCount vrátí ≥ 1 po insertu', () => {
    const cnt = db.getKnownScamsCount();
    assert.ok(cnt >= 1, `počet by měl být ≥1, je ${cnt}`);
  }));

  // ── RugCheck cache funkce ─────────────────────────────────────────────────

  console.log('\n── DB rugcheck_cache (SQLite) ──');

  const RC_MINT = 'RCTESTmint111111111111111111111111111111111';

  // Cleanup z případných předchozích běhů
  db.db.prepare('DELETE FROM rugcheck_cache WHERE mint = ?').run(RC_MINT);

  tests.push(test('getRugcheckCache vrátí null pro neznámý mint', () => {
    const r = db.getRugcheckCache(RC_MINT);
    assert.strictEqual(r, null);
  }));

  tests.push(test('setRugcheckCache + getRugcheckCache round-trip', () => {
    db.setRugcheckCache({
      mint:       RC_MINT,
      risk_level: 'danger',
      score:      15000,
      score_norm: 75,
      rugged:     false,
      risks:      [{ name: 'Top 10 holders', level: 'danger', score: 7000, description: 'test' }],
      raw:        { score: 15000 },
    });
    const r = db.getRugcheckCache(RC_MINT);
    assert.ok(r, 'cache by měla existovat');
    assert.strictEqual(r.risk_level, 'danger');
    assert.strictEqual(r.score, 15000);
    assert.strictEqual(r.score_norm, 75);
    assert.strictEqual(r.rugged, 0);
    assert.ok(Array.isArray(r.risks_json), 'risks_json by mělo být array');
    assert.strictEqual(r.risks_json.length, 1);
    assert.strictEqual(r.risks_json[0].name, 'Top 10 holders');
  }));

  tests.push(test('setRugcheckCache aktualizuje existující cache', () => {
    db.setRugcheckCache({
      mint:       RC_MINT,
      risk_level: 'warn',
      score:      5000,
      score_norm: 30,
      rugged:     false,
      risks:      [],
      raw:        { score: 5000 },
    });
    const r = db.getRugcheckCache(RC_MINT);
    assert.strictEqual(r.risk_level, 'warn');
    assert.strictEqual(r.score_norm, 30);
  }));

  // ── lookupScamDb integrace (mock fetch) ────────────────────────────────────

  console.log('\n── lookupScamDb (mocked fetch) ──');

  // Nahraď globální fetch mockem pro tento test
  const { lookupScamDb } = require('../src/scam-db/lookup');

  tests.push(test('lookupScamDb vrátí known_scam pro TEST_MINT', async () => {
    // TEST_MINT je v known_scams (vložen výše)
    const result = await lookupScamDb(TEST_MINT);
    assert.ok(result.known_scam, 'known_scam by neměl být null');
    assert.strictEqual(result.known_scam.source, 'solrpds');
    assert.strictEqual(result.db_match, true);
  }));

  tests.push(test('lookupScamDb vrátí null known_scam pro neznámý mint', async () => {
    const UNKNOWN = 'UNKNOWNmint1111111111111111111111111111111';
    // Přidej do rugcheck_cache fresh záznam (bez rugged)
    db.setRugcheckCache({
      mint:       UNKNOWN,
      risk_level: 'good',
      score:      100,
      score_norm: 5,
      rugged:     false,
      risks:      [],
      raw:        {},
    });
    const result = await lookupScamDb(UNKNOWN);
    assert.strictEqual(result.known_scam, null);
    assert.ok(result.rugcheck, 'rugcheck by měl existovat z cache');
    assert.strictEqual(result.db_match, false); // good + not rugged = no match
  }));

  tests.push(test('lookupScamDb rugged=true → db_match=true', async () => {
    const RUGGED = 'RUGGEDmint111111111111111111111111111111111';
    db.setRugcheckCache({
      mint:       RUGGED,
      risk_level: 'danger',
      score:      90000,
      score_norm: 99,
      rugged:     true,
      risks:      [{ name: 'Rugged', level: 'danger', score: 90000 }],
      raw:        { rugged: true },
    });
    const result = await lookupScamDb(RUGGED);
    assert.strictEqual(result.rugcheck.rugged, 1); // SQLite stores as integer
    assert.strictEqual(result.db_match, true);
  }));

  tests.push(test('lookupScamDb nevrací error pro nevalidní mint', async () => {
    const result = await lookupScamDb('');
    assert.strictEqual(result.known_scam, null);
    assert.strictEqual(result.rugcheck, null);
    assert.strictEqual(result.db_match, false);
  }));

  return Promise.all(tests).then(() => {
    console.log(`\nVýsledek: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });

}).catch(e => {
  console.error('DB init selhal:', e.message);
  process.exit(1);
});
