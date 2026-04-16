# integrity.molt -- Project Map

> Posledni aktualizace: 2026-04-16 (po user flow auditu)

## Co to je

integrity.molt je security scanner API pro Solanu (a EVM chainy). Bezici na Node.js/Express (port 3402) za NGINX reverse proxy s TLS na domene intmolt.org. Nabizi 7 typu scanu (quick, token, wallet, pool, deep, evm-token, agent-token) s x402 USDC micropayment paywallem. Reporty jsou Ed25519 podepsane. Ma Telegram bota, Google A2A protocol pro AI agenty, Helius webhooky pro live monitoring, a IRIS scoring engine (4-dimenzni rug pull detektor trenovy na 33k scam tokenech). 3 free scany denne, placene od $0.15 USDC.

---

## High-level flow

```
Uzivatel (browser / bot / A2A agent)
        |
        v
NGINX (intmolt.org:443, TLS, rate limit)
   |-- /api/v2/* --> rewrite to /* na Express
   |-- /scan/free --> vlastni rate limit (10 req/min)
   |-- /* --> proxy na 127.0.0.1:3402
        |
        v
server.js (Express, port 3402)
   |
   |-- Static files: public/ (index.html, scan.html, verify.html, ...)
   |
   |-- POST /scan/free --> CAPTCHA check --> quickScanRpcOnly() / auditToken() / scanEVMToken()
   |       (3 free/day/IP, no payment)
   |
   |-- POST /scan/{quick,token,wallet,pool,deep,evm-token,agent-token}
   |       --> requireApiKey() --> requirePayment() --> scan pipeline
   |       |-- x402: X-PAYMENT header (base64 JSON, tx_sig)
   |       |-- verifyPayment(): RPC fetch tx, check USDC transfer to ATA, anti-replay
   |       |-- ATA derived at startup: getAssociatedTokenAddressSync(USDC_MINT, WALLET)
   |
   |-- POST /a2a --> A2A JSON-RPC 2.0 (tasks/send, tasks/get, tasks/cancel)
   |       --> autopilot spending limits, PDA validation
   |
   |-- POST /internal/bot/{quick,token,evm,contract}
   |       --> X-Admin-Key auth --> scan bez platby (pro Telegram bot)
   |
   |-- Helius webhooks --> /webhook/helius --> re-scan watchlist adres
   |
   v
Scan pipeline:
   quickScanRpcOnly()         [server.js:201]   -- RPC-only, IRIS scoring, scam-db
   auditToken()               [scanners/token-audit.js] -- enrichment + IRIS + LLM
   scanEVMToken()             [scanners/evm-token.js]   -- Alchemy RPC, honeypot check
   agentTokenScanner()        [scanners/agent-token-scanner.js] -- Metaplex Core
   |
   v
Ed25519 signing --> JSON response --> scan_history DB
```

---

## Adresarova struktura

