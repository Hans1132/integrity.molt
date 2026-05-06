# Database — integrity.molt

## Overview

integrity.molt uses **SQLite 3 in WAL (Write-Ahead Logging) mode** for all persistent storage. The database file lives at `/root/x402-server/data/intmolt.db` (13.5 MB live as of May 2026).

**Why SQLite?**
- Single-file, no server process
- ACID transactions with WAL mode for concurrent reads
- Better-sqlite3 binding provides synchronous API with low overhead
- Sufficient scale for current usage (~1000 requests/day, ~50k scan records)

**Key pragmas:**
```sql
PRAGMA journal_mode = WAL;              -- Write-Ahead Logging
PRAGMA foreign_keys = ON;               -- Enforce FK constraints
PRAGMA busy_timeout = 5000;             -- Retry locked writes for 5s
PRAGMA synchronous = NORMAL;            -- Balance durability/speed
PRAGMA wal_autocheckpoint = 1000;       -- Checkpoint every 1000 writes
```

## Schema

All tables are initialized in `db.js` via `initSchema()` function. Tables are organized by feature area.

### Payments & Anti-Replay

#### `payments` — x402 USDC transaction log

```sql
CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY,
  tx_sig              TEXT    NOT NULL UNIQUE,
  resource            TEXT    NOT NULL,
  required_micro_usdc INTEGER NOT NULL,
  micro_usdc          INTEGER NOT NULL DEFAULT 0,
  verified            INTEGER NOT NULL DEFAULT 0,  -- 0/1 (SQLite bool)
  reason              TEXT,
  ip                  TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS payments_created_at ON payments (created_at DESC);
CREATE INDEX IF NOT EXISTS payments_verified   ON payments (verified, created_at DESC);
```

**Usage:**
```javascript
// After successful x402 verification
await logPayment({
  tx_sig: 'xxxxxxxx...',           // Base58 transaction signature
  resource: '/scan/token',         // Endpoint that was called
  required_micro_usdc: 750_000,    // 0.75 USDC expected
  micro_usdc: 750_000,             // Actual amount transferred
  verified: 1,                     // On-chain confirmed
  ip: '203.0.113.45'               // Client IP (CF-Connecting-IP)
});
```

#### `used_signatures` — Replay protection

```sql
CREATE TABLE IF NOT EXISTS used_signatures (
  sig        TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS used_signatures_created ON used_signatures (created_at DESC);
```

**Usage:**
```javascript
// CRITICAL: Must be marked BEFORE response sent
const txSig = envelope.tx_sig;
const claimed = markSignatureUsed(txSig);
if (!claimed) {
  // Another request already claimed this signature — replay detected
  return res.status(402).json({error: 'Signature already used'});
}
```

**Implementation:**
```javascript
function markSignatureUsed(sig) {
  const r = db.prepare(
    'INSERT OR IGNORE INTO used_signatures (sig) VALUES (?)'
  ).run(sig);
  return r.changes === 1;  // true = atomic claim won
}
```

### Scan Results & Caching

#### `scan_history` — Cache for all scan results

```sql
CREATE TABLE IF NOT EXISTS scan_history (
  id          INTEGER PRIMARY KEY,
  email       TEXT,
  address     TEXT    NOT NULL,
  scan_type   TEXT    NOT NULL,
  risk_score  INTEGER,
  risk_level  TEXT,
  summary     TEXT,
  cached      INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS scan_history_email     ON scan_history (email, created_at DESC);
CREATE INDEX IF NOT EXISTS scan_history_created   ON scan_history (created_at DESC);
CREATE INDEX IF NOT EXISTS scan_history_addr_type ON scan_history (address, scan_type, created_at DESC);
```

