# Hackathon Submission Draft — integrity.molt

## Project name
integrity.molt

## One-liner
Solana-first A2A security oracle issuing Ed25519-signed, server-verifiable risk receipts for agents and small protocols.

## Problem
Agents and small Solana protocols need to assess counterparty risk, verify token safety, and detect governance changes before committing funds. Current security tools produce human-readable output — PDFs, dashboards, HTML — that agents cannot consume, chain, or cryptographically verify. There is no composable, machine-native security primitive for Solana.

## Solution
integrity.molt exposes a narrow set of oracle endpoints that return **signed JSON envelopes** over a **free discovery tier + x402 paid attestation tier**. Every response is signed with Ed25519 using canonical JSON, and can be verified server-side (with key pinning) or offline (against the JWKS). The oracle is A2A-discoverable via `/.well-known/agent-card.json`.

## Why now
The A2A protocol (Google, April 2025) and x402 payment standard (Cloudflare, April 2025) have just standardized the infrastructure for agent-to-agent commerce. Solana has the highest agent transaction activity of any L1. The tooling gap — secure, composable security primitives — is open today.

## What is working today (v0.5.0-a2a-oracle)

All of the following are live on `https://intmolt.org`:

| Feature | Status |
|---|---|
| `GET /scan/v1/:address` — free signed scan | ✅ live |
| `POST /verify/v1/signed-receipt` — server-side key-pinned verification | ✅ live |
| `POST /monitor/v1/governance-change` — paid signed verdict | ✅ live |
| `GET /feed/v1/new-spl-tokens` — signed pull-feed | ✅ live |
| `/.well-known/agent-card.json` — A2A discovery (v0.5.0) | ✅ live |
| `/.well-known/jwks.json` — Ed25519 JWKS | ✅ live |
| `/.well-known/receipts-schema.json` — envelope schema | ✅ live |
| x402 pay-per-call (USDC on Solana mainnet) | ✅ live |
| Anti-replay (SQLite atomic INSERT) | ✅ live |
| 70 unit tests green | ✅ green |

**Not yet live:** transparency log, ZK receipts, EVM oracle expansion.

## Demo
- Live API: `https://intmolt.org`
- Quickstart: `curl https://intmolt.org/scan/v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Demo script: `bash scripts/demo-a2a-oracle.sh` (in repo)
- Smoke test: `bash scripts/smoke-a2a.sh`
- Video: [placeholder — record 3 min terminal session against live server]

## Public Goods angle
- Free discovery tier — no account, no key, no friction
- Open verification — JWKS published, receipts verifiable offline, schema documented
- Developer-facing oracle surface — tools for builders, not a closed data product
- Permissionless pay-per-call via x402 — no sales process, no SLA negotiation

## Technical differentiator

1. **Key-pinned verification** — `valid:true` requires matching the oracle's own JWKS key, not just Ed25519 math; prevents forged-receipt injection attacks
2. **Canonical JSON signing** — sorted-key deterministic serialization on both sign and verify sides; interoperable across Go, Python, TypeScript consumers
3. **Composable receipts** — flat JSON envelope passable between agents without unwrapping/re-signing
4. **x402 + A2A native** — no SDK required; any HTTP client with a Solana wallet can call the oracle

## Target users
- On-chain agent frameworks (ElizaOS, SendAI, Olas)
- Sub-$10M TVL Solana protocols without a full-time security team
- DeFi aggregators that need pre-trade counterparty risk checks
- Wallet UIs that want verified token safety badges

## Current traction / proof
- Oracle running on mainnet since April 2025
- x402 payment flow tested end-to-end (USDC on Solana)
- Anti-replay verified across payment tests
- No known production bugs in oracle surface at time of submission

## Roadmap — next 2 weeks
1. `readline` streaming on events.jsonl feed (shipped in v0.5.0)
2. SendAI plugin PR — single `check_solana_address` action
3. Demo video recording against live server
4. Transparency log v0: daily Merkle root of issued receipts published to `/.well-known/receipts-log.json`

## Links checklist
- [ ] Live API: `https://intmolt.org`
- [ ] GitHub repo: [placeholder]
- [ ] Agent card: `https://intmolt.org/.well-known/agent-card.json`
- [ ] JWKS: `https://intmolt.org/.well-known/jwks.json`
- [ ] Demo video: [placeholder]
- [ ] OpenAPI spec: `https://intmolt.org/openapi.json`
