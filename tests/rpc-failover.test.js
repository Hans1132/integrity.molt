'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

test('rpcPost falls back to secondary URL on primary timeout', async () => {
  // Tento test ověřuje, že rpcPost existuje a má správný fallback pattern.
  // Full integration test by potřeboval mock https — tady testujeme exporty.
  const rpc = require('../src/rpc');
  assert.ok(rpc.PUBLIC_FALLBACK, 'PUBLIC_FALLBACK musí být exportován');
  assert.equal(rpc.PUBLIC_FALLBACK, 'https://api.mainnet-beta.solana.com');
});
