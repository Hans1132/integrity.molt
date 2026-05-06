# Architecture — integrity.molt

## Overview

integrity.molt is a Solana-native Agent-to-Agent (A2A) security oracle exposing 11 cryptographic skills through JSON-RPC 2.0 and REST endpoints. The system runs on Node.js/Express on port 3402 behind NGINX (TLS termination) with Cloudflare CDN in front.

**Stack:**
- **Runtime:** Node.js 18+ with Express 5.x
- **Database:** SQLite 3 (WAL mode) at `/root/x402-server/data/intmolt.db` (13.5 MB live)
- **Signing:** Ed25519 via tweetnacl/PyNaCl, keys stored in `/root/.secrets/`
- **Payments:** x402 USDC micropayments via Solana SPL token transfers
- **Discovery:** A2A 0.4.1 metadata, frames.ag registry, Metaplex Agent Registry (Core Asset)

## Core Components

### Entry Point: `server.js` (~5000 lines)

The main Express application. Contains:
- **Port 3402** binding with Morgan request logging
- **x402 middleware** (`requirePayment`) for payment verification
- **Route mounts:**
  - `/a2a` — JSON-RPC 2.0 handler (A2A oracle MVP)
  - `/api/v1/scan/*` — REST scan endpoints (deep, token-audit, agent-token)
  - `/scan/*` — REST oracle endpoints (iris, address, token, wallet)
  - `/monitor/v1/*` — Governance change detection
  - `/feed/v1/*` — SPL token feed
  - `/verify/v1/*` — Receipt verification
  - `/.well-known/*` — Discovery (agent-card.json, jwks.json)
- **Advisor pipeline** for LLM-assisted scoring (grey-zone 40-70 only)
- **Rate limiting** per IP using free_scan_quota table
- **Abuse detection** with IP blacklist

**Key patterns:**
- All middleware runs before route handlers (auth, rate limits, payment)
- Real client IP extracted from `CF-Connecting-IP` (Cloudflare), not `X-Forwarded-For`
- Subprocess concurrency bounded at 8 for signing (`SIGN_CONCURRENCY`)
- Hot path bypasses Anthropic (uses Gemini Flash only)

### A2A JSON-RPC 2.0 Handler: `src/a2a/handler.js` (~500 lines)

The canonical surface for agent-to-agent communication per Google's A2A 0.4.1 spec.

**Exposed methods:**
- `tasks/send` — Start a new scan or query
- `tasks/get` — Poll task status
- `tasks/cancel` — Cancel pending task
- `/.well-known/agent-card.json` — Discover available skills and pricing

**Implementation details:**
- Parses A2A `message` parts (text or structured data)
- Extracts skill ID and target address from message
- Maps skill to internal REST loopback (`internalPost` / `internalGet`)
- Handles payment forwarding (`x402-payment` or `Authorization` headers)
- AutoPilot co-signing checks for AI agents (`x-agent-mint` header)
- Task persistence via SQLite (`a2a_tasks` table)
- TTL cleanup every 10 minutes

**Skill executor:**
```javascript
executeSkill(skillId, address, options, paymentHeader)
  └─ Routes to internal REST endpoints:
     quick_scan        → /scan/iris (free, IRIS-only)
     token_audit       → /scan/token (0.75 USDC)
     agent_token_scan  → /api/v1/scan/agent-token (0.15 USDC)
     wallet_profile    → /scan/wallet (0.75 USDC)
     deep_audit        → /scan/deep (5.00 USDC)
     adversarial_sim   → /api/v1/adversarial/simulate (4.00 USDC)
     scan_address      → /scan/v1/{address} (free, signed)
     new_spl_feed      → /feed/v1/new-spl-tokens (free)
     verify_receipt    → /verify/v1/signed-receipt (free)
     governance_change → /monitor/v1/governance-change (0.15 USDC)
     program_verification_status → /ottersec lookup (free, cached 1h)
```

### REST Oracle Routes: `src/routes/a2a-oracle.js` (~250 lines)

A2A Oracle MVP endpoints for discovery and verification.

**Endpoints:**
- `GET /scan/v1/:address` — IRIS signed envelope (free, cached 30min)
- `POST /verify/v1/signed-receipt` — Ed25519 verification with key pinning (free)
- `POST /monitor/v1/governance-change` — Helius transaction analysis (0.15 USDC, cached 15min)
- `GET /feed/v1/new-spl-tokens` — New SPL mints from events.jsonl (free)

**Caching strategy:**
```
getCachedScanFromDb(address, scan_type, TTL)
├─ Queries: scan_history WHERE address=X AND scan_type=Y AND created_at > now()-TTL
├─ Returns: { risk_score, risk_level, result_json }
└─ If hit: skip expensive operation, return immediately

logScanToHistory(email, address, scan_type, result)
├─ Inserts into scan_history table
├─ Marks cached=0 for fresh computation
├─ Used after free /scan/v1 and paid /scan/token
└─ Enables later cache hits
```

