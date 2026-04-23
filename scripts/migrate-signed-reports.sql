-- migrate-signed-reports.sql
-- DO NOT run against production without backup.
-- Run with: sqlite3 data/intmolt.db < scripts/migrate-signed-reports.sql

CREATE TABLE IF NOT EXISTS signed_reports (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id                 TEXT    UNIQUE NOT NULL,
  target_address            TEXT    NOT NULL,
  scan_type                 TEXT    NOT NULL,
  verdict_hash              TEXT    NOT NULL,
  verdict_json              TEXT    NOT NULL,
  signature_b64             TEXT    NOT NULL,
  signed_at                 INTEGER NOT NULL,
  key_id                    TEXT    NOT NULL DEFAULT 'integrity-molt-primary-2026',
  scam_db_snapshot_count    INTEGER,
  iris_version              TEXT,
  merkle_leaf_hash          TEXT,
  merkle_batch_id           TEXT
);

CREATE INDEX IF NOT EXISTS idx_signed_reports_target  ON signed_reports (target_address);
CREATE INDEX IF NOT EXISTS idx_signed_reports_signed  ON signed_reports (signed_at);
CREATE INDEX IF NOT EXISTS idx_signed_reports_id      ON signed_reports (report_id);

CREATE TABLE IF NOT EXISTS receipts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id                TEXT    UNIQUE NOT NULL,
  report_id                 TEXT    NOT NULL,
  payer_pubkey              TEXT    NOT NULL,
  amount_usdc_atomic        INTEGER NOT NULL,
  solana_tx_sig             TEXT,
  resource_path             TEXT    NOT NULL,
  scope                     TEXT,
  issued_at                 INTEGER NOT NULL,
  expires_at                INTEGER,
  receipt_signature_b64     TEXT,
  verification_payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_receipts_payer     ON receipts (payer_pubkey);
CREATE INDEX IF NOT EXISTS idx_receipts_tx_sig    ON receipts (solana_tx_sig);
CREATE INDEX IF NOT EXISTS idx_receipts_report_id ON receipts (report_id);
