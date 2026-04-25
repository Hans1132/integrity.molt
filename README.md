# integrity.molt

**Solana A2A Security Oracle**

Solana-first A2A security oracle issuing Ed25519-signed, server-verifiable risk receipts for agents and small protocols.

---

## What it does

integrity.molt lets an on-chain agent or a sub-$10M TVL Solana protocol ask:

- **"Is this address safe to interact with?"** → signed IRIS risk score, instantly
- **"Has this program's governance changed?"** → signed verdict with per-transaction findings
- **"What new tokens minted recently?"** → signed pull-feed, no subscription required
- **"Is this receipt genuine?"** → server-side Ed25519 key-pinned verification

Every answer is an **Ed25519-signed portable envelope**, verifiable offline against the published JWKS. The oracle is A2A-discoverable via `/.well-known/agent-card.json` and payable per-call via the x402 protocol.

## Why it's not just a retail scanner

Most security tools return human-readable HTML or PDF. integrity.molt returns structured JSON envelopes that an agent can sign-check, forward, cache, and chain — without a human in the loop. The receipt carries the oracle's public key fingerprint; a downstream agent can verify authenticity without calling home.

---

## Quickstart

```bash
# Free scan — returns signed envelope
curl https://intmolt.org/scan/v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

# Verify the receipt you just got
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d '{"envelope": <paste scan response here>}'

# Pull new SPL token mints (last 24h)
curl "https://intmolt.org/feed/v1/new-spl-tokens"

# Governance change detection — paid (0.15 USDC via x402)
curl -X POST https://intmolt.org/monitor/v1/governance-change \
  -H "Content-Type: application/json" \
  -H "X-Payment: <x402-envelope>" \
  -d '{"program_id": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf"}'
```

---

## A2A Oracle Endpoints

### Free discovery tier

| Endpoint | Description |
|---|---|
| `GET /scan/v1/:address` | IRIS risk scan, signed envelope |
| `GET /feed/v1/new-spl-tokens` | Pull-feed of new SPL mint events, signed |
| `GET /.well-known/agent-card.json` | A2A skill + pricing discovery |
| `GET /.well-known/jwks.json` | Ed25519 public key (RFC 8037 JWK) |
| `GET /.well-known/receipts-schema.json` | JSON Schema for signed envelopes |

### Attestation tier (0.15 USDC via x402)

| Endpoint | Description |
|---|---|
| `POST /monitor/v1/governance-change` | Signed verdict on program governance events |

### Verification (free, no paywall)

| Endpoint | Description |
|---|---|
| `POST /verify/v1/signed-receipt` | Server-side Ed25519 receipt verification with key pinning |

### Legacy deep-scan tier (existing endpoints)

| Endpoint | Price |
|---|---|
| `POST /api/v1/scan/quick` | 1.00 USDC |
| `POST /api/v1/scan/deep` | 5.00 USDC |
| `POST /api/v1/scan/token` | 1.00 USDC |
| `POST /api/v1/adversarial/simulate` | 5.00 USDC |
| `POST /api/v1/delta/:address` | 0.50 USDC |

---

## Signed Receipt Flow

Every oracle response is a **flat signed envelope**:

```json
{
  "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "iris_score": 94,
  "risk_level": "low",
  "risk_factors": [],
  "signed_at": "2026-04-24T10:00:00.000Z",
  "signature": "<base64 Ed25519 sig>",
  "verify_key": "<base64 raw 32-byte public key>",
  "key_id": "<first 16 chars of verify_key>",
  "signer": "integrity.molt",
  "algorithm": "Ed25519"
}
```

**To verify a receipt:**

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

`valid: true` requires **both** correct Ed25519 math AND the key matching the server's JWKS. A self-signed envelope with a foreign key returns `valid: false, reason: key_not_pinned, mathematically_valid: true` — so downstream agents can distinguish oracle attestation from arbitrary Ed25519 proofs.

**Offline verification** (Python, no HTTP call):

```python
import json, base64, nacl.signing

receipt = json.load(open('receipt.json'))
vk = nacl.signing.VerifyKey(base64.b64decode(receipt['verify_key']))
payload = {k: v for k, v in receipt.items()
           if k not in {'signature','verify_key','key_id','signed_at','signer','algorithm','report'}}
canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
vk.verify(canonical.encode(), base64.b64decode(receipt['signature']))
print("✓ Valid")
```

---

## Agent Discovery

