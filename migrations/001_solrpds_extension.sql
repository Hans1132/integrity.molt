-- Pool activity tracking (per (pool_address, mint) pair)
CREATE TABLE IF NOT EXISTS pool_activity (
  pool_address TEXT NOT NULL,
  mint TEXT NOT NULL,
  total_added_liquidity REAL DEFAULT 0,
  total_removed_liquidity REAL DEFAULT 0,
  add_count INTEGER DEFAULT 0,
  remove_count INTEGER DEFAULT 0,
  first_activity_ts INTEGER,
  last_activity_ts INTEGER,
  last_liquidity_remove_ts INTEGER,
  last_swap_ts INTEGER,
  last_swap_tx TEXT,
  inactivity_status TEXT DEFAULT 'active' CHECK(inactivity_status IN ('active', 'inactive')),
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (pool_address, mint)
);

CREATE INDEX IF NOT EXISTS idx_pool_mint ON pool_activity(mint);
CREATE INDEX IF NOT EXISTS idx_inactivity ON pool_activity(inactivity_status, last_activity_ts);
CREATE INDEX IF NOT EXISTS idx_pool_updated ON pool_activity(updated_at);

-- Polling state - track last seen tx per DEX
CREATE TABLE IF NOT EXISTS polling_state (
  dex_program_id TEXT PRIMARY KEY,
  dex_name TEXT NOT NULL,
  last_seen_signature TEXT,
  last_seen_ts INTEGER,
  last_poll_ts INTEGER,
  last_poll_tx_count INTEGER DEFAULT 0,
  last_poll_credits_used INTEGER DEFAULT 0,
  total_polls INTEGER DEFAULT 0,
  total_credits_used INTEGER DEFAULT 0,
  total_tx_processed INTEGER DEFAULT 0,
  last_error TEXT,
  last_error_ts INTEGER,
  created_at INTEGER DEFAULT (unixepoch() * 1000)
);
