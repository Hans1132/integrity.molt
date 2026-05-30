'use strict';
/**
 * tests/crypto/sign-timeout.test.js
 *
 * Complements sign-spof.test.js (which covers ENOENT). Covers the rest of the
 * asyncSign() failure surface and — critically — that the concurrency semaphore
 * is released on EVERY exit path (success, non-zero exit, bad JSON), so a burst
 * of failures cannot wedge the signing pool (the report-signing SPOF).
 *
 * Uses real python3 stub scripts (python3 is required by the prod pipeline and
 * by test-gate.sh). Run: node tests/crypto/sign-timeout.test.js
 */

process.env.NODE_ENV = 'test'; // suppress Telegram alerts in _recordFailure

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { asyncSign, SignPipelineError } = require('../../src/crypto/sign');

let dir, OK, FAIL, BADJSON;
let hasPython = true;

before(() => {
  try { execSync('python3 --version', { stdio: 'ignore' }); }
  catch { hasPython = false; return; }

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-test-'));
  OK = path.join(dir, 'ok.py');
  FAIL = path.join(dir, 'fail.py');
  BADJSON = path.join(dir, 'badjson.py');

  fs.writeFileSync(OK,
    'import sys, json\n' +
    'data = sys.stdin.read()\n' +
    'print(json.dumps({"sig": "ok", "len": len(data)}))\n');
  fs.writeFileSync(FAIL,
    'import sys\n' +
    'sys.stderr.write("simulated signer failure")\n' +
    'sys.exit(2)\n');
  fs.writeFileSync(BADJSON,
    'print("this is not json {{{")\n');
});

after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('happy path: resolves parsed JSON envelope from stdout', { skip: !hasPython }, async () => {
  const out = await asyncSign('hello world', OK);
  assert.equal(out.sig, 'ok');
  assert.equal(out.len, 'hello world'.length);
});

test('non-zero exit → SignPipelineError carrying exit code + stderr', { skip: !hasPython }, async () => {
  await assert.rejects(
    asyncSign('payload', FAIL),
    (e) => e instanceof SignPipelineError && /exited 2|simulated signer failure/.test(e.message),
  );
});

test('invalid JSON on stdout → SignPipelineError (invalid JSON)', { skip: !hasPython }, async () => {
  await assert.rejects(
    asyncSign('payload', BADJSON),
    (e) => e instanceof SignPipelineError && /invalid JSON/i.test(e.message),
  );
});

test('semaphore is released on success path under high concurrency', { skip: !hasPython }, async () => {
  // 24 > SIGN_CONCURRENCY (8): forces the queue to drain via _releaseSemaphore.
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) => asyncSign('p'.repeat(i + 1), OK)),
  );
  assert.equal(results.length, 24);
  results.forEach((r, i) => assert.equal(r.len, i + 1, `call #${i} returned wrong length`));
});

test('semaphore is NOT leaked after a burst of failures (no pool deadlock)', { skip: !hasPython }, async () => {
  // Saturate the pool with failures, then prove successes still flow through.
  const fails = await Promise.allSettled(
    Array.from({ length: 16 }, () => asyncSign('x', FAIL)),
  );
  assert.ok(fails.every(r => r.status === 'rejected'), 'all fail calls should reject');

  // If failures leaked semaphore slots, these would hang/never resolve.
  const oks = await Promise.all(
    Array.from({ length: 16 }, () => asyncSign('y', OK)),
  );
  assert.ok(oks.every(r => r.sig === 'ok'), 'pool recovered after failures');
});
