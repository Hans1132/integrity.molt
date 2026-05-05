'use strict';
// tests/a2a-task-store.test.js — Unit testy pro src/a2a/task-store.js
// Run: node tests/a2a-task-store.test.js
process.env.SQLITE_DB_PATH = ':memory:';

const assert = require('assert');
const {
  createTask,
  getTask,
  updateTask,
  listTasksBySession,
  deleteExpiredTasks,
} = require('../src/a2a/task-store');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('\na2a-task-store.test.js\n');

// ── createTask ────────────────────────────────────────────────────────────────

test('createTask returns task with id and submitted state', () => {
  const t = createTask('quick_scan', { address: 'ABC123' }, 'sess-1');
  assert.ok(t.id, 'id missing');
  assert.strictEqual(t.skillId, 'quick_scan');
  assert.deepStrictEqual(t.status, { state: 'submitted' });
  assert.deepStrictEqual(t.artifacts, []);
  assert.strictEqual(t.sessionId, 'sess-1');
  assert.ok(t.createdAt > 0);
  assert.ok(t.expiresAt > t.createdAt);
  assert.ok(Array.isArray(t.history) && t.history.length === 1);
  assert.strictEqual(t.history[0].state, 'submitted');
});

test('createTask with null sessionId stores null', () => {
  const t = createTask('token_audit', { address: 'XYZ' }, null);
  assert.strictEqual(t.sessionId, null);
});

// ── getTask ───────────────────────────────────────────────────────────────────

test('getTask returns task by id', () => {
  const t = createTask('wallet_profile', { address: 'AAA' }, null);
  const got = getTask(t.id);
  assert.ok(got, 'getTask returned null');
  assert.strictEqual(got.id, t.id);
});

test('getTask returns null for unknown id', () => {
  assert.strictEqual(getTask('nonexistent-uuid-xyz'), null);
});

test('getTask returns null for expired task', () => {
  const t = createTask('quick_scan', { address: 'EXP' }, null);
  const { db } = require('../db');
  db.prepare('UPDATE a2a_tasks SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, t.id);
  assert.strictEqual(getTask(t.id), null);
});

// ── updateTask ────────────────────────────────────────────────────────────────

test('updateTask changes status state', () => {
  const t = createTask('quick_scan', { address: 'UPD' }, null);
  updateTask(t.id, { status: { state: 'working' } });
  const got = getTask(t.id);
  assert.strictEqual(got.status.state, 'working');
});

test('updateTask appends to history', () => {
  const t = createTask('quick_scan', { address: 'HIST' }, null);
  updateTask(t.id, { status: { state: 'working' } });
  updateTask(t.id, { status: { state: 'completed' } });
  const got = getTask(t.id);
  assert.ok(got.history.length >= 3, `Expected >=3 history entries, got ${got.history.length}`);
  assert.strictEqual(got.history[got.history.length - 1].state, 'completed');
});

test('updateTask merges status fields (does not replace)', () => {
  const t = createTask('quick_scan', { address: 'MERGE' }, null);
  updateTask(t.id, { status: { state: 'working', extra: 'foo' } });
  updateTask(t.id, { status: { state: 'completed' } });
  const got = getTask(t.id);
  assert.strictEqual(got.status.state, 'completed');
  assert.strictEqual(got.status.extra, 'foo');
});

test('updateTask sets artifacts', () => {
  const t = createTask('quick_scan', { address: 'ART' }, null);
  const arts = [{ name: 'result', mimeType: 'application/json', parts: [{ type: 'data', data: { x: 1 } }] }];
  updateTask(t.id, { status: { state: 'completed' }, artifacts: arts });
  const got = getTask(t.id);
  assert.deepStrictEqual(got.artifacts, arts);
});

test('updateTask on unknown id does nothing (no throw)', () => {
  assert.doesNotThrow(() => updateTask('no-such-id', { status: { state: 'working' } }));
});

// ── listTasksBySession ────────────────────────────────────────────────────────

test('listTasksBySession returns tasks in descending order', () => {
  const sess = 'sess-list-' + Date.now();
  const t1 = createTask('quick_scan', { address: 'A' }, sess);
  // Ensure t2 has a strictly later created_at than t1
  const deadline = t1.createdAt + 1;
  while (Date.now() < deadline) { /* busy-wait 1ms */ }
  const t2 = createTask('token_audit', { address: 'B' }, sess);
  const list = listTasksBySession(sess);
  assert.ok(list.length >= 2);
  assert.strictEqual(list[0].id, t2.id);
  assert.strictEqual(list[1].id, t1.id);
});

test('listTasksBySession returns empty array for unknown session', () => {
  const list = listTasksBySession('nonexistent-session-xyz');
  assert.deepStrictEqual(list, []);
});

// ── deleteExpiredTasks ────────────────────────────────────────────────────────

test('deleteExpiredTasks removes expired tasks', () => {
  const { db } = require('../db');
  const t = createTask('quick_scan', { address: 'DEL' }, null);
  db.prepare('UPDATE a2a_tasks SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, t.id);
  deleteExpiredTasks();
  assert.strictEqual(getTask(t.id), null);
});

test('deleteExpiredTasks does not remove live tasks', () => {
  const t = createTask('quick_scan', { address: 'LIVE' }, null);
  deleteExpiredTasks();
  assert.ok(getTask(t.id) !== null);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