### Payment Middleware: `src/middleware/payment.js`

PDA-aware payment context enrichment.

**Flow:**
1. Client sends x402 payment envelope with `x-amount-usdc` and `x-payment` headers
2. `requirePayment` middleware verifies on-chain USDC transfer
3. Anti-replay check: transaction signature must be unique in `used_signatures` table
4. `validatePDAOrReject` checks A2A agents (`x-agent-mint` header)
5. Route handler executes with `req.paymentVerified=true`

**Security invariant:** `INSERT OR IGNORE` into `used_signatures` happens BEFORE receipt issuance. Double-spend via race is atomic-safe under SQLite's single writer lock.

### Crypto Utilities: `src/crypto/sign.js` (~100 lines)

Async Ed25519 signing without blocking the event loop.

**Functions:**
- `asyncSign(reportText)` — Spawns Python3 subprocess with sign-report.py, returns envelope
  - Semaphore bounds concurrency to 8 processes
  - 10-second timeout per call
  - Returns: `{ report, signature, verify_key, key_id, signed_at, signer, algorithm }`
- `canonicalJSON(obj)` — Deterministic JSON serialization
  - Sorts object keys alphabetically
  - No whitespace (compact)
  - Recurses into nested objects
  - Essential for signature verification across languages

**Key ID:** `integrity-molt-primary-2026` (hardcoded, matches Ed25519 keypair in `/root/.secrets/verify_key.bin`)

### Database Layer: `db.js` (~1000 lines)

Single source of truth for all SQLite operations.

**Key tables:**
| Table | Purpose | Indexes |
|-------|---------|---------|
| `scan_history` | Cache for all scan results | `(address, scan_type, created_at DESC)` |
| `used_signatures` | Anti-replay log for x402 transactions | PRIMARY KEY on `sig` |
| `free_scan_quota` | Rate limit by IP+date | `(identifier, scan_date)` |
| `a2a_tasks` | A2A task persistence | `(session_id, expires_at)` |
| `autopilot_spending` | AutoPilot co-signing audit log | `(agent_mint, created_at DESC)` |
| `ottersec_verifications` | OtterSec cache (1h TTL) | `(expires_at)` |
| `iris_enrichment` | IRIS feature cache | PRIMARY KEY on `mint` |
| `known_scams` | Scam database imports (SolRPDS, SolRugDetector) | `(source, scam_type)`, `(confidence DESC)` |

**Pragmas:**
```javascript
journal_mode = WAL      // Write-Ahead Logging for concurrent reads
foreign_keys = ON       // FK constraint enforcement
busy_timeout = 5000ms   // Retry failed locks for 5s
synchronous = NORMAL    // Balance durability/speed (not FULL)
```

**Atomic operations:**
- `markSignatureUsed(sig)` — `INSERT OR IGNORE` returns true only for the atomic claim winner
- `getCachedScanFromDb()` — Fast indexed lookup with TTL comparison
- `logScanToHistory()` — Insert new scan result after computation

### Configuration: `config/pricing.js`

Single source of truth for skill pricing in micro-USDC (6 decimals).

```javascript
const PRICING = {
  quick:               500_000,   // 0.50 USDC
  deep:              5_000_000,   // 5.00 USDC
  token:               750_000,   // 0.75 USDC
  wallet:              750_000,   // 0.75 USDC
  'agent-token':       150_000,   // 0.15 USDC
  'governance-change': 150_000,   // 0.15 USDC
  adversarial:       4_000_000,   // 4.00 USDC
  // ... others
};
```

**Never mix USDC micro-units and SOL lamports in one variable.** Explicit naming required.

## Data Flow

### Free Skill: `quick_scan`

```
A2A JSON-RPC /a2a
  ├─ Handler extracts skill=quick_scan, address
  ├─ No payment check (free tier)
  ├─ executeSkill() → internalPost('/scan/iris', {address}, null)
  │
  └─ Internal POST /scan/iris (127.0.0.1, X-A2A-Caller=1)
     ├─ Rate limit check (free_scan_quota, 10 req/min per IP)
     ├─ Address validation (base58, length 32-44)
     ├─ IRIS enrichment (offline)
     ├─ Scam-db lookup
     ├─ Risk scoring (IRIS formula)
     ├─ asyncSign() with Ed25519
     └─ Response: { iris_score, risk_level, risk_factors, signature, verify_key, ... }
        └─ Flattened back to A2A caller
```

### Paid Skill: `token_audit` (0.75 USDC)

