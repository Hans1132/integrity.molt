const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Vytvoří tabulky pokud neexistují; volá se při startu serveru.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id                  BIGSERIAL PRIMARY KEY,
      tx_sig              TEXT        NOT NULL UNIQUE,
      resource            TEXT        NOT NULL,
      required_micro_usdc BIGINT      NOT NULL,
      micro_usdc          BIGINT      NOT NULL DEFAULT 0,
      verified            BOOLEAN     NOT NULL DEFAULT FALSE,
      reason              TEXT,
      ip                  TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS payments_created_at ON payments (created_at DESC);
    CREATE INDEX IF NOT EXISTS payments_verified   ON payments (verified, created_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      resource   TEXT,
      ip         TEXT,
      meta       JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_name_created ON events (name, created_at DESC);
    CREATE INDEX IF NOT EXISTS events_created_at   ON events (created_at DESC);

    CREATE TABLE IF NOT EXISTS watchlist (
      id                   BIGSERIAL    PRIMARY KEY,
      address              TEXT         NOT NULL,
      label                TEXT,
      notify_telegram_chat TEXT,
      notify_email         TEXT,
      last_checked_at      TIMESTAMPTZ,
      last_risk_level      TEXT,
      last_risk_summary    TEXT,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
      active               BOOLEAN      NOT NULL DEFAULT TRUE,
      CONSTRAINT watchlist_address_chat_uniq UNIQUE (address, notify_telegram_chat)
    );
    CREATE INDEX IF NOT EXISTS watchlist_active  ON watchlist (active, last_checked_at);
    CREATE INDEX IF NOT EXISTS watchlist_address ON watchlist (address);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                  BIGSERIAL    PRIMARY KEY,
      stripe_customer_id  TEXT         NOT NULL,
      stripe_sub_id       TEXT         UNIQUE,
      email               TEXT         NOT NULL,
      tier                TEXT         NOT NULL,
      status              TEXT         NOT NULL DEFAULT 'incomplete',
      current_period_end  TIMESTAMPTZ,
      telegram_chat_id    TEXT,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS subscriptions_email  ON subscriptions (email);
    CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions (status, current_period_end);

    CREATE TABLE IF NOT EXISTS api_keys (
      id            BIGSERIAL    PRIMARY KEY,
      key_hash      TEXT         NOT NULL UNIQUE,
      key_prefix    TEXT         NOT NULL,
      email         TEXT         NOT NULL,
      tier          TEXT         NOT NULL,
      label         TEXT,
      usage_count   BIGINT       NOT NULL DEFAULT 0,
      last_used_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      revoked_at    TIMESTAMPTZ,
      active        BOOLEAN      NOT NULL DEFAULT TRUE
    );
    CREATE INDEX IF NOT EXISTS api_keys_email ON api_keys (email, active);
    CREATE INDEX IF NOT EXISTS api_keys_hash  ON api_keys (key_hash);

    CREATE TABLE IF NOT EXISTS scan_history (
      id         BIGSERIAL    PRIMARY KEY,
      email      TEXT,
      address    TEXT         NOT NULL,
      scan_type  TEXT         NOT NULL,
      risk_score INTEGER,
      risk_level TEXT,
      summary    TEXT,
      cached     BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS scan_history_email ON scan_history (email, created_at DESC);
    CREATE INDEX IF NOT EXISTS scan_history_created ON scan_history (created_at DESC);
  `);
  // Migrate existing scan_history + watchlist tables
  await pool.query(`
    ALTER TABLE scan_history ADD COLUMN IF NOT EXISTS result_json JSONB;
    CREATE INDEX IF NOT EXISTS scan_history_addr_type ON scan_history (address, scan_type, created_at DESC);
    ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS notify_email TEXT;
    ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS last_risk_score INTEGER;
    CREATE INDEX IF NOT EXISTS watchlist_email ON watchlist (notify_email, active);
  `).catch(() => {});
}

// Uloží záznam o platbě. tx_sig má UNIQUE constraint — duplicitní INSERT je ignorován.
async function logPayment({ tx_sig, resource, required_micro_usdc, micro_usdc, verified, reason, ip }) {
  await pool.query(
    `INSERT INTO payments (tx_sig, resource, required_micro_usdc, micro_usdc, verified, reason, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tx_sig) DO NOTHING`,
    [tx_sig, resource, required_micro_usdc, micro_usdc, verified, reason, ip]
  );
}

// Vrátí true pokud transakce se stejným sig už byla úspěšně ověřena.
// UNIQUE constraint + tato kontrola spolu zabraňují replay útokům.
async function isAlreadyUsed(sig) {
  const { rows } = await pool.query(
    'SELECT 1 FROM payments WHERE tx_sig = $1 AND verified = TRUE LIMIT 1',
    [sig]
  );
  return rows.length > 0;
}

// Zaznamená funnel událost. Fire-and-forget — chyby se logují, ale neblokují response.
async function logEvent({ name, resource, ip, meta }) {
  await pool.query(
    'INSERT INTO events (name, resource, ip, meta) VALUES ($1, $2, $3, $4)',
    [name, resource || null, ip || null, meta ? JSON.stringify(meta) : null]
  );
}

// Vrátí konverzní statistiky funnelu za posledních N dní.
async function getFunnelStats(days = 30) {
  const { rows } = await pool.query(`
    SELECT
      name,
      COUNT(*)                                          AS total,
      COUNT(DISTINCT ip)                                AS unique_ips,
      date_trunc('day', created_at AT TIME ZONE 'UTC') AS day
    FROM events
    WHERE created_at >= now() - ($1 || ' days')::INTERVAL
    GROUP BY name, day
    ORDER BY day DESC, name
  `, [days]);
  return rows;
}

// Vrátí přehled úspěšnosti plateb za posledních N dní.
async function getPaymentStats(days = 30) {
  const { rows } = await pool.query(`
    SELECT
      date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
      resource,
      COUNT(*)                                          AS attempts,
      SUM(CASE WHEN verified THEN 1 ELSE 0 END)        AS verified,
      ROUND(
        100.0 * SUM(CASE WHEN verified THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1
      )                                                 AS verified_pct,
      SUM(CASE WHEN verified THEN micro_usdc ELSE 0 END) AS revenue_micro_usdc
    FROM payments
    WHERE created_at >= now() - ($1 || ' days')::INTERVAL
    GROUP BY day, resource
    ORDER BY day DESC, resource
  `, [days]);
  return rows;
}

// ── Watchlist ──────────────────────────────────────────────────────────────────

async function addWatchlistEntry({ address, label, notify_telegram_chat, notify_email }) {
  const { rows } = await pool.query(
    `INSERT INTO watchlist (address, label, notify_telegram_chat, notify_email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (address, notify_telegram_chat) DO UPDATE
       SET active = TRUE, label = EXCLUDED.label
     RETURNING id, address, label, created_at`,
    [address, label || null, notify_telegram_chat || null, notify_email || null]
  );
  return rows[0];
}

async function removeWatchlistEntry(id, notify_telegram_chat) {
  const { rowCount } = await pool.query(
    `UPDATE watchlist SET active = FALSE
     WHERE id = $1 AND (notify_telegram_chat = $2 OR $2 IS NULL)`,
    [id, notify_telegram_chat || null]
  );
  return rowCount > 0;
}

async function getActiveWatchlist() {
  const { rows } = await pool.query(
    `SELECT id, address, label, notify_telegram_chat, notify_email,
            last_checked_at, last_risk_level
     FROM watchlist
     WHERE active = TRUE
     ORDER BY last_checked_at ASC NULLS FIRST`
  );
  return rows;
}

async function updateWatchlistRisk(id, { risk_level, risk_score, risk_summary }) {
  await pool.query(
    `UPDATE watchlist
     SET last_checked_at = now(), last_risk_level = $2, last_risk_score = $3, last_risk_summary = $4
     WHERE id = $1`,
    [id, risk_level, risk_score ?? null, risk_summary]
  );
}

async function listWatchlistForChat(notify_telegram_chat) {
  const { rows } = await pool.query(
    `SELECT id, address, label, last_risk_level, last_checked_at
     FROM watchlist
     WHERE notify_telegram_chat = $1 AND active = TRUE
     ORDER BY created_at`,
    [notify_telegram_chat]
  );
  return rows;
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

async function upsertSubscription({ stripe_customer_id, stripe_sub_id, email, tier, status, current_period_end, telegram_chat_id }) {
  await pool.query(
    `INSERT INTO subscriptions (stripe_customer_id, stripe_sub_id, email, tier, status, current_period_end, telegram_chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stripe_sub_id) DO UPDATE SET
       status             = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       tier               = EXCLUDED.tier,
       updated_at         = now()`,
    [stripe_customer_id, stripe_sub_id, email, tier, status,
     current_period_end ? new Date(current_period_end * 1000) : null,
     telegram_chat_id || null]
  );
}

async function getActiveSubscription(email) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
     WHERE email = $1 AND status = 'active'
       AND (current_period_end IS NULL OR current_period_end > now())
     ORDER BY current_period_end DESC NULLS LAST
     LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

// Vrátí statistiky zobrazení stránek za posledních N dní.
async function getPageviewStats(days = 30) {
  const { rows } = await pool.query(`
    SELECT
      date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
      meta->>'path'                                     AS path,
      COUNT(*)                                          AS views,
      COUNT(DISTINCT ip)                                AS uniq
    FROM events
    WHERE name = 'page_view'
      AND created_at >= now() - ($1 || ' days')::INTERVAL
    GROUP BY day, path
    ORDER BY day DESC, views DESC
  `, [days]);
  return rows;
}

// ── API Keys ────────────────────────────────────────────────────────────────────

// Vygeneruje nový API klíč tvaru im_<64hex>, uloží SHA-256 hash; vrátí raw key (jen jednou).
async function createApiKey({ email, tier, label }) {
  const raw    = 'im_' + crypto.randomBytes(32).toString('hex');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.substring(0, 10); // "im_" + 7 znaků pro zobrazení
  const { rows } = await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, email, tier, label)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, key_prefix, email, tier, label, created_at`,
    [hash, prefix, email, tier, label || null]
  );
  return { ...rows[0], key: raw };
}

// Ověří raw API klíč; vrátí záznam nebo null.
async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('im_')) return null;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { rows } = await pool.query(
    `SELECT * FROM api_keys WHERE key_hash = $1 AND active = TRUE LIMIT 1`,
    [hash]
  );
  return rows[0] || null;
}

