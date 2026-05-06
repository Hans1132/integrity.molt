# Developer Documentation Index — integrity.molt

This directory contains comprehensive internal developer documentation for the integrity.molt project. Start here to understand the system architecture, API surface, and development workflows.

## Quick Navigation

### Getting Started

**New to the project?** Start here:
1. **[development.md](./development.md)** — Setup, running locally, testing, common tasks
2. **[architecture.md](./architecture.md)** — System components and data flow
3. **[CLAUDE.md](../CLAUDE.md)** — Project rules, safety constraints, gotchas

### Deep Dives by Topic

**A2A Oracle Surface:**
- **[skills.md](./skills.md)** — All 11 skills, caching patterns, A2A JSON-RPC 2.0 interface
- **[architecture.md#a2a-json-rpc-20-handler](./architecture.md#a2a-json-rpc-20-handler)** — Handler implementation

**Payments & Economics:**
- **[payments.md](./payments.md)** — x402 USDC micropayments, anti-replay, payment flow
- **[config/pricing.js](../config/pricing.js)** — Single source of truth for skill prices

**Security & Cryptography:**
- **[signing.md](./signing.md)** — Ed25519 signatures, offline verification, JWKS
- **[development.md#key-development-patterns](./development.md#key-development-patterns)** — Anti-replay, canonical JSON

**Data & Persistence:**
- **[database.md](./database.md)** — SQLite schema, caching strategy, tables, indexes
- **[db.js](../db.js)** — SQLite layer implementation (~1000 lines)

## Document Overview

| Document | Purpose | Audience | Length |
|----------|---------|----------|--------|
| [architecture.md](./architecture.md) | System design, components, data flow | Backend dev, architect | ~550 lines |
| [skills.md](./skills.md) | A2A skill catalog, caching, authentication | Backend dev, integrator | ~600 lines |
| [payments.md](./payments.md) | x402 protocol, payment flow, anti-replay | Backend dev, security | ~500 lines |
| [database.md](./database.md) | SQLite schema, tables, indexes, patterns | Backend dev, ops | ~450 lines |
| [signing.md](./signing.md) | Ed25519 signatures, verification, JWKS | Backend dev, integrator | ~400 lines |
| [development.md](./development.md) | Setup, testing, debugging, workflows | Backend dev, junior | ~450 lines |

**Total:** ~2,950 lines of organized, cross-linked internal documentation.

## Key Files Referenced

### Source Code

- **[server.js](../server.js)** (~5000 lines) — Main Express app, all route mounts
- **[src/a2a/handler.js](../src/a2a/handler.js)** (~700 lines) — A2A JSON-RPC 2.0 implementation
- **[src/routes/a2a-oracle.js](../src/routes/a2a-oracle.js)** (~250 lines) — Oracle REST endpoints
- **[db.js](../db.js)** (~1000 lines) — SQLite data layer
- **[src/crypto/sign.js](../src/crypto/sign.js)** (~100 lines) — Async signing utility
- **[config/pricing.js](../config/pricing.js)** — Pricing (single source of truth)

### Project Rules

- **[CLAUDE.md](../CLAUDE.md)** — Development rules, constraints, gotchas (CRITICAL)
- **[@memory.md](./@memory.md)** — Living log of decisions, bugs, precedents (auto-updated)

### Tests

- **[tests/a2a-oracle.test.js](../tests/a2a-oracle.test.js)** — 91 unit tests
- **[tests/payment/anti-replay.test.js](../tests/payment/anti-replay.test.js)** — Anti-replay tests
- **[scripts/test-gate.sh](../scripts/test-gate.sh)** — Pre-commit validation

## Common Workflows

### I want to understand the system

1. Read [architecture.md](./architecture.md) (15 min)
2. Skim [src/a2a/handler.js](../src/a2a/handler.js) (10 min)
3. Check [skills.md](./skills.md) for specific skill (5 min)

### I want to add a new skill

1. Read [skills.md#add-a-new-skill](./skills.md#add-a-new-skill)
2. Check [development.md#add-a-new-skill](./development.md#add-a-new-skill)
3. Follow pattern in [config/pricing.js](../config/pricing.js) + [src/a2a/handler.js#executeSkill](../src/a2a/handler.js)
4. Run test-gate.sh before commit

### I want to debug a payment issue

1. Check [payments.md#troubleshooting](./payments.md#troubleshooting)
2. Query [database.md#payments--anti-replay](./database.md#payments--anti-replay)
3. Verify anti-replay via [database.md#used_signatures](./database.md#used_signatures)

### I want to verify a signature offline

1. Read [signing.md#offline-verification](./signing.md#offline-verification)
2. Copy code example (Python, JavaScript, etc.)
3. Check [signing.md#troubleshooting](./signing.md#troubleshooting)

### I want to set up a development environment

1. Follow [development.md#setup](./development.md#setup) (20 min)
2. Run tests: `npm run test` (5 min)
3. Start server: `node server.js` (2 min)
4. Test endpoints: [development.md#api-testing](./development.md#api-testing)

### I want to understand caching

1. Check [skills.md#caching-patterns](./skills.md#caching-patterns)
2. Query examples in [database.md#scan_history](./database.md#scan_history)
3. TTL values in [architecture.md#cache-ttl-enforcement](./architecture.md#cache-ttl-enforcement)

## Architecture at a Glance

```
Request → NGINX (TLS) → Express (port 3402)
          ↓
    Middleware Stack
    ├─ Morgan logging
    ├─ API key auth
    ├─ Rate limit (free_scan_quota)
    └─ x402 payment (requirePayment)
          ↓
    Route Handler
    ├─ /a2a (JSON-RPC 2.0) → A2A handler → executeSkill() → internal loopback
    ├─ /scan/* (REST oracle) → Signature + response
    ├─ /monitor/* (Governance) → Helius/Alchemy + verdict
    ├─ /feed/* (SPL tokens) → Streaming mint events
    ├─ /verify/* (Receipt verification) → Key pinning + Ed25519 check
    └─ /.well-known/* (Discovery) → JWKS, agent-card.json
          ↓
    Cache Check (scan_history)
    ├─ Hit? Return immediately
    └─ Miss? Compute + store
          ↓
    Compute Result
    ├─ RPC calls (Solana, Alchemy, Helius)
    ├─ Enrichment (scam-db, IRIS)
    ├─ Optional LLM (Advisor, grey-zone 40-70)
    └─ Ed25519 signing (asyncSign)
          ↓
    Database Write
    ├─ scan_history (cache for future)
    ├─ advisor_calls (LLM usage tracking)
    └─ payments (x402 log)
          ↓
    Response
    ├─ Flat JSON envelope
    ├─ Signature + verify_key
    └─ Metadata (signed_at, signer, issuer, etc.)
```

## Key Invariants

These are non-negotiable constraints enforced throughout the codebase:

1. **Single source of truth for pricing** → `config/pricing.js` only
2. **Anti-replay atomicity** → `markSignatureUsed()` before response
3. **Canonical JSON for all signatures** → `canonicalJSON()` everywhere
4. **Real IP detection** → `CF-Connecting-IP` header (Cloudflare)
5. **Cache TTL enforcement** → All cache hits check expiry
6. **Bounded subprocess concurrency** → Max 8 signing processes
7. **Free tier isolation** → No payment required for free skills
8. **AutoPilot spending limits** → Enforced per-agent, per-day

See [architecture.md#key-invariants--constraints](./architecture.md#key-invariants--constraints) for details.

## Performance Budget

- **Hot path (free skills):** < 1 second
- **Warm path (LLM evaluation):** 1-30 seconds
- **Cold path (deep audit):** 30+ seconds
- **Signing subprocess:** 100-200ms (bounded at 8 parallel)
- **Database cache hit:** ~5ms
- **RPC latency:** 200-500ms (Alchemy/Quicknode)

See [architecture.md#hot-path-performance-budget](./architecture.md#hot-path-performance-budget).

## Testing Strategy

- **Unit tests:** ~187 passing (in-memory SQLite, mocked RPC)
- **Integration tests:** temp SQLite, real endpoints via loopback
- **E2E smoke:** Live deployment (`scripts/smoke-a2a.sh`)
- **Test gate:** Pre-commit validation (`scripts/test-gate.sh`)

Run tests before every commit:

```bash
bash scripts/test-gate.sh
```

## External Resources

### Standards & Specs

- **A2A 0.4.1** — Agent-to-Agent protocol: https://google.github.io/A2A/specification
- **x402** — HTTP 402 payment protocol: https://github.com/cheapay/x402
- **RFC 8037** — CFRG ECDH and Signatures (Ed25519): https://tools.ietf.org/html/rfc8037
- **RFC 8032** — Edwards-Curve Digital Signature Algorithm (EdDSA): https://tools.ietf.org/html/rfc8032

### Tools & Services

- **Solana Web3.js** — https://solana-labs.github.io/solana-web3.js/
- **Alchemy RPC** — https://alchemy.com/
- **Helius Enhanced TX API** — https://docs.helius.xyz/
- **OtterSec verify.osec.io** — https://verify.osec.io/
- **Metaplex Agent Registry** — https://www.metaplex.com/agents/

## Contributing

Before submitting code:

1. Read [CLAUDE.md](../CLAUDE.md) (project rules)
2. Read [development.md](./development.md) (setup + testing)
3. Check file ownership in CLAUDE.md#6
4. Write tests for new functionality
5. Run `bash scripts/test-gate.sh` before commit
6. Follow conventional commit format

For larger changes:
1. Create GitHub issue describing the change
2. Request review from Hans (hanslicko@gmail.com)
3. Include link to this documentation in PR description

## Maintenance Notes

**Database backups:**
- SQLite WAL file lives alongside main DB
- Checkpoint every 6 hours via PRAGMA
- Backup both files atomically

**Key rotation:**
- Ed25519 keys in `/root/.secrets/` (not in git)
- Published as JWKS at `/.well-known/jwks.json`
- Rotation requires ADR discussion (see CLAUDE.md#12)

**Dependencies:**
- Keep `@solana/web3.js` and SPL token libraries in sync
- Update better-sqlite3 carefully (native module rebuilds)
- Lock Stripe version (minimal use, may deprecate)

## Questions?

- **Architecture questions** → Hans Licko (hanslicko@gmail.com)
- **Specific code questions** → Check file comments + test examples
- **API integration questions** → See [skills.md](./skills.md)
- **Deployment questions** → See [development.md](./development.md) + systemd service

---

**Last updated:** 2026-05-06
**Document set version:** 1.0
**Coverage:** Architecture, A2A skills, payments, database, signing, development workflows
