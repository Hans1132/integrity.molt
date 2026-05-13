'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Stub sendAlert BEFORE requiring sign.js
const alertCalls = [];
require.cache[require.resolve('../../src/monitor/notifications.js')] = {
  id: require.resolve('../../src/monitor/notifications.js'),
  filename: require.resolve('../../src/monitor/notifications.js'),
  loaded: true,
  exports: {
    sendAlert: async (alert, channels) => { alertCalls.push({ alert, channels }); },
  },
};

const { asyncSign, SignPipelineError } = require('../../src/crypto/sign');

test('asyncSign rejects with SignPipelineError on ENOENT', async () => {
  // sign-report.py does not exist at a fake path — override SIGN_SCRIPT via env
  // We test the error type only; spawn failure triggers ENOENT
  try {
    await asyncSign('test payload', '/nonexistent/sign-report.py');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof SignPipelineError, `expected SignPipelineError, got ${e.constructor.name}`);
    assert.match(e.message, /ENOENT|spawn|No such file|nonexistent/i);
  }
});

test('SignPipelineError is exported', () => {
  assert.ok(SignPipelineError, 'SignPipelineError must be exported');
  const e = new SignPipelineError('test');
  assert.equal(e.name, 'SignPipelineError');
  assert.ok(e instanceof Error);
});
