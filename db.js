'use strict';
/**
 * db.js — SQLite databázová vrstva (better-sqlite3)
 *
 * Náhrada za pg (PostgreSQL). Synchronní API better-sqlite3 je zabaleno
 * do async funkcí kvůli zpětné kompatibilitě se zbytkem kódu.
 *
 * Všechna boolean pole jsou ukládána jako INTEGER (0/1).
 * Všechna časová razítka jako TEXT (ISO 8601 UTC).
 * JSONB → TEXT (JSON.stringify / JSON.parse).
 */

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');

// Konvertuje JS Date na SQLite TEXT formát 'YYYY-MM-DD HH:MM:SS' (bez T, bez Z, bez ms).
// SQLite datetime('now') vrací tento formát — musí být konzistentní při WHERE porovnáních.
function toSQLiteTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, 'data', 'intmolt.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Výkonnostní nastavení
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout  = 5000');
db.pragma('synchronous   = NORMAL');

// ── Schéma ────────────────────────────────────────────────────────────────────

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id                  INTEGER PRIMARY KEY,
      tx_sig              TEXT    NOT NULL UNIQUE,
      resource            TEXT    NOT NULL,
      required_micro_usdc INTEGER NOT NULL,
      micro_usdc          INTEGER NOT NULL DEFAULT 0,
      verified            INTEGER NOT NULL DEFAULT 0,
      reason              TEXT,
      ip                  TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS payments_created_at ON payments (created_at DESC);
    CREATE INDEX IF NOT EXISTS payments_verified   ON payments (verified, created_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      resource   TEXT,
      ip         TEXT,
      meta       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS events_name_created ON events (name, created_at DESC);
    CREATE INDEX IF NOT EXISTS events_created_at   ON events (created_at DESC);

    CREATE TABLE IF NOT EXISTS watchlist (
      id                   INTEGER PRIMARY KEY,
      address              TEXT    NOT NULL,
      label                TEXT,
      notify_telegram_chat TEXT,
      notify_email         TEXT,
      last_checked_at      TEXT,
      last_risk_level      TEXT,
      last_risk_summary    TEXT,
      last_risk_score      INTEGER,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      active               INTEGER NOT NULL DEFAULT 1,
      UNIQUE (address, notify_telegram_chat)
    );
    CREATE INDEX IF NOT EXISTS watchlist_active  ON watchlist (active, last_checked_at);
    CREATE INDEX IF NOT EXISTS watchlist_address ON watchlist (address);
    CREATE INDEX IF NOT EXISTS watchlist_email   ON watchlist (notify_email, active);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                    INTEGER PRIMARY KEY,
      stripe_customer_id    TEXT    NOT NULL,
      stripe_sub_id         TEXT    UNIQUE,
      email                 TEXT    NOT NULL,
      tier                  TEXT    NOT NULL,
      status                TEXT    NOT NULL DEFAULT 'incomplete',
      current_period_end    TEXT,
      telegram_chat_id      TEXT,
      digest_unsubscribed   INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS subscriptions_email  ON subscriptions (email);
    CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions (status, current_period_end);

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

    CREATE TABLE IF NOT EXISTS ads (
      id          INTEGER PRIMARY KEY,
      advertiser  TEXT    NOT NULL,
      headline    TEXT    NOT NULL,
      tagline     TEXT,
      cta_text    TEXT    NOT NULL DEFAULT 'Learn more',
      cta_url     TEXT    NOT NULL,
      image_url   TEXT,
      placement   TEXT    NOT NULL DEFAULT 'scan_result',
      active      INTEGER NOT NULL DEFAULT 1,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks      INTEGER NOT NULL DEFAULT 0,
      budget_usd  REAL,
      spent_usd   REAL    NOT NULL DEFAULT 0,
      cpm_usd     REAL    NOT NULL DEFAULT 5.00,
      expires_at  TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ads_placement_active ON ads (placement, active, expires_at);

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

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid      TEXT PRIMARY KEY,
      sess     TEXT NOT NULL,
      expires  TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON user_sessions (expires);

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

    CREATE TABLE IF NOT EXISTS used_signatures (
      sig        TEXT    PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS used_signatures_created ON used_signatures (created_at DESC);

    CREATE TABLE IF NOT EXISTS scan_accuracy_signals (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id              INTEGER REFERENCES scan_history(id),
      mint                 TEXT,
      scan_type            TEXT,
      raw_score            INTEGER,
      llm_score            INTEGER,
      final_score          INTEGER,
      final_category       TEXT,
      validation_flags     TEXT,   -- JSON array of llm_validation_flags
      corrections_count    INTEGER NOT NULL DEFAULT 0,
      user_feedback        TEXT,   -- 'correct' | 'false_positive' | 'false_negative' | null
      feedback_note        TEXT,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS accuracy_mint       ON scan_accuracy_signals (mint, created_at DESC);
    CREATE INDEX IF NOT EXISTS accuracy_created    ON scan_accuracy_signals (created_at DESC);
    CREATE INDEX IF NOT EXISTS accuracy_flags      ON scan_accuracy_signals (corrections_count DESC);

    -- Statická scam databáze (SolRPDS, SolRugDetector a další importy)
    CREATE TABLE IF NOT EXISTS known_scams (
      mint              TEXT    PRIMARY KEY,
      source            TEXT    NOT NULL,  -- 'solrpds' | 'solrugdetector' | 'manual'
      scam_type         TEXT,              -- 'rug_pull' | 'honeypot' | 'pump_dump' | 'fake' | 'phishing'
      confidence        REAL    NOT NULL DEFAULT 1.0, -- 0.0–1.0
      label             TEXT,              -- human-readable popis
      raw_data          TEXT,              -- JSON z originálu
      creator           TEXT,              -- creator/deployer wallet address (NULL pro SolRPDS)
      first_seen_slot   INTEGER,           -- první slot aktivity (NULL pokud nemáme slot)
      first_seen_at     TEXT,              -- první časové razítko aktivity (ISO 8601)
      rug_pattern       TEXT,              -- 'liquidity_drain' | 'inactive_pool' | 'active_suspicious'
      confidence_score  REAL,              -- alias pro confidence (pro zpětnou kompatibilitu nových zdrojů)
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS known_scams_source ON known_scams (source, scam_type);

    -- Agregace scam tvůrců — guilt-by-association
    CREATE TABLE IF NOT EXISTS scam_creators (
      creator_wallet  TEXT    PRIMARY KEY,
      scam_count      INTEGER NOT NULL DEFAULT 1,
      last_scam_at    TEXT,
      patterns        TEXT    -- JSON array of distinct rug_pattern values
    );
    CREATE INDEX IF NOT EXISTS scam_creators_count ON scam_creators (scam_count DESC);

    -- Ephemerní cache RugCheck API výsledků (TTL 24h)
    CREATE TABLE IF NOT EXISTS rugcheck_cache (
      mint        TEXT    PRIMARY KEY,
      risk_level  TEXT,   -- 'good' | 'warn' | 'danger'
      score       INTEGER,
      score_norm  INTEGER,
      rugged      INTEGER NOT NULL DEFAULT 0,
      risks_json  TEXT,   -- JSON array of risk objects
      raw_json    TEXT,   -- plná odpověď
      fetched_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS rugcheck_cache_fetched ON rugcheck_cache (fetched_at DESC);

    -- Validation log — záznam každé validace reportu před podpisem
    CREATE TABLE IF NOT EXISTS validation_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      mint              TEXT,
      scan_type         TEXT    NOT NULL DEFAULT 'token-audit',
      valid             INTEGER NOT NULL DEFAULT 1,  -- 0/1
      issues_json       TEXT,   -- JSON array of issue objects
      corrections_count INTEGER NOT NULL DEFAULT 0,
      escalations_count INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS validation_log_mint    ON validation_log (mint, created_at DESC);
    CREATE INDEX IF NOT EXISTS validation_log_invalid ON validation_log (valid, created_at DESC);

    -- SPL mint feed — naplněno Alchemy pollerem (spl-mint-poller.js)
    CREATE TABLE IF NOT EXISTS spl_mints (
      mint        TEXT    PRIMARY KEY,
      tx_sig      TEXT    NOT NULL UNIQUE,
      slot        INTEGER,
      block_time  INTEGER NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'alchemy_poller',
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
    CREATE INDEX IF NOT EXISTS idx_spl_mints_bt ON spl_mints(block_time DESC);

    -- Kurzor polleru — vždy max 1 řádek (id=1)
    CREATE TABLE IF NOT EXISTS spl_mint_cursor (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      last_sig    TEXT,
      last_run_at INTEGER
    );

    -- Free scan quota per IP+den
    CREATE TABLE IF NOT EXISTS free_scan_quota (
      identifier   TEXT NOT NULL,
      scan_date    DATE NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      last_scan_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (identifier, scan_date)
    );
    CREATE INDEX IF NOT EXISTS idx_free_quota_date ON free_scan_quota (scan_date);

    -- Abuse events log
    CREATE TABLE IF NOT EXISTS abuse_events (
      id           INTEGER   PRIMARY KEY AUTOINCREMENT,
      ip           TEXT      NOT NULL,
      event_type   TEXT      NOT NULL,
      details      TEXT,
      occurred_at  TEXT      NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_abuse_ip   ON abuse_events (ip, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_abuse_type ON abuse_events (event_type, occurred_at DESC);

    -- IP blacklist
    CREATE TABLE IF NOT EXISTS ip_blacklist (
      ip          TEXT    PRIMARY KEY,
      reason      TEXT    NOT NULL,
      added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT,
      hit_count   INTEGER NOT NULL DEFAULT 0
    );

    -- Globální scan statistiky per den
    CREATE TABLE IF NOT EXISTS global_scan_stats (
      stat_date   DATE    PRIMARY KEY,
      free_count  INTEGER NOT NULL DEFAULT 0,
      paid_count  INTEGER NOT NULL DEFAULT 0
    );

    -- IRIS enrichment — výsledky offline enrichment skriptu
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

    -- A2A task persistence
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

    -- AutoPilot spending log
    CREATE TABLE IF NOT EXISTS autopilot_spending (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_mint        TEXT    NOT NULL,
      skill_id          TEXT    NOT NULL,
      amount_usdc       REAL    NOT NULL,
      tx_sig            TEXT,
      decision          TEXT    NOT NULL,
      rejection_reason  TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_mint ON autopilot_spending (agent_mint, created_at DESC);

    -- OtterSec program verification cache
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
  `);
  // Migruj sloupce pro existující DB (bezpečné i při opakovaném volání)
  migrateKnownScamsSchema();
  migrateAccuracySignalsSchema();
  return Promise.resolve();
}

// migrateKnownScamsSchema musí být definovaná před initSchema, ale volá se z ní.
// Funkce je deklarovaná jako function (hoisted) níže.
function migrateKnownScamsSchema() {
  const alterCols = [
    "ALTER TABLE known_scams ADD COLUMN creator          TEXT",
    "ALTER TABLE known_scams ADD COLUMN first_seen_slot  INTEGER",
    "ALTER TABLE known_scams ADD COLUMN first_seen_at    TEXT",
    "ALTER TABLE known_scams ADD COLUMN rug_pattern      TEXT",
    "ALTER TABLE known_scams ADD COLUMN confidence_score REAL",
  ];
  for (const sql of alterCols) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS known_scams_creator ON known_scams (creator) WHERE creator IS NOT NULL");
  } catch {}
}

function migrateAccuracySignalsSchema() {
  const cols = [
    "ALTER TABLE scan_accuracy_signals ADD COLUMN envelope_signature TEXT",
    "ALTER TABLE scan_accuracy_signals ADD COLUMN address            TEXT",
    "ALTER TABLE scan_accuracy_signals ADD COLUMN oracle_verdict     TEXT",
    "ALTER TABLE scan_accuracy_signals ADD COLUMN source             TEXT",
    "ALTER TABLE watchlist ADD COLUMN webhook_url TEXT",
  ];
  for (const sql of cols) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  const idxs = [
    "CREATE UNIQUE INDEX IF NOT EXISTS accuracy_envelope_sig ON scan_accuracy_signals (envelope_signature) WHERE envelope_signature IS NOT NULL",
    // Rychlejší cache lookup — pokrývá getCachedScanFromDb()
    "CREATE INDEX IF NOT EXISTS scan_history_cache_lookup ON scan_history (address, scan_type, created_at DESC) WHERE result_json IS NOT NULL",
    // Confidence-based filtering known_scams
    "CREATE INDEX IF NOT EXISTS known_scams_confidence ON known_scams (confidence DESC, scam_type)",
    // IP blacklist — pouze aktivní záznamy
    "CREATE INDEX IF NOT EXISTS ip_blacklist_active ON ip_blacklist (ip) WHERE expires_at IS NULL",
  ];
  for (const sql of idxs) {
    try { db.exec(sql); } catch {}
  }
}

// auth.js volá initUsersSchema() samostatně — mapujeme na initSchema
function initUsersSchema() { return initSchema(); }

// ── Periodic WAL checkpoint (každých 6h) ─────────────────────────────────────
// Zabrání neomezenému růstu WAL souboru při dlouhém běhu service.
setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
}, 6 * 3_600_000).unref();

// ── Pool compatibility shim ────────────────────────────────────────────────────
// server.js a mailer.js používají db.pool.query(...) přímo pro ad-hoc dotazy.
// Tento shim konvertuje PostgreSQL parametrové značky ($1, $2, ...) na SQLite (?)
// a PostgreSQL-specifické funkce na SQLite ekvivalenty.

function pgToSqlite(sql) {
  return sql
    // Parametrové zástupné symboly
    .replace(/\$(\d+)/g, '?')
    // Typy
    .replace(/::interval/gi, '')
    .replace(/::text/gi, '')
    .replace(/::integer/gi, '')
    // now() → datetime('now')
    .replace(/\bnow\(\)/g, "datetime('now')")
    // TIMESTAMPTZ / BOOLEAN DEFAULT — ignoruj (jen pro CREATE TABLE, ale tam nepoužíváme)
    // date_trunc('day', col AT TIME ZONE 'UTC') → date(col)
    .replace(/date_trunc\('day',\s*\w+\s+AT\s+TIME\s+ZONE\s+'UTC'\)/gi, (m) => {
      const colMatch = m.match(/date_trunc\('day',\s*(\w+)/i);
      return colMatch ? `date(${colMatch[1]})` : m;
    })
    // current_period_end > now() → current_period_end > datetime('now')
    // (already handled by now() replacement above)
    // LOWER( → lower(
    .replace(/\bLOWER\s*\(/g, 'lower(')
    // RANDOM() → RANDOM()  (same in SQLite)
    // meta->>'path' → json_extract(meta, '$.path')
    .replace(/(\w+)->>'(\w+)'/g, "json_extract($1, '$.$2')")
    // NULLIF → nullif (same, just normalize)
    .replace(/\bNULLIF\s*\(/g, 'nullif(')
    // digest_unsubscribed = FALSE → digest_unsubscribed = 0
    .replace(/= FALSE\b/gi, '= 0')
    .replace(/= TRUE\b/gi, '= 1')
    // current_period_end IS NULL OR current_period_end > datetime('now')
    // (no change needed, already valid SQLite)
    ;
}

const pool = {
  async query(sql, params = []) {
    try {
      const sqlLite = pgToSqlite(sql);
      const trimmed = sqlLite.trim().replace(/^\/\*.*?\*\/\s*/s, '').trimStart();
      const isSelect = /^(SELECT|WITH|PRAGMA)\b/i.test(trimmed);
      if (isSelect) {
        const rows = db.prepare(sqlLite).all(params);
        return { rows, rowCount: rows.length };
      } else {
        const result = db.prepare(sqlLite).run(params);
        return { rows: [], rowCount: result.changes };
      }
    } catch (e) {
      console.error('[db.pool.query] error:', e.message, '\nSQL:', sql.slice(0, 200));
      throw e;
    }
  }
};

// ── Platby ────────────────────────────────────────────────────────────────────

async function logPayment({ tx_sig, resource, required_micro_usdc, micro_usdc, verified, reason, ip }) {
  db.prepare(`
    INSERT INTO payments (tx_sig, resource, required_micro_usdc, micro_usdc, verified, reason, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tx_sig) DO NOTHING
  `).run(tx_sig, resource, required_micro_usdc, micro_usdc, verified ? 1 : 0, reason || null, ip || null);
}

// Anti-replay: check used_signatures table (dedicated, fast PRIMARY KEY lookup).
async function isAlreadyUsed(sig) {
  const row = db.prepare(
    'SELECT 1 FROM used_signatures WHERE sig = ? LIMIT 1'
  ).get(sig);
  return !!row;
}

// Anti-replay: mark a signature as used immediately after successful on-chain verification.
// INSERT OR IGNORE prevents errors if two concurrent requests race on the same sig.
//
// Returns TRUE only for the caller whose INSERT actually created the row — this is the
// atomic "claim". All other racers (duplicates) get FALSE because SQLite's UNIQUE PRIMARY
// KEY deduplicates under a single writer lock. Callers MUST check the return value and
// reject the request when it is FALSE to prevent double-spend via parallel replays.
function markSignatureUsed(sig) {
  const r = db.prepare(
    'INSERT OR IGNORE INTO used_signatures (sig) VALUES (?)'
  ).run(sig);
  return r.changes === 1; // true = atomic claim won, false = another racer beat us
}

// ── Events ────────────────────────────────────────────────────────────────────

async function logEvent({ name, resource, ip, meta }) {
  db.prepare(
    'INSERT INTO events (name, resource, ip, meta) VALUES (?, ?, ?, ?)'
  ).run(name, resource || null, ip || null, meta ? JSON.stringify(meta) : null);
}

async function getFunnelStats(days = 30) {
  const cutoff = toSQLiteTimestamp(new Date(Date.now() - days * 86400000));
  return db.prepare(`
    SELECT name,
           COUNT(*)          AS total,
           COUNT(DISTINCT ip) AS unique_ips,
           date(created_at)  AS day
    FROM events
    WHERE created_at >= ?
    GROUP BY name, day
    ORDER BY day DESC, name
  `).all(cutoff);
}

async function getPaymentStats(days = 30) {
  const cutoff = toSQLiteTimestamp(new Date(Date.now() - days * 86400000));
  return db.prepare(`
    SELECT date(created_at)                                         AS day,
           resource,
           COUNT(*)                                                  AS attempts,
           SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END)            AS verified,
           ROUND(100.0 * SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END)
                 / nullif(COUNT(*), 0), 1)                           AS verified_pct,
           SUM(CASE WHEN verified = 1 THEN micro_usdc ELSE 0 END)   AS revenue_micro_usdc
    FROM payments
    WHERE created_at >= ?
    GROUP BY day, resource
    ORDER BY day DESC, resource
  `).all(cutoff);
}

async function getPageviewStats(days = 30) {
  const cutoff = toSQLiteTimestamp(new Date(Date.now() - days * 86400000));
  return db.prepare(`
    SELECT date(created_at)              AS day,
           json_extract(meta, '$.path')  AS path,
           COUNT(*)                      AS views,
           COUNT(DISTINCT ip)            AS uniq
    FROM events
    WHERE name = 'page_view' AND created_at >= ?
    GROUP BY day, path
    ORDER BY day DESC, views DESC
  `).all(cutoff);
}

async function countFreeScansToday(ip) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM events
    WHERE name = 'free_scan_used' AND ip = ? AND created_at >= ?
  `).get(ip, toSQLiteTimestamp(dayStart));
  return parseInt(row?.cnt ?? 0, 10);
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

async function addWatchlistEntry({ address, label, notify_telegram_chat, notify_email }) {
  try {
    const result = db.prepare(`
      INSERT INTO watchlist (address, label, notify_telegram_chat, notify_email)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (address, notify_telegram_chat) DO UPDATE
        SET active = 1, label = EXCLUDED.label
    `).run(address, label || null, notify_telegram_chat || null, notify_email || null);
    const id = result.lastInsertRowid || db.prepare(
      'SELECT id FROM watchlist WHERE address = ? AND notify_telegram_chat IS ?'
    ).get(address, notify_telegram_chat || null)?.id;
    return db.prepare('SELECT id, address, label, created_at FROM watchlist WHERE id = ?').get(id);
  } catch (e) {
    throw e;
  }
}

async function removeWatchlistEntry(id, notify_telegram_chat) {
  const result = db.prepare(`
    UPDATE watchlist SET active = 0
    WHERE id = ? AND (notify_telegram_chat = ? OR ? IS NULL)
  `).run(id, notify_telegram_chat || null, notify_telegram_chat || null);
  return result.changes > 0;
}

async function getActiveWatchlist() {
  return db.prepare(`
    SELECT id, address, label, notify_telegram_chat, notify_email,
           last_checked_at, last_risk_level
    FROM watchlist
    WHERE active = 1
    ORDER BY last_checked_at ASC NULLS FIRST
  `).all();
}

async function updateWatchlistRisk(id, { risk_level, risk_score, risk_summary }) {
  db.prepare(`
    UPDATE watchlist
    SET last_checked_at = datetime('now'),
        last_risk_level = ?,
        last_risk_score = ?,
        last_risk_summary = ?
    WHERE id = ?
  `).run(risk_level, risk_score ?? null, risk_summary || null, id);
}

async function listWatchlistForChat(notify_telegram_chat) {
  return db.prepare(`
    SELECT id, address, label, last_risk_level, last_checked_at
    FROM watchlist
    WHERE notify_telegram_chat = ? AND active = 1
    ORDER BY created_at
  `).all(notify_telegram_chat);
}

async function addUserWatchlistEntry({ email, address, label, notify_email }) {
  const notifyEmail = notify_email !== undefined ? notify_email : email;
  try {
    const result = db.prepare(`
      INSERT INTO watchlist (address, label, notify_email)
      VALUES (?, ?, ?)
    `).run(address, label || null, notifyEmail);
    return db.prepare('SELECT id, address, label, created_at FROM watchlist WHERE id = ?')
      .get(result.lastInsertRowid);
  } catch (e) {
    // Conflict — reactivate if inactive
    const existing = db.prepare(`
      UPDATE watchlist SET active = 1,
        label = COALESCE(?, label), notify_email = ?
      WHERE address = ? AND (notify_email = ? OR ? IS NULL) AND active = 0
    `).run(label || null, notifyEmail, address, notifyEmail, notifyEmail);
    if (existing.changes > 0) {
      return db.prepare('SELECT id, address, label, created_at FROM watchlist WHERE address = ? AND notify_email = ?')
        .get(address, notifyEmail);
    }
    return null;
  }
}

async function removeUserWatchlistEntry({ email, id }) {
  const result = db.prepare(
    'UPDATE watchlist SET active = 0 WHERE id = ? AND notify_email = ?'
  ).run(id, email);
  return result.changes > 0;
}

async function getUserWatchlist(email) {
  return db.prepare(`
    SELECT id, address, label, last_risk_level, last_risk_score, last_checked_at, created_at
    FROM watchlist
    WHERE notify_email = ? AND active = 1
    ORDER BY created_at DESC
  `).all(email);
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

async function upsertSubscription({ stripe_customer_id, stripe_sub_id, email, tier, status, current_period_end, telegram_chat_id }) {
  const periodEnd = current_period_end
    ? new Date(current_period_end * 1000).toISOString()
    : null;
  db.prepare(`
    INSERT INTO subscriptions
      (stripe_customer_id, stripe_sub_id, email, tier, status, current_period_end, telegram_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (stripe_sub_id) DO UPDATE SET
      status             = excluded.status,
      current_period_end = excluded.current_period_end,
      tier               = excluded.tier,
      updated_at         = datetime('now')
  `).run(stripe_customer_id, stripe_sub_id, email, tier, status, periodEnd, telegram_chat_id || null);
}

async function getActiveSubscription(email) {
  return db.prepare(`
    SELECT * FROM subscriptions
    WHERE email = ? AND status = 'active'
      AND (current_period_end IS NULL OR current_period_end > datetime('now'))
    ORDER BY current_period_end DESC
    LIMIT 1
  `).get(email) || null;
}

async function getActiveSubscriptionByChatId(telegram_chat_id) {
  if (!telegram_chat_id) return null;
  return db.prepare(`
    SELECT * FROM subscriptions
    WHERE telegram_chat_id = ? AND status = 'active'
      AND (current_period_end IS NULL OR current_period_end > datetime('now'))
    ORDER BY current_period_end DESC
    LIMIT 1
  `).get(String(telegram_chat_id)) || null;
}

function countWatchlistForEmail(email) {
  return db.prepare(
    `SELECT COUNT(*) as n FROM watchlist WHERE notify_email = ? AND active = 1`
  ).get(email)?.n ?? 0;
}

function countWatchlistForChat(telegram_chat_id) {
  return db.prepare(
    `SELECT COUNT(*) as n FROM watchlist WHERE notify_telegram_chat = ? AND active = 1`
  ).get(String(telegram_chat_id))?.n ?? 0;
}

// ── API Keys ──────────────────────────────────────────────────────────────────

async function createApiKey({ email, tier, label }) {
  const raw    = 'im_' + crypto.randomBytes(32).toString('hex');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.substring(0, 10);
  const result = db.prepare(
    'INSERT INTO api_keys (key_hash, key_prefix, email, tier, label) VALUES (?, ?, ?, ?, ?)'
  ).run(hash, prefix, email, tier, label || null);
  const row = db.prepare('SELECT id, key_prefix, email, tier, label, created_at FROM api_keys WHERE id = ?')
    .get(result.lastInsertRowid);
  return { ...row, key: raw };
}

async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('im_')) return null;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  return db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND active = 1 LIMIT 1').get(hash) || null;
}

async function incrementApiKeyUsage(id) {
  db.prepare(
    "UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?"
  ).run(id);
}

async function listApiKeys(email) {
  return db.prepare(`
    SELECT id, key_prefix, email, tier, label, usage_count, last_used_at, created_at
    FROM api_keys WHERE email = ? AND active = 1 ORDER BY created_at DESC
  `).all(email);
}

async function revokeApiKey(id, email) {
  const result = db.prepare(
    "UPDATE api_keys SET active = 0, revoked_at = datetime('now') WHERE id = ? AND email = ?"
  ).run(id, email);
  return result.changes > 0;
}

// ── Scan history ──────────────────────────────────────────────────────────────

async function logScanToHistory({ email, address, scan_type, risk_score, risk_level, summary, cached, result_json }) {
  db.prepare(`
    INSERT INTO scan_history
      (email, address, scan_type, risk_score, risk_level, summary, cached, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    email || null, address, scan_type,
    risk_score ?? null, risk_level || null,
    (summary || '').slice(0, 300),
    cached ? 1 : 0,
    result_json ? JSON.stringify(result_json) : null
  );
}

async function getCachedScanFromDb(address, scan_type, maxAgeMs = 3_600_000) {
  // SQLite datetime format: 'YYYY-MM-DD HH:MM:SS' — toISOString() uses 'T' separator
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const row = db.prepare(`
    SELECT result_json FROM scan_history
    WHERE address = ? AND scan_type = ? AND result_json IS NOT NULL
      AND created_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(address, scan_type, cutoff);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

async function getScanHistory(email, limit = 50) {
  return db.prepare(`
    SELECT id, address, scan_type, risk_score, risk_level, summary, cached, created_at
    FROM scan_history WHERE email = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(email, limit);
}

// ── Ads ───────────────────────────────────────────────────────────────────────

function initAdsSchema() { return initSchema(); }

async function getAdForPlacement(placement) {
  return db.prepare(`
    SELECT id, advertiser, headline, tagline, cta_text, cta_url, image_url, impressions, clicks
    FROM ads
    WHERE active = 1
      AND (placement = ? OR placement = 'all')
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND (budget_usd IS NULL OR spent_usd < budget_usd)
    ORDER BY impressions ASC, RANDOM()
    LIMIT 1
  `).get(placement) || null;
}

async function trackAdImpression(id, spent_increment_usd) {
  db.prepare(
    'UPDATE ads SET impressions = impressions + 1, spent_usd = spent_usd + ? WHERE id = ?'
  ).run(spent_increment_usd || 0, id);
}

async function trackAdClick(id) {
  db.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').run(id);
  return db.prepare('SELECT cta_url FROM ads WHERE id = ?').get(id)?.cta_url || null;
}

async function listAds() {
  return db.prepare(`
    SELECT *, ROUND(100.0 * clicks / nullif(impressions, 0), 2) AS ctr
    FROM ads ORDER BY created_at DESC
  `).all();
}

async function createAd({ advertiser, headline, tagline, cta_text, cta_url, image_url, placement, budget_usd, cpm_usd, expires_at }) {
  const result = db.prepare(`
    INSERT INTO ads
      (advertiser, headline, tagline, cta_text, cta_url, image_url, placement, budget_usd, cpm_usd, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    advertiser, headline, tagline || null, cta_text || 'Learn more', cta_url,
    image_url || null, placement || 'scan_result',
    budget_usd || null, cpm_usd || 5.00, expires_at || null
  );
  return db.prepare('SELECT * FROM ads WHERE id = ?').get(result.lastInsertRowid);
}

async function updateAd(id, fields) {
  const allowed = ['headline','tagline','cta_text','cta_url','image_url','placement','active','budget_usd','cpm_usd','expires_at'];
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (!sets.length) return null;
  vals.push(id);
  db.prepare(`UPDATE ads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare('SELECT * FROM ads WHERE id = ?').get(id) || null;
}

// ── Users (přesunuto z auth.js) ───────────────────────────────────────────────

async function findOrCreateUser({ email, name, avatar_url, provider, provider_id }) {
  if (!email) email = `${provider}_${provider_id}@noemail.local`;
  try {
    const result = db.prepare(`
      INSERT INTO users (email, name, avatar_url, provider, provider_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, name || null, avatar_url || null, provider, String(provider_id));
    return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  } catch {
    // Conflict — update existing
    db.prepare(`
      UPDATE users
      SET name        = COALESCE(?, name),
          avatar_url  = COALESCE(?, avatar_url),
          provider    = ?,
          provider_id = ?
      WHERE email = ?
    `).run(name || null, avatar_url || null, provider, String(provider_id), email);
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }
}

async function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

async function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

async function createLocalUser({ email, password_hash, name }) {
  try {
    const result = db.prepare(`
      INSERT INTO users (email, name, password_hash, provider) VALUES (?, ?, ?, 'local')
    `).run(email, name || null, password_hash);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  } catch { return null; }
}

async function createPasswordResetToken(email) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = toSQLiteTimestamp(new Date(Date.now() + 2 * 3600 * 1000));
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE email = ?')
    .run(token, expires, email);
  return token;
}

async function consumePasswordResetToken(token, newPasswordHash) {
  const user = db.prepare(
    "SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > datetime('now')"
  ).get(token);
  if (!user) return null;
  db.prepare(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?'
  ).run(newPasswordHash, user.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) || null;
}

// ── Mailer helpers (přesunuto z mailer.js) ─────────────────────────────────────

async function getActiveSubscribers() {
  // SQLite nemá DISTINCT ON — emulujeme přes GROUP BY + MAX
  return db.prepare(`
    SELECT email, tier, current_period_end
    FROM subscriptions
    WHERE status = 'active'
      AND (current_period_end IS NULL OR current_period_end > datetime('now'))
      AND digest_unsubscribed = 0
    GROUP BY email
    ORDER BY email
  `).all();
}

async function getSubscriberWatchlist(email) {
  return db.prepare(`
    SELECT address, label, last_risk_level, last_risk_score, last_checked_at
    FROM watchlist
    WHERE notify_email = ? AND active = 1
    ORDER BY last_risk_score DESC, created_at
  `).all(email);
}

async function getWeeklyScanSummary(email) {
  const cutoff = toSQLiteTimestamp(new Date(Date.now() - 7 * 86400000));
  return db.prepare(`
    SELECT
      COUNT(*)                                                         AS total_scans,
      SUM(CASE WHEN risk_level = 'high'     THEN 1 ELSE 0 END)        AS high_risk,
      SUM(CASE WHEN risk_level = 'critical' THEN 1 ELSE 0 END)        AS critical_risk,
      SUM(CASE WHEN risk_level = 'medium'   THEN 1 ELSE 0 END)        AS medium_risk,
      SUM(CASE WHEN scan_type  = 'deep'     THEN 1 ELSE 0 END)        AS deep_scans,
      MAX(risk_score)                                                  AS max_score,
      COUNT(DISTINCT address)                                          AS unique_addresses
    FROM scan_history
    WHERE email = ? AND created_at >= ?
  `).get(email, cutoff) || {};
}

async function getDigestAd() {
  return db.prepare(`
    SELECT id, advertiser, headline, tagline, cta_text, cta_url, image_url, cpm_usd
    FROM ads
    WHERE active = 1
      AND (placement = 'digest' OR placement = 'all')
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND (budget_usd IS NULL OR spent_usd < budget_usd)
    ORDER BY impressions ASC, RANDOM()
    LIMIT 1
  `).get() || null;
}

async function getRecentHighRiskScans(email) {
  const cutoff = toSQLiteTimestamp(new Date(Date.now() - 7 * 86400000));
  return db.prepare(`
    SELECT address, scan_type, risk_score, risk_level, summary, created_at
    FROM scan_history
    WHERE email = ?
      AND risk_level IN ('high', 'critical')
      AND created_at >= ?
    ORDER BY risk_score DESC, created_at DESC
    LIMIT 5
  `).all(email, cutoff);
}

// ── Live stats (server.js /stats endpoint) ────────────────────────────────────

async function getLiveStats() {
  // created_at is stored as 'YYYY-MM-DD HH:MM:SS' (space, no timezone) — use strftime for date comparison
  const r = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM scan_history)                                                AS total_scans,
      (SELECT COUNT(*) FROM scan_history
        WHERE strftime('%Y-%m-%d', created_at) = date('now'))                           AS scans_today,
      (SELECT COUNT(*) FROM payments WHERE verified = 1)                                AS total_payments,
      (SELECT ROUND(100.0 * COUNT(CASE WHEN risk_score IS NOT NULL THEN 1 END)
              / NULLIF(COUNT(*), 0), 1)
        FROM scan_history WHERE scan_type != 'legacy-import')                           AS success_rate_pct,
      (SELECT ROUND(AVG(CAST(json_extract(result_json, '$.scan_ms') AS INTEGER)), 0)
        FROM scan_history
        WHERE result_json IS NOT NULL
          AND json_extract(result_json, '$.scan_ms') IS NOT NULL
          AND strftime('%Y-%m-%d', created_at) >= date('now', '-7 days'))               AS avg_scan_ms
  `).get();
  return {
    total_scans:             r?.total_scans        || 0,
    scans_today:             r?.scans_today        || 0,
    total_payments:          r?.total_payments     || 0,
    success_rate_pct:        r?.success_rate_pct   || 0,
    average_response_time_ms: r?.avg_scan_ms || null
  };
}

// ── Advisor usage tracking ────────────────────────────────────────────────────

// Sonnet 4.6: $3/M input,  $15/M output  (executor)
// Opus 4.6:   $5/M input,  $25/M output  (advisor) — source: docs.anthropic.com/en/docs/about-claude/pricing
function logAdvisorUsage(scanId, scanType, result) {
  const usage = result.usage || {};
  const executorCost = ((usage.input_tokens || 0) * 3 + (usage.output_tokens || 0) * 15) / 1_000_000;
  const advisorInputTokens  = usage.advisor_input_tokens  || 0;
  const advisorOutputTokens = usage.advisor_output_tokens || 0;
  const advisorCost = (advisorInputTokens * 5 + advisorOutputTokens * 25) / 1_000_000;

  db.prepare(`
    INSERT INTO advisor_calls
      (scan_id, scan_type, advisor_invoked,
       executor_input_tokens, executor_output_tokens,
       advisor_input_tokens, advisor_output_tokens,
       estimated_cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scanId || null,
    scanType || null,
    result.advisorUsed ? 1 : 0,
    usage.input_tokens  || 0,
    usage.output_tokens || 0,
    advisorInputTokens,
    advisorOutputTokens,
    executorCost + advisorCost
  );
}

// ── Měsíční scan kvóty per subscription tier ─────────────────────────────────

// Limity: kolik paid scanů může subscriber odeslat za měsíc.
// "Paid scan" = jakýkoliv endpoint chráněný requirePayment (quick, token, wallet, pool, evm, deep, contract, adversarial, delta).
// Adversarial sims mají navíc vlastní sub-limit.
const MONTHLY_SCAN_LIMITS = {
  free:       0,      // bez API klíče — neaplikuje se (řídí FREE_SCAN_LIMIT per IP)
  pro_trader: 200,    // $15/mo → break-even ~200 scanů při avg $0.03 LLM/scan
  builder:    700,    // $49/mo → break-even ~700 scanů
  team:       3000,   // $299/mo → break-even ~3000 scanů
};

const MONTHLY_ADVERSARIAL_LIMITS = {
  pro_trader: 0,   // adversarial není zahrnut v Pro
  builder:    1,   // 1 sim/mo (jak je popsáno v ceníku)
  team:       10,  // 10 sim/mo (bonus: $20/sim za každý další)
};

/**
 * Vrátí počet paid scanů pro daný email v aktuálním kalendářním měsíci.
 * Neblokující (synchronní díky better-sqlite3).
 */
function getMonthlyScansForEmail(email) {
  if (!email) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM scan_history
    WHERE email = ?
      AND cached = 0
      AND created_at >= strftime('%Y-%m-01 00:00:00', 'now')
  `).get(email);
  return row?.cnt ?? 0;
}

/**
 * Vrátí počet adversarial simulací pro daný email v aktuálním kalendářním měsíci.
 */
function getMonthlyAdversarialForEmail(email) {
  if (!email) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM scan_history
    WHERE email = ?
      AND scan_type = 'adversarial'
      AND cached = 0
      AND created_at >= strftime('%Y-%m-01 00:00:00', 'now')
  `).get(email);
  return row?.cnt ?? 0;
}

function getAdvisorStats(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000)
    .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  return db.prepare(`
    SELECT
      COUNT(*)                                                              AS total_scans,
      SUM(CASE WHEN advisor_invoked = 1 THEN 1 ELSE 0 END)                 AS advisor_scans,
      ROUND(AVG(CASE WHEN advisor_invoked = 1
                THEN advisor_output_tokens END), 0)                        AS avg_advisor_tokens,
      ROUND(SUM(estimated_cost_usd), 4)                                    AS total_cost_usd,
      ROUND(AVG(estimated_cost_usd), 4)                                    AS avg_cost_per_scan
    FROM advisor_calls
    WHERE created_at >= ?
  `).get(cutoff);
}

// ── SQLite session store (pro auth.js) ────────────────────────────────────────

const session = require('express-session');

class SqliteStore extends session.Store {
  constructor() {
    super();
    // Periodické čištění prošlých sessions (každých 15 minut)
    setInterval(() => {
      db.prepare("DELETE FROM user_sessions WHERE expires IS NOT NULL AND expires < datetime('now')")
        .run();
    }, 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expires FROM user_sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires && new Date(row.expires) < new Date()) {
        db.prepare('DELETE FROM user_sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires
        ? toSQLiteTimestamp(new Date(sess.cookie.expires))
        : toSQLiteTimestamp(new Date(Date.now() + 30 * 24 * 3600 * 1000));
      db.prepare(
        'INSERT OR REPLACE INTO user_sessions (sid, sess, expires) VALUES (?, ?, ?)'
      ).run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM user_sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// ── Scan accuracy signals ────────────────────────────────────────────────────

function logAccuracySignal({ scanId, mint, scanType, rawScore, llmScore, finalScore, finalCategory, validationFlags }) {
  const flags = Array.isArray(validationFlags) ? validationFlags : [];
  db.prepare(`
    INSERT INTO scan_accuracy_signals
      (scan_id, mint, scan_type, raw_score, llm_score, final_score, final_category, validation_flags, corrections_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scanId    || null,
    mint      || null,
    scanType  || null,
    rawScore  ?? null,
    llmScore  ?? null,
    finalScore ?? null,
    finalCategory || null,
    JSON.stringify(flags),
    flags.length
  );
}

function logValidationIssues({ mint, scanType, valid, issues, correctionsCount }) {
  const issuesArr = Array.isArray(issues) ? issues : [];
  const escalations = issuesArr.filter(i => i.action === 'escalate').length;
  db.prepare(`
    INSERT INTO validation_log
      (mint, scan_type, valid, issues_json, corrections_count, escalations_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    mint           || null,
    scanType       || 'token-audit',
    valid ? 1 : 0,
    JSON.stringify(issuesArr),
    correctionsCount ?? 0,
    escalations
  );
}

function logUserFeedback(mint, feedback, note) {
  // Update the most recent signal for this mint
  db.prepare(`
    UPDATE scan_accuracy_signals
    SET user_feedback = ?, feedback_note = ?
    WHERE mint = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).run(feedback, note || null, mint);
}

function getAccuracyStats(hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(corrections_count)                                             AS total_corrections,
      SUM(CASE WHEN corrections_count > 0 THEN 1 ELSE 0 END)           AS corrected_count,
      ROUND(100.0 * SUM(CASE WHEN corrections_count > 0 THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*), 0), 1)                                   AS corrected_pct,
      SUM(CASE WHEN user_feedback = 'false_positive' THEN 1 ELSE 0 END) AS false_positives,
      SUM(CASE WHEN user_feedback = 'false_negative' THEN 1 ELSE 0 END) AS false_negatives,
      SUM(CASE WHEN user_feedback = 'correct'        THEN 1 ELSE 0 END) AS confirmed_correct
    FROM scan_accuracy_signals
    WHERE created_at >= ?
  `).get(since);

  const topFlags = db.prepare(`
    SELECT f.value AS flag, COUNT(*) AS count
    FROM scan_accuracy_signals s,
         json_each(s.validation_flags) f
    WHERE s.created_at >= ? AND s.corrections_count > 0
    GROUP BY f.value
    ORDER BY count DESC
    LIMIT 10
  `).all(since);

  const byCategory = db.prepare(`
    SELECT final_category, COUNT(*) AS count,
           ROUND(AVG(CASE WHEN corrections_count > 0 THEN 1.0 ELSE 0 END) * 100, 1) AS corrected_pct
    FROM scan_accuracy_signals
    WHERE created_at >= ?
    GROUP BY final_category
  `).all(since);

  return { hours, since, totals, topFlags, byCategory };
}

// Uloží feedback k oracle receiptu. Klíč = envelope_signature → duplikát je tiché IGNORE.
function recordReceiptFeedback({ envelopeSignature, address, oracleVerdict, source, verdict, note }) {
  const VALID = new Set(['false_positive', 'false_negative', 'correct']);
  if (!VALID.has(verdict)) throw new Error('invalid_verdict');
  db.prepare(`
    INSERT OR IGNORE INTO scan_accuracy_signals
      (envelope_signature, address, oracle_verdict, source, user_feedback, feedback_note, scan_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    envelopeSignature || null,
    address           || null,
    oracleVerdict     || null,
    source            || null,
    verdict,
    note              || null,
    source            || null,
  );
}

function getReceiptFeedbackSummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                                                 AS total,
      SUM(CASE WHEN user_feedback = 'false_positive' THEN 1 ELSE 0 END)       AS false_positives,
      SUM(CASE WHEN user_feedback = 'false_negative' THEN 1 ELSE 0 END)       AS false_negatives,
      SUM(CASE WHEN user_feedback = 'correct'        THEN 1 ELSE 0 END)       AS confirmed_correct
    FROM scan_accuracy_signals
    WHERE envelope_signature IS NOT NULL
  `).get();

  const bySource = db.prepare(`
    SELECT source,
           COUNT(*)                                                            AS total,
           SUM(CASE WHEN user_feedback = 'false_positive' THEN 1 ELSE 0 END)  AS false_positives,
           SUM(CASE WHEN user_feedback = 'false_negative' THEN 1 ELSE 0 END)  AS false_negatives,
           SUM(CASE WHEN user_feedback = 'correct'        THEN 1 ELSE 0 END)  AS confirmed_correct
    FROM scan_accuracy_signals
    WHERE envelope_signature IS NOT NULL
    GROUP BY source
    ORDER BY total DESC
  `).all();

  const recent = db.prepare(`
    SELECT address, source, oracle_verdict, user_feedback, feedback_note, created_at
    FROM scan_accuracy_signals
    WHERE envelope_signature IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `).all();

  return { totals, by_source: bySource, recent };
}

// ── Abuse events ──────────────────────────────────────────────────────────────

function logAbuseEvent(ip, eventType, details) {
  db.prepare(`
    INSERT INTO abuse_events (ip, event_type, details, occurred_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(ip, eventType, details ? JSON.stringify(details) : null);
}

function getAbuseStats(hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`
    SELECT event_type, COUNT(*) AS count, COUNT(DISTINCT ip) AS unique_ips
    FROM abuse_events
    WHERE occurred_at >= ?
    GROUP BY event_type
    ORDER BY count DESC
  `).all(since);
}

// ── IP blacklist ──────────────────────────────────────────────────────────────

function isIpBlacklisted(ip) {
  const row = db.prepare(`
    SELECT ip FROM ip_blacklist
    WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(ip);
  return !!row;
}

function blacklistIp(ip, reason, expiresInMs = null) {
  const expiresAt = expiresInMs
    ? new Date(Date.now() + expiresInMs).toISOString().slice(0, 19)
    : null;
  db.prepare(`
    INSERT INTO ip_blacklist (ip, reason, added_at, expires_at, hit_count)
    VALUES (?, ?, datetime('now'), ?, 0)
    ON CONFLICT(ip) DO UPDATE SET
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      hit_count = hit_count + 1
  `).run(ip, reason, expiresAt);
}

function cleanExpiredBlacklist() {
  return db.prepare(`DELETE FROM ip_blacklist WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')`).run().changes;
}

// ── Global scan stats ─────────────────────────────────────────────────────────

function incrementGlobalScanStats(type) {
  const col = type === 'paid' ? 'paid_count' : 'free_count';
  db.prepare(`
    INSERT INTO global_scan_stats (stat_date, free_count, paid_count)
    VALUES (date('now'), 0, 0)
    ON CONFLICT(stat_date) DO UPDATE SET ${col} = ${col} + 1
  `).run();
}

function getGlobalScanStats(days = 7) {
  return db.prepare(`
    SELECT stat_date, free_count, paid_count, (free_count + paid_count) AS total
    FROM global_scan_stats
    ORDER BY stat_date DESC
    LIMIT ?
  `).all(days);
}

// ── IRIS enrichment (read-only — zapisuje offline skript) ─────────────────────

function getIrisEnrichment(mint) {
  return db.prepare('SELECT * FROM iris_enrichment WHERE mint = ?').get(mint);
}

// ── Known scams databáze ──────────────────────────────────────────────────────

function lookupKnownScam(mint) {
  const row = db.prepare('SELECT * FROM known_scams WHERE mint = ?').get(mint);
  if (!row) return null;
  try { row.raw_data = row.raw_data ? JSON.parse(row.raw_data) : null; } catch {}
  return row;
}

function upsertKnownScam({
  mint, source, scam_type, confidence, label, raw_data,
  creator, first_seen_at, first_seen_slot, rug_pattern, confidence_score
}) {
  db.prepare(`
    INSERT INTO known_scams
      (mint, source, scam_type, confidence, label, raw_data,
       creator, first_seen_at, first_seen_slot, rug_pattern, confidence_score,
       updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mint) DO UPDATE SET
      source           = excluded.source,
      scam_type        = excluded.scam_type,
      confidence       = excluded.confidence,
      label            = excluded.label,
      raw_data         = excluded.raw_data,
      creator          = COALESCE(excluded.creator, known_scams.creator),
      first_seen_at    = COALESCE(excluded.first_seen_at, known_scams.first_seen_at),
      first_seen_slot  = COALESCE(excluded.first_seen_slot, known_scams.first_seen_slot),
      rug_pattern      = COALESCE(excluded.rug_pattern, known_scams.rug_pattern),
      confidence_score = COALESCE(excluded.confidence_score, known_scams.confidence_score),
      updated_at       = datetime('now')
  `).run(
    mint,
    source,
    scam_type      || null,
    confidence     != null ? confidence : 1.0,
    label          || null,
    raw_data       ? JSON.stringify(raw_data) : null,
    creator        || null,
    first_seen_at  || null,
    first_seen_slot != null ? first_seen_slot : null,
    rug_pattern    || null,
    confidence_score != null ? confidence_score : null
  );
}

function getKnownScamsCount() {
  return db.prepare('SELECT COUNT(*) AS cnt FROM known_scams').get().cnt;
}

// ── Scam creators (guilt-by-association) ─────────────────────────────────────

/**
 * Vyhledá wallet address v tabulce scam_creators.
 * @param {string} walletAddress
 * @returns {{ isKnownScammer: boolean, scamCount: number, lastScamAt: string|null, patterns: string[] }|null}
 */
function lookupScamCreator(walletAddress) {
  if (!walletAddress || typeof walletAddress !== 'string') return null;
  const row = db.prepare('SELECT * FROM scam_creators WHERE creator_wallet = ?').get(walletAddress);
  if (!row) return null;
  let patterns = [];
  try { patterns = row.patterns ? JSON.parse(row.patterns) : []; } catch {}
  return {
    isKnownScammer: true,
    scamCount:      row.scam_count,
    lastScamAt:     row.last_scam_at,
    patterns,
  };
}

/**
 * Přepočítá / naplní tabulku scam_creators z known_scams.
 * Spouštěno po importu — není třeba volat za běhu.
 */
function rebuildScamCreators() {
  db.exec("DELETE FROM scam_creators");
  db.prepare(`
    INSERT INTO scam_creators (creator_wallet, scam_count, last_scam_at, patterns)
    SELECT
      creator,
      COUNT(*)                                                              AS scam_count,
      MAX(COALESCE(first_seen_at, created_at))                             AS last_scam_at,
      json_group_array(DISTINCT rug_pattern) FILTER (WHERE rug_pattern IS NOT NULL) AS patterns
    FROM known_scams
    WHERE creator IS NOT NULL AND creator != ''
    GROUP BY creator
    HAVING COUNT(*) >= 1
  `).run();
  return db.prepare('SELECT COUNT(*) AS cnt FROM scam_creators').get().cnt;
}

// ── RugCheck API cache ────────────────────────────────────────────────────────
const RUGCHECK_CACHE_TTL_MS = 24 * 3_600_000; // 24 hodin

function getRugcheckCache(mint) {
  const row = db.prepare('SELECT * FROM rugcheck_cache WHERE mint = ?').get(mint);
  if (!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > RUGCHECK_CACHE_TTL_MS) return null; // expirovaná cache
  try { row.risks_json = row.risks_json ? JSON.parse(row.risks_json) : []; } catch { row.risks_json = []; }
  try { row.raw_json   = row.raw_json   ? JSON.parse(row.raw_json)   : {}; } catch { row.raw_json   = {}; }
  return row;
}

function setRugcheckCache({ mint, risk_level, score, score_norm, rugged, risks, raw }) {
  db.prepare(`
    INSERT INTO rugcheck_cache (mint, risk_level, score, score_norm, rugged, risks_json, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mint) DO UPDATE SET
      risk_level = excluded.risk_level,
      score      = excluded.score,
      score_norm = excluded.score_norm,
      rugged     = excluded.rugged,
      risks_json = excluded.risks_json,
      raw_json   = excluded.raw_json,
      fetched_at = datetime('now')
  `).run(
    mint,
    risk_level || null,
    score ?? null,
    score_norm ?? null,
    rugged ? 1 : 0,
    JSON.stringify(risks || []),
    raw ? JSON.stringify(raw) : null
  );
}

module.exports = {
  db, pool, initSchema, initUsersSchema, initAdsSchema,
  logPayment, isAlreadyUsed, markSignatureUsed, logEvent,
  getFunnelStats, getPaymentStats, getPageviewStats,
  countFreeScansToday,
  addWatchlistEntry, removeWatchlistEntry, getActiveWatchlist,
  updateWatchlistRisk, listWatchlistForChat,
  addUserWatchlistEntry, removeUserWatchlistEntry, getUserWatchlist,
  upsertSubscription, getActiveSubscription, getActiveSubscriptionByChatId,
  countWatchlistForEmail, countWatchlistForChat,
  createApiKey, validateApiKey, incrementApiKeyUsage, listApiKeys, revokeApiKey,
  logScanToHistory, getScanHistory, getCachedScanFromDb,
  getAdForPlacement, trackAdImpression, trackAdClick, listAds, createAd, updateAd,
  // Users (přesunuto z auth.js)
  findOrCreateUser, findUserById, findUserByEmail,
  createLocalUser, createPasswordResetToken, consumePasswordResetToken,
  // Mailer helpers
  getActiveSubscribers, getSubscriberWatchlist, getWeeklyScanSummary,
  getDigestAd, getRecentHighRiskScans,
  // Live stats
  getLiveStats,
  // Accuracy monitoring
  logAccuracySignal, logUserFeedback, getAccuracyStats,
  recordReceiptFeedback, getReceiptFeedbackSummary,
  // Abuse & IP blacklist
  logAbuseEvent, getAbuseStats,
  isIpBlacklisted, blacklistIp, cleanExpiredBlacklist,
  // Global scan stats
  incrementGlobalScanStats, getGlobalScanStats,
  // IRIS enrichment
  getIrisEnrichment,
  // Validation log
  logValidationIssues,
  // Scam database
  lookupKnownScam, upsertKnownScam, getKnownScamsCount,
  lookupScamCreator, rebuildScamCreators,
  // RugCheck cache
  getRugcheckCache, setRugcheckCache,
  // Advisor usage
  logAdvisorUsage, getAdvisorStats,
  MONTHLY_SCAN_LIMITS, MONTHLY_ADVERSARIAL_LIMITS,
  getMonthlyScansForEmail, getMonthlyAdversarialForEmail,
  // Session store
  SqliteStore
};
