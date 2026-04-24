# Changelog — integrity.molt

All notable changes to integrity.molt are documented here.
Format: `## [vX.Y.Z] — YYYY-MM-DD`

## [v0.5.0-a2a-oracle] — 2026-04-24

### A2A Security Oracle MVP

First release positioning integrity.molt as a Solana-first A2A security oracle
with signed, server-verifiable receipts and agent-discoverable endpoints.

#### New endpoints
- `POST /verify/v1/signed-receipt` — server-side Ed25519 receipt verification with key pinning; free
- `GET /scan/v1/:address` — IRIS free discovery scan for any Solana address; signed envelope
- `POST /monitor/v1/governance-change` — paid (0.15 USDC) signed verdict on program governance events
- `GET /feed/v1/new-spl-tokens` — public pull-feed of new SPL mint creation events; signed snapshot

#### Trust layer
- `/.well-known/agent-card.json` — A2A-discoverable skills, pricing tiers, examples (v0.5.0)
- `/.well-known/jwks.json` — Ed25519 public key in RFC 8037 JWK format
- `/.well-known/receipts-schema.json` — JSON Schema for signed envelope format

#### Security fixes (post-audit)
- Key pinning enforced: `valid:true` requires correct Ed25519 math AND key matching the server JWKS; foreign-signed envelopes return `valid:false, reason:key_not_pinned, mathematically_valid:true`
- `canonicalJSON()` — sorted-key deterministic JSON on both sign and verify sides; eliminates key-order-dependent canonicalization across consumers
- `src/delta/signing.js` — was pretty-printed `JSON.stringify(obj, null, 2)`; now `canonicalJSON()`, consistent with oracle verify path
- `requirePayment` sets `req.paymentVerified=true`; governance handler asserts it as defense-in-depth against mount-order regressions

#### Performance / reliability
- `events.jsonl` feed reads via `readline` streaming (was `fs.readFileSync` — DoS on large files)
- `asyncSign` subprocess bounded by semaphore (`SIGN_CONCURRENCY=8`)
- `proc.stdin.on('error')` handler catches EPIPE on early subprocess exit

#### Tests
- `tests/a2a-oracle.test.js` — 70 unit tests; 350 ms
- `scripts/smoke-a2a.sh` — E2E smoke for live server
- `npm test` now includes A2A oracle suite

#### Pricing model
| Tier | Price | Endpoints |
|---|---|---|
| discovery | free | `/scan/v1/:address`, `/feed/v1/new-spl-tokens`, `/.well-known/*` |
| attestation | 0.15 USDC | `/monitor/v1/governance-change` |
| forensic | existing prices | `/api/v1/scan/deep`, `/api/v1/scan/adversarial` |

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
