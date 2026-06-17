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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { asyncSign, SignPipelineError, _activeCountForTest } = require('../../src/crypto/sign');

// Writes a throwaway python "signer" stub and returns its path.
function writeStub(body) {
  const p = path.join(os.tmpdir(), `sign-stub-${process.pid}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(p, body);
  return p;
}

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

// Regression: a signer that exits 0 but prints invalid JSON used to release the
// semaphore twice (success branch released, then JSON.parse failure routed into
// fail() which released again), drifting the in-flight counter negative.
test('asyncSign releases the semaphore exactly once on invalid-JSON-but-exit-0', async () => {
  // Skip gracefully where python3 is unavailable (matches prod-pipeline assumption).
  const { spawnSync } = require('node:child_process');
  if (spawnSync('python3', ['--version']).status !== 0) return;

  const before = _activeCountForTest();
  const stub = writeStub('import sys\nsys.stdout.write("this is not json")\nsys.exit(0)\n');
  try {
    // A burst: each failure that double-released would drive _active negative by N.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(asyncSign('payload', stub), (e) => e instanceof SignPipelineError);
    }
  } finally {
    fs.unlinkSync(stub);
  }
  assert.equal(_activeCountForTest(), before,
    `semaphore in-flight count drifted: before=${before} after=${_activeCountForTest()}`);
});
