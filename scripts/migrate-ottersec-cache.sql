-- migrate-ottersec-cache.sql
-- OtterSec verify.osec.io API cache + circuit breaker backing store.
-- Run with: sqlite3 data/intmolt.db < scripts/migrate-ottersec-cache.sql

CREATE TABLE IF NOT EXISTS ottersec_verifications (
  program_id       TEXT    PRIMARY KEY,
  is_verified      INTEGER NOT NULL,
  on_chain_hash    TEXT,
  executable_hash  TEXT,
  repo_url         TEXT,
  last_verified_at TEXT,
  source           TEXT    NOT NULL DEFAULT 'ottersec_api',
  fetched_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  fetch_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ottersec_expires ON ottersec_verifications(expires_at);
CREATE INDEX IF NOT EXISTS idx_ottersec_fetched ON ottersec_verifications(fetched_at);