```
A2A JSON-RPC /a2a
  ├─ Handler extracts skill=token_audit, address
  ├─ Payment header forwarded (x402-payment or Bearer im_xxx)
  ├─ AutoPilot check (if x-agent-mint present)
  ├─ executeSkill() → internalPost('/scan/token', {address}, paymentHeader)
  │
  └─ Internal POST /scan/token
     ├─ requirePayment middleware (0.75 USDC = 750_000 micro-USDC)
     │  ├─ Verifies x402 payment via @cheapay/x402 library
     │  ├─ Checks used_signatures for anti-replay
     │  ├─ Marks signature used BEFORE response (atomic)
     │  └─ Sets req.paymentVerified = true
     ├─ Cache check: getCachedScanFromDb(address, 'token', 60min TTL)
     │  └─ If hit: return cached result immediately
     ├─ Cache miss: auditToken(mint)
     │  ├─ RPC fetch mint account data
     │  ├─ Parse mint authorities, supply, decimals
     │  ├─ Analyze holder distribution
     │  ├─ LLM validation layer
     │  └─ Compute risk_score (0-100)
     ├─ logScanToHistory() insert
     ├─ asyncSign() with Ed25519
     └─ Response: { risk_score, category, summary, findings, signature, ... }
        └─ Flattened back to A2A caller
```

### Governance Monitoring: `governance_change` (0.15 USDC)

```
A2A JSON-RPC /a2a
  ├─ Handler extracts skill=governance_change, program_id
  ├─ Payment forwarded
  ├─ executeSkill() → internalPost('/monitor/v1/governance-change', {program_id}, paymentHeader)
  │
  └─ Internal POST /monitor/v1/governance-change
     ├─ requirePayment middleware (0.15 USDC)
     ├─ Cache check: getCachedScanFromDb(program_id, 'governance', 15min TTL)
     ├─ Cache miss:
     │  ├─ Helius Enhanced Transactions API (if HELIUS_API_KEY set)
     │  │  └─ fetchHeliusTransactions(program_id)
     │  └─ Fallback to Alchemy RPC if Helius missing/down
     │     └─ parseEnhancedTransaction() + evaluateTransaction()
     ├─ evaluateTransaction detects:
     │  ├─ authority_change (update authority or upgrade authority change)
     │  ├─ program_upgrade (buffer account creation)
     │  ├─ admin_function_call (9-sig account change)
     │  └─ returns signed verdict
     ├─ asyncSign() envelope
     └─ Response: { program_id, findings: [{type, signature, time}], verdict, signature, ... }
        └─ Flattened back to A2A caller
```

## Hot Path Performance Budget

**Target latency:** < 1 second for free tier endpoints

**Implementation:**
- IRIS scoring: RPC + offline enrichment + IRIS formula (~200ms)
- Scam-db lookup: in-memory set checks (~0ms)
- Signing: spawned subprocess with semaphore, buffered to 8 parallel (~100-200ms)
- Database cache hits: indexed SELECT + deserialize (~5ms)

**Excluded from hot path:**
- Anthropic LLM calls (warm/cold path only, Advisor escalation)
- Full LLM audits (deep_audit endpoint is async, not hot path)
- Heavy enrichment (token extensions, on-chain analysis)

**Provider selection:**
- Hot path (< 1s): Gemini 2.5 Flash only
- Warm path (1-30s): Anthropic Sonnet 4.6
- Cold path (30s+): Anthropic Opus 4.7 (max wisdom)

## Network Topology

```
┌─────────────────────────────────────────────────┐
│             Cloudflare CDN                       │
│     (CF-Connecting-IP header set here)          │
└────────────────────┬────────────────────────────┘
                     │
                ┌────▼────────────────┐
                │     NGINX           │
                │  (TLS termination)  │
                │   Port 443 → 3402   │
                └────┬────────────────┘
                     │
            ┌────────▼─────────────┐
            │  Express server.js   │
            │    Port 3402         │
            ├──────────────────────┤
            │  Middleware stack:   │
            │  ├─ Morgan logging   │
            │  ├─ Auth (API key)   │
            │  ├─ Rate limit       │
            │  ├─ x402 payment     │
            │  └─ Route handlers   │
            └────────┬─────────────┘
                     │
         ┌───────────┼────────────────┐
         │           │                │
    ┌────▼────┐  ┌──▼───────┐  ┌─────▼─────┐
    │ SQLite  │  │ Solana    │  │ External  │
    │ DB      │  │ RPC       │  │ APIs      │
    │(WAL)    │  │(Alchemy,  │  │(Helius,   │
    │         │  │ Quicknode)│  │ Metaplex) │
    └─────────┘  └──────────┘  └───────────┘
```

## Session Lifecycle

### Free Scan (via A2A)

