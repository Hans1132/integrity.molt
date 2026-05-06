'use strict';
// tests/security/watchlist-idor.test.js
// Regresní test pro CRITICAL-1: Watchlist IDOR
// Commit 1840ab5 — opraveno odstraněním `OR ? IS NULL` predikátu a přidáním auth guardu.
// Testuje db.js funkce přímo bez HTTP.
// Run: node tests/security/watchlist-idor.test.js

process.env.SQLITE_DB_PATH = ':memory:';
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';

const assert = require('assert');
const { db: rawDb, initSchema, addWatchlistEntry, removeWatchlistEntry,
        addUserWatchlistEntry, removeUserWatchlistEntry } = require('../../db');

let passed = 0, failed = 0;

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

async function run() {
  await initSchema();

  console.log('\nwatchlist-idor.test.js\n');

  // ── Telegram watchlist (removeWatchlistEntry) ─────────────────────────────

  await test('removeWatchlistEntry: valid owner + valid id → deactivates entry', async () => {
    const entry = await addWatchlistEntry({
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      label: 'USDC',
      notify_telegram_chat: 'chat_owner_A',
    });
    assert.ok(entry && entry.id, 'insert must succeed');
    const ok = await removeWatchlistEntry(entry.id, 'chat_owner_A');
    assert.strictEqual(ok, true, 'owner can delete own entry');
    const row = rawDb.prepare('SELECT active FROM watchlist WHERE id = ?').get(entry.id);
    assert.strictEqual(row.active, 0, 'entry must be deactivated');
  });

  await test('removeWatchlistEntry: null/empty owner → refuses to delete (IDOR guard)', async () => {
    const entry = await addWatchlistEntry({
      address: 'So11111111111111111111111111111111111111112',
      label: 'wSOL',
      notify_telegram_chat: 'chat_owner_B',
    });
    assert.ok(entry && entry.id);

    const resultNull  = await removeWatchlistEntry(entry.id, null);
    const resultEmpty = await removeWatchlistEntry(entry.id, '');
    assert.strictEqual(resultNull,  false, 'null owner must return false');
    assert.strictEqual(resultEmpty, false, 'empty string owner must return false');

    const row = rawDb.prepare('SELECT active FROM watchlist WHERE id = ?').get(entry.id);
    assert.strictEqual(row.active, 1, 'entry must remain active after rejected delete');
  });

  await test('removeWatchlistEntry: different owner cannot delete foreign entry', async () => {
    const entry = await addWatchlistEntry({
      address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      label: 'JUP',
      notify_telegram_chat: 'chat_owner_C',
    });
    assert.ok(entry && entry.id);

    const ok = await removeWatchlistEntry(entry.id, 'chat_attacker');
    assert.strictEqual(ok, false, 'attacker owner must not delete foreign entry');

    const row = rawDb.prepare('SELECT active FROM watchlist WHERE id = ?').get(entry.id);
    assert.strictEqual(row.active, 1, 'entry must remain active');
  });

  await test('removeWatchlistEntry: nonexistent id returns false (no crash)', async () => {
    const ok = await removeWatchlistEntry(999999, 'any_chat');
    assert.strictEqual(ok, false, 'nonexistent id must return false');
  });

  // ── Email watchlist (removeUserWatchlistEntry) ────────────────────────────

  await test('removeUserWatchlistEntry: valid email + valid id → deactivates entry', async () => {
    const entry = await addUserWatchlistEntry({
      email: 'alice@example.com',
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      label: 'BONK',
    });
    assert.ok(entry && entry.id);
    const ok = await removeUserWatchlistEntry({ email: 'alice@example.com', id: entry.id });
    assert.strictEqual(ok, true, 'owner email can delete own entry');
    const row = rawDb.prepare('SELECT active FROM watchlist WHERE id = ?').get(entry.id);
    assert.strictEqual(row.active, 0, 'entry must be deactivated');
  });

  await test('removeUserWatchlistEntry: different email cannot delete foreign entry', async () => {
    const entry = await addUserWatchlistEntry({
      email: 'bob@example.com',
      address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
      label: 'RAY',
    });
    assert.ok(entry && entry.id);

    const ok = await removeUserWatchlistEntry({ email: 'attacker@evil.com', id: entry.id });
    assert.strictEqual(ok, false, 'different email must not delete foreign entry');

    const row = rawDb.prepare('SELECT active FROM watchlist WHERE id = ?').get(entry.id);
    assert.strictEqual(row.active, 1, 'entry must remain active');
  });

  // ── Výsledek ───────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
