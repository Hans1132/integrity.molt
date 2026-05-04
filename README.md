# integrity.molt

A Solana-native A2A 0.4.1 security oracle for autonomous agents
exposing 11 skills (5 free, 6 paid via x402 USDC). Returns
Ed25519-signed risk receipts that another agent or a human can verify offline.

- **Live API:** [intmolt.org](https://intmolt.org)
- **Marketing site:** [integritymolt.com](https://integritymolt.com)
- **Metaplex Agent Registry:** [Active, EIP-8004 metadata](https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy)

---

## What it does

When an on-chain agent or a small protocol needs a quick trust signal before acting, it can ask:

- *Is this address safe to interact with?* — IRIS risk score, signed.
- *Has this program's governance changed?* — signed verdict with per-transaction findings.
- *What new SPL tokens minted recently?* — signed pull-feed, no subscription.
- *Is this receipt genuine?* — server-side Ed25519 verification with key pinning.

Responses are flat JSON envelopes signed with Ed25519. The signature is verifiable against the published JWKS, so a downstream consumer doesn't need to call back to confirm authenticity.
Discovery is A2A-compatible via `/.well-known/agent-card.json`, and paid endpoints settle per-call through the x402 protocol.

The target user is an agent operator or a sub-$10M TVL Solana protocol that needs callable trust primitives — not a human browsing a dashboard.

---

## Composability

OtterSec [verify.osec.io](https://verify.osec.io) is integrated as a live enrichment layer on every program-level skill. If deployed bytecode does not match a verified source repository, the signed receipt says so.

Metaplex Agent Registry registration ([Core Asset 2tWPw22b...gZZy](https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy)) is cryptographically referenced in every signed receipt envelope through `issuer_metaplex_asset` and `issuer_metaplex_url` fields. Identity is verifiable on chain, not just in metadata.

Alchemy Solana RPC serves as the automatic fallback data source for the governance endpoint. When Helius Enhanced Transactions are unavailable, the oracle transparently switches to Alchemy's `getSignaturesForAddress` + `getTransaction` pipeline — no change to the response schema, only `data_source` reflects the switch.

Open standards — A2A 0.4.1 for discovery, x402 for payments, Ed25519 for signatures, JWKS (RFC 8037) for key publication. No proprietary protocol, no lock-in.

---

## Quickstart

> **Platform note:** All `curl` commands below run on Linux and macOS (bash/zsh) without modification. Windows users: use WSL2 or Git Bash, or see the [Windows (PowerShell)](#windows-powershell) section at the bottom.

```bash
# Free scan — save response to file for reuse in subsequent commands
curl https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  | tee /tmp/receipt.json

# Verify the receipt you just received
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d "{\"envelope\": $(cat /tmp/receipt.json)}"

# Pull-feed of new SPL token mints (last 24h)
curl https://intmolt.org/feed/v1/new-spl-tokens

# Governance change detection — paid (0.15 USDC via x402)
# Step 1: probe — returns 402 + payment instructions
curl -X POST https://intmolt.org/monitor/v1/governance-change \
  -H "Content-Type: application/json" \
  -d '{"program_id": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf"}'
# Step 2: settle 0.15 USDC on Solana using an x402 client, then retry with X-Payment header
```

---

## A2A skills

The canonical surface is A2A 0.4.1 — eleven skills, discoverable via `/.well-known/agent-card.json`. Five are free, six settle in USDC over x402.

### Free tier

| Skill | Description |
|---|---|
| `quick_scan` | Fast first-pass risk scoring |
| `scan_address` | IRIS oracle lookup, signed envelope |
| `new_spl_feed` | Pull-feed of newly deployed SPL tokens |
| `verify_receipt` | Offline verification of a signed receipt |
| `program_verification_status` | OtterSec `verify.osec.io` cross-reference |

### Paid tier (x402 USDC)

| Skill | Price | Description |
|---|---|---|
| `agent_token_scan` | $0.15 | Risk scan for an agent token |
| `governance_change` | $0.15 | Detection and signed verdict on program governance events |
| `token_audit` | $0.75 | Mid-tier audit on SPL tokens |
| `wallet_profile` | $0.75 | Behavioral profile and reputation lookup for a wallet |
| `adversarial_sim` | $4.00 | Adversarial simulation against a target program |
| `deep_audit` | $5.00 | Full deep audit, multi-LLM Advisor pipeline |

---

## HTTP endpoints

A subset of skills is exposed as plain REST for clients that don't speak A2A JSON-RPC.

### Free

| Endpoint | Maps to skill |
|---|---|
| `GET /scan/v1/:address` | `scan_address` |
| `GET /feed/v1/new-spl-tokens` | `new_spl_feed` |
| `POST /verify/v1/signed-receipt` | `verify_receipt` |

### Paid (x402)

| Endpoint | Maps to skill | Price |
|---|---|---|
| `POST /monitor/v1/governance-change` | `governance_change` | 0.15 USDC |

### Discovery

| Endpoint | Description |
|---|---|
| `GET /.well-known/agent-card.json` | A2A skill list and pricing |
| `GET /.well-known/jwks.json` | Ed25519 public key, RFC 8037 JWK |
| `GET /.well-known/receipts-schema.json` | JSON Schema for signed envelopes |

---

## Receipt format

Every oracle response is a flat envelope:

```json
{
  "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "iris_score": 94,
  "risk_level": "low",
  "risk_factors": [],
  "signed_at": "2026-04-24T10:00:00.000Z",
  "signature": "<base64url Ed25519 signature>",
  "verify_key": "<base64url raw 32-byte public key>",
  "key_id": "<first 16 chars of verify_key>",
  "signer": "integrity.molt",
  "algorithm": "Ed25519"
}
```

### Server-side verification

```bash
# Save scan to file first
curl https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  | tee /tmp/receipt.json

# Verify
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d "{\"envelope\": $(cat /tmp/receipt.json)}"
```

Example response:

```json
{
  "valid": true,
  "key_pinned": true,
  "mathematically_valid": true,
  "reason": "signature_valid",
  "key_id": "qzppeeRmbyQ4hE4B",
  "signed_at": "2026-05-04T11:25:14Z",
  "issuer": "integrity.molt"
}
```

`valid: true` requires both correct Ed25519 math *and* the key matching the server's published JWKS.
A self-signed envelope with a foreign key returns `valid: false`, `reason: key_not_pinned`, `mathematically_valid: true` — so a consumer can tell the difference between an oracle attestation and an arbitrary Ed25519 signature.

### Offline verification

No HTTP call required. Python with PyNaCl:

```bash
pip install pynacl
```

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

---

## Agent discovery

```bash
curl https://intmolt.org/.well-known/agent-card.json
```

Returns the skill list with endpoint paths, pricing tiers, and example inputs. Compatible with A2A agent registries and ElizaOS plugin discovery.

---

## x402 payments

Paid endpoints respond with `402` and payment instructions. No account, no API key required.

```bash
# Step 1: probe — returns 402 with full payment instructions
curl -X POST https://intmolt.org/monitor/v1/governance-change \
  -H "Content-Type: application/json" \
  -d '{"program_id": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf"}'
```

The `402` response body:

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "maxAmountRequired": "150000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "6u8gFVyzyf5dUtKPQKFwSsiAHwkpfKZfJji8J6jzcwvM",
    "description": "Governance Change Detection — Ed25519-signed program audit"
  }]
}
```

```bash
# Step 2: use an x402-capable client to settle and retry automatically
# Node.js example (coinbase/x402-fetch):
#
#   import { withPaymentInterceptor } from "x402-fetch"
#   const res = await withPaymentInterceptor(fetch)(
#     "https://intmolt.org/monitor/v1/governance-change",
#     {
#       method: "POST",
#       headers: { "Content-Type": "application/json" },
#       body: JSON.stringify({ program_id: "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf" })
#     }
#   )
```

---

## Smoke tests

```bash
# Unit tests, no server required
npm run test:a2a

# E2E against a live deployment
API_URL=https://intmolt.org bash scripts/smoke-a2a.sh
```

---

## Demo flow (3 min)

```bash
# 1. Free scan
curl https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  | tee /tmp/receipt.json | jq '{address, iris_score, risk_level, signature}'

# 2. Verify the receipt
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d "{\"envelope\": $(cat /tmp/receipt.json)}" \
  | jq '{valid, key_pinned, reason}'

# 3. Pull recent mints (Linux)
curl "https://intmolt.org/feed/v1/new-spl-tokens?since=$(date -u -d '1 hour ago' +%FT%TZ)" \
  | jq '{count, since}'

# 3. Pull recent mints (macOS)
curl "https://intmolt.org/feed/v1/new-spl-tokens?since=$(date -u -v-1H +%FT%TZ)" \
  | jq '{count, since}'

# 4. Skill discovery
curl https://intmolt.org/.well-known/agent-card.json | jq '.skills[].id'
```

---

## Security properties

- Ed25519 signatures over canonical JSON (sorted keys, no whitespace ambiguity).
- Key pinning on `/verify/v1/signed-receipt` — oracle key vs. foreign key is distinguishable.
- Replay protection: USDC transaction signatures stored in SQLite with atomic `INSERT OR IGNORE`.
- x402 payment enforced by middleware; the governance handler additionally asserts `req.paymentVerified` as defense in depth.
- Rate limits on free endpoints: 10 req/min on scan, 20 req/min on feed, per IP.
- Bounded subprocess concurrency for signing (`SIGN_CONCURRENCY=8`).

Real client IP is read from the `CF-Connecting-IP` header set by the Cloudflare proxy in front of NGINX, not from `X-Forwarded-For`.

---

## Known limitations

- The governance endpoint uses Helius Enhanced Transactions as its primary data source, with automatic fallback to Alchemy RPC (`getSignaturesForAddress` + batched `getTransaction`). The response carries `data_source: "helius"`, `"alchemy_rpc"`, or `"mock"` so consumers can always see which backend was used.
- `GET /feed/v1/new-spl-tokens` returns integrity.molt's signed feed of observed new SPL mint events. The current MVP poller tracks Pump.fun CREATE transactions and Token-2022 mint activity through Alchemy. It is not a complete global index of every SPL mint on Solana — standard Token Program mint discovery may be incomplete depending on upstream RPC indexing behavior.
- No transparency log or Merkle anchoring yet. Receipts are atomic, not chained. Planned for Solana Foundation grant Milestone 3.

---

## Self-hosted setup

```bash
git clone https://github.com/Hans1132/integrity.molt
cd integrity.molt
cp .env.example .env
# Fill in: HELIUS_API_KEY, ALCHEMY_RPC_URL, OPENROUTER_API_KEY, USDC_ATA, SOLANA_WALLET_ADDRESS
npm install
node server.js
```

Required secrets in `/root/.secrets/` (not committed):

- `signing_key.bin` — Ed25519 private key, 32 raw bytes.
- `verify_key.bin` — corresponding public key.

---

## Architecture

```
server.js                   Express app, x402 middleware, all route mounts
src/
  a2a/
    handler.js              JSON-RPC 2.0, SSE, buildAgentCard()
    autopilot.js            AutoPilot PDA co-signing
  routes/
    a2a-oracle.js           A2A oracle endpoints (verify, scan, monitor, feed)
  crypto/
    sign.js                 asyncSign(), canonicalJSON(), semaphore
  monitor/
    alerts.js               Detection engine (authority change, program upgrade, ...)
    webhook-receiver.js     Helius webhook ingestion → events.jsonl
  features/
    iris-score.js           IRIS scoring for the free discovery tier
  delta/
    signing.js              Delta report signing
  payment/
    verify-pda.js           Metaplex Asset Signer PDA derivation
config/
  pricing.js                Single source of truth for prices
tests/
  a2a-oracle.test.js        91 unit tests
  ottersec.test.js          22 adversarial tests
scripts/
  smoke-a2a.sh              E2E smoke script
```

---

## Backed by

- Superteam Agentic Engineering Grant (April 2026)
- Solana Foundation Grant (under review, May 2026)
- Metaplex Agent Registry (Active, EIP-8004 metadata)
- Alchemy Solana Credits Program

---

## Frontier Hackathon

Submitted to the Colosseum Solana Frontier Hackathon (May 2026) in the Public Goods track. Demo video: TBD.

---

## Windows (PowerShell)

The commands above require bash. On Windows, use **WSL2** or **Git Bash** to run them as-is.

If you prefer native PowerShell:

```powershell
# Free scan — save to file
Invoke-RestMethod "https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" `
  | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 "$env:TEMP\receipt.json"

# Verify receipt
$envelope = Get-Content "$env:TEMP\receipt.json" -Raw | ConvertFrom-Json
$body = @{ envelope = $envelope } | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Post "https://intmolt.org/verify/v1/signed-receipt" `
  -ContentType "application/json" -Body $body

# Pull feed with 1-hour window
$since = (Get-Date).ToUniversalTime().AddHours(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
Invoke-RestMethod "https://intmolt.org/feed/v1/new-spl-tokens?since=$since"

# Governance probe — returns 402 + payment instructions
Invoke-RestMethod -Method Post "https://intmolt.org/monitor/v1/governance-change" `
  -ContentType "application/json" `
  -Body '{"program_id": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf"}'
```

---

## License

MIT