**Usage — cache lookup:**
```javascript
// Query: SELECT result_json FROM scan_history
// WHERE address=? AND scan_type=? AND created_at > datetime('now', '-30 minutes')
// ORDER BY created_at DESC LIMIT 1

async function getCachedScanFromDb(address, scan_type, ttl_ms) {
  const ttl_minutes = Math.ceil(ttl_ms / 60_000);
  const row = db.prepare(`
    SELECT result_json FROM scan_history
    WHERE address = ? AND scan_type = ?
    AND created_at > datetime('now', ? || ' minutes')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(address, scan_type, `-${ttl_minutes}`);
  
  if (!row) return null;
  try {
    return JSON.parse(row.result_json);
  } catch {
    return null;  // Corrupted JSON, treat as miss
  }
}
```

**Usage — cache insert:**
```javascript
async function logScanToHistory(email, address, scan_type, result) {
  db.prepare(`
    INSERT INTO scan_history (
      email, address, scan_type, risk_score, risk_level, summary, cached, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
  `).run(
    email || null,
    address,
    scan_type,
    result.risk_score || null,
    result.risk_level || null,
    result.summary || null,
    JSON.stringify(result)
  );
}
```

**Cache TTL by scan type:**
```javascript
const CACHE_TTL_MS = {
  'quick':        30 * 60 * 1000,  // 30 min
  'token':        60 * 60 * 1000,  // 60 min (token-audit)
  'wallet':       30 * 60 * 1000,  // 30 min
  'deep':         60 * 60 * 1000,  // 60 min
  'agent-token':  30 * 60 * 1000,  // 30 min
  'governance':   15 * 60 * 1000,  // 15 min (governance-change)
};
```

### Rate Limiting & Abuse

#### `free_scan_quota` — Per-IP daily rate limit

```sql
CREATE TABLE IF NOT EXISTS free_scan_quota (
  identifier   TEXT NOT NULL,
  scan_date    DATE NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  last_scan_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identifier, scan_date)
);

CREATE INDEX IF NOT EXISTS idx_free_quota_date ON free_scan_quota (scan_date);
```

**Usage:**
```javascript
// identifier = IP address (from CF-Connecting-IP header)
const key = getRealClientIP(req);
const today = new Date().toISOString().split('T')[0];

// Check quota
const row = db.prepare('SELECT count FROM free_scan_quota WHERE identifier=? AND scan_date=?')
  .get(key, today);
const usedToday = row?.count || 0;

if (usedToday >= 10) {  // 10 req/min limit
  return res.status(429).json({error: 'Rate limit exceeded', reset_at: tomorrow_00_00});
}