// Inkrementuje usage_count a nastaví last_used_at.
async function incrementApiKeyUsage(id) {
  await pool.query(
    `UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = now() WHERE id = $1`,
    [id]
  );
}

// Vrátí seznam aktivních klíčů pro daný email (bez hash hodnot).
async function listApiKeys(email) {
  const { rows } = await pool.query(
    `SELECT id, key_prefix, email, tier, label, usage_count, last_used_at, created_at
     FROM api_keys
     WHERE email = $1 AND active = TRUE
     ORDER BY created_at DESC`,
    [email]
  );
  return rows;
}

// Odvolá klíč (soft delete); vrátí true pokud byl klíč nalezen a vlastněn emailem.
async function revokeApiKey(id, email) {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET active = FALSE, revoked_at = now()
     WHERE id = $1 AND email = $2`,
    [id, email]
  );
  return rowCount > 0;
}

// ── Scan history ───────────────────────────────────────────────────────────────

async function logScanToHistory({ email, address, scan_type, risk_score, risk_level, summary, cached, result_json }) {
  await pool.query(
    `INSERT INTO scan_history (email, address, scan_type, risk_score, risk_level, summary, cached, result_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [email || null, address, scan_type, risk_score ?? null, risk_level || null,
     (summary || '').slice(0, 300), cached ? true : false, result_json ? JSON.stringify(result_json) : null]
  );
}

