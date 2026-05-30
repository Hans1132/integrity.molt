'use strict';
/**
 * tests/monitor/webhook-auth.test.js
 *
 * Unit tests for verifyWebhookAuth in src/monitor/webhook-receiver.js.
 * The Helius webhook ingests on-chain events that drive customer alerts, so the
 * auth gate is security-critical and previously untested.
 *
 * WEBHOOK_SECRET is captured at module load, so each case reloads the module
 * with a fresh env. Run: node tests/monitor/webhook-auth.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const RECEIVER = require.resolve('../../src/monitor/webhook-receiver');

function loadFresh(secret) {
  delete require.cache[RECEIVER];
  if (secret === undefined) delete process.env.HELIUS_WEBHOOK_SECRET;
  else process.env.HELIUS_WEBHOOK_SECRET = secret;
  return require(RECEIVER);
}

function mockReq(authHeader) {
  const headers = {};
  if (authHeader !== undefined) headers['authorization'] = authHeader;
  return { headers };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('no secret configured → 503, request rejected, next NOT called', () => {
  const { verifyWebhookAuth } = loadFresh(undefined);
  const res = mockRes();
  let nexted = false;
  verifyWebhookAuth(mockReq('anything'), res, () => { nexted = true; });
  assert.equal(res.statusCode, 503);
  assert.equal(nexted, false);
  assert.match(res.body.error, /not configured/i);
});

test('matching Authorization header → next() called, no error response', () => {
  const { verifyWebhookAuth } = loadFresh('s3cr3t-token');
  const res = mockRes();
  let nexted = false;
  verifyWebhookAuth(mockReq('s3cr3t-token'), res, () => { nexted = true; });
  assert.equal(nexted, true, 'next must be called on valid secret');
  assert.equal(res.statusCode, null, 'no status should be set on success');
});

test('wrong Authorization header → 200 {ok:false, unauthorized}, next NOT called', () => {
  const { verifyWebhookAuth } = loadFresh('s3cr3t-token');
  const res = mockRes();
  let nexted = false;
  verifyWebhookAuth(mockReq('wrong-token'), res, () => { nexted = true; });
  assert.equal(nexted, false);
  // 200 (not 401) is intentional: stops Helius from retrying bad requests.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'unauthorized');
});

test('missing Authorization header → rejected (empty-string mismatch)', () => {
  const { verifyWebhookAuth } = loadFresh('s3cr3t-token');
  const res = mockRes();
  let nexted = false;
  verifyWebhookAuth(mockReq(undefined), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
});

test('a "Bearer "-prefixed token does NOT match the raw secret', () => {
  // Helius sends the secret as a plain string, not "Bearer <secret>".
  const { verifyWebhookAuth } = loadFresh('s3cr3t-token');
  const res = mockRes();
  let nexted = false;
  verifyWebhookAuth(mockReq('Bearer s3cr3t-token'), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 200);
});
