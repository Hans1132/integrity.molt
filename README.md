# integrity.molt

A Solana-native A2A security oracle exposing 11 skills (5 free, 6 paid via x402 USDC). Returns Ed25519-signed risk receipts that any agent or human can verify offline.

**Live API:** [intmolt.org](https://intmolt.org)  
**Moltbook agent:** [moltbook.com/u/integrity_molt](https://www.moltbook.com/u/integrity_molt)  
**Metaplex Agent Registry:** [Active, EIP-8004](https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy)  
**frames.ag registry:** [PR submitted](https://github.com/frames-engineering/skills/pull/9)

## What it does

When an on-chain agent or small protocol needs a trust signal before acting, it can ask:

- *Is this address safe to interact with?* IRIS risk score, signed.
- *Has this program's governance changed?* Signed verdict with per-transaction findings.
- *What new SPL tokens minted recently?* Signed pull-feed, no subscription.
- *Is this receipt genuine?* Server-side Ed25519 verification with key pinning.
- *Is this program's source verified?* OtterSec build attestation cross-reference.

Responses are flat JSON envelopes signed with Ed25519. The signature is verifiable against the published JWKS, so a downstream consumer does not need to call back to confirm authenticity. Discovery is A2A-compatible via /.well-known/agent-card.json. Paid endpoints settle per-call through the x402 protocol — no account, no API key.

The target user is an agent operator or a sub-$10M TVL Solana protocol that needs callable trust primitives, not a human browsing a dashboard.

## Quickstart

All skills are available through the A2A endpoint (POST /a2a) using JSON-RPC 2.0. A subset is also exposed as plain REST for clients that do not speak A2A.

```bash
# Free scan via A2A
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [{"type": "text", "text": "scan"}]},
      "metadata": {"skill": "quick_scan", "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}
    }
  }'

# Free scan via REST oracle endpoint
curl https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Verify a signed receipt
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d '{"envelope": <paste scan response here>}'

# Pull-feed of new SPL token mints
curl https://intmolt.org/feed/v1/new-spl-tokens
```

For paid skills, agents can use the [frames.ag AgentWallet x402/fetch proxy](https://frames.ag):

```bash
curl -X POST https://frames.ag/api/wallets/USERNAME/actions/x402/fetch \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://intmolt.org/a2a",
    "method": "POST",
    "body": {
      "jsonrpc": "2.0", "id": "1", "method": "tasks/send",
      "params": {
        "message": {"role": "user", "parts": [{"type": "text", "text": "scan"}]},
        "metadata": {"skill": "token_audit", "address": "TOKEN_MINT"}
      }
    }
  }'
```

## A2A skills

The canonical surface is A2A 0.4.1, discoverable via /.well-known/agent-card.json. Five skills are free; six settle in USDC over x402.

### Free tier

| Skill | Description |
|---|---|
| quick_scan | Fast on-chain scan — account info, balance, basic IRIS risk assessment |
| scan_address | IRIS oracle lookup, signed envelope with iris_score, risk_level, risk_factors |
| new_spl_feed | Pull-feed of new SPL token mint creation events; filter by ?since=ISO8601 |
| verify_receipt | Server-side Ed25519 verification of a signed oracle receipt with key pinning |
| program_verification_status | OtterSec verify.osec.io cross-reference for Solana program build attestation; cached 1h |

### Paid tier (x402 USDC)

| Skill | Price | Description |
|---|---|---|
| agent_token_scan | $0.15 | Metaplex Agent Token scan — Core NFT backing, treasury PDA, update authority, creator fees, DAO governance |
| governance_change | $0.15 | Detect authority changes and program upgrades via Helius enhanced transactions; signed verdict |
| token_audit | $0.75 | Polymorphic audit — auto-detects Metaplex registered agent (ERC-8004 + wallet + claim validation) or SPL token (mint/freeze authority, holder distribution, rug risk). Returns Ed25519-signed receipt. |
| wallet_profile | $0.75 | Wallet behavioral profile — age, activity, DeFi exposure, risk classification |
| adversarial_sim | $4.00 | Fork on-chain state, probe 7 attack playbooks, return signed risk report |
| deep_audit | $5.00 | Full program audit — static analysis, LLM-verified findings, Ed25519-signed report |

Prices are the single source of truth from config/pricing.js. All paid endpoints require X-PAYMENT header with a settled Solana USDC transaction on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.

## HTTP endpoints

A subset of skills is exposed as plain REST for clients that do not speak A2A JSON-RPC.

### A2A protocol

| Endpoint | Description |
|---|---|
| POST /a2a | JSON-RPC 2.0 — tasks/send, tasks/get, tasks/cancel; rate-limited to 20 req/min |
| POST /a2a/subscribe | SSE streaming — events: task_created, task_working, task_completed, task_failed |

### Free oracle

| Endpoint | Maps to skill |
|---|---|
| GET /scan/v1/:address | scan_address |
| GET /feed/v1/new-spl-tokens | new_spl_feed |
| POST /verify/v1/signed-receipt | verify_receipt |

### Paid oracle (x402)

| Endpoint | Price |
|---|---|
| POST /monitor/v1/governance-change | $0.15 USDC |

### Discovery

| Endpoint | Description |
|---|---|
| GET /.well-known/agent-card.json | A2A skill list and pricing (also at /agent.json and /.well-known/agent.json) |
| GET /.well-known/jwks.json | Ed25519 public key, RFC 8037 JWK; kid: integrity-molt-primary-2026 |
| GET /.well-known/x402.json | x402 payment manifest (runtime-generated from config/pricing.js) |
| GET /.well-known/receipts-schema.json | JSON Schema for signed envelope format |
| GET /skill.md | frames.ag registry descriptor |
| GET /offer | Machine-readable JSON offer with all 11 skills and pricing |
| GET /openapi.json | OpenAPI 3.x spec (runtime-generated) |
| GET /health | Health check |

## Receipt format

Every oracle response is a flat envelope:

```json
{
  "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "iris_score": 94,
  "risk_level": "low",
  "risk_factors": [],
  "signed_at": "2026-04-24T10:00:00.000Z",
  "signature": "<base64 Ed25519 sig>",
  "verify_key": "<base64 raw 32-byte public key>",
  "key_id": "<first 16 chars of verify_key>",
  "signer": "integrity.molt",
  "algorithm": "Ed25519",
  "issuer_metaplex_asset": "2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy",
  "issuer_metaplex_url": "https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy"
}
```

### Server-side verification

```bash
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d '{"envelope": <envelope json>}'
```

```json
{
  "valid": true,
  "key_pinned": true,
  "mathematically_valid": true,
  "reason": "signature_valid",
  "key_id": "...",
  "signed_at": "...",
  "issuer": "integrity.molt"
}
```

valid: true requires both correct Ed25519 math and the key matching the server's published JWKS. A self-signed envelope with a foreign key returns valid: false, reason: key_not_pinned, mathematically_valid: true — so a consumer can tell oracle attestation from arbitrary Ed25519 output.

### Offline verification

No HTTP call required. Python with PyNaCl:

```python
import json, base64, nacl.signing

receipt = json.load(open('receipt.json'))
vk = nacl.signing.VerifyKey(base64.b64decode(receipt['verify_key']))
payload = {k: v for k, v in receipt.items()
           if k not in {'signature', 'verify_key', 'key_id',
                        'signed_at', 'signer', 'algorithm', 'report'}}
canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
vk.verify(canonical.encode(), base64.b64decode(receipt['signature']))
print("Valid")
```

Signing uses canonicalJSON() (sorted keys, no whitespace) from src/crypto/sign.js. Verification must use the same canonical form.

## x402 payments

Paid endpoints respond with 402 and payment instructions. No account, no API key needed.

```bash
# 1. Probe for payment requirements (returns 402 with x402 payment instructions)
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": "1", "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [{"type": "text", "text": "scan"}]},
      "metadata": {"skill": "token_audit", "address": "..."}
    }
  }'

# 2. Settle USDC on Solana mainnet, retry with X-PAYMENT header
# Or use frames.ag AgentWallet x402/fetch proxy (see Quickstart above)
```

Payment is settled on Solana mainnet (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp) in USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). Anti-replay protection: each transaction signature stored in SQLite; a used signature is rejected fail-closed.

## Security properties

- Ed25519 signatures over canonical JSON (sorted keys, no whitespace).
- Key pinning on /verify/v1/signed-receipt: oracle key vs. foreign key is distinguishable.
- Anti-replay: USDC transaction signatures stored atomically in SQLite before receipt is issued; duplicate signature is rejected.
- requirePayment middleware sets req.paymentVerified = true; governance handler asserts it as defense-in-depth.
- Free tier rate limits: 3 scans/day per IP, global 500 free scans/day; quota tracked in SQLite.
- A2A endpoint rate limit: 20 req/min per IP.
- Real client IP read from CF-Connecting-IP (Cloudflare proxy), not X-Forwarded-For.
- CAPTCHA_SECRET required at startup; server fails-closed if missing or left at default.
- HELIUS_WEBHOOK_SECRET required; all webhook requests rejected without it.
- Bounded subprocess concurrency for signing: SIGN_CONCURRENCY = 8 (semaphore in src/crypto/sign.js).
- Path traversal protection on /report/download.
- Watchlist reads scoped to the authenticated API key owner (no IDOR).
- uncaughtException / unhandledRejection both send admin Telegram alert then call process.exit(1).

## Known limitations

- The governance endpoint uses Helius Enhanced Transactions. Without HELIUS_API_KEY it falls back to a mock verdict; the response carries data_source: "mock" so consumers can detect degraded mode.
- No transparency log or Merkle anchoring. Receipts are atomic, not chained.

## Self-hosted setup

```bash
git clone https://github.com/Hans1132/integrity.molt.git
cd integrity.molt
cp .env.example .env
# Fill in required secrets (see Environment variables below)
npm install
node server.js
```

The server listens on 127.0.0.1:3402 (default). Place NGINX in front for TLS termination and Cloudflare proxy in front of NGINX.

Required file outside the repo:

- /root/.secrets/verify_key.bin — raw 32-byte Ed25519 public key (path overridable via VERIFY_KEY_PATH)
- /root/scanner/sign-report.py — PyNaCl signing script called by src/crypto/sign.js

### Environment variables

| Variable | Required | Description |
|---|---|---|
| PORT | no | Server port (default 3402) |
| SOLANA_WALLET_ADDRESS | yes | Solana wallet address for USDC payment receipt |
| SOLANA_RPC_URL | yes | Solana RPC endpoint (Helius or QuickNode recommended for production) |
| HELIUS_API_KEY | yes (governance skill) | Helius API key for enhanced transactions; governance endpoint mocks without it |
| HELIUS_WEBHOOK_SECRET | yes | Authorization header value for /webhook/helius; server rejects all webhooks if unset |
| CAPTCHA_SECRET | yes | HMAC-SHA256 secret for /scan/free CAPTCHA (openssl rand -hex 32) |
| ANTHROPIC_API_KEY | yes (Advisor path) | Used by src/llm/anthropic-advisor.js for deep/grey-zone analysis |
| OPENROUTER_API_KEY | no | Fallback LLM provider via OpenRouter |
| ALCHEMY_RPC_URL | no | Alchemy RPC; used as fallback in governance change detection and SPL mint poller |
| RUGCHECK_API_KEY | no | RugCheck enrichment API key |
| SOLANA_TRACKER_API_KEY | no | Solana Tracker enrichment API key |
| OTTERSEC_API | no | OtterSec API override (defaults to public verify.osec.io) |
| TELEGRAM_BOT_TOKEN | no | Telegram bot token for watchlist alerts |
| ADMIN_TELEGRAM_CHAT | no | Telegram chat ID for uncaught error alerts |
| ADMIN_API_KEY | no | Admin endpoints (/monitor/status, /admin/*) |
| STATS_TOKEN | no | Bearer token for /stats/funnel |
| INTERNAL_SCAN_SECRET | no | X-Internal-Secret header to bypass free quota from internal callers |
| VERIFY_KEY_PATH | no | Path to verify_key.bin (default /root/.secrets/verify_key.bin) |
| SQLITE_DB_PATH | no | Database path (default data/intmolt.db) |
| SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM | no | SMTP for email alerts |

> Note: The .env.example file in the repository is partially stale and lists DATABASE_URL (PostgreSQL) which is not used — the project runs SQLite exclusively. Use the table above as the reference.

## Architecture

```
server.js                     Express 5, all route mounts, startup, shutdown
db.js                         SQLite (better-sqlite3, WAL) — data/intmolt.db
auth.js                       Session/auth strategies (Passport)
config/
  pricing.js                  Single source of truth for prices (USDC micro-units)
src/
  a2a/
    handler.js                JSON-RPC 2.0, A2A 0.4.1, SSE, skill executor
    autopilot.js              AutoPilot PDA co-signing rules and spending limits
    task-store.js             SQLite-backed async task store (TTL 10 min, max 100)
  adversarial/
    playbooks.js              7 attack playbook definitions
    runner.js                 Adversarial simulation orchestration
    executor.js               Per-playbook execution
    fork.js                   On-chain state fork for simulation
  config/
    agent-identity.js         Metaplex asset address, EIP-8004 registry block
  crypto/
    sign.js                   asyncSign(), canonicalJSON(), semaphore (8 concurrent)
  delta/
    diff.js                   Snapshot delta computation
    signing.js                Delta report signing (uses canonicalJSON)
    store.js                  Snapshot persistence
  docs/
    endpoint-spec.js          Endpoint definitions (single source for OpenAPI)
    generate-openapi.js       Runtime OpenAPI 3.x generation
    generate-x402-discovery.js Runtime /.well-known/x402.json generation
  enrichment/
    index.js                  Enrichment orchestration
    rugcheck.js               RugCheck API integration
    solana-tracker.js         Solana Tracker API integration
    token-extensions.js       Token-2022 extension parsing
  features/
    iris-score.js             IRIS v1.0 scoring engine (Inflows + Rights + Imbalance + Speed)
  lib/
    ottersec.js               OtterSec verify.osec.io client with circuit breaker (5 failures/60s)
  llm/
    anthropic-advisor.js      Anthropic Sonnet/Opus Advisor (grey zone 40-70 score)
    scan-validator.js         LLM scan validator (6 rules, false-negative prevention)
    prompts/
      security-analyst.js     System prompt for security analysis
  middleware/
    free-quota.js             Per-IP daily quota (3/day), global cap (500/day), blacklist
    payment.js                x402 payment verification middleware
  monitor/
    alerts.js                 Detection engine (authority_change, program_upgrade, ...)
    init.js                   Monitor startup
    notifications.js          Alert dispatch
    spl-mint-poller.js        Alchemy-based SPL mint poller (Pump.fun + Token-2022, 5 min)
    status.js                 Monitor status reporting
    webhook-manager.js        Helius webhook registration/management
    webhook-receiver.js       Helius webhook ingestion into events.jsonl
  og/
    generator.js              OpenGraph scan image generation (Puppeteer)
  payment/
    verify-pda.js             Metaplex Asset Signer PDA derivation
  routes/
    a2a-oracle.js             Oracle REST endpoints (scan/v1, verify/v1, monitor/v1, feed/v1)
  rpc.js                      Shared Solana RPC URL export
  scam-db/
    lookup.js                 Scam DB lookup (SolRPDS + RugCheck archive, 17k+ tokens)
    whitelist.js              Known-safe token list
  validation/
    address.js                Solana/EVM address format validation
    report-validator.js       LLM report validation and correction
tests/
  a2a-oracle.test.js          A2A oracle unit tests
  a2a-handler.test.js         A2A handler integration tests
  a2a/task-store.test.js      Task store unit tests
  adversarial.test.js         Adversarial simulation tests
  crypto/canonical-json.test.js  Canonical JSON determinism tests
  db-tables.test.js           DB schema tests
  delta.test.js               Delta diff tests
  e2e/smoke.js                E2E smoke (requires live server)
  e2e/captcha.test.js         CAPTCHA E2E (requires live server)
  features/iris-score.test.js IRIS scoring unit tests
  middleware/free-quota.test.js  Free quota middleware tests
  monitor.test.js             Monitor alert detection tests
  ottersec.test.js            OtterSec client tests (circuit breaker, cache, SQL injection)
  payment/anti-replay.test.js Anti-replay unit tests
  payment/autopilot.test.js   AutoPilot co-signing tests
  payment/pricing-consistency.test.js Pricing consistency tests
  payment/verify-pda.test.js  PDA derivation tests
  registry.test.js            Discovery endpoint tests
  scam-db.test.js             Scam DB lookup tests
  scan-validator.test.js      Scan validator tests
  scanner/accuracy.test.js    Golden dataset accuracy tests (17 tokens, 29 assertions)
  security/no-secrets.js      Secrets-in-code check
  security/path-traversal.test.js  Path traversal tests
  security/watchlist-idor.test.js  Watchlist IDOR tests
  validation/report-validator.test.js  Report validator tests
scripts/
  test-gate.sh                Mandatory pre-commit gate (13 checks)
  smoke-a2a.sh                E2E smoke against live deployment
```

## Testing

```bash
# Run full test suite (npm test runs all test files in sequence)
npm test

# Individual suites
npm run test:a2a          # A2A oracle unit tests
npm run test:iris         # IRIS scoring unit tests
npm run test:quota        # Free quota middleware tests
npm run test:task-store   # A2A task store unit tests
npm run test:anti-replay  # Payment anti-replay tests
npm run test:pricing      # Pricing consistency tests
npm run test:report-validator  # Report validator tests

# Pre-commit gate (mandatory before every commit)
bash scripts/test-gate.sh

# E2E against live server
API_URL=https://intmolt.org bash scripts/smoke-a2a.sh

# OpenAPI coverage validation
npm run validate:openapi
```

The test gate (scripts/test-gate.sh) runs 13 checks including secrets scan, syntax check, service health, E2E smoke, CAPTCHA E2E, adversarial tests, golden dataset accuracy, and A2A integration tests. Exit code 0 = PASS (safe to commit).

## Composability

**OtterSec verify.osec.io** is integrated as a live enrichment layer on every program-level skill. If deployed bytecode does not match a verified source repository, the signed receipt says so. Cached 1h with a circuit breaker (opens after 5 failures in 60s, resets after 5 min).

**Metaplex Agent Registry** registration (Core Asset [2tWPw22b...gZZy](https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy)) is cryptographically referenced in every signed receipt through issuer_metaplex_asset and issuer_metaplex_url. Identity is verifiable on-chain.

**Open standards:** A2A 0.4.1 for discovery, x402 for payments, Ed25519 for signatures, JWKS (RFC 8037) for key publication.

## Moltbook agent

integrity.molt has an autonomous agent on [moltbook](https://www.moltbook.com/u/integrity_molt) (integrity_molt). It runs every 30 minutes: replies to comments using Gemini 2.5 Flash with live IRIS scan results when a Solana address is mentioned, engages with the feed, and sends token audit DM outreach (up to 3/day) to authors of token-launch posts.

Reachable via A2A relay:

```
POST https://multiclaw.moltid.workers.dev/c/integrity/a2a
```

Same JSON-RPC 2.0 envelope as the direct endpoint.

## frames.ag registry

integrity.molt is listed in the [frames.ag tools registry](https://github.com/frames-engineering/skills/pull/9) under skills/integrity-molt. The GET /skill.md and GET /offer endpoints follow the frames.ag spec.

## Backed by

- Superteam Agentic Engineering Grant (April 2026)
- Solana Foundation Grant (under review, May 2026)
- Metaplex Agent Registry (Active, EIP-8004)
- Alchemy Solana Credits Program

## Frontier Hackathon

Submitted to the Colosseum Solana Frontier Hackathon (May 2026) in the Public Goods track.

## Acknowledgments & Citations

This project integrates the **SolRPDS dataset** (Solana Rug Pull Dataset) as a historical baseline for scam pool detection covering February 2021 through November 2024.

> Alhaidari, A., Kalal, B., Palanisamy, B., & Sural, S. (2025).
> **SolRPDS: A Dataset for Analyzing Rug Pulls in Solana Decentralized Finance.**
> Proceedings of the Fifteenth ACM Conference on Data and Application Security and Privacy (CODASPY '25), 293–298.
> https://doi.org/10.1145/3714393.3726487

The SolRPDS dataset is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) and is publicly available at https://github.com/DeFiLabX/SolRPDS.

**Indication of changes:** Original SolRPDS records are stored unmodified in the `known_scams` table with `source = 'solrpds'`. integrity.molt augments this baseline with multi-source live signals (RugCheck API, Solana Tracker, OtterSec verify.osec.io) and a Solana DEX liquidity event monitoring pipeline that applies the same deterministic methodology described in paper sections 4.2–4.3 to post-cutoff data.

## License

MIT — see [LICENSE](./LICENSE).