async function getCachedScanFromDb(address, scan_type, maxAgeMs = 3_600_000) {
  const { rows } = await pool.query(
    `SELECT result_json, risk_score, risk_level, summary, created_at
     FROM scan_history
     WHERE address = $1 AND scan_type = $2 AND result_json IS NOT NULL
       AND created_at > now() - ($3 || ' milliseconds')::interval
     ORDER BY created_at DESC
     LIMIT 1`,
    [address, scan_type, maxAgeMs]
  );
  if (!rows.length) return null;
  return rows[0].result_json;
}

async function getScanHistory(email, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, address, scan_type, risk_score, risk_level, summary, cached, created_at
     FROM scan_history
     WHERE email = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [email, limit]
  );
  return rows;
}

// ── User-based watchlist (keyed by email, no telegram_chat_id required) ────────

async function addUserWatchlistEntry({ email, address, label, notify_email }) {
  // notify_email může být null (uživatel nechce email notifikace)
  // email je vždy účet vlastníka záznamu — ukládáme jako notify_email pokud chce notifikace
  const notifyEmail = notify_email !== undefined ? notify_email : email;
  const { rows } = await pool.query(
    `INSERT INTO watchlist (address, label, notify_email)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id, address, label, created_at`,
    [address, label || null, notifyEmail]
  );
  // If conflict (reactivate deactivated entry)
  if (!rows[0]) {
    const existing = await pool.query(
      `UPDATE watchlist SET active = TRUE, label = COALESCE($3, label), notify_email = $4
       WHERE address = $1 AND (notify_email = $2 OR $2 IS NULL) AND active = FALSE
       RETURNING id, address, label, created_at`,
      [address, notifyEmail, label || null, notifyEmail]
    );
    return existing.rows[0] || null;
  }
  return rows[0];
}

async function removeUserWatchlistEntry({ email, id }) {
  const { rowCount } = await pool.query(
    `UPDATE watchlist SET active = FALSE WHERE id = $1 AND notify_email = $2`,
    [id, email]
  );
  return rowCount > 0;
}