```
/root/x402-server/
|-- server.js              -- hlavni Express app, vsechny routes (~4500 radku)
|-- db.js                  -- SQLite wrapper (intmolt.db)
|-- auth.js                -- OAuth/session (Passport.js)
|-- report-generator.js    -- TXT/PDF/PNG generovani
|-- mailer.js              -- email (Mailgun)
|
|-- src/
|   |-- payment/verify-pda.js     -- PDA overeni pro A2A (Metaplex Asset Signer)
|   |-- middleware/payment.js      -- PDA-aware payment wrapper
|   |-- enrichment/
|   |   |-- index.js               -- orchestrator (RugCheck + SolanaTracker + extensions)
|   |   |-- rugcheck.js            -- RugCheck API klient (cache: rugcheck_cache)
|   |   |-- solana-tracker.js      -- metadata, holders, LP burn
|   |   |-- token-extensions.js    -- Token-2022 extensions parser
|   |-- features/iris-score.js     -- IRIS scoring (Inflows+Rights+Imbalance+Speed, 0-100)
|   |-- a2a/
|   |   |-- handler.js             -- A2A JSON-RPC 2.0
|   |   |-- autopilot.js           -- spending limits
|   |   |-- task-store.js          -- SQLite task queue
|   |-- llm/
|   |   |-- anthropic-advisor.js   -- LLM advisor (Anthropic primary, OpenRouter fallback)
|   |   |-- scan-validator.js      -- LLM score validation
|   |   |-- prompts/               -- system prompts
|   |-- monitor/                   -- Helius webhook monitoring subsystem
|   |-- delta/                     -- delta reports (snapshot + diff + signing)
|   |-- adversarial/               -- adversarial simulation (playbooks, fork)
|   |-- scam-db/lookup.js          -- known_scams + rugcheck_cache lookup
|   |-- rpc.js                     -- Solana RPC config
|
|-- scanners/
|   |-- token-audit.js             -- komplexni Solana token audit
|   |-- evm-token.js               -- EVM token scanner (Base, Ethereum, Arbitrum)
|   |-- agent-token-scanner.js     -- Metaplex Core Agent Token scanner
|
|-- config/
|   |-- pricing.js                 -- USDC ceny (single source of truth)
|   |-- autopilot.js               -- A2A autopilot pravidla
|   |-- known-safe-tokens.json     -- whitelist legitimnich tokenu
|
|-- scripts/
|   |-- bot/telegram-bot.sh        -- Telegram bot (bash, systemd)
|   |-- iris-*.js                  -- IRIS batch enrichment/analysis
|   |-- import-scam-db.js          -- import scam DB
|   |-- test-gate.sh               -- povinny test runner pred commitem
|
|-- public/                        -- staticke HTML (index, scan, verify, dashboard, ...)
|-- data/intmolt.db                -- SQLite databaze
|-- data/scam-datasets/            -- offline datasety (SolRPDS CSV)
|-- tasks/{active,done,failed,backlog}/  -- agent task management
|-- agents/                        -- agent role definitions
|-- tests/                         -- test suites
|-- docs/                          -- IRIS-whitepaper, project map, audit report
```

---

## Top 15 kritickych souboru

| Soubor | Radku | Co dela |
|--------|-------|---------|
| `server.js` | 4532 | Hlavni Express app. Vsechny routes, payment middleware, quickScanRpcOnly(), Ed25519 signing, A2A routing. |
| `db.js` | ~600 | SQLite wrapper. Payments, scan_history, api_keys, watchlist, subscriptions, advisor_calls. |
| `config/pricing.js` | ~40 | Jediny zdroj pravdy pro ceny (USDC micro-units). |
| `src/features/iris-score.js` | ~200 | IRIS scoring engine. 4 dimenze, prahy z SolRPDS datasetu. |
| `scanners/token-audit.js` | ~900 | Komplexni token audit: enrichment + IRIS + LLM + scam-db. |
| `scanners/evm-token.js` | ~400 | EVM token scanner. Alchemy RPC, honeypot detekce, source code analyza. |
| `src/enrichment/index.js` | ~150 | Orchestrator enrichmentu (RugCheck + SolanaTracker + extensions paralelne). |
| `src/a2a/handler.js` | ~300 | Google A2A protokol. tasks/send, tasks/get, tasks/cancel. |
| `src/llm/anthropic-advisor.js` | ~200 | LLM advisor. Anthropic primary, OpenRouter/gemini fallback. Grey zone (40-70). |
| `src/scam-db/lookup.js` | ~100 | Lookup v known_scams + rugcheck_cache. |
| `scripts/bot/telegram-bot.sh` | ~800 | Telegram bot. /scan, /token, /evm, /status, /admin, /verify. |
| `src/monitor/webhook-receiver.js` | ~150 | Helius webhook prijem, dedup cache, re-scan trigger. |
| `public/index.html` | ~1500 | Landing page. Stats counters, scan cards, pricing, FAQ. |
| `public/scan.html` | ~1500 | Free scan page. Math CAPTCHA, address input, results display. |
| `x402-discovery.json` | ~200 | x402 discovery file. Pricing, services, subscriptions. |

---

## Databazove tabulky (intmolt.db)