```bash
curl https://intmolt.org/.well-known/agent-card.json
```

Returns skills list with endpoint paths, pricing tiers, and example inputs — compatible with A2A agent registries and ElizaOS plugin discovery.

---

## x402 Payment Protocol

Paid endpoints return `402` with payment instructions. No account required.

```bash
# 1. Get payment instructions
curl -X POST https://intmolt.org/monitor/v1/governance-change \
  -d '{"program_id": "..."}' -H "Content-Type: application/json"
# → 402 { "accepts": [{ "scheme": "exact", "asset": "USDC", ... }] }

# 2. Send USDC on Solana, include tx sig
curl -X POST https://intmolt.org/monitor/v1/governance-change \
  -H "X-Payment: <base64-x402-envelope>" \
  -H "Content-Type: application/json" \
  -d '{"program_id": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf"}'
```

---

## Smoke Test

```bash
# Unit tests (no server required)
npm run test:a2a

# E2E smoke against live server
API_URL=https://intmolt.org bash scripts/smoke-a2a.sh
```

---

## Demo Flow (3 min)

```bash
# 1. Free scan — agent discovers risk score
curl https://intmolt.org/scan/v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  | tee /tmp/receipt.json | jq '{address, iris_score, risk_level, signature}'

# 2. Verify the receipt — no secret, no trust-me
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d "{\"envelope\": $(cat /tmp/receipt.json)}" \
  | jq '{valid, key_pinned, reason}'

# 3. Pull feed of new tokens
curl "https://intmolt.org/feed/v1/new-spl-tokens?since=$(date -u -d '1 hour ago' +%FT%TZ)" \
  | jq '{count, since}'

# 4. Agent-card discovery
curl https://intmolt.org/.well-known/agent-card.json | jq '.skills[].id'
```

---

## Security Properties

- Ed25519 signatures over `canonicalJSON` (sorted-key, no pretty-print ambiguity)
- Key pinning on `/verify/v1/signed-receipt` — oracle key vs. foreign key is explicit
- Anti-replay: USDC transaction signatures stored in SQLite with atomic `INSERT OR IGNORE`
- x402 payment enforced by middleware; governance handler asserts `req.paymentVerified` as defense-in-depth
- Rate limiting on free endpoints (10 req/min scan, 20 req/min feed per IP)
- Subprocess concurrency bounded (`SIGN_CONCURRENCY=8`)

---

## Known Limitations

- Governance endpoint uses Helius Enhanced Transactions API; falls back to mock verdict if `HELIUS_API_KEY` is not set (response includes `data_source: "mock"`)
- Transparency log / Merkle anchoring not yet implemented — receipts are atomic, not chained
- Solana-only oracle surface; EVM scanner exists but is a separate legacy endpoint
- `sign-report.py` subprocess dependency (Python + PyNaCl) — migrating to native Node.js Ed25519 is planned

integrity.molt cross-references OtterSec's verify.osec.io API as zero-cost trust signal enrichment for program-level skills.

---

## Self-hosted Setup

```bash
git clone <repo>
cp .env.example .env
# Fill in: HELIUS_API_KEY, OPENROUTER_API_KEY, USDC_ATA, SOLANA_WALLET_ADDRESS
npm install
node server.js
```

Required secrets in `/root/.secrets/` (never committed):
- `signing_key.bin` — Ed25519 private key (32 bytes raw)
- `verify_key.bin` — corresponding public key

---

## Architecture

```
server.js                   Express monolit, x402 middleware, všechny mount body
src/
  a2a/
    handler.js              JSON-RPC 2.0 + SSE + buildAgentCard()
    autopilot.js            AutoPilot PDA co-signing
  routes/
    a2a-oracle.js           4 A2A oracle endpointy (verify, scan, monitor, feed)
  crypto/
    sign.js                 asyncSign(), canonicalJSON(), semaphore
  monitor/
    alerts.js               Detection engine (authority change, program upgrade, …)
    webhook-receiver.js     Helius webhook ingestion → events.jsonl
  features/
    iris-score.js           IRIS scoring (free discovery layer)
  delta/
    signing.js              Delta report signing
  payment/
    verify-pda.js           Metaplex Asset Signer PDA derivation
config/
  pricing.js                Single source of truth pro ceny
tests/
  a2a-oracle.test.js        70 unit tests (350 ms)
scripts/
  smoke-a2a.sh              E2E smoke skript
```

---

## License

MIT
