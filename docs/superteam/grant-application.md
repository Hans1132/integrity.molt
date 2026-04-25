# Superteam Agentic Engineering Grant — Application
**Project:** integrity.molt  
**URL:** https://intmolt.org  
**X:** @HLo18147  
**GitHub:** github.com/hans1132  
**Grant amount:** $200 USDG  
**Deadline:** May 31, 2026

---

## Problem Statement

AI agents operating on Solana have no programmatic way to verify whether a token, wallet, or DeFi pool is safe before interacting with it. Existing security tools either:

- Require human oversight (not agent-compatible)
- Have no machine-readable API
- Don't accept on-chain micropayments from agent wallets (PDA signers)

When an autonomous agent needs to know if a token is a rug pull before executing a swap, there is no pay-as-you-go security API that accepts payment from the agent's own Asset Signer PDA wallet. Agents making financial decisions on Solana are flying blind.

---

## Proposed Solution

**integrity.molt** is a deployed Solana security scanner built specifically for AI agents.

Agents call scan skills (`token_audit`, `agent_token_scan`, `wallet_profile`, `deep_audit`) and pay per-scan in USDC via the **x402 micropayment protocol** — directly from their Asset Signer PDA wallets. No human approval. No API keys. Results are **Ed25519-signed reports** that agents can cryptographically verify.

### What's already live

- **5 scan endpoints:** `/api/v1/scan/{quick,token,wallet,pool,deep}`
- **IRIS scoring engine** — multi-agent swarm: Scanner → Analyst → Reputation → Meta-scorecard
- **x402 paywall** — USDC/SOL micropayments, ATA-correct, anti-replay
- **Helius webhooks** — live on-chain monitoring
- **Telegram bot** — @integrity_molt_bot for human alerts
- **A2A protocol** — Google A2A JSON-RPC 2.0: `tasks/send`, `tasks/get`, `tasks/cancel`
- **6 agent skills** in `/.well-known/agent.json`
- **Metaplex Agent Registry** — registered as an OpenClaw module
- **Delta reports** — LLM-powered diffs via OpenRouter/gemini-2.5-flash

### What the grant funds: A2A Phase 1

The current A2A task store is **in-memory** — a server restart loses all pending tasks. OpenClaw agents waiting on a `deep_audit` (2+ minutes) lose their task ID and cannot retrieve results.

**Phase 1 implementation (1-2 days):**

1. **SQLite task store** (`src/a2a/task-store.js`)  
   - Persist tasks across restarts  
   - TTL cleanup (1h), cron every 10 min  
   - API: `createTask()`, `getTask()`, `updateTask()`, `listTasksBySession()`

2. **SSE streaming** — new `tasks/sendSubscribe` method  
   - Agents subscribe once, receive `task_created → task_working → task_completed` events  
   - No polling — pure push  
   - Timeouts: 30s quick_scan, 150s token_audit, 330s deep_audit

3. **Webhook callback** — agents register a `callbackUrl`, get POSTed results on completion

---

## Why This Matters for the Solana Ecosystem

- **AI agents need security oracles.** As Solana agent activity grows (OpenClaw, Metaplex Agent Registry, .molt domain tokens), agents executing swaps and DeFi operations need real-time rug pull detection.
- **x402 is the native agent payment rail.** No API keys, no subscriptions — agents pay per-use from their own wallets, autonomously.
- **Already positioned.** integrity.molt is explicitly named as an OpenClaw module. The infrastructure exists. Phase 1 makes it production-grade for long-running agent workflows.
- **Composability, not redundancy.** integrity.molt integrates with OtterSec's verify.osec.io — the public verification API for Solana program builds — as a zero-cost enrichment layer. Each scan that targets a program now surfaces whether the deployed bytecode matches a verified public repository. This composability demonstrates integrity.molt's role as a verdict aggregation layer, not a redundant scanner: we cite authoritative sources and add agent-economy distribution (A2A, x402, Metaplex Agent Registry) on top.

---

## Proof of Execution

- **intmolt.org** — live scanner (Node.js/Express, systemd, NGINX/TLS)
- **Paid scan endpoints** — tested across LEGIT/SCAM/UNKNOWN token matrix
- **A2A handler** — `src/a2a/handler.js` functional, 6 skills wired
- **Metaplex Agent Registry** — registered 2026-04-14
- **28+ commits** on main branch, conventional commit convention enforced
- **Multi-agent CI** — test-gate.sh runs unit + integration before every commit

---

## Milestones

| Milestone | Deliverable | Date |
|-----------|-------------|------|
| M1 | SQLite task store deployed, tasks survive restart | May 10, 2026 |
| M2 | SSE streaming live, OpenClaw agent test call succeeds | May 20, 2026 |
| M3 | Webhook callback tested end-to-end with external agent | May 31, 2026 |

---

## Team

Solo builder. Full-stack + Solana background. Running integrity.molt since early 2026.  
All infrastructure managed autonomously via multi-agent Claude Code swarm (conductor, backend, monitor, bot agents).

---

*Generated with Claude Code (claude-sonnet-4-6) as part of the Superteam Agentic Engineering Grant application process.*
