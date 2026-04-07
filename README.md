# integrity.molt

**Autonomous AI Security Agent for Solana**

On-chain risk intelligence with cryptographically verifiable reports and x402 micropayments.

---

## Features

- **Smart contract security scanning** — Anchor/native Rust programs, token mints, DeFi pools, wallets
- **Ed25519 signed reports** — every report is cryptographically signed and independently verifiable
- **x402 pay-per-scan** — no accounts, no subscriptions required; pay per query with USDC
- **Verified Delta Reports** — cryptographically signed diffs between two scans of the same address
- **Adversarial Simulation** — AI agent forks on-chain state and systematically probes exploit paths
- **Agent-to-agent commerce ready** — machine-readable API, x402 discovery, OpenAPI spec

---

## API

**Base URL:** `https://intmolt.org`

### Scan endpoints (x402 micropayments)

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| `/api/v2/scan/quick` | POST | 1.00 USDC | Fast RPC-only risk assessment |
| `/api/v2/scan/deep` | POST | 2.00 USDC | Full multi-agent security audit |
| `/api/v2/scan/token` | POST | 1.00 USDC | Token security audit (mint/freeze authority, supply) |
| `/api/v2/scan/wallet` | POST | 1.00 USDC | Wallet profiling and risk classification |
| `/api/v2/scan/pool` | POST | 1.00 USDC | DeFi pool safety scan |
| `/api/v2/scan/evm-token` | POST | 1.00 USDC | EVM token honeypot + source analysis |
| `/api/v1/scan/token-audit` | POST | 0.15 USDC | Deep token security audit with LLM analysis |

### Delta & history endpoints

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| `/api/v1/history/:address` | GET | Free | Snapshot history for an address |
| `/api/v1/delta/:address` | GET | 0.15 USDC | Signed diff: latest vs. baseline snapshot |
| `/api/v1/delta/:address/:ts1/:ts2` | GET | 0.15 USDC | Signed diff between two specific snapshots |

### Adversarial simulation

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| `/api/v1/adversarial/playbooks` | GET | Free | List all attack playbooks |
| `/api/v1/adversarial/simulate` | POST | 2.00 USDC | Full adversarial simulation against a program |

### Discovery endpoints (free)

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service health check |
| `GET /services` | Full service catalog with pricing |
| `GET /openapi.json` | OpenAPI 3.0 specification |
| `GET /.well-known/x402.json` | x402 protocol discovery |
| `GET /stats` | Public reputation statistics |

---

## x402 Payment Flow

```bash
# 1. Check what payment is required
curl -X POST https://intmolt.org/api/v1/scan/token-audit \
  -H "Content-Type: application/json" \
  -d '{"token_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'
# → 402 with payment instructions

# 2. Send USDC on Solana mainnet, include tx sig as X-Payment header
curl -X POST https://intmolt.org/api/v1/scan/token-audit \
  -H "Content-Type: application/json" \
  -H "X-Payment: <base64-encoded-payment-envelope>" \
  -d '{"token_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'
```

API key subscribers skip the payment step entirely:
```bash
curl -X POST https://intmolt.org/api/v1/scan/token-audit \
  -H "Authorization: Bearer im_yourkey" \
  -H "Content-Type: application/json" \
  -d '{"token_mint": "..."}'
```

---

## Verify Reports

Every report is signed with Ed25519. Three ways to verify:

**Browser:** `https://intmolt.org/verify` — paste any `.signed.json` or delta report

**Python:**
```python
import json, base64, nacl.signing

with open('report.signed.json') as f:
    env = json.load(f)

vk = nacl.signing.VerifyKey(base64.b64decode(env['verify_key']))
vk.verify(env['report'].encode(), base64.b64decode(env['signature']))
print("✓ Valid")
```

**CLI:** `python3 verify-report.py report.signed.json`

The public verify key is published at `GET /services` → `reportSigning.verifyKey`.

---

## Adversarial Simulation

```bash
curl -X POST https://intmolt.org/api/v1/adversarial/simulate \
  -H "Authorization: Bearer im_yourkey" \
  -H "Content-Type: application/json" \
  -d '{
    "program_id": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "skip_fork": false
  }'
```

Attack playbooks: `authority_takeover`, `oracle_manipulation`, `missing_signer_check`,
`account_confusion`, `drain_vault`, `reentrancy_cpi`, `integer_overflow`.

Results are signed with Ed25519 and include CWE mappings, LLM-generated exploit paths, and remediation recommendations.

---

## Self-hosted setup

```bash
git clone git@github.com:Hans1132/integrity.molt.git
cd integrity.molt
cp .env.example .env
# Fill in .env values (see .env.example for documentation)

npm install
node server.js
```

**Required secrets** (stored in `/root/.secrets/`, never committed):
- `signing_key.bin` — Ed25519 private key (generate: `python3 -c "import nacl.signing, open; k=nacl.signing.SigningKey.generate(); open('.secrets/signing_key.bin','wb').write(bytes(k))"`)
- `verify_key.bin` — corresponding public key
- `openrouter_api_key` — OpenRouter API key for LLM analysis
- `alchemy_api_key` — Alchemy RPC key (optional, improves reliability)
- `etherscan_api_key` — Etherscan API key (for EVM scanning)

**Required services:**
- PostgreSQL (schema auto-created on first start)
- NGINX reverse proxy (see `nginx.conf.example`)
- systemd service (see `intmolt.service.example`)

---

## Architecture

```
server.js              — Express app, x402 payment middleware, API routing
scanners/
  token-audit.js       — SPL token security audit (web3.js + LLM)
  evm-token.js         — EVM token analysis (Etherscan + Alchemy)
src/
  delta/
    store.js           — Snapshot filesystem storage
    diff.js            — Structured diff engine with LLM explanations
    signing.js         — Ed25519 delta report signing
  adversarial/
    fork.js            — solana-test-validator fork + account discovery
    playbooks.js       — Attack playbook definitions (7 playbooks, CWE-mapped)
    executor.js        — @solana/web3.js transaction-level exploit executor
    runner.js          — AI orchestrator: fork → analyze → simulate → sign
report-generator.js    — Puppeteer PDF/PNG generation
auth.js                — Passport.js (Google/GitHub/Twitter/local)
db.js                  — PostgreSQL (users, API keys, payments, events)
```

---

## License

MIT — see [LICENSE](LICENSE)
