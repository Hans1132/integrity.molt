# integrity.molt

A Solana-native A2A 0.4.1 security oracle for autonomous agents
exposing 11 skills (5 free, 6 paid via x402 USDC). Returns
Ed25519-signed risk receipts that another agent or a human can verify offline.

**Live API:** [intmolt.org](https://intmolt.org)
**Marketing site:** [integritymolt.com](https://integritymolt.com)
**Moltbook agent:** [app.molt.id/integrity](https://app.molt.id/integrity)
**Metaplex Agent Registry:** [Active, EIP-8004 metadata](https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy)
**frames.ag registry:** [PR submitted](https://github.com/frames-engineering/skills/pull/9)

## What it does

When an on-chain agent or a small protocol needs a quick trust signal before acting, it can ask:

- *Is this address safe to interact with?* IRIS risk score, signed.
- *Has this program's governance changed?* Signed verdict with per-transaction findings.
- *What new SPL tokens minted recently?* Signed pull-feed, no subscription.
- *Is this receipt genuine?* Server-side Ed25519 verification with key pinning.

Responses are flat JSON envelopes signed with Ed25519. The signature is verifiable against the published JWKS, so a downstream consumer does not need to call back to confirm authenticity.
Discovery is A2A-compatible via `/.well-known/agent-card.json`, and paid endpoints settle per-call through the x402 protocol.

The target user is an agent operator or a sub-$10M TVL Solana protocol that needs callable trust primitives, not a human browsing a dashboard.

## Quickstart

All skills are available through the A2A endpoint (`POST /a2a`) using JSON-RPC 2.0. A subset is also exposed as plain REST for clients that do not speak A2A.

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

# Free scan via REST (legacy)
curl https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Verify a signed receipt
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d '{"envelope": <paste scan response here>}'

# Pull-feed of new SPL token mints (last 24h)
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
      "params": {"message": {"role": "user", "parts": [{"type": "text", "text": "scan"}]},
                 "metadata": {"skill": "token_audit", "address": "TOKEN_MINT"}}
    }
  }'
```

## A2A skills

The canonical surface is A2A 0.4.1, discoverable via `/.well-known/agent-card.json`. Five skills are free, six settle in USDC over x402.

### Free tier

| Skill | Description |
|---|---|
| `quick_scan` | Fast first-pass risk scoring |
| `scan_address` | IRIS oracle lookup, signed envelope |
| `new_spl_feed` | Pull-feed of newly deployed SPL tokens |
| `verify_receipt` | Offline verification of a signed receipt |
| `program_verification_status` | OtterSec verify.osec.io cross-reference |

### Paid tier (x402 USDC)

| Skill | Price | Description |
|---|---|---|
| `agent_token_scan` | $0.15 | Risk scan optimized for AI agents |
| `governance_change` | $0.15 | Detection and signed verdict on program governance events |
| `token_audit` | $0.75 | Mid-tier audit on SPL tokens |
| `wallet_profile` | $0.75 | Behavioral profile and reputation lookup for a wallet |
| `adversarial_sim` | $4.00 | Adversarial simulation against a target program |
| `deep_audit` | $5.00 | Full deep audit, multi-LLM Advisor pipeline |

## HTTP endpoints

A subset of skills is exposed as plain REST for clients that do not speak A2A JSON-RPC.

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
| `GET /skill.md` | frames.ag registry descriptor with full skill listing |
| `GET /offer` | Machine-readable JSON offer with all 11 skills and pricing |
| `GET /x402.json` | x402 payment manifest |

## Moltbook agent

integrity.molt has an autonomous agent registered on [moltbook](https://app.molt.id/integrity) (molt.id) under the handle `integrity_molt`.

The agent runs every 30 minutes and:
- Replies to comments on its posts using Gemini 2.5 Flash, with live IRIS scan results when a Solana address is mentioned
- Engages with the feed by upvoting relevant posts on security, AI agents, and DeFi
- Sends token audit DM outreach (up to 3/day) to authors of token-launch posts

The agent is also reachable via A2A relay:

```
POST https://multiclaw.moltid.workers.dev/c/integrity/a2a
```

Same JSON-RPC 2.0 envelope as the direct endpoint. Useful for agents already operating in the molt.id ecosystem.

The moltbook agent identity is backed by the same Metaplex core asset (`2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy`) that is referenced in every signed receipt envelope.

## frames.ag registry

integrity.molt is listed in the [frames.ag tools registry](https://github.com/frames-engineering/skills/pull/9) under `skills/integrity-molt`. Agents using the frames.ag ecosystem can discover and call integrity.molt skills directly, paying via the AgentWallet x402/fetch proxy.

The `GET /skill.md` and `GET /offer` endpoints follow the frames.ag spec and are kept in sync with the registry entry.

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

`valid: true` requires both correct Ed25519 math and the key matching the server's published JWKS.
A self-signed envelope with a foreign key returns `valid: false`, `reason: key_not_pinned`, `mathematically_valid: true`, so a consumer can tell the difference between an oracle attestation and an arbitrary Ed25519 signature.

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

## Composability

integrity.molt composes with three independent Solana primitives.

OtterSec verify.osec.io is integrated as a live enrichment layer on every program-level skill. If deployed bytecode does not match a verified source repository, the signed receipt says so.

Metaplex Agent Registry registration ([Core Asset 2tWPw22b...gZZy](https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy))
is cryptographically referenced in every signed receipt envelope through `issuer_metaplex_asset` and `issuer_metaplex_url` fields.
Identity is verifiable on chain, not just in metadata.

Open standards: A2A 0.4.1 for discovery, x402 for payments, Ed25519 for signatures, JWKS (RFC 8037) for key publication. No proprietary protocol, no lock-in.

## x402 payments

Paid endpoints respond with `402` and payment instructions. No account, no API key.

```bash
# 1. Probe for payment requirements
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tasks/send","params":{"message":{"role":"user","parts":[{"type":"text","text":"scan"}]},"metadata":{"skill":"token_audit","address":"..."}}}'
# Response: 402 with x402 payment instructions

# 2. Settle USDC on Solana, retry with payment envelope
# Or use frames.ag AgentWallet x402/fetch proxy (see Quickstart above)
```

## Security properties

- Ed25519 signatures over canonical JSON (sorted keys, no whitespace ambiguity).
- Key pinning on `/verify/v1/signed-receipt`: oracle key vs. foreign key is distinguishable.
- Replay protection: USDC transaction signatures stored in SQLite with atomic `INSERT OR IGNORE`.
- x402 payment enforced by middleware; the governance handler additionally asserts `req.paymentVerified` as defense in depth.
- Rate limits on free endpoints: 10 req/min on scan, 20 req/min on feed, per IP.
- Bounded subprocess concurrency for signing (`SIGN_CONCURRENCY=8`).

Real client IP is read from the `CF-Connecting-IP` header set by the Cloudflare proxy in front of NGINX, not from `X-Forwarded-For`.

## Known limitations

- The governance endpoint uses Helius Enhanced Transactions. Without `HELIUS_API_KEY` it falls back to a mock verdict; the response carries `data_source: "mock"` so consumers can detect this.
- No transparency log or Merkle anchoring yet. Receipts are atomic, not chained. Planned for the Solana Foundation grant Milestone 3.

## Self-hosted setup

```bash
git clone https://github.com/Hans1132/integrity.molt
cd integrity.molt
cp .env.example .env
# Fill in: HELIUS_API_KEY, OPENROUTER_API_KEY, USDC_ATA, SOLANA_WALLET_ADDRESS
npm install
node server.js
```

Required secrets in `/root/.secrets/` (not committed):

- `signing_key.bin`: Ed25519 private key, 32 raw bytes.
- `verify_key.bin`: corresponding public key.

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
    webhook-receiver.js     Helius webhook ingestion into events.jsonl
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

## Smoke tests

```bash
# Unit tests, no server required
npm run test:a2a

# E2E against a live deployment
API_URL=https://intmolt.org bash scripts/smoke-a2a.sh
```

## Backed by

- Superteam Agentic Engineering Grant (April 2026)
- Solana Foundation Grant (under review, May 2026)
- Metaplex Agent Registry (Active, EIP-8004 metadata)
- Alchemy Solana Credits Program

## Frontier Hackathon

Submitted to the Colosseum Solana Frontier Hackathon (May 2026)
in the Public Goods track.

## License

MIT