// Consume quota
db.prepare(`
  INSERT INTO free_scan_quota (identifier, scan_date, count, last_scan_at)
  VALUES (?, ?, 1, datetime('now'))
  ON CONFLICT (identifier, scan_date) DO UPDATE
  SET count = count + 1, last_scan_at = datetime('now')
`).run(key, today);
```

#### `abuse_events` — Abuse detection log

```sql
CREATE TABLE IF NOT EXISTS abuse_events (
  id           INTEGER   PRIMARY KEY AUTOINCREMENT,
  ip           TEXT      NOT NULL,
  event_type   TEXT      NOT NULL,  -- 'quota_exceed', 'invalid_sig', 'blacklist_hit'
  details      TEXT,
  occurred_at  TEXT      NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_abuse_ip   ON abuse_events (ip, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_type ON abuse_events (event_type, occurred_at DESC);
```

#### `ip_blacklist` — IP denial list

```sql
CREATE TABLE IF NOT EXISTS ip_blacklist (
  ip          TEXT    PRIMARY KEY,
  reason      TEXT    NOT NULL,
  added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  hit_count   INTEGER NOT NULL DEFAULT 0
);
```

**Usage:**
```javascript
// Check blacklist
const blacklisted = db.prepare(`
  SELECT 1 FROM ip_blacklist
  WHERE ip = ?
  AND (expires_at IS NULL OR expires_at > datetime('now'))
  LIMIT 1
`).get(clientIP);

if (blacklisted) {
  return res.status(429).json({error: 'IP blocked'});
}
```

### A2A Task Persistence

#### `a2a_tasks` — Task storage for async A2A operations

```sql
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

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_session ON a2a_tasks (session_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_expires ON a2a_tasks (expires_at);
```

**Usage:**
```javascript
// Create task
const taskId = crypto.randomUUID();
const now = Date.now();
const expiresAt = now + 10 * 60 * 1000;  // 10 min TTL

db.prepare(`
  INSERT INTO a2a_tasks (
    id, skill_id, params_json, status_json, artifacts_json, history_json, 
    session_id, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  taskId,
  skillId,
  JSON.stringify(params),
  JSON.stringify({state: 'pending'}),
  JSON.stringify({}),
  JSON.stringify([]),
  sessionId || null,
  now,
  expiresAt
);

// Cleanup (called every 10 minutes)
function deleteExpiredTasks() {
  const now = Date.now();
  db.prepare('DELETE FROM a2a_tasks WHERE expires_at < ?').run(now);
}
```

### AutoPilot Spending Log

#### `autopilot_spending` — AI agent co-signing audit trail

```sql
CREATE TABLE IF NOT EXISTS autopilot_spending (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_mint        TEXT    NOT NULL,
  skill_id          TEXT    NOT NULL,
  amount_usdc       REAL    NOT NULL,
  tx_sig            TEXT,
  decision          TEXT    NOT NULL,  -- 'approved' | 'rejected'
  rejection_reason  TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autopilot_mint ON autopilot_spending (agent_mint, created_at DESC);
```

**Usage:**
```javascript
// Log AutoPilot decision
await logAutoSignDecision(agentMint, skillId, {
  allowed: true,
  reason: 'Within daily spending limit',
  dailyUsedUSDC: 12.50,
  dailyLimitUSDC: 50.00,
  txLimit: 5.00,
  txAmount: 0.75
});
```

### Enrichment & Verification

#### `iris_enrichment` — IRIS feature cache

```sql
CREATE TABLE IF NOT EXISTS iris_enrichment (
  mint                  TEXT    PRIMARY KEY,
  mint_authority        TEXT,
  freeze_authority      TEXT,
  mint_auth_active      INTEGER,
  freeze_auth_active    INTEGER,
  top1_holder_pct       REAL,
  top10_holder_pct      REAL,
  hhi                   REAL,
  holder_count          INTEGER,
  supply_total          TEXT,
  error_info            TEXT,
  enriched_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  rc_score              INTEGER,
  rc_rugged             INTEGER,
  rc_top1_pct           REAL,
  rc_top10_pct          REAL,
  rc_hhi                REAL,
  rc_insider_count      INTEGER,
  rc_total_holders      INTEGER,
  rc_total_liquidity    REAL,
  rc_risk_danger_count  INTEGER,
  rc_risk_score_total   INTEGER,
  rc_risks_json         TEXT,
  rc_enriched_at        TEXT,
  source                TEXT    NOT NULL DEFAULT 'scam_dataset'
);
```

Used for caching expensive IRIS calculations (holder distribution, concentration metrics).

#### `ottersec_verifications` — OtterSec program verification cache

```sql
CREATE TABLE IF NOT EXISTS ottersec_verifications (
  program_id        TEXT    PRIMARY KEY,
  is_verified       INTEGER NOT NULL,
  on_chain_hash     TEXT,
  executable_hash   TEXT,
  repo_url          TEXT,
  last_verified_at  TEXT,
  source            TEXT    NOT NULL DEFAULT 'ottersec_api',
  fetched_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  fetch_error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ottersec_expires ON ottersec_verifications (expires_at);
```

**TTL:** 1 hour (OtterSec API is rate-limited)

#### `known_scams` — Static scam database imports

```sql
CREATE TABLE IF NOT EXISTS known_scams (
  mint              TEXT    PRIMARY KEY,
  source            TEXT    NOT NULL,      -- 'solrpds', 'solrugdetector', 'manual'
  scam_type         TEXT,                   -- 'rug_pull', 'honeypot', 'pump_dump', 'fake', 'phishing'
  confidence        REAL    NOT NULL DEFAULT 1.0,
  label             TEXT,
  raw_data          TEXT,
  creator           TEXT,
  first_seen_slot   INTEGER,
  first_seen_at     TEXT,
  rug_pattern       TEXT,
  confidence_score  REAL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS known_scams_source ON known_scams (source, scam_type);
CREATE INDEX IF NOT EXISTS known_scams_creator ON known_scams (creator) WHERE creator IS NOT NULL;
CREATE INDEX IF NOT EXISTS known_scams_confidence ON known_scams (confidence DESC, scam_type);
```

#### `scam_creators` — Guilt-by-association cache

```sql
CREATE TABLE IF NOT EXISTS scam_creators (
  creator_wallet  TEXT    PRIMARY KEY,
  scam_count      INTEGER NOT NULL DEFAULT 1,
  last_scam_at    TEXT,
  patterns        TEXT  -- JSON array of rug_pattern values
);

CREATE INDEX IF NOT EXISTS scam_creators_count ON scam_creators (scam_count DESC);
```

### Advisor & Reporting

#### `advisor_calls` — LLM invocation tracking

```sql
CREATE TABLE IF NOT EXISTS advisor_calls (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id                 TEXT,
  scan_type               TEXT,
  advisor_invoked         INTEGER NOT NULL DEFAULT 0,
  executor_input_tokens   INTEGER NOT NULL DEFAULT 0,
  executor_output_tokens  INTEGER NOT NULL DEFAULT 0,
  advisor_input_tokens    INTEGER NOT NULL DEFAULT 0,
  advisor_output_tokens   INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd      REAL    NOT NULL DEFAULT 0,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS advisor_calls_created ON advisor_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS advisor_calls_type    ON advisor_calls (scan_type, created_at DESC);
```

**Usage:**
```javascript
// Log LLM invocation
db.logAdvisorUsage(scanId, scanType, {
  advisorUsed: true,
  usage: {
    input_tokens: 1250,
    output_tokens: 450
  }
});
```

#### `validation_log` — Report validation audit trail

```sql
CREATE TABLE IF NOT EXISTS validation_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mint              TEXT,
  scan_type         TEXT    NOT NULL DEFAULT 'token-audit',
  valid             INTEGER NOT NULL DEFAULT 1,
  issues_json       TEXT,
  corrections_count INTEGER NOT NULL DEFAULT 0,
  escalations_count INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS validation_log_mint    ON validation_log (mint, created_at DESC);
CREATE INDEX IF NOT EXISTS validation_log_invalid ON validation_log (valid, created_at DESC);
```

#### `scan_accuracy_signals` — Feedback & corrections

```sql
CREATE TABLE IF NOT EXISTS scan_accuracy_signals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id              INTEGER REFERENCES scan_history(id),
  mint                 TEXT,
  scan_type            TEXT,
  raw_score            INTEGER,
  llm_score            INTEGER,
  final_score          INTEGER,
  final_category       TEXT,
  validation_flags     TEXT,   -- JSON array
  corrections_count    INTEGER NOT NULL DEFAULT 0,
  user_feedback        TEXT,   -- 'correct', 'false_positive', 'false_negative'
  feedback_note        TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS accuracy_mint       ON scan_accuracy_signals (mint, created_at DESC);
CREATE INDEX IF NOT EXISTS accuracy_created    ON scan_accuracy_signals (created_at DESC);
CREATE INDEX IF NOT EXISTS accuracy_flags      ON scan_accuracy_signals (corrections_count DESC);
```

### New SPL Mints Feed

#### `spl_mints` — Newly deployed SPL token records

```sql
CREATE TABLE IF NOT EXISTS spl_mints (
  mint        TEXT    PRIMARY KEY,
  tx_sig      TEXT    NOT NULL UNIQUE,
  slot        INTEGER,
  block_time  INTEGER NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'alchemy_poller',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_spl_mints_bt ON spl_mints(block_time DESC);
```

#### `spl_mint_cursor` — Poller state (max 1 row, id=1)

```sql
CREATE TABLE IF NOT EXISTS spl_mint_cursor (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_sig    TEXT,
  last_run_at INTEGER
);
```

**Usage:**
```javascript
// Track poller position
const cursor = db.prepare('SELECT last_sig FROM spl_mint_cursor WHERE id=1').get();
const lastSig = cursor?.last_sig || null;

// Fetch mints since last run
const mints = await pollForNewMints(lastSig);

// Update cursor
db.prepare('INSERT OR REPLACE INTO spl_mint_cursor (id, last_sig, last_run_at) VALUES (1, ?, ?)').run(
  mints[mints.length - 1].tx_sig,
  Date.now()
);
```

### User Management (Legacy, minimal use)

#### `users` — User profiles

```sql
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  email                TEXT    NOT NULL UNIQUE,
  name                 TEXT,
  avatar_url           TEXT,
  provider             TEXT,
  provider_id          TEXT,
  password_hash        TEXT,
  reset_token          TEXT,
  reset_token_expires  TEXT,
  stripe_customer_id   TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS users_email    ON users (email);
CREATE INDEX IF NOT EXISTS users_provider ON users (provider, provider_id);
```

#### `api_keys` — API key storage

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY,
  key_hash      TEXT    NOT NULL UNIQUE,
  key_prefix    TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  tier          TEXT    NOT NULL,
  label         TEXT,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS api_keys_email ON api_keys (email, active);
CREATE INDEX IF NOT EXISTS api_keys_hash  ON api_keys (key_hash);
```

## Key Patterns & Best Practices

### 1. Timestamps

All timestamps are **TEXT in ISO 8601 format** for consistency with JavaScript `Date.toISOString()`:

```javascript
const timestamp = new Date().toISOString();  // "2026-05-06T10:00:00.000Z"

// SQLite function
datetime('now')        // "2026-05-06 10:00:00"
strftime('%s', 'now')  // Unix epoch (integer, milliseconds)
```

**Conversion function:**
```javascript
function toSQLiteTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  // "2026-05-06 10:00:00"
}
```

### 2. Boolean Fields

SQLite has no native BOOLEAN type. Use **INTEGER (0/1)** with explicit naming:

```sql
verified      INTEGER NOT NULL DEFAULT 0  -- 0=false, 1=true
cached        INTEGER NOT NULL DEFAULT 0
is_verified   INTEGER NOT NULL
```

**No ambiguity:** Always check `= 0` or `= 1` explicitly, never `!= 0`.

### 3. JSON Serialization

For complex structures, use **TEXT with JSON.stringify/JSON.parse**:

```sql
result_json   TEXT  -- Full JSON serialized result
risks_json    TEXT  -- Array of risk objects
params_json   TEXT  -- Request parameters
```

**Safety:**
```javascript
try {
  const obj = JSON.parse(row.result_json);
} catch {
  // Corrupted JSON — skip or warn
}
```

### 4. Indexes for Hot Paths

**Cache lookups (query `scan_history` frequently):**
```sql
CREATE INDEX IF NOT EXISTS scan_history_addr_type 
  ON scan_history (address, scan_type, created_at DESC);
```

**Time-based cleanup:**
```sql
CREATE INDEX IF NOT EXISTS scan_history_created 
  ON scan_history (created_at DESC);
```

**Anti-replay (PRIMARY KEY already indexed):**
```sql
CREATE TABLE used_signatures (sig TEXT PRIMARY KEY);
-- PK is automatically indexed for fast lookups
```

### 5. Atomic Operations

**Anti-replay (atomic INSERT):**
```javascript
function markSignatureUsed(sig) {
  const r = db.prepare('INSERT OR IGNORE INTO used_signatures (sig) VALUES (?)').run(sig);
  return r.changes === 1;  // true = won the atomic claim
}
```

**Why `INSERT OR IGNORE` works:**
- SQLite has a single writer at a time (WAL mode)
- INSERT fails on UNIQUE constraint violation
- `INSERT OR IGNORE` swallows the error, returns r.changes=0
- Only the first successful INSERT sees r.changes=1

### 6. Transaction Boundaries

**Rare case where multi-statement atomic is needed:**
```javascript
db.transaction(() => {
  // Mark signature used
  db.prepare('INSERT INTO used_signatures (sig) VALUES (?)').run(txSig);
  
  // Log payment
  db.prepare('INSERT INTO payments (...) VALUES (...)').run(...);
  
  // Both succeed or both roll back
})();
```

**Most operations are single-statement,** so explicit transactions are uncommon.

## Performance Considerations

### WAL Mode Benefits

SQLite WAL mode allows:
- **Concurrent readers** (no lock contention during reads)
- **One writer** at a time (serialized writes)
- **Checkpoint every 1000 writes** (controlled via PRAGMA)

**Not suitable for:** Extremely high-concurrency (100+ req/s) write workloads. Current usage (~10 req/s) is well within limits.

### Index Selectivity

**Good indexes:**
- `scan_history (address, scan_type, created_at DESC)` — 3-column selectivity for cache hits
- `used_signatures (sig)` — PRIMARY KEY, O(log N) lookup
- `payments (verified, created_at DESC)` — Filter by status, then sort by time

**Avoid over-indexing:** Each index consumes disk space and slows writes. Only index columns used in WHERE or ORDER BY clauses.

### Query Optimization

**Use prepared statements ALWAYS:**
```javascript
// ✓ Good
db.prepare('SELECT * FROM scan_history WHERE address=?').get(address);

// ✗ Bad
db.prepare(`SELECT * FROM scan_history WHERE address='${address}'`).get();
// SQL injection risk + no parameter binding
```

**Reuse prepared statement handles:**
```javascript
const stmt = db.prepare('SELECT * FROM scan_history WHERE address=?');
for (const addr of addresses) {
  const row = stmt.get(addr);  // Reuse compiled statement
}
```

### Monitoring

**Check database size:**
```bash
ls -lh /root/x402-server/data/intmolt.db*
# intmolt.db     13.5 MB (main database)
# intmolt.db-wal  2.3 MB (write-ahead log)
# intmolt.db-shm  (shared memory, temporary)
```

**Manual checkpoint (if WAL grows too large):**
```bash
sqlite3 /root/x402-server/data/intmolt.db "PRAGMA wal_checkpoint(RESTART);"
```

**Automatic checkpoint (every 6 hours):**
```javascript
setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
}, 6 * 3_600_000).unref();
```

## Backup & Recovery

**Backup strategy:**
1. Stop the Express server (`systemctl stop integrity-x402.service`)
2. Copy both files atomically:
   ```bash
   cp /root/x402-server/data/intmolt.db  /backups/intmolt-$(date +%s).db
   cp /root/x402-server/data/intmolt.db-wal  /backups/intmolt-$(date +%s).db-wal
   ```
3. Restart server (`systemctl start integrity-x402.service`)

**Restore from backup:**
```bash
systemctl stop integrity-x402.service
cp /backups/intmolt-TIMESTAMP.db /root/x402-server/data/intmolt.db
cp /backups/intmolt-TIMESTAMP.db-wal /root/x402-server/data/intmolt.db-wal
systemctl start integrity-x402.service
```

## Migration & Schema Changes

**Adding a new column:**
```javascript
// 1. Define migration function
function migrateAddNewColumn() {
  const alteration = "ALTER TABLE scan_history ADD COLUMN new_field TEXT";
  try {
    db.exec(alteration);
  } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e;
  }
}