| Tabulka | Zaznamu | Ucel |
|---------|---------|------|
| `scan_history` | 111 | Historie vsech scanu (address, type, risk_score, result_json) |
| `known_scams` | 33,359 | SolRPDS scam token dataset (mint, source, scam_type, confidence) |
| `iris_enrichment` | 1,075 | IRIS enrichment data (offline batch analyza) |
| `scam_creators` | 767 | Penezenky scam deployeru (creator_wallet, scam_count, patterns) |
| `events` | 1,519 | Event log (scan_started, report_viewed, payment_required) |
| `advisor_calls` | 62 | LLM usage metriky (scan_type, cost_usd) |
| `rugcheck_cache` | 6 | Cache RugCheck API odpovedi |
| `payments` | 5 | Zaplacene x402 transakce |
| `watchlist` | 3 | Monitorovane adresy (Helius webhook) |
| `api_keys` | 2 | API klice pro pristup |
| `users` | 1 | OAuth uzivatele |
| `user_sessions` | 1 | Express session store |
| `subscriptions` | 0 | Stripe predplatne |
| `a2a_tasks` | 0 | A2A task queue |
| `used_signatures` | 0 | Anti-replay (tx signatures) |
| `ads` | 0 | Reklamni bannery |
| `autopilot_spending` | 0 | A2A autopilot spending log |
| `scan_accuracy_signals` | 0 | Feedback loop pro ML |

---

## Externi sluzby

| Sluzba | Env var | K cemu |
|--------|---------|--------|
| Helius RPC | `SOLANA_RPC_URL`, `HELIUS_API_KEY` | Primarni Solana RPC + webhooky pro monitoring |
| Helius (webhooky) | `HELIUS_WEBHOOK_SECRET` | Overeni webhook payloadu |
| Alchemy | `ALCHEMY_API_KEY`, `ALCHEMY_RPC_URL` | EVM chain RPC (Base, Ethereum, Arbitrum) |
| RugCheck API | `RUGCHECK_API_KEY` | Token enrichment, rug detekce |
| Flux RPC | `SOLANA_RPC_URL_FLUX` | Alternativni Solana RPC |
| Anthropic | `ANTHROPIC_API_KEY` | LLM advisor (Claude) |
| OpenRouter | `OPENROUTER_API_KEY` | LLM fallback (gemini-2.5-flash) |
| Telegram Bot API | `TELEGRAM_BOT_TOKEN` | Bot + watchlist alerty |
| Stripe | `STRIPE_SECRET_KEY` | Subscription checkout |
| Mailgun | `MAILGUN_API_KEY` | Email alerty, weekly digest |
| Google Analytics | GA4: G-WXYD5E5NWE | Web analytics |

---

## Systemd sluzby

| Sluzba | Stav | PID | Popis |
|--------|------|-----|-------|
| `integrity-x402.service` | active | node server.js | API server, port 3402 |
| `intmolt-bot.service` | active | bash telegram-bot.sh | Telegram bot (long-polling) |

---

## Rozpracovane veci (z auditu 2026-04-16)

### Kriticke (P0)
- x402-discovery.json payTo = wallet address, ne ATA -- klienti by poslali USDC na spatnou adresu
- USDC/USDT/SOL false positive v token-audit.js -- chybi KNOWN_LEGITIMATE_TOKENS bypass

### Dulezite (P1)
- ADMIN_CHAT_ID neni nastaven -- /admin bot command nefunguje
- agent.json url/iconUrl ukazuji na localhost misto https://intmolt.org
- openapi.json chybi x-payment pricing metadata

### Rozsireni (P2-P3)
- Bot chybi /wallet, /pool, /deep commands
- average_response_time_ms vzdy 0 ve stats
- Holder distribution selhava pro velke tokeny (RPC 503)
- Adversarial simulation -- playbooks definovane, fork.js neuplna
- Delta reports -- infrastruktura existuje, neni plne integrovana pro verejne pouziti

---

## Entry points

### Spusteni / restart
```bash
sudo systemctl restart integrity-x402.service   # API server
sudo systemctl restart intmolt-bot.service       # Telegram bot
```

### Logy
```bash
sudo journalctl -u integrity-x402.service -f     # API server (live)
sudo journalctl -u intmolt-bot.service -f         # Bot (live)
tail -f /var/log/intmolt/access.log               # HTTP access log
```

### Testovani
```bash
bash scripts/test-gate.sh                         # povinny pred commitem
curl -s http://127.0.0.1:3402/health              # health check
curl -s http://127.0.0.1:3402/api/v1/stats        # stats
```

### Scan (API test)
```bash
# Free scan (vyzaduje CAPTCHA -- pouzij /scan page v browseru)
# Nebo pres interni endpoint:
curl -s -X POST http://127.0.0.1:3402/internal/bot/token \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $(cat /root/.secrets/bot_admin_key)" \
  -d '{"address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'

# x402 discovery
curl -s https://intmolt.org/.well-known/x402.json | python3 -m json.tool
```

---

*Generovano z kodu a live API testu. Zadne vymyslene informace.*