async function getUserWatchlist(email) {
  const { rows } = await pool.query(
    `SELECT id, address, label, last_risk_level, last_risk_score, last_checked_at, created_at
     FROM watchlist
     WHERE notify_email = $1 AND active = TRUE
     ORDER BY created_at DESC`,
    [email]
  );
  return rows;
}

// ── Ads ────────────────────────────────────────────────────────────────────────

async function initAdsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id              BIGSERIAL    PRIMARY KEY,
      advertiser      TEXT         NOT NULL,
      headline        TEXT         NOT NULL,
      tagline         TEXT,
      cta_text        TEXT         NOT NULL DEFAULT 'Learn more',
      cta_url         TEXT         NOT NULL,
      image_url       TEXT,
      placement       TEXT         NOT NULL DEFAULT 'scan_result',
      -- scan_result | homepage | digest | all
      active          BOOLEAN      NOT NULL DEFAULT TRUE,
      impressions     BIGINT       NOT NULL DEFAULT 0,
      clicks          BIGINT       NOT NULL DEFAULT 0,
      budget_usd      NUMERIC(10,2),
      spent_usd       NUMERIC(10,2) NOT NULL DEFAULT 0,
      cpm_usd         NUMERIC(6,2) NOT NULL DEFAULT 5.00,
      -- expires_at NULL = nikdy
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ads_placement_active ON ads (placement, active, expires_at);
  `);
}

// Vrátí aktivní reklamu pro daný placement (round-robin dle nejméně zobrazené)
async function getAdForPlacement(placement) {
  const { rows } = await pool.query(`
    SELECT id, advertiser, headline, tagline, cta_text, cta_url, image_url, impressions, clicks
    FROM ads
    WHERE active = TRUE
      AND (placement = $1 OR placement = 'all')
      AND (expires_at IS NULL OR expires_at > now())
      AND (budget_usd IS NULL OR spent_usd < budget_usd)
    ORDER BY impressions ASC, RANDOM()
    LIMIT 1
  `, [placement]);
  return rows[0] || null;
}

async function trackAdImpression(id, spent_increment_usd) {
  await pool.query(
    `UPDATE ads SET impressions = impressions + 1, spent_usd = spent_usd + $2 WHERE id = $1`,
    [id, spent_increment_usd || 0]
  );
}

async function trackAdClick(id) {
  const { rows } = await pool.query(
    `UPDATE ads SET clicks = clicks + 1 WHERE id = $1 RETURNING cta_url`,
    [id]
  );
  return rows[0]?.cta_url || null;
}

async function listAds() {
  const { rows } = await pool.query(
    `SELECT *, ROUND(100.0 * clicks / NULLIF(impressions, 0), 2) AS ctr
     FROM ads ORDER BY created_at DESC`
  );
  return rows;
}

async function createAd({ advertiser, headline, tagline, cta_text, cta_url, image_url, placement, budget_usd, cpm_usd, expires_at }) {
  const { rows } = await pool.query(
    `INSERT INTO ads (advertiser, headline, tagline, cta_text, cta_url, image_url, placement, budget_usd, cpm_usd, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [advertiser, headline, tagline || null, cta_text || 'Learn more', cta_url,
     image_url || null, placement || 'scan_result',
     budget_usd || null, cpm_usd || 5.00, expires_at || null]
  );
  return rows[0];
}

async function updateAd(id, fields) {
  const allowed = ['headline','tagline','cta_text','cta_url','image_url','placement','active','budget_usd','cpm_usd','expires_at'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE ads SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return rows[0] || null;
}

// ── Vrátí počet free scanů pro danou IP od začátku dnešního dne (UTC).
async function countFreeScansToday(ip) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM events
     WHERE name = 'free_scan_used' AND ip = $1
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [ip]
  );
  return parseInt(rows[0].cnt, 10);
}

module.exports = {
  pool, initSchema, logPayment, isAlreadyUsed, logEvent,
  getFunnelStats, getPaymentStats,
  addWatchlistEntry, removeWatchlistEntry, getActiveWatchlist,
  updateWatchlistRisk, listWatchlistForChat,
  upsertSubscription, getActiveSubscription,
  createApiKey, validateApiKey, incrementApiKeyUsage, listApiKeys, revokeApiKey,
  getPageviewStats, countFreeScansToday,
  logScanToHistory, getScanHistory, getCachedScanFromDb,
  addUserWatchlistEntry, removeUserWatchlistEntry, getUserWatchlist,
  initAdsSchema, getAdForPlacement, trackAdImpression, trackAdClick, listAds, createAd, updateAd
};
