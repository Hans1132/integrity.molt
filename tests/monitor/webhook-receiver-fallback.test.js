'use strict';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const { initSchema } = require('../../db');
initSchema();

const mod = require('../../src/monitor/webhook-receiver');
const assert = require('assert');

async function run() {
  if (!mod._recordDbFailure) {
    console.log('  SKIP — _recordDbFailure not exported yet');
    process.exit(0);
  }
  // Reset counter pred testem
  if (mod._resetDbFailureCount) mod._resetDbFailureCount();

  mod._recordDbFailure();
  mod._recordDbFailure();
  mod._recordDbFailure();

  assert.ok(mod._getDbFallbackCount() >= 3, `counter musi byt >= 3, je ${mod._getDbFallbackCount()}`);
  console.log('  OK dbFallbackCount reaches 3');
  console.log('\n1 tests: 1 passed, 0 failed');
}
run().catch(e => { console.error(e); process.exit(1); });
