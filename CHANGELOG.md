# Changelog

All notable changes to integrity.molt are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - 2026-04-07

### Initial public release

#### Core scanner pipeline
- Solana address quick scan (RPC-only, ~1-2s)
- Deep security audit via multi-agent swarm orchestrator
- Token security audit — mint/freeze authority, supply concentration, Metaplex metadata, Token-2022 extensions, Beggars Allocation risk
- Wallet profiling — age estimate, DeFi exposure, risk classification
- DeFi pool safety scan — Raydium/Orca/Meteora liquidity analysis
- EVM token scanner — honeypot detection, source code analysis (Base/Ethereum/Arbitrum)

#### Report signing & verification
- Ed25519 cryptographic signatures on every report (PyNaCl / libsodium)
- Public verify key published at `/services` and `/.well-known/x402.json`
- Browser-native verification at `/verify` (WebCrypto Ed25519, no dependencies)
- Python CLI verifier: `verify-report.py`

#### Verified Delta Reports
- Snapshot storage for every paid scan (`data/snapshots/`)
- SHA-256 content hashing per snapshot
- Structured diff engine — 6 change categories with LLM-generated security explanations
- Signed delta reports (Ed25519) comparing two snapshots
- API: `GET /api/v1/delta/:address`, `GET /api/v1/history/:address`

#### Adversarial Simulation
- Local validator fork via `solana-test-validator --clone`
- 7 attack playbooks: authority takeover, oracle manipulation, missing signer check, account confusion, drain vault, CPI reentrancy, integer overflow
- CWE-mapped findings with VULNERABLE/LIKELY_VULNERABLE/PROTECTED verdicts
- LLM-powered exploit path analysis (Gemini 2.5 Flash via OpenRouter)
- API: `POST /api/v1/adversarial/simulate`

#### Payment & access
- x402 micropayment paywall (USDC on Solana mainnet)
- Per-scan pricing: 0.15–2.00 USDC
- Bearer API key support for subscribers (unlimited scans)
- Stripe subscription checkout (Builder $79/mo, Team $299/mo)

#### Infrastructure
- Express server with NGINX reverse proxy
- PostgreSQL — users, API keys, payments, funnel events, watchlist
- Passport.js — Google, GitHub, Twitter OAuth + local email/password
- Telegram bot integration with watchlist alerts
- OpenAPI 3.0 specification at `/openapi.json`
- x402 discovery at `/.well-known/x402.json`
- Puppeteer PDF/PNG report generation
