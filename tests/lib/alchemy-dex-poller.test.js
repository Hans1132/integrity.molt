'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { extractSwapEvents, filterNewSignatures } = require('../../lib/alchemy-dex-poller');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); fail++; }
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'alchemy-raydium-swap.json'), 'utf8'
)).result;

(async () => {
  await test('extractSwapEvents — reálná swap tx vrací >=1 SWAP event', () => {
    const events = extractSwapEvents(fixture);
    assert.ok(events.length >= 1, `expected >=1 event, got ${events.length}`);
    for (const ev of events) {
      assert.strictEqual(ev.eventType, 'SWAP');
      assert.ok(ev.mint && ev.mint.length >= 32, 'mint je base58 adresa');
      assert.ok(ev.poolAddress, 'poolAddress nesmí být prázdná');
      assert.strictEqual(ev.timestamp, fixture.blockTime * 1000, 'timestamp = blockTime v ms');
      assert.strictEqual(ev.txHash, fixture.transaction.signatures[0]);
    }
  });

  await test('extractSwapEvents — max 1 event per mint (dedup)', () => {
    const events = extractSwapEvents(fixture);
    const mints = events.map(e => e.mint);
    assert.strictEqual(new Set(mints).size, mints.length, 'duplicitní mint v events');
  });

  await test('extractSwapEvents — failed tx (meta.err) vrací []', () => {
    const failed = JSON.parse(JSON.stringify(fixture));
    failed.meta.err = { InstructionError: [0, 'Custom'] };
    assert.deepStrictEqual(extractSwapEvents(failed), []);
  });

  await test('extractSwapEvents — null/prázdný input vrací []', () => {
    assert.deepStrictEqual(extractSwapEvents(null), []);
    assert.deepStrictEqual(extractSwapEvents({}), []);
    assert.deepStrictEqual(extractSwapEvents({ meta: { err: null }, blockTime: 1 }), []);
  });

  await test('extractSwapEvents — nulová delta mint se neemituje', () => {
    const noop = JSON.parse(JSON.stringify(fixture));
    // post == pre → žádné delty
    noop.meta.preTokenBalances = noop.meta.postTokenBalances;
    assert.deepStrictEqual(extractSwapEvents(noop), []);
  });

  await test('filterNewSignatures — skipuje err txs a zachová pořadí', () => {
    const sigs = [
      { signature: 'sigA', err: null },
      { signature: 'sigB', err: { InstructionError: [2, {}] } },
      { signature: 'sigC', err: null },
    ];
    assert.deepStrictEqual(filterNewSignatures(sigs), ['sigA', 'sigC']);
  });

  await test('filterNewSignatures — prázdný/nevalidní input vrací []', () => {
    assert.deepStrictEqual(filterNewSignatures([]), []);
    assert.deepStrictEqual(filterNewSignatures(null), []);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
