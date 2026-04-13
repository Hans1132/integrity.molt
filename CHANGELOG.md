# Changelog — integrity.molt

All notable changes to integrity.molt are documented here.
Format: `## [vX.Y.Z] — YYYY-MM-DD`

---

## [v0.5.0] — 2026-04-13

### Added
- **Pro Trader subscription tier** ($15/mo) — 20 watchlist addresses, unlimited scans, Telegram + email alerts, weekly delta report, signed reports
- **Scam token database** — integrated SolRPDS + RugCheck archives; 17 000+ known scam tokens checked at scan time before LLM invocation
- **EVM scam detection** — fee asymmetry analysis, holder concentration check, mint/burn risk patterns across Ethereum, BSC, Polygon, Arbitrum, Base
- **Scan accuracy monitoring** — `scan_accuracy_signals` table, `/api/v1/admin/accuracy` endpoint, user feedback via `/api/v1/feedback`
- **LLM scan validator** — prevents false negatives and hallucinations; 6 validation rules, prompt anchoring, JSON schema enforcement
- **Golden dataset regression suite** — 17 tokens (SolRPDS + Jupiter), 29 accuracy tests, gate in `test-gate.sh`

### Changed
- Pricing unified: wallet / pool / token-audit all $0.75; deep audit $5.00
- 3-column paywall layout with Pro Trader $15 tier prominently featured
- Scan type cards now have full click targets (entire card clickable)

### Fixed
- Helius RPC deduplication in fork.js — eliminates redundant on-chain calls
- `scans_today` always returning zero (date format mismatch in SQL)
- SOL/USDC payment thresholds separated (previously mixed up)
- ATA verification and anti-replay protection added to payment middleware
- CAPTCHA: replaced Cloudflare Turnstile with HMAC-signed math CAPTCHA (no external dependency)
- Google OAuth strategy now correctly registered on startup
- Stripe Pro Trader price ID configured (`price_1TLgkyHPCh953ukRC7Uw6rqr`)

### Security
- `events.jsonl` 50 MB cap with automatic rotation
- WAL checkpoint every 6 hours — prevents unbounded SQLite WAL growth

---

## [v0.4.0] — 2026-04-11

### Added
- Visual scan type card picker (replaces HTML select dropdown)
- Live activity ticker on landing page (scans today, total, success rate)
- FAQ section (8 questions, accordion, linked from nav)
- Feature comparison table across all 4 tiers (15 features)
- Soft paywall email capture (one-shot per session, before hard paywall)
- Cached results badge ("⚡ Instant result")
- X/Twitter share button on scan results
- 38 unit tests for scanner logic (no network required)
- LLM advisor module for grey-zone scores (40–70)
- Known-safe token whitelist

### Changed
- Watchlist tier limits now enforced server-side (was UI-only before)
- Helius webhook filter: `ANY` → targeted security tx types only (eliminates AMM noise)

### Fixed
- Friendly error messages (quota, invalid address, RPC timeout, unknown)
- Stats auto-refresh every 60s on landing page

### Security
- Helius webhook rate limit: 300 req/min
- Server-side watchlist enforcement prevents limit bypass via direct API calls

---

## [v0.3.0] — 2026-04-08

### Added
- Multi-chain EVM scanner — Ethereum, BSC, Polygon, Arbitrum, Base
- Etherscan v2 API (one key for all chains via `?chainid=N`)
- EVM rate limiter: max 5 req/s per explorer hostname, 429 retry with exponential backoff
- Subscription tiers: Builder ($49/mo), Team ($299/mo) via Stripe

### Changed
- Landing page rewrite — pricing section, hero, trust signals

---

## [v0.1.0] — 2026-04-07

### Added
- Core Solana security scanner (quick, token, wallet, pool, deep scan types)
- Ed25519 signed reports via `sign-report.py`
- x402 micropayment paywall (USDC on Solana)
- Multi-agent swarm: Scanner → Analyst → Reputation → Meta-scorecard
- Telegram watchlist alerts (critical = immediate, warning = batched 5 min)
- Delta reports with LLM diffs (OpenRouter / gemini-2.5-flash)
- Helius webhooks for live address monitoring
- SQLite database with `subscriptions`, `watchlist`, `events` tables
- Ed25519 report verification endpoint (`/verify`)
- Adversarial simulation: 7 attack playbooks (authority takeover, oracle manipulation, drain vault, CPI reentrancy…)
- Puppeteer PDF/PNG report generation