1. **Request:** A2A JSON-RPC POST `/a2a` with `tasks/send` method
2. **Parse:** Extract skill, address, optional callbackUrl
3. **Check:** Validate skill exists, address valid
4. **Execute:** `executeSkill()` → internal loopback
5. **Compute:** Cache hit or full analysis
6. **Sign:** `asyncSign()` envelope
7. **Response:** Flat JSON envelope with signature
8. **Optional:** POST callback to agent if callbackUrl provided

### Paid Scan (via A2A with x402)

1. **Request:** A2A JSON-RPC POST `/a2a` with payment envelope
2. **Payment check:** Verify USDC transfer on-chain
3. **Anti-replay:** Check/mark `used_signatures` table
4. **AutoPilot:** If AI agent, validate spending limits
5. **Execute:** `executeSkill()` → internal loopback with payment forwarded
6. **Compute:** Cache hit or full analysis (now requires payment)
7. **Sign:** `asyncSign()` envelope
8. **Response:** Same envelope format
9. **DB:** Log to scan_history + advisor_calls tables

### Task Polling (A2A Async)

1. **`tasks/send`** returns `{ id, status: 'pending|complete', result? }`
2. If pending, caller polls `tasks/get` with task ID
3. Task stored in `a2a_tasks` table with 10-minute TTL
4. Poll response updates on status change
5. Optional callback POST when complete

## Error Handling & Recovery

**Payment failures (402 errors):**
- Missing payment header → 402 with x402 instructions
- Invalid signature → 402 with retry hint
- Already-used signature → 402 "replay detected"

**Rate limit (429 errors):**
- Free scan quota exceeded → 429 with reset time
- IP blacklisted → 429 with contact info

**Computation errors:**
- Address validation fails → 400 bad request
- RPC timeout → 504 gateway timeout (with fallback to cache)
- LLM error (non-critical) → response still sent (advisor skipped, logged)
- Signature timeout → 500 (critical path failure)

**Graceful degradation:**
- Helius down? Fall back to Alchemy RPC
- Scam-db unavailable? Return base IRIS score
- LLM unavailable? Return heuristic scoring
- Cache expired? Recompute on-demand

## Deployment & Operations

**Systemd services:**
- `integrity-x402.service` — Main Express server
- `intmolt-bot.service` — Moltbook Telegram bot (separate)

**Environment variables** (in `/root/x402-server/.env`):
```
PORT=3402
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
ALCHEMY_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/...
HELIUS_API_KEY=...
OPENROUTER_API_KEY=...
STRIPE_SECRET_KEY=...
USDC_ATA=...
SOLANA_WALLET_ADDRESS=...
```

**Secrets** (in `/root/.secrets/`, NOT in repo):
- `signing_key.bin` — 32-byte Ed25519 private key
- `verify_key.bin` — 32-byte Ed25519 public key

**Database backup & maintenance:**
- SQLite WAL file grows over time; `PRAGMA wal_checkpoint(PASSIVE)` runs every 6 hours
- Manual checkpoint: `sqlite3 data/intmolt.db "PRAGMA wal_checkpoint(RESTART);"`
- Backup: Copy `data/intmolt.db` and `data/intmolt.db-wal` together

## Key Invariants & Constraints

1. **Single source of truth for pricing:** `config/pricing.js` is the only place skill prices are defined. A2A handler, REST routes, and test suite all read from this file.

2. **Anti-replay atomicity:** `markSignatureUsed()` must succeed (return true) before response is sent. No race window for double-spend.

3. **Cache TTL enforcement:** All cache hits check `created_at > now() - TTL_MS`. Expired entries are treated as misses and recomputed.

4. **Canonical JSON for all signatures:** Both asyncSign and offline verification use the same `canonicalJSON()` implementation. Key ordering must be consistent.

5. **Real IP detection:** Always use `CF-Connecting-IP` for rate limiting and logging. `X-Forwarded-For` is unreliable when Cloudflare is in front.

6. **Bounded subprocess concurrency:** Signing uses a semaphore with `SIGN_CONCURRENCY=8`. Never spawn unlimited Python3 processes.

7. **Free tier isolation:** Free skills never call `requirePayment` middleware. No cross-contamination between free and paid codepaths.

8. **AutoPilot spending limits:** AI agents (x-agent-mint header) are co-signed; `canAutoSign()` checks daily spending + per-tx limits before execution.

## Testing & Validation

- **Unit tests:** `npm run test` (187 passing tests + 22 adversarial)
- **Test gate:** `bash scripts/test-gate.sh` (runs before commit)
- **E2E smoke:** `API_URL=https://intmolt.org bash scripts/smoke-a2a.sh`
- **Code inspection:** `grep -rn "PRIVATE|SECRET|sk_|api_key" --include="*.js" src/`

See `docs/development.md` for setup and testing instructions.