// 2. Call during initSchema
function initSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS ...`);
  migrateAddNewColumn();
  // ...
}

// 3. Idempotent — safe to run multiple times (checks for existing column)
```

**Pattern (already used in codebase):**
- `migrateKnownScamsSchema()` — Adds creator, first_seen_slot, etc. columns
- `migrateAccuracySignalsSchema()` — Adds envelope_signature, address, etc. columns

**Never drop columns or rename tables** without explicit migration plan (complex with WAL mode).

## Testing Database Operations

**Unit tests use in-memory DB:**
```javascript
process.env.SQLITE_DB_PATH = ':memory:';
const db = require('./db');
// All operations in RAM, fast, isolated
```

**Integration tests use temp file:**
```bash
SQLITE_DB_PATH=/tmp/intmolt-test-$$.db npm run test:a2a
```

## Common Queries for Debugging

**Find all paid scans today:**
```sql
SELECT address, scan_type, risk_score, created_at FROM scan_history
WHERE scan_type IN ('token-audit', 'wallet', 'deep', 'agent-token')
AND created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;
```

**Find failed payments:**
```sql
SELECT tx_sig, resource, reason, created_at FROM payments
WHERE verified = 0
AND created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;
```

**List blacklisted IPs:**
```sql
SELECT ip, reason, added_at, hit_count FROM ip_blacklist
WHERE expires_at IS NULL OR expires_at > datetime('now')
ORDER BY hit_count DESC;
```

**Cache hit ratio for token_audit:**
```sql
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN cached=1 THEN 1 ELSE 0 END) as hits,
  ROUND(100.0 * SUM(CASE WHEN cached=1 THEN 1 ELSE 0 END) / COUNT(*), 1) as hit_pct
FROM scan_history
WHERE scan_type='token-audit'
AND created_at > datetime('now', '-1 day');
```
