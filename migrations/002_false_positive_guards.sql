-- False positive guards: token whitelist for inactivity scanner
-- Migration 002 — run after 001_solrpds_extension.sql

CREATE TABLE IF NOT EXISTS token_whitelist (
  mint       TEXT    PRIMARY KEY,
  symbol     TEXT,
  name       TEXT,
  source     TEXT    NOT NULL DEFAULT 'jupiter_strict',
  added_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_whitelist_source ON token_whitelist(source);
