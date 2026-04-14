'use strict';
/**
 * src/a2a/task-store.js — SQLite-backed A2A task store
 *
 * Replaces the in-memory Map in handler.js. Tasks survive server restarts.
 * Uses better-sqlite3 (same instance as db.js) via synchronous API.
 *
 * Schema: a2a_tasks
 *   id             TEXT PRIMARY KEY        — UUID
 *   skill_id       TEXT NOT NULL
 *   params_json    TEXT                    — JSON.stringify(params)
 *   status_json    TEXT                    — JSON.stringify({state, message, ...})
 *   artifacts_json TEXT                    — JSON.stringify([...])
 *   history_json   TEXT                    — JSON.stringify([{state, timestamp},...])
 *   session_id     TEXT
 *   created_at     INTEGER                 — unix ms
 *   expires_at     INTEGER                 — unix ms (created_at + 3600_000)
 */

const { randomUUID } = require('crypto');
const { db }         = require('../../db');

const TASK_TTL_MS = 3_600_000; // 1 hour

// ── Schema ────────────────────────────────────────────────────────────────────

function initA2ASchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      id             TEXT    PRIMARY KEY,
      skill_id       TEXT    NOT NULL,
      params_json    TEXT,
      status_json    TEXT,
      artifacts_json TEXT,
      history_json   TEXT,
      session_id     TEXT,
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS a2a_tasks_expires ON a2a_tasks (expires_at);
    CREATE INDEX IF NOT EXISTS a2a_tasks_session ON a2a_tasks (session_id);
  `);
}

// Call schema init immediately when module is loaded
initA2ASchema();

// ── Prepared statements ───────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO a2a_tasks
    (id, skill_id, params_json, status_json, artifacts_json, history_json, session_id, created_at, expires_at)
  VALUES
    (@id, @skill_id, @params_json, @status_json, @artifacts_json, @history_json, @session_id, @created_at, @expires_at)
`);

const stmtSelect = db.prepare(`
  SELECT * FROM a2a_tasks WHERE id = ?
`);

const stmtUpdate = db.prepare(`
  UPDATE a2a_tasks
  SET status_json    = @status_json,
      artifacts_json = @artifacts_json,
      history_json   = @history_json
  WHERE id = @id
`);

const stmtDeleteExpired = db.prepare(`
  DELETE FROM a2a_tasks WHERE expires_at < ?
`);

const stmtListBySession = db.prepare(`
  SELECT * FROM a2a_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 50
`);

// ── Helper: row → task object ─────────────────────────────────────────────────

function rowToTask(row) {
  if (!row) return null;
  return {
    id:        row.id,
    skillId:   row.skill_id,
    params:    row.params_json    ? JSON.parse(row.params_json)    : {},
    status:    row.status_json    ? JSON.parse(row.status_json)    : { state: 'submitted' },
    artifacts: row.artifacts_json ? JSON.parse(row.artifacts_json) : [],
    history:   row.history_json   ? JSON.parse(row.history_json)   : [],
    sessionId: row.session_id     || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * createTask — insert a new task into SQLite.
 * @param {string} skillId
 * @param {object} params  — { address, options, callbackUrl?, ... }
 * @param {string|null} sessionId
 * @returns task object
 */
function createTask(skillId, params, sessionId = null) {
  const id        = randomUUID();
  const now       = Date.now();
  const expiresAt = now + TASK_TTL_MS;
  const initialStatus  = { state: 'submitted' };
  const initialHistory = [{ state: 'submitted', timestamp: new Date(now).toISOString() }];

  stmtInsert.run({
    id,
    skill_id:       skillId,
    params_json:    JSON.stringify(params),
    status_json:    JSON.stringify(initialStatus),
    artifacts_json: JSON.stringify([]),
    history_json:   JSON.stringify(initialHistory),
    session_id:     sessionId || null,
    created_at:     now,
    expires_at:     expiresAt,
  });

  return rowToTask(stmtSelect.get(id));
}

/**
 * getTask — fetch a task by ID. Returns null if not found or expired.
 * @param {string} id
 * @returns task object or null
 */
function getTask(id) {
  const row = stmtSelect.get(id);
  if (!row) return null;
  // Soft-expire check: treat expired tasks as not found
  if (row.expires_at < Date.now()) return null;
  return rowToTask(row);
}

/**
 * updateTask — update status and/or artifacts, append to history.
 * @param {string} id
 * @param {{ status?, artifacts? }} update
 */
function updateTask(id, update) {
  const row = stmtSelect.get(id);
  if (!row) return;

  const currentStatus    = row.status_json    ? JSON.parse(row.status_json)    : { state: 'submitted' };
  const currentArtifacts = row.artifacts_json ? JSON.parse(row.artifacts_json) : [];
  const currentHistory   = row.history_json   ? JSON.parse(row.history_json)   : [];

  const newStatus    = update.status    ? { ...currentStatus, ...update.status }    : currentStatus;
  const newArtifacts = update.artifacts ? update.artifacts                           : currentArtifacts;

  // Append to history when status state changes
  if (update.status) {
    currentHistory.push({ ...update.status, timestamp: new Date().toISOString() });
  }

  stmtUpdate.run({
    id,
    status_json:    JSON.stringify(newStatus),
    artifacts_json: JSON.stringify(newArtifacts),
    history_json:   JSON.stringify(currentHistory),
  });
}

/**
 * listTasksBySession — list tasks for a session, most recent first.
 * @param {string} sessionId
 * @returns task[]
 */
function listTasksBySession(sessionId) {
  return stmtListBySession.all(sessionId).map(rowToTask);
}

/**
 * deleteExpiredTasks — delete tasks past their TTL. Call on a cron interval.
 */
function deleteExpiredTasks() {
  const info = stmtDeleteExpired.run(Date.now());
  if (info.changes > 0) {
    console.log(`[a2a] deleteExpiredTasks: removed ${info.changes} expired task(s)`);
  }
}

module.exports = {
  initA2ASchema,
  createTask,
  getTask,
  updateTask,
  listTasksBySession,
  deleteExpiredTasks,
};
