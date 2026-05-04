'use strict';
/**
 * tests/a2a/task-store.test.js
 *
 * Unit tests for src/a2a/task-store.js
 * Covers: createTask, getTask, updateTask, listTasksBySession, deleteExpiredTasks
 *
 * task-store.js calls initA2ASchema() at module load time, which creates the
 * a2a_tasks table on the shared db instance. Setting SQLITE_DB_PATH=:memory:
 * before any require ensures an isolated in-memory database.
 *
 * Run: node tests/a2a/task-store.test.js
 */

process.env.SQLITE_DB_PATH = ':memory:';
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';

const assert = require('assert');
const { db: rawDb, initSchema } = require('../../db');
const {
  createTask,
  getTask,
  updateTask,
  listTasksBySession,
  deleteExpiredTasks,
} = require('../../src/a2a/task-store');

let passed = 0;
let failed = 0;

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE  = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function run() {
  await initSchema();
  // task-store auto-ran initA2ASchema() at require time; table already exists.

  console.log('\n── A2A Task Store Tests ───────────────────────────────────────────────────────\n');

  await test('createTask returns object with UUID id and submitted state', async () => {
    const task = createTask('quick_scan', { address: 'Sol111TestAddress' }, null);
    assert.ok(UUID_RE.test(task.id), `id should be UUID, got "${task.id}"`);
    assert.strictEqual(task.skillId, 'quick_scan');
    assert.strictEqual(task.status.state, 'submitted');
    assert.ok(Array.isArray(task.artifacts), 'artifacts should be array');
    assert.strictEqual(task.artifacts.length, 0);
    assert.ok(Array.isArray(task.history), 'history should be array');
    assert.strictEqual(task.history.length, 1);
  });

  await test('initial history entry has correct state and ISO timestamp', async () => {
    const task = createTask('token_audit', { address: 'TestMint111' }, null);
    const entry = task.history[0];
    assert.strictEqual(entry.state, 'submitted');
    assert.ok(ISO_RE.test(entry.timestamp), `timestamp should be ISO 8601, got "${entry.timestamp}"`);
  });

  await test('getTask returns task immediately after createTask', async () => {
    const created = createTask('deep_audit', { address: 'ProgramAddr111' }, 'sess-get-test');
    const fetched  = getTask(created.id);
    assert.ok(fetched !== null, 'getTask should return the created task');
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.skillId, created.skillId);
    assert.strictEqual(fetched.status.state, 'submitted');
  });

  await test('getTask returns null for unknown ID', async () => {
    const result = getTask('00000000-0000-0000-0000-000000000000');
    assert.strictEqual(result, null);
  });

  await test('updateTask: status transitions are appended to history', async () => {
    const task = createTask('wallet_profile', { address: 'WalletAddr111' }, null);
    updateTask(task.id, { status: { state: 'working' } });
    updateTask(task.id, { status: { state: 'completed' } });
    const updated = getTask(task.id);
    assert.strictEqual(updated.history.length, 3, `expected 3 history entries, got ${updated.history.length}`);
    assert.strictEqual(updated.history[1].state, 'working');
    assert.strictEqual(updated.history[2].state, 'completed');
    assert.strictEqual(updated.status.state, 'completed');
  });

  await test('updateTask: artifacts can be set and retrieved', async () => {
    const task = createTask('quick_scan', { address: 'ArtifactTestAddr' }, null);
    const artifact = { type: 'result', data: { risk_score: 42, category: 'CAUTION' } };
    updateTask(task.id, { artifacts: [artifact] });
    const updated = getTask(task.id);
    assert.strictEqual(updated.artifacts.length, 1);
    assert.strictEqual(updated.artifacts[0].data.risk_score, 42);
  });

  await test('listTasksBySession returns tasks in reverse creation order', async () => {
    const sessId = `sess-list-${Date.now()}`;
    const t1 = createTask('quick_scan', { address: 'Addr1' }, sessId);
    await new Promise(r => setTimeout(r, 5));
    const t2 = createTask('token_audit', { address: 'Addr2' }, sessId);
    await new Promise(r => setTimeout(r, 5));
    const t3 = createTask('deep_audit',  { address: 'Addr3' }, sessId);
    const list = listTasksBySession(sessId);
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[0].id, t3.id, 'most recent task should be first');
    assert.strictEqual(list[2].id, t1.id, 'oldest task should be last');
  });

  await test('listTasksBySession is isolated per session', async () => {
    const sessA = `sess-a-${Date.now()}`;
    const sessB = `sess-b-${Date.now()}`;
    createTask('quick_scan', { address: 'AddrA' }, sessA);
    createTask('quick_scan', { address: 'AddrB' }, sessB);
    const listA = listTasksBySession(sessA);
    const listB = listTasksBySession(sessB);
    assert.ok(listA.every(t => t.sessionId === sessA), 'session A list must not contain session B tasks');
    assert.ok(listB.every(t => t.sessionId === sessB), 'session B list must not contain session A tasks');
  });

  await test('deleteExpiredTasks removes tasks with expires_at in the past', async () => {
    const task = createTask('quick_scan', { address: 'ExpiredAddr111' }, null);
    // Manually set expires_at to 1 second in the past
    rawDb.prepare('UPDATE a2a_tasks SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);
    deleteExpiredTasks();
    // stmtSelect bypasses the soft-expire check — verify the row is truly gone
    const row = rawDb.prepare('SELECT id FROM a2a_tasks WHERE id = ?').get(task.id);
    assert.strictEqual(row, undefined, 'expired task row should be deleted from DB');
  });

  await test('getTask soft-expire: treats task with past expires_at as not found', async () => {
    const task = createTask('quick_scan', { address: 'SoftExpiredAddr111' }, null);
    rawDb.prepare('UPDATE a2a_tasks SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);
    const result = getTask(task.id);
    assert.strictEqual(result, null, 'getTask should return null for expired task');
  });

  await test('params are preserved round-trip through createTask/getTask', async () => {
    const params = { address: 'RoundTripAddr111', options: { fast: true }, extra: 42 };
    const task = createTask('quick_scan', params, null);
    const fetched = getTask(task.id);
    assert.deepStrictEqual(fetched.params, params);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
