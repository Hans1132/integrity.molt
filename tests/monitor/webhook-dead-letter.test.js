'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Stub sendAlert a evaluateTransaction
require.cache[require.resolve('../../src/monitor/notifications.js')] = {
  id: require.resolve('../../src/monitor/notifications.js'),
  loaded: true,
  exports: { sendAlert: async () => {} },
};
require.cache[require.resolve('../../src/monitor/alerts.js')] = {
  id: require.resolve('../../src/monitor/alerts.js'),
  loaded: true,
  exports: { evaluateTransaction: () => { throw new Error('simulated processing failure'); } },
};

// Stub db — vrátí jednu watchlist položku jejíž adresa je v fakeTx.accounts
const WATCHED_ADDR = 'WatchedAddr11111111111111111111111111111111111';
require.cache[require.resolve('../../db')] = {
  id: require.resolve('../../db'),
  loaded: true,
  exports: {
    getActiveWatchlist: async () => [{ address: WATCHED_ADDR }],
  },
};

// Nastav dočasný dead-letter soubor
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-test-'));
process.env.DEAD_LETTER_FILE = path.join(tmpDir, 'dead-letter.jsonl');

const { handleHeliusWebhook } = require('../../src/monitor/webhook-receiver');

test('handleHeliusWebhook zapisuje do dead-letter při processing failure', async () => {
  const fakeTx = { signature: 'testSig123', type: 'TEST', accounts: [WATCHED_ADDR], accountData: [{ account: WATCHED_ADDR }] };
  const mockReq = {
    body: [fakeTx],
    headers: { authorization: process.env.HELIUS_WEBHOOK_SECRET || 'test' },
    db: { prepare: () => ({ all: () => [] }) },
  };
  const mockRes = { status: () => ({ json: () => {} }) };

  // Zavolej handler (ACK se pošle okamžitě, zpracování proběhne async)
  await handleHeliusWebhook(mockReq, mockRes);

  // Počkej na async processing
  await new Promise(r => setTimeout(r, 100));

  const dlPath = process.env.DEAD_LETTER_FILE;
  assert.ok(fs.existsSync(dlPath), 'dead-letter soubor musí existovat po failure');
  const content = fs.readFileSync(dlPath, 'utf-8').trim();
  assert.ok(content.length > 0, 'dead-letter soubor nesmí být prázdný');
  const entry = JSON.parse(content.split('\n')[0]);
  assert.equal(entry.signature, 'testSig123');
  assert.ok(entry._deadLetterAt, '_deadLetterAt musí být nastaven');
  assert.ok(entry._error, '_error musí popisovat chybu');
});
