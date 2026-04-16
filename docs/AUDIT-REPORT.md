# Audit Report — 2026-04-16

## Executive Summary

integrity.molt API server is running healthy (0 errors in 2h, 111 total scans in DB). The core payment flow (x402 paywall, anti-replay, ATA-based verification) is correctly implemented. However, there are critical cross-component inconsistencies: x402-discovery.json advertises wallet addresses instead of ATA addresses for payTo, USDC is flagged as a scam in the token audit pipeline (false positive from SolRPDS), and the agent.json card exposes localhost URLs. Stats counters, scan cards, and captcha flow on the landing page work correctly. Bot is running but ADMIN_CHAT_ID is not set, making /admin inaccessible.

---

## Flow A: Anonymous visitor -> paid scan

### Co funguje
- Landing page HTML valid, SEO metadata complete (OG, Twitter, JSON-LD), GA4 tracking active
- Stats counters load from `/api/v2/stats` and show real data (111 total scans, 91.3% success rate)
- Scan type cards have working click targets (`<a href="/scan?type=quick">`, etc.) -- CLAUDE.md bug #5 is FIXED
- `/api/v1/stats` and `/api/v2/stats` both return valid JSON -- CLAUDE.md bug #4 is FIXED
- Free scan page (`/scan`) exists with math CAPTCHA integration
- Deep scan returns proper 402 with x402 payment info
- Verify page exists at `/verify` with Ed25519 verification UI
- Payment verification correctly uses ATA (not wallet address) via `postTokenBalances.owner` check
- Anti-replay implemented and working (CLAUDE.md bug #3 is FIXED)
- Subscribe flow redirects to `/login?next=/subscribe/pro_trader` (Stripe checkout behind auth)

### Co je rozbite
- **[x402-discovery.json] payTo = wallet address (HNhZiuih...), NOT ATA address (6u8gFVy...)** -- x402 clients reading discovery doc would send USDC to the wallet directly instead of the ATA. server.js correctly derives and uses the ATA in 402 responses, but x402-discovery.json is a static file with the wrong address. Any client using the discovery file for payment construction will fail verification.
- **[server.js:700] 402 response `resource` field uses `/api/v2/scan/*` paths** -- these only work via NGINX rewrite, not on localhost. Not a bug in production (NGINX handles it), but confusing for local development and testing.
- **[openapi.json] No `x-payment` annotations on any endpoint** -- openapi.json paths list all scan endpoints but none have x-payment pricing metadata. Any client using OpenAPI spec won't discover pricing.

### UX problemy
- **Free scan requires CAPTCHA** for `/scan/free` endpoint. For local API testing, use the internal bypass:
  ```bash
  # CAPTCHA bypass — funguje jen z 127.0.0.1
  curl -s http://127.0.0.1:3402/scan/free -X POST \
    -H "Content-Type: application/json" \
    -H "x-a2a-caller: 1" \
    -d '{"address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEWGkZwyTDt1v","type":"quick"}'
  ```
  Bypass podmínka: `x-a2a-caller: 1` header + request z `127.0.0.1` (server.js:3373).
- **`average_response_time_ms: 0`** in stats -- counter appears to not be recording response times, making the "< 3s" stat a hardcoded fallback rather than real data.
- **Demo scan button** on landing page uses `demoScan()` JS function -- if this calls `/scan/free` it will also need CAPTCHA.

---

## Flow B: Telegram bot

### Co funguje
- `intmolt-bot.service` is active (running since 11:16:10 UTC)
- Bot supports commands: `/start`, `/help`, `/scan`, `/token`, `/evm`, `/status`, `/admin`, `/verify`, `/upgrade`
- `/admin` is properly guarded by ADMIN_CHAT_ID check (returns "Unauthorized" to non-admin users)
- Bot uses correct auth header (`X-Admin-Key`) for internal endpoints
- Async advisor flow works: preliminary response + Telegram push for grey-zone scores
- Last user interaction logged: 2026-04-15 (EVM scan)

### Co je rozbite
- **ADMIN_CHAT_ID not set** -- bot logs `WARNING: ADMIN_CHAT_ID not set — /admin command will be inaccessible` at startup. File `/root/.secrets/admin_chat_id` apparently missing or empty. /admin command is completely broken.
- **JSONDecodeError in journal** (2026-04-15 08:13:31) -- Python JSON parsing crash from bot, likely from empty/malformed API response. The fix in commit 31ba336 should address this, but the error appeared after that commit date needs verification.

### UX problemy
- **Empty Telegram API responses** appear periodically in logs ("Empty response from Telegram API, sleeping 5s") -- 4 occurrences on 2026-04-15. Not critical but indicates network flakiness or Telegram API timeouts.
- **Bot commands /wallet and /pool are missing** -- landing page advertises these scan types but bot only has `/scan` (quick), `/token`, `/evm`. No `/deep` command either.

---

## Flow C: A2A agent

### Co funguje
- Agent card at `/.well-known/agent.json` returns valid A2A card with 8 skills
- A2A handler accepts JSON-RPC 2.0 at `/a2a` (returns proper error for malformed requests)
- Skills include: quick_scan (free), token_audit, agent_token_scan, wallet_profile, deep_audit, adversarial_sim, pool_scan, evm_token_scan
- AutoPilot spending limits and PDA validation are implemented
- SSE streaming endpoint at `/a2a/subscribe`
- Task store is SQLite-backed with TTL cleanup

### Co je rozbite
- **[agent.json] `url` and `iconUrl` use `http://127.0.0.1:3402`** instead of `https://intmolt.org`. External agents cannot reach the service using these URLs. The agent card is built dynamically in server.js, so this is likely from `req.protocol + '://' + req.get('host')` not being overridden.
- **[x402-discovery.json] payTo mismatch** (same as Flow A) -- affects A2A agents trying to construct x402 payments from the discovery file.
- **A2A tasks/send requires `message` param** (`"Missing required param: message"`) -- the error message is correct per A2A spec, but the test in the task description used `params.address` directly instead of wrapping in a message object. This is spec-correct behavior, not a bug.

### UX problemy
- **a2a_tasks table is empty** (0 rows) -- no A2A agent has successfully completed a task yet. Either no agents have connected, or there's an integration issue.

---

## Flow D: IRIS consistency

### Co funguje
- IRIS scoring engine is implemented with 4 dimensions (Inflows, Rights, Imbalance, Speed)
- Thresholds derived from SolRPDS dataset (33,359 scam tokens analyzed)
- server.js quick scan has `KNOWN_LEGITIMATE_TOKENS` whitelist that bypasses scam-db penalty
- Known safe authorities recognized (Circle USDC mint authority, USDT freeze authority)

### Co je rozbite
- **[scanners/token-audit.js] USDC flagged as scam -- risk_score 40 ("CAUTION")** -- The `auditToken()` function does NOT have the `KNOWN_LEGITIMATE_TOKENS` bypass. USDC is in `known_scams` table (SolRPDS false positive: "active pool suspicious -- rug_pattern: active_suspicious", confidence 50%). While `server.js:287` skips the scam-db penalty for known legit tokens in quick scan, `token-audit.js:387` unconditionally adds a `critical` severity finding for any scam-db match. Result: USDC gets `risk_score: 40`, `category: "CAUTION"`, summary says "flagged as potential rug pull". This is the most damaging bug -- it undermines credibility when the world's most trusted stablecoin is flagged as suspicious.
- **[scanners/token-audit.js:36] RPC 503 for holder distribution** -- "Could not fetch holder distribution: RPC HTTP 503". USDC holders endpoint likely rate-limited or oversized. No fallback data source.

---

## Chybejici vazby mezi komponenty

| Inkonzistence | Detail |
|---------------|--------|
| **payTo address: x402-discovery.json vs server.js 402 response** | Discovery: `HNhZiuih...` (wallet). Server 402: `6u8gFVy...` (ATA). Client using discovery file will send to wrong address. |
| **KNOWN_LEGITIMATE_TOKENS: server.js vs token-audit.js** | server.js has whitelist bypass for known legit tokens. token-audit.js does not. Same token gets different risk assessments depending on which endpoint is called. |
| **Route paths: openapi.json vs x402-discovery.json vs server.js** | openapi.json: `/scan/*`. x402-discovery.json: `/api/v2/scan/*`. server.js registers: `/scan/*`. NGINX rewrites `/api/v2/*` -> `/*`. Works in prod but paths are inconsistent across docs. |
| **Agent card URLs: localhost vs production** | agent.json shows `http://127.0.0.1:3402` for url/iconUrl. Should be `https://intmolt.org`. |
| **Bot commands vs scan types** | Server offers 7 scan types (quick, token, wallet, pool, deep, evm-token, agent-token). Bot only supports 3 (/scan=quick, /token, /evm). |
| **Pricing sources** | pricing.js (source of truth), x402-discovery.json, agent.json skills, /services endpoint -- all need manual sync. Prices currently match but there's no automated check. |

---

## Priority fix list

| # | Priorita | Problem | Soubor | Effort |
|---|----------|---------|--------|--------|
| 1 | P0-Security | x402-discovery.json payTo = wallet address, not ATA. Clients would send USDC to wrong address | `x402-discovery.json` | 5 min |
| 2 | P0-Security | USDC/USDT/SOL flagged as scam in token-audit.js (no KNOWN_LEGITIMATE_TOKENS bypass) | `scanners/token-audit.js` | 15 min |
| 3 | P1-Reliability | ADMIN_CHAT_ID not set -- /admin bot command completely broken | `/root/.secrets/admin_chat_id` | 2 min |
| 4 | P1-Reliability | agent.json url/iconUrl show localhost instead of https://intmolt.org | `server.js` or `src/a2a/handler.js` | 10 min |
| 5 | P2-Reliability | openapi.json missing x-payment pricing metadata on all endpoints | `openapi.json` | 20 min |
| 6 | P2-Reliability | average_response_time_ms always 0 in stats | `server.js` (stats route) | 10 min |
| 7 | P3-Feature | Bot missing /wallet, /pool, /deep commands | `scripts/bot/telegram-bot.sh` | 1-2 hr |
| 8 | P3-Feature | Holder distribution fails for large tokens (RPC 503) -- needs fallback | `scanners/token-audit.js` | 30 min |
| 9 | P3-UX | CAPTCHA bypass for API testing not documented | `docs/` | 5 min |

---

*Generated by @Conductor audit. No code was modified during this audit.*
