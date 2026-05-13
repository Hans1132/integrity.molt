# integrity.molt - memory.md

> Living log Claude Code. Sem se zapisují rozhodnutí, fixed bugs, gotchas, recent changes, scope creep precedents.
> Hans stahuje pravidelně a uploaduje do project files na claude.ai pro strategický kontext.
> Stručnost > úplnost. Jeden entry typicky 3 až 5 řádků.

**Last updated:** 2026-05-13 (VoltAgent audit hardening — K1, K4, H1–H6, M3, M6, A1 komplet)

---

## Recent changes (top of stack, newest first)

### 2026-05-13: K2 — Dead-letter JSONL pro failed Helius webhook processing — [monitor]
- **Změny:** `src/monitor/webhook-receiver.js` — přidán `DEAD_LETTER_FILE` constant, `_writeDeadLetter()` helper (sync appendFileSync), per-tx try/catch v `handleHeliusWebhook` (watchlist load failure = celý batch do DL, per-tx failure = jen ta tx). `tests/monitor/webhook-dead-letter.test.js` (nový).
- **Důvod:** K2 — processing po 200 ACK házel výjimky tiše; event byl ztracen bez záznamu.
- **Dopad:** Failed transakce zachovány v `data/monitor/dead-letter.jsonl` s `_deadLetterAt` + `_error`. Jeden tx failure nezastaví zbytek batche.
- **Test:** 1/1 passed. Gate 11/11 PASS. Commit: b3cd816.
- **Gotcha:** `appendFileSync` (sync) záměrný — async race v catch bloku je nebezpečný. `DEAD_LETTER_FILE` env override umožňuje testování bez zásahu do live dat.

### 2026-05-13: VoltAgent audit — Backend Security Hardening komplet (10 tasků) — [security/backend]
- **Změny:** `src/crypto/sign.js` (SignPipelineError + Telegram alert, scriptPath param); `src/rpc.js` (export PUBLIC_FALLBACK); `server.js` (rpcPost fallback, H1 scan-page RL, H2 CF-IP rate limitery, M3 safeCompare, A1 LRU caps, K1 callers 503); `src/a2a/handler.js` (H6 SSRF IPv6+decimal+octal); `src/middleware/free-quota.js` (H2 getClientIp export, H5 timingSafeEqual, M6 atomická tx); `auth.js` (H4 isSafeNext open redirect). Nové testy: `tests/rpc-failover.test.js`, `tests/security/{scan-page-ratelimit,open-redirect,ssrf-deny-list}.test.js`, `tests/crypto/sign-spof.test.js`.
- **Důvod:** VoltAgent chaos/security audit nalezl 11 nálezů (K1–K5, H1–H6, M3/M6, A1, S8). K3+K5/S8 opraveny 2026-05-12, zbývající dnes.
- **Dopad:** Paid endpointy vracejí 503+Retry-After při sign outage. Rate limity používají CF-Connecting-IP. Free quota atomická (no race). SSRF blokuje IPv6/decimal/octal. Open redirect uzavřen.
- **Test:** Gate 11/11 PASS. Commity: 6c6e95c (K1), 9910f12 (K4), d0dd30b–482d229 (H1–A1).
- **Gotcha:** M6 — `consumeFreeQuota` je nyní no-op; quota se spotřebuje v `checkFreeQuota`. Existující testy upraveny.

### 2026-05-12: K5/S8 — DB fallback counter + Telegram alert v webhook-receiver.js — [qa]
- **Změny:** `src/monitor/webhook-receiver.js` — přidán `_recordDbFailure()`, counter + window reset (1h), `sendAlert` high-severity při >= 3 failurách; volání v catch bloku `getWatchedAddresses()`; test-only exports. `tests/monitor/webhook-receiver-fallback.test.js` (nový).
- **Důvod:** K5/S8 — tiché watchlist DB read failure bylo neviditelné, fallback na stale cache bez jakéhokoli signálu.
- **Dopad:** Hans dostane Telegram alert (ADMIN_CHAT_ID) při >= 3 watchlist DB failurách za hodinu. NODE_ENV=test guard zabrání alertu v CI.
- **Test:** 1/1 passed. Gate 11/11 PASS. Commit: d37562e + followup NODE_ENV guard.
- **Gotcha:** `sendAlert` musí být gated `process.env.NODE_ENV !== 'test'` — jinak test odesílá reálný Telegram alert Hansovi.

### 2026-05-12: K3 — LRU cap 1 000 na sentAlerts + rateWindows v notifications.js — [qa]
- **Změny:** `src/monitor/notifications.js` — snížen cap z 10 000 na 1 000 pro `sentAlerts` (isDuplicate) a `rateWindows` (isRateLimited); `tests/monitor/notifications-lru.test.js` (nový).
- **Důvod:** Chaos audit nález K3 — unbounded Maps pod alert storm → OOM → restart loop každých ~5 min.
- **Dopad:** Memento per-adresa timestamp přijde o starší záznamy po ~1 000 unikátních adresách, ale produkční provoz toto nikdy nevyvolal. Rate limit window 1h zajišťuje TTL přirozené čistění.
- **Test:** 2/2 passed. Gate 11/11 PASS. Commit: 973dd59.

### 2026-05-11: EVM free scan — 3 bugy opraveny po QA auditu — [guardian/backend]
- **Změny:** `server.js` (1) cached.status discriminátor místo cached.data — EVM L1 nemá `.data` pole; (2) přidán `db.logScanToHistory` do EVM větve `/scan/free` — chyběl L2 DB cache; (3) guard 400 pro `0x...` s type=quick nebo type!=evm-token; `public/scan.html` const→let pro type/isEvm, auto-reassign při EVM detekci místo selectType() loop.
- **Důvod:** EVM z L1 cache vracelo N/A meta (wrong wrapper). Po restartu žádný L2 hit (nikdy se neukládalo). 0x adresa s Quick Scan type → Solana sanitizace → Unknown RISK.
- **Dopad:** L1, L2, a fresh cesty pro EVM všechny ověřeny end-to-end. result_json v DB = celý result objekt (se status), ne surový evmResult.
- **Test:** test-gate.sh 11/11 PASS. L2 CACHE HIT ověřen v journalctl po restartu.
- **Gotcha:** EVM L1 result nemá `.data` pole (flat struktura). Solana L1 má `{ status, data: scanData }`. L2 DB raw scanData (pro Solana) nemá `.status`. Discriminátor: `cached.status ? cached : wrap`.

### 2026-05-11: Visual redesign — Electric Cyan paleta, sdílený style.css — [conductor]
- **Změny:** `public/style.css` (nový), `public/*.html` (Tier 1–2: index, scan, scan-view, pricing, docs, verify, login, dashboard, watchlist, scan-contract, scan-evm), `public/blog/*.html`, `public/demo/*.html`, `public/og-template.html` — odstraněny :root bloky, přidány Google Fonts + style.css; `server.js` (řádky 3601–4080: renderPaidScanPage + subscribe/success + unsubscribe inline HTML — hardcoded barvy → Electric Cyan)
- **Důvod:** Visual redesign před Frontier deadline 2026-05-11. Forest green/blue → Electric Cyan (#06B6D4), Space Grotesk + JetBrains Mono.
- **Dopad:** Všechny user-facing stránky sdílejí CSS proměnné. Backwards-compat aliasy zachovány.
- **Test:** test-gate.sh 11/11 PASS. Service restart OK.
- **Fixy součástí:** agent-token přidán do /scan/free allowlistu; docs.html ceny opraveny (wallet/pool → 0.75); /jwks.json + /x402.json 301 redirecty.

### 2026-05-09: validate-v4.js — 24h statistiky se správným INTEGER ms formátem
- **Změny:** `scripts/validate-v4.js` — přidán blok 24h activity stats před hybrid signal coverage
- **Důvod:** `spl_mints.created_at` a `pool_activity.updated_at` jsou INTEGER ms — dotaz `> datetime('now','-24 hours')` vrátí vždy 0. Správný formát: `(Math.floor(Date.now()/1000) - 86400) * 1000`
- **Gotcha:** Dvě různé timestamp konvence v DB — TEXT `datetime('now')` (events, known_scams, scan_history) vs INTEGER ms `unixepoch()*1000` (spl_mints, pool_activity). Vždy zkontroluj schema před psaním WHERE filtru.
- **Test:** `node scripts/validate-v4.js` — 250 nových mintů / 24h, 4370 pool updates ✓

### 2026-05-09: Security fixes — 4 nálezy z code review — [guardian/conductor]
- **Změny:** `src/middleware/free-quota.js` (getClientIp: odstraněny X-Forwarded-For a req.ip fallbacky — pouze CF-Connecting-IP); `server.js` (admin/abuse-stats: odstraněn req.query.token; /api/v1/admin/accuracy + /api/v1/admin/helius: přidán requireStatsToken; scan/contract output path: path.resolve + /root/ prefix check)
- **Důvod:** X-Forwarded-For fallback umožňoval bypass IP quota spoofingem headeru. Token v query stringu padá do access logů a Cloudflare logů. Dva interní admin endpointy bez auth (mitigováno portem 127.0.0.1 — ale tech debt). Path z child process stdout bez validace.
- **Dopad:** IP rate limiting nyní spolehlivě závisí jen na CF-Connecting-IP. Admin endpointy vyžadují STATS_TOKEN. Service restartován, gate 11/11 PASS.
- **Gotcha:** requireStatsToken je function declaration (hoisted) — lze ji použít i na řádcích před její definicí v server.js.
- **Test:** 11/11 gate PASS, `systemctl is-active` = active

### 2026-05-09: IRIS scoring fixes — threshold, LP fallback, null-address filter
3 opravy schválené Hansem. Token 5pdyeWSC: IRIS 28/MEDIUM → 51/HIGH.
- **Změny:** `src/enrichment/rugcheck.js` (přidat `lp_locked_pct` z markets[].lp.lpLockedPct, min přes všechny markety), `src/features/iris-score.js` (isRcDanger threshold >=75→>=50; LP fallback `rugcheck?.lp_locked_pct` když tracker=null; System Program + Token Program do DEX_PROGRAM_IDS deny-listu)
- **Důvod:** score_norm=71 těsně minul threshold >=75 → floor nefire-oval → MEDIUM místo HIGH. Solana Tracker null → LP burn zcela chyběl. RugCheck někdy vrátí 11111...111 jako 63% holder (null address bug).
- **Gotcha:** RugCheck `lp_locked_pct` je timelocked NEBO burned (ne nutně permanentní). Sekundární signál je méně silný než Solana Tracker `lp_burn_pct`. Solana Tracker má prioritu.
- **Test:** 11/11 gate pass. Live debug: IRIS 51/HIGH ✓

### 2026-05-09: Ultrareview bug fixes — V4 hybrid pipeline fully enabled (commit 2ea577f)
11 nálezů opraveno (8 normal, 3 nit). V4 pipeline byl před těmito opravami nefunkční v produkci.

- **Změny:** `lib/inactivity-scanner.js` (stmtMarkInactive/stmtGetCandidates cross-row JOIN by mint, lazy anchor, age guard flip, inProgress flag), `lib/bitquery-client.js` (timeout, filter tighten, ascending order), `lib/bitquery-poller.js` (cursor+1ms, total_polls on error), `scripts/run-migration.js` (bitquery_dexpools seed), `scripts/start-bitquery-cron.js` (cron :30→:35), `scripts/seed-whitelist.js` (CRLF), `.env.example` (dead vars), `IMPLEMENTATION_NOTES.md` (docs drift)
- **Důvod:** Helius píše pool_address=programId, Bitquery píše pool_address=MarketAddress — nikdy nesedí → hybrid_realtime flag nevznikal. Opraveno EXISTS subquery + mint-level aggregation JOIN.
- **Dopad:** hybrid_realtime detekce nyní funkční. Age guard obrácen (nové tokeny jsou riziko, ne staré).
- **Gotcha:** `first_activity_ts` je čas-prvního-vidění-pipelinou, ne on-chain creation — age guard je stopgap s TODO (bug_010).
- **Backup:** `/root/backups/intmolt-pre-bugfixes-*.db`

---

### 2026-05-09: Helius webhook fix — monitor (commits 8bbbb4f, 6b8bed9)
Server startal a Helius odmítal vytvořit webhook kvůli neplatným hodnotám `transactionTypes`.

- **Změny:** `src/monitor/webhook-manager.js` — odstraněny `TRANSFER_CHECKED` a `INITIALIZE_MINT` z `SECURITY_TX_TYPES` (nejsou v Helius TransactionType enumu). `.gitignore` — odstraněn duplicitní řádek `.gcp-credentials.json`.
- **Důvod:** Helius API vrácelo `400 Bad Request: Each transaction type must be a valid TransactionType` — 2 ze 9 typů neexistují v Helius enumu. Webhook se nevytvořil = live monitoring nefungoval od každého restartu.
- **Dopad:** Webhook `62134a7f-37e8-4dd0-8368-c988cc229c74` nyní úspěšně vytvořen při startu. 7 platných typů zůstalo — žádné `ANY`, kreditová spotřeba minimální.
- **Gotcha:** Helius enum má 700+ hodnot ale nezahrnuje nízkoúrovňové SPL instrukce (`TRANSFER_CHECKED`, `INITIALIZE_MINT`) — jsou to Solana instrukce, ne Helius event typy.

---

### 2026-05-07: 9-agent team setup — conductor (commit b80460f)
Přepsán CLAUDE.md + vytvořeno 9 agent souborů v `.claude/agents/`. Staré soubory `tester.md` a `web.md` odstraněny.

- **Změny:** `CLAUDE.md` (kompletní přepis do nového formátu), `.claude/agents/` — 9 nových souborů: conductor, backend, db, security, qa, frontend, monitor, llm-economist, guardian
- **Důvod:** Multi-agent orchestrace — každý agent má jasně definovaný scope, file ownership, memory.md povinnosti, backup protokol a escalation triggers
- **Nové role:** `db` (SQLite WAL specialist), `security` (Ed25519/JWKS/auth), `llm-economist` (prompt cache + LLM cost optimization), `guardian` (read-only watchdog, devil's advocate)
- **Gotcha:** `.claude/` je v `.gitignore` — agent soubory vyžadovaly `git add -f` pro commit

---

### 2026-05-07: Colosseum Frontier submission review — `voltagent-qa-sec:ai-writing-auditor`
Read-only review hackathon submission odpovědí. Žádné commity do repo. Nainstalované skills.

- **5 submission otázek reviewováno/finalizováno:** Brief description, What are you building, Why now, What technologies, Repo context. Tón: konkrétní čísla, žádný AI filler, osobní hlas.
- **Klíčová změna repo context otázky:** přidán framing "x402-server: Node/Express A2A agent, SQLite 33k scam pool records" + prominentně 22 adversarial scenarios. Nepřekrývá se s ostatními odpověďmi.
- **Sponsor alignment pro Colosseum hodnotitele:** Coinbase x402 (primární — integrity.molt je paid API nad x402), Metaplex 014 Agent Registry (již integrováno), Helius RPC (latency budget < 1s).
- **Nainstalované skills:** `ColosseumOrg/colosseum-resources` + `coinbase/agentic-wallet-skills` (9 skills: x402, monetize-service, pay-for-service, send-usdc, aj.). Security note: `authenticate-wallet` má Snyk High Risk.

---

### 2026-05-07: Database audit fixes round 2 — `voltagent-data-ai:database-optimizer` (commit 526b31b)
Read-only audit → empirické verifikace (V-7 není bug, K-1 žádné duplicity) → implementace. 11/11 test gate PASS.

- **K-1 watchlist duplicate guard:** `watchlist_unique_email_entry` partial UNIQUE index (address, notify_email WHERE notify_telegram_chat IS NULL) + `addUserWatchlistEntry` přepsán na `INSERT … ON CONFLICT … DO UPDATE`. Dříve: souběžné inserty mohly vytvořit duplicity pro email-only záznamy.
- **K-2 users_reset_token:** partial index `ON users (reset_token) WHERE reset_token IS NOT NULL` — `consumePasswordResetToken` dělal full-table scan.
- **K-3 rebuildScamCreators atomicity:** DELETE + INSERT obalen do `db.transaction()`. Dříve: crash po DELETE = prázdná tabulka scam_creators až do restartu.
- **V-1/V-5/V-8/V-9 nové indexy:** `subscriptions_email_status`, `idx_autopilot_mint_decision` (covering), `events_date_name` (expression), `subscriptions_digest_active` (partial) — přidány přes `migrateAccuracySignalsSchema()`.
- **V-4 autopilot.js:** `stmtDailySpent` + `stmtInsertDecision` hoistnuty na module-level. Chyba: `getAgentDailySpending` četl `row.spent_usdc` ale sdílený stmt vrací `daily_spent` — opraveno.
- **V-6 dropLegacyDuplicateIndexes:** přidán `DROP INDEX IF EXISTS users_email` (SQLite UNIQUE autoindex ho duplikoval).
- **V-10 spl-mint-poller:** cursor prepared stmts (`_stmtGetCursor`, `_stmtUpsertCursor`, `_stmtUpdateLastRun`) hoistnuty do lazy singletons.
- **D-1 TTL cleanup:** 6h interval rozšířen o 8 tabulek: events (90d), abuse_events (30d), advisor_calls (90d), scan_accuracy_signals (180d), spl_mints (90d), autopilot_spending (90d), global_scan_stats (365d), free_scan_quota (7d).
- **Přeskočeno:** V-7 (SQLite build má `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, ORDER BY v UPDATE funguje), K-4 (atomická transakce logPayment+markSignatureUsed — příliš invazivní), D-2/D-3/D-5–D-8.

---

### 2026-05-07: Database audit fixes round 1 — `voltagent-data-ai:database-optimizer` (commit 28e2a4f)
Read-only audit → implementace v jednom commitu. 11/11 test gate PASS.

- **K-3/D-5 TTL cleanup:** `used_signatures` (1h, unix seconds `strftime('%s','now') - 3600`) + `rugcheck_cache` (25h) přidáno do 6h WAL checkpoint setInterval. Obě tabulky dříve rostly neomezeně.
- **V-1 spl-mint-poller:** `db.prepare()` pro INSERT hoistnuto z poll smyčky do lazy singleton `_getInsertMintStmt()`. Dříve: až 100 SQL kompilací per poll cyklus.
- **V-2 index:** `subscriptions_telegram ON subscriptions (telegram_chat_id, status)` — přidán do `initSchema()` + `migrateAccuracySignalsSchema()` (existující DB).
- **V-3 getLiveStats():** `strftime('%Y-%m-%d', created_at) = date('now')` → sargable `created_at >= date('now') AND created_at < date('now', '+1 day')`. Totéž pro 7denní okno. Umožňuje index range scan místo full table scan.
- **V-4 dead code:** odstraněna `countFreeScansToday()` — nikde nevolána, index nevyhovující.
- **V-6 admin abuse-stats:** 5× `rawDb.prepare()` hoistnuto na module level jako konstanty. Dříve: SQL kompilace při každém admin requestu.
- **D-2 schema drift:** do `initSchema()` přidány chybějící indexy (`autopilot_spending_decision`, `idx_blacklist_expires`, `idx_ottersec_fetched`, `iris_enrichment_mint_auth`) a tabulky `framesag_agent_wallets`, `framesag_agent_networks`. Nový deploy byl dříve bez nich.
- **Záměrně přeskočeno:** D-1 (scan_history_addr_type ponechán), D-3 (duplikátní schema v modulech — defensive guarantee), V-5/V-7 (OK při aktuální zátěži).

---

### 2026-05-06: Regresní testy + rozšíření npm test scope (commit 5230e3b)
Zdroj: `voltagent-qa-sec:test-automator` audit + implementace.

- **Nové regresní testy:** `tests/security/path-traversal.test.js` (CRITICAL-2, 10 cases), `tests/security/watchlist-idor.test.js` (CRITICAL-1, 6 cases) — pinují oba security fixy z 1840ab5
- **`tests/crypto/canonical-json.test.js`** (14 cases) — pinuje byte-identical serializaci canonicalJSON, základ pro všechny signed receipts
- **CF-Connecting-IP** — 6 nových testů v `tests/middleware/free-quota.test.js` (GAP-3, ostrý edge z CLAUDE.md)
- **`tests/a2a-handler.test.js`** — přidán sync port guard (`nc -z 127.0.0.1 3402`), test bezpečně přeskočí v npm test když běží production
- **npm test scope:** rozšířen z 9 na 24 souborů (`package.json`), odstraněna divergence mezi `npm test` a `test-gate.sh`

---

### 2026-05-06: Performance quick wins — 4 commity (837873e, 807887a)
Zdroj: `voltagent-qa-sec:performance-engineer` audit (read-only) + implementace.
Všechny testy PASS (11/11 gates), service active.

- **C1 Anthropic prompt caching** (`src/llm/anthropic-advisor.js`): `system` a tools blok nyní posílány s `cache_control: { type: 'ephemeral' }`. Cache miss rate byl 100%. Očekáváno: −40–60 % Anthropic API nákladů, −200–400 ms na cache hit. Ověřit v `usage.cache_read_input_tokens > 0` po druhém advisory volání.
- **C3 Solana RPC keepalive** (`server.js:51`): `rpcAgent = https.Agent({ keepAlive: true, maxSockets: 10 })` singleton, předáván do každého `rpcPost()`. Dříve: nový TCP+TLS handshake per RPC call (~50–150 ms). Teď se spojení recykluje.
- **H3 JWKS key cache** (`server.js:152`): `_jwksKeyBytes` načten při startu, JWKS handler zjednodušen (odstraněn try/catch + per-request readFileSync). Pokud klíč chybí při startu, server se nespustí — správné chování pro pinned signing key.
- **M3 HTML template cache** (`server.js:153`): `_scanViewTemplate` načten při startu, `/scan/:address` route přestala číst `scan-view.html` per request.

### 2026-05-06 (night+): 5 security fixů z pentest auditu
Commit `1840ab5`. 187/187 testů PASS, service active.

- **CRITICAL-2 path traversal `/report/download`:** `server.js:3742` — `path.resolve` + `REPORTS_DIR + path.sep` prefix check. Před opravou: `/../` sekvence procházela `startsWith` kontrolou. **PoC po fixu: 403 ✓**
- **CRITICAL-1 Watchlist IDOR:** `db.js:630` — odstraněn `OR ? IS NULL` predikát (null owner = no delete). `server.js:3159,3201,3214` — `requireApiKey` + 401 guard na `POST /watchlist/add`, `DELETE /watchlist/:id`, `GET /watchlist`. **PoC po fixu: 401 ✓**. Gotcha: `GET /watchlist` data nebyla exposovana dříve díky `express.static` (line 644), který pre-emptuje route a servuje HTML; mutace (POST/DELETE) byly klíčové.
- **CRITICAL-3 CAPTCHA_SECRET fail-closed:** `server.js:4132` — `process.exit(1)` pokud chybí nebo `=== 'changeme-local-dev'`. Přidáno do `.env.example`.
- **CRITICAL-4 Helius webhook fail-closed:** `webhook-receiver.js:45` — 503 pokud `HELIUS_WEBHOOK_SECRET` chybí (dříve `accept all`). Přidáno do `.env.example`.
- **H3 `/scan/cached` auth:** `server.js:4116` — `requireApiKey` + 401 guard (dříve bez auth = free přístup k paid deep audit výsledkům).

**Zbývající z pentest auditu (neresolvováno):**
- H1: `/scan/:address` self-fetch quota bypass (DoS amplification)
- H2: `req.ip` nekonzistence napříč rate limitery
- H4: Open redirect `?next=` (known M2)
- H5: `INTERNAL_SCAN_SECRET` timing-unsafe (known M4)
- Shell skripty v `/root/scanner/`, `/root/swarm/` — neauditovány, potenciální command injection

### 2026-05-06 (night+): Penetration Testing Audit — `voltagent-qa-sec:penetration-tester`
Read-only audit. Žádné commity. 4 CRITICAL, 6 HIGH, 4 MEDIUM, 4 LOW.

**CRITICAL (opravit do 24h):**
- **C1 — Watchlist IDOR + unauth CRUD** `db.js:630-636`, `server.js:3159-3223`: SQL predikát `OR ? IS NULL → TRUE` = smazání jakékoli watchlist položky bez auth. `POST /watchlist/add` a `GET /watchlist` bez jakéhokoli ověření. PoC: `DELETE /watchlist/42 -d '{}'`. Fix: opravit SQL, přidat `requireApiKey`.
- **C2 — Path traversal `/report/download`** `server.js:3742`: `startsWith` bez `path.normalize` → `/root/scanner/reports/../../../etc/anything.html` projde. Server běží jako root. Fix: `path.resolve` + re-check prefix.
- **C3 — CAPTCHA_SECRET hardcoded fallback** `server.js:4132`: `|| 'changeme-local-dev'`, chybí v `.env.example`. Fresh deploy = deterministický HMAC bypass → unlimited free scany. Fix: fail-closed + `.env.example`.
- **C4 — Helius webhook fail-open** `src/monitor/webhook-receiver.js:45-57`: `HELIUS_WEBHOOK_SECRET` chybí v `.env.example`, při absenci přijme vše. Útočník může injektovat fake tx → spam Telegram alertů, credit burn. Fix: fail-closed + `.env.example`.

**HIGH (tento týden):** `/scan/:address` self-fetch quota bypass (H1), `req.ip` nekonzistence napříč rate limitery (H2), `/scan/cached` bez auth vrací paid deep audit z cache (H3), open redirect `?next=` (H4 = known M2), `INTERNAL_SCAN_SECRET` timing-unsafe (H5 = known M4 eskalace).

**Top exploit chain:** CRITICAL-3 (CAPTCHA bypass) + H1 (quota bypass) + H3 (cached deep audit) = $5 deep audity zdarma. CRITICAL-1 (watchlist) + HTML injection v `label` = spam z důvěryhodného bota.

**Kritický gap — shell skripty neauditovány:** `/root/scanner/*.sh`, `/root/swarm/`, `/root/bounty-hunter/deep-scan.sh` přijímají GitHub URL. `spawn()` v JS je OK (no shell), ale skripty samotné mohou být zranitelné na command injection. **Nutný separátní audit bash skriptů.**

**Pozitiva:** x402 anti-replay atomic, Stripe fail-closed, A2A Oracle signature check, `escapeHtml` v HTML, address validation konzistentní.

---

### 2026-05-06 (night+): 3 reliability fixy z error detective auditu
Commit `e3e577a`. 187/187 testů PASS, service active.

- **K2 `_signed: false` marker:** `src/delta/signing.js:25` — catch blok nyní vrací `{ ...deltaReport, _signed: false }` místo holého `deltaReport`. Calleři mohou rozlišit podepsaný od nepodepsaného reportu. **Dopad před opravou: unsigned delta report byl vydáván bez jakéhokoli rozlišovacího znaku.**
- **K3 process.exit(1):** `server.js:5419-5420` — `uncaughtException` a `unhandledRejection` handlery nyní volají `.finally(() => setTimeout(() => process.exit(1), 1000))`. Process se po Telegram alertu ukončí — systemd (`Restart=always`) restartuje. **Dopad před opravou: process pokračoval v indeterminate state, systemd ho nerestartoval.**
- **H1 JSON-RPC error:** `src/a2a/handler.js:258` — `program_verification_status` asyncSign catch blok nyní `throw e` místo pokračování s `signature: null`. Caller `rpcError()` vrátí `{ jsonrpc: "2.0", error: { code: -32603, ... } }` s HTTP 200. **Dopad před opravou: A2A klient dostával `signature: null` jako úspěšný výsledek.**

**Gotcha — systemd:** service má `Restart=always` (ne `on-failure`) — process.exit(1) způsobí restart i při "čistém" shutdown; při deployi `systemctl stop` zavolat manuálně nebo přepnout na `Restart=on-failure` při příštím review.

---

### 2026-05-06 (night+): Chaos Engineering Audit — `voltagent-qa-sec:chaos-engineer`
Read-only audit. Žádné commity. 5 kritických a 9 středních failure modes nalezeno.

**Kritické (opravit přednostně):**
- **K1** `src/crypto/sign.js` — `sign-report.py` SPOF: extern mimo repo, bez fallback, žádný dedikovaný alert. Výpadek = 100% paid tier selhání, zákazníci platí USDC bez receiptu.
- **K2** `src/monitor/webhook-receiver.js:262` — Helius ack-before-process + žádná dead-letter queue. Downstream failure po ack = tiché ztracení eventu.
- **K3** `src/monitor/notifications.js` — dvě unbounded Maps (`sentAlerts`, `rateWindows`): OOM pod alert storm → restart smyčka každých ~5 minut.
- **K4** `src/rpc.js` — jediné RPC URL, failover nastává POUZE při restartu procesu, ne za runtime. Outage = 8s timeout cascade na všech scan endpointech.
- **K5** `src/monitor/webhook-receiver.js:21-33` — `_dedupCache` in-memory Set, reset při každém restartu → Helius retry = duplicitní eventy.

**Střední (S1–S9):** TOCTOU v free-quota, Anthropic API bez timeout, A2A loopback port exhaustion, Puppeteer unbounded cache, autopilot_spending tabulka bez TTL, WAL checkpoint lock, silent watchlist DB fallback, SPL poller ztracené poll okno, file-based circuit breaker tiše selže při disk full.

**Doporučené opravy před prvním Game Day (4 položky):**
1. sign pipeline: Telegram alert při spawn failure + 503 s `retry-after`
2. `notifications.js`: cap `rateWindows` na 1000 entries s LRU eviction
3. `webhook-receiver.js:213`: counter + alert při DB fallback na stale cache
4. `rpc.js`: runtime failover array (primary/secondary bez restartu)

**Observability gaps (8):** žádné metriky pro sign pipeline, A2A loopback, Map sizes, Helius downstream failure rate, watchlist DB fallback, SQLite BUSY count, autopilot table size; test-gate.sh nepokrývá payment chaos ani RPC timeout.

**Chaos experiment agenda (CE-01 až CE-07):** seřazeno od nejnižšího blast radiu. CE-01 (sign-report.py chmod 000) a CE-04 (notification storm, staging only) jsou priorita 1.

---

### 2026-05-06 (night+): AI Writing Audit — `voltagent-qa-sec:ai-writing-auditor`
Read-only audit 22 souborů (jen lidsky čtené texty, ne kód). Žádné commity.

**Výsledek:** Technická dokumentace (`CLAUDE.md`, `memory.md`, `REVIEW_PACKET.md`, `CHANGELOG.md`, `architecture.md`, `payments.md`) je věcná a čistá. Problémy jsou koncentrované do marketingových/submission textů.

**Střední závažnost (opravit před příštím odesláním):**
- `docs/superteam/grant-application.md` — "flying blind", "Why This Matters", "Composability, not redundancy", "production-grade", "Solo builder + multi-agent swarm"
- `docs/hackaton-submission.md` — "Composable by design, not by accident", anafora "There is no X" (3×), em dash density (39)
- `docs/hackaton-plan.md` — "vítězná payment infrastruktura" (3×)
- `docs/IRIS-whitepaper.md` — 44 em dashů (cíl < 20), "Novel Finding" bez citace negativního důkazu → přepsat na "To our knowledge..."
- `docs/frontier-submission.md` — "canonical Solana program verification API maintained by Solana's leading auditor" (hyperbolické bez evidence)

**Cross-cutting patterns:** "ecosystem" 4×, "composable/composability" 6×, "production-grade/ready" 3×, triády/anafora 4×, em dash overdose, sebepochvalná tvrzení bez důkazu.

**Co nepřepisovat:** `outreach.md` (sales tón záměrný), `demo-script.md` (mluvený text), `COPY.md` (landing — konzultovat s Hansem zda nasazena).

**Otázky pro Hanse:** (1) Jsou submission texty již odeslány? (2) Je COPY.md nasazena na intmolt.org? (3) Kam míří IRIS whitepaper (arXiv / blog / interní)?

---

### 2026-05-06 (night): 6 security fixů z ad-security-reviewer auditu
Commit `f7588ee`. 187/187 testů PASS.

- **H1+H2 canonicalJSON rekurze:** `src/crypto/sign.js` — `canonicalJSON()` nyní rekurzuje do polí (`[].map(canonicalJSON)`). Nested objekty uvnitř polí (např. `findings: [{severity, rule}]`) měly insertion-order klíče → sign a verify produkovaly různé bytes. Governance a feed `asyncSign` volaly `JSON.stringify()` místo `canonicalJSON()` — opraveno. **Dopad před opravou: governance a feed receipty byly externě neověřitelné.**
- **C2 Stripe webhook fail-closed:** Oba webhook handlery (`/stripe/webhook`, `/api/v1/stripe-webhook`) nyní vrátí 503 pokud `STRIPE_WEBHOOK_SECRET` chybí — žádný fallback na `JSON.parse(body)`. **Dopad před opravou: forged Stripe event → volná subscription → free API klíč.**
- **C1 API key auth gate:** `/api-keys/generate`, `GET /api-keys`, `DELETE /api-keys/:id` nyní vyžadují `req.isAuthenticated()` + shodu `req.user.email` s cílovým emailem. Fallback jen přes `ADMIN_API_KEY` hlavičku. Nový `requireApiKeyOwnership(emailExtractor)` middleware. **Dopad před opravou: kdokoli se znalostí emailu subscribera mohl vygenerovat plnohodnotný `im_xxx` API klíč.**
- **H5 SESSION_SECRET assertion:** `auth.js configureSession()` — `process.exit(1)` při startu pokud `SESSION_SECRET` chybí v env. Odstraněn fallback `'dev-secret-please-change'`. SESSION_SECRET v `.env` přítomen.
- **H3 agentMint validace:** `handler.js` — `x-agent-mint` header validovaný přes `isSolanaAddress()` před AutoPilot použitím. Odmítá 400 na neplatný formát (obě varianty: tasks/send i SSE). Import `isSolanaAddress` přidán na řádek 34.
- **H4 CF-Connecting-IP:** `free-quota.js getClientIp()` — priorita: `cf-connecting-ip` → `x-forwarded-for` → `req.ip` → `socket.remoteAddress`. Před opravou XFF mohl být spoofnutý → obejití per-IP kvóty.

**Gotcha — canonicalJSON testy:** A2A oracle testy testují sign→verify round-trip přes node:crypto (ne Python sign-report.py). Po opravě rekurze do polí prošly bez úprav, protože testovací payload neobsahoval nested-object arrays. Pokud se findings payload v testech rozroste, může odhalit regresi.

**Gotcha — getClientIp fallback:** `socket.remoteAddress` zůstává jako poslední fallback kvůli unit testům v `tests/middleware/free-quota.test.js` — `makeReq()` nastavuje jen `socket.remoteAddress`, ne `req.ip`. Bez tohoto fallbacku by 3 testy selhávaly (IP = 'unknown', quota neaplikována správně).

**Zbývající nálezy z auditu (neuděláno, není CRITICAL):**
- M1: `/api/v1/admin/accuracy` a `/api/v1/admin/helius` bez autentizace
- M2: Open redirect `?next=` v `/auth/*`
- M3: `ADMIN_TOKEN` v `/admin/abuse-stats` přes `!==` (timing leak)
- M4: `INTERNAL_SCAN_SECRET` přes `===` v free-quota.js
- M5: Stripe/Passport live-mounted i po ADR-009 deprioritizaci
- M6: Free quota check+consume race condition (dvě separátní transakce)
- H6: SSRF deny-list neblokuje IPv6, `0.0.0.0`, decimální encoding, DNS rebinding

### 2026-05-06 (night): 5 security fixů z code-reviewer auditu
Commit `5117b16`. Všech 5 fixů v jednom commitu, 187/187 testů PASS.

- **K1 XSS:** `escapeHtml()` aplikován na user-controlled hodnoty v `/subscribe/success` (email, tier) a `/unsubscribe` (email). Funkce existovala v server.js ~3275, jen se nepoužívala na těchto místech.
- **V7 x402 header shim:** `requirePayment` čte `req.headers['x-payment'] || req.headers['x402-payment']`. x402 klienti posílají `x402-payment`, server čekal `x-payment` → paid A2A přes reálné x402 klienty vždy vracel 402.
- **V6 feedback key pinning:** `/verify/v1/signed-receipt` nyní odmítne `verify_key` neshodující se s pinnutým serverovým klíčem (`getVerifyKeyBytes()`). Envelope mohl být mathematically_valid ale vydaný jiným klíčem.
- **K2 SSRF callback:** `/scan/token-audit` callback_url validovaný přes `validateCallbackUrl()` z `handler.js` (SSRF deny-list: localhost, 169.254.x, 10.x, 172.16.x, 192.168.x). Import přidán do řádku 1044 server.js.
- **V5/V4 timing-safe auth:** Nová `safeCompare(a, b)` wrapper funkce nad `crypto.timingSafeEqual` (handle length mismatch). Nahrazuje `===` u STATS_TOKEN (3 místa: `/stats/funnel`, `/admin/digest/run`, `requireStatsToken`) a ADMIN_API_KEY (`requireBotKey`).

**Gotcha:** `timingSafeEqual` byl lokálně importován uvnitř CAPTCHA sekce na řádku ~4110. Přidán globálně jako `_timingSafeEqual` na začátek souboru; lokální instance aliasována na `const timingSafeEqual = _timingSafeEqual` pro zpětnou kompatibilitu s CAPTCHA kódem.

### 2026-05-06 (evening): Architekturální review + 2 quick fixy
Commit `00fdc28`. Review provedl `voltagent-qa-sec:architect-reviewer`.

**Fix 1 — explicitní Solana deps (KRITICKÉ, opraveno):**
`@solana/web3.js@^1.98.4` a `@solana/spl-token@^0.4.14` přidány do `package.json`. Byly jen transitivní přes `@cheapay/x402` — riziko při `npm ci` na čisté mašině (process.exit(1) na startupu, celý payment flow down).

**Fix 2 — global Express error handler (opraveno):**
Přidán před `app.listen` v `server.js`. Express 5.2.1 propaguje async rejections nativně — `express-async-errors` nepotřeba. Loguje `method`, `url`, `x-request-id`; nikdy neposílá `err.message` klientovi.

**Výsledky architekturálního auditu — otevřené položky (neuděláno):**

KRITICKÉ (zbývá):
- `server.js` je 5457 řádků (routes + payment middleware factory + HTML renderer + cron scheduler)
  → Doporučeno: vyčlenit Stripe/legacy funnel do `src/legacy/` s feature flag `ENABLE_LEGACY_FUNNEL=false`

STŘEDNÍ (zbývá):
- 10 legacy deps (Stripe, Passport 4×, Puppeteer, bcrypt, nodemailer) v deps pro deprio funnel — attack surface
- Synchronní `better-sqlite3` v async Express — OK dnes, re-evaluate při DB > 10 GB nebo > 100 writes/s
- Žádný structured logger (console.log/error) — post-mortem korelace je manuální
- `/health` vrací jen `{ok}` bez DB/RPC/signing-pipeline check
- Žádný global try/catch v 56+ async route handlerech (Express 5 zachytí jen s global handlerem)

NÍZKÉ (zbývá):
- Skill metadata duplikovaná: `handler.js SKILLS` + `buildAgentCard` + `config/pricing.js` — 3 místa
- JSON-RPC error code -32000 jako catch-all (AutoPilot reject, payment fail, server error)
- callbackUrl SSRF deny-list: chybí link-local IPv6, DNS pre-resolution
- `_a2aRL` Map roste bez bound — RAM leak při botnetu

CO NEOPRAVOVAT (over-engineering pro aktuální scale):
SQLite→Postgres, microservices split, Fastify, custom JWKS rotation, per-skill soubory v handleru.

### 2026-05-06 (evening): Interní developer dokumentace
Commit `e75a09f`. Vytvořeno agentem `voltagent-dev-exp:documentation-engineer`, ~2950 řádků v 7 souborech v `docs/`:
- `DEVELOPER-INDEX.md` — navigační hub
- `architecture.md` — komponentová mapa, datové toky (free/paid path), hot path budget
- `skills.md` — všech 11 skills, cache TTL tabulka, executeSkill dispatch pattern
- `payments.md` — x402 flow, anti-replay, pricing, frames.ag proxy
- `database.md` — SQLite schéma 25+ tabulek, scan_history cache pattern
- `signing.md` — Ed25519, canonicalJSON, JWKS, offline verifikace Python/JS
- `development.md` — setup, test-gate, gotchas (CF-Connecting-IP, DB path, snake_case bug)

### 2026-05-06 (evening): QA A2A full test run — P0 bug nalezen a opraven
Commit `a60e405`. QA agent (`voltagent-qa-sec:accessibility-tester`) otestoval všech 11 skills + 5 discovery endpointů.

**Výsledek: 16/16 PASS po opravě.**

**P0 bug — adversarial_sim parameter mismatch:**
- `executeSkill` posílal camelCase: `programId`, `skipFork`, `playbookIds`
- Endpoint `/api/v1/adversarial/simulate` čekal snake_case: `program_id`, `skip_fork`, `playbook_ids`
- Dopad: 100% failure rate pro adversarial_sim přes A2A od doby přidání skilu
- Fix: 3 přejmenování v `handler.js` case `adversarial_sim`
- **Prevence regrese:** při přidávání nového skill case do executeSkill vždy ověřit naming convention cílového REST endpointu (Express routes typicky snake_case v body, handler.js musí matchovat)

**Výsledky testu (všechny skills):**
- Free: quick_scan, scan_address, new_spl_feed, verify_receipt, program_verification_status — PASS
- Paid: agent_token_scan, governance_change, token_audit, wallet_profile, adversarial_sim, deep_audit — PASS
- Discovery: agent-card.json, jwks.json, x402.json, skill.md, /offer — PASS
- Cache hit ověřen: agent_token_scan 298ms→32ms; token_audit hit na 2. call

### 2026-05-06 (evening): Missing skills + DB caching pro paid routes
Commit `5f53e45`.

**handler.js — chybějící skills přidány do executeSkill switch:**
- `scan_address` → GET `/scan/v1/:address` via nový `internalGet()` helper
- `new_spl_feed` → GET `/feed/v1/new-spl-tokens` (nevyžaduje address)
- `verify_receipt` → POST `/verify/v1/signed-receipt`
- `governance_change` → POST `/monitor/v1/governance-change`
- Fix: API klíč (`Bearer im_xxx`) forwardovaný jako `Authorization` header na loopbacku, ne jako `x402-payment`. Bez toho `requireApiKey` nedetekoval klíč na paid loopback calls → vždy 402.

**server.js — DB-first caching pro 5 paid routes:**
- `/scan/token` (token_audit): 60min TTL; saves result_json; 48s→cache hit
- `/scan/wallet` (wallet_profile): 30min TTL; added logScanToHistory (bylo chybějící)
- `/scan/deep` (deep_audit): 60min TTL; saves result_json
- `/api/v1/scan/agent-token` (agent_token_scan): 30min TTL; 298ms→32ms (10x)
- `/api/v1/adversarial/simulate` (adversarial_sim): 2h TTL

Cache pattern: `getCachedScanFromDb(address, scan_type, ttl)` AFTER payment middleware, logScanToHistory s result_json na response objektu. Stejný pattern jako existující `/scan/v1/:address` a `/monitor/v1/governance-change`.

**Test klíč vytvořen pro testování:** `im_baeaa344...` (tier=dev, email=test@intmolt.org). Lze mazat — žádná produkční data neprojdou přes něj.

### 2026-05-06 (afternoon): Clean history rebase + PR #1 merge
Po commit triáži byl rebase + force-push s `--force-with-lease`: 22 KEEP commitů cherry-picknuto na temp branch, main reset na ten temp, force-push do origin. Výsledek: commits `3770298` (MCP feat) ani `dde98e4` (cleanup) v origin/main už neexistují. HEAD po rebase byl `341f443` (fix(a2a)).

Následně PR #1 z claude.ai session 2026-05-04 mergnut do main jako merge commit `45bd1a8`. PR přidal 74 unit testů v 5 nových souborech: `tests/features/iris-score.test.js`, `tests/middleware/free-quota.test.js`, `tests/payment/pricing-consistency.test.js`, `tests/validation/report-validator.test.js`, `tests/a2a/task-store.test.js`. Žádné konflikty, všech 74 testů PASS po mergi.

**Test suite teď: ~187 passing tests + 22 adversarial scenarios** (před cleanupem 113).

Backup `backup/pre-cleanup-2026-05-06` plus physical archiv `/root/backups/mcp-scope-creep-2026-05-06/` ponechány týden pro případ rollbacku.

### 2026-05-06 (morning): Strategická porada, ADR-009 inverze, ADR-010 frames.ag
Po VPS reconu a auditu s colosseum-copilot agentem na hackathon Frontier proběhla strategická porada s Hansem na claude.ai. Tři klíčové výstupy:

1. **ADR-009 inverze priorit (supersedes ADR-007).** A2A 0.4.1 je teď primary monetizační i positioning surface, human funnel přes integritymolt.com plus Stripe je sekundární nebo deprecated. Pricing tier $0.15 až $5 USDC pro 6 paid skills zůstává.
2. **ADR-010 frames.ag distribuce plus research source.** Registrovat integrity.molt v frames.ag agent registry (publikace `intmolt.org/skill.md` plus PR do registry), používat frames.ag/datasets jako citovatelný external validator. Hans má wallet na frames.ag/u/hanslicko.
3. **MCP scope creep z 5. 5. ke triáži a archivaci.** Colosseum-copilot agent kódoval kompletní MCP server v `/root/x402-server/mcp/` po Hansově schválení auditu, ale BEZ schválení implementace.

CLAUDE.md a memory.md (tento soubor) v0.6 nasazeny na VPS, knowledge files na claude.ai aktualizovány.

### 2026-05-06: VPS recon report
Plný inventář `/root` ukázal: primární projekt `/root/x402-server/` (985 MB, live), orphan `/root/intmolt/` (132 KB, dead od 14. 4., k archivaci), `/root/scanner/` (live ale bez .git, kdo updatuje?), 4 prázdné `.db` artefakty z migrací (k vyčištění). `Backend.md` má velké B (k přejmenování na lowercase). `intmolt-bot.service` (ne `molt-telegram.service`) běží stabilně, ale Telegram API občas vrací empty response.

---

## Fixed bugs (lessons learned)

> Pre-v0.5.1-ottersec audit našel šest issues. Všechny opraveny. Pamatovat **proč** byly špatně, abychom je nepřivolali zpátky regresí. Po PR #1 mergi (2026-05-06) máme navíc 74 unit testů pokrývajících iris-score, free-quota, pricing-consistency, report-validator, task-store, takže regression check na tyhle moduly je teď automatický.

### requiredLamports míchal SOL a USDC thresholds
- **Symptom:** Špatné účtování, paid skill mohl projít s nedostatečnou platbou.
- **Root cause:** Jedna proměnná `requiredLamports` použitá pro USDC i SOL flow bez konverze mezi unity (SOL má 9 decimals, USDC 6).
- **Fix:** Oddělené `requiredLamports` (SOL only) a `requiredUSDCMicro` (USDC only). Validace per-skill na typu měny.
- **Regression check:** `tests/payment/pricing-consistency.test.js` (z PR #1) plus code review na `transfer` flow.

### destination = wallet adresa místo ATA
- **Symptom:** SPL token platby s nesprávnou destination, verifikace selhávala nebo procházela falešně.
- **Root cause:** Source code zaměňoval wallet adresu za Associated Token Account.
- **Fix:** Helper `getATAForWallet(wallet, mint)` použitý všude, kde se SPL transfer verifikuje.
- **Regression check:** `tests/payment/pricing-consistency.test.js` ověřuje `payTo` ATA address. Code review na `destination ===` patterns.

### Anti-replay chyběl
- **Symptom:** Stejný `tx_sig` použitelný několikrát, paid skill flow zneužitelný.
- **Root cause:** Žádný persistent log použitých signatur.
- **Fix:** Tabulka `x402_used_signatures` v `data/intmolt.db` s unique constraint na `tx_sig`. Insert PŘED issue receipt, fail-on-duplicate.
- **Regression check:** Při novém paid skill nebo změně payment flow ověř, že signature insert je BEFORE work, ne after. Pořadí je kritické.

### `/api/v1/stats` nevracel data
- **Symptom:** Landing page counters na integritymolt.com prázdné, monitoring slepý.
- **Root cause:** SQL query joinoval špatnou tabulku, returned empty result.
- **Fix:** Query přepsaný, test pokrývá happy path.
- **Regression check:** Cron sanity check stats endpoint, alert pokud counters = 0 déle než 1h. (TODO: ověřit, že alert reálně běží.)

### Scan type cards bez funkčních click targets
- **Domain:** `integrity-molt-web` repo, NE tady. Fix in web repo.
- **Lesson:** Při cross-repo issue: vždy fix v správném repu, nepokoušej se obcházet proxy logikou v backendu.

### Conflicting pricing: openapi.json vs x402.json vs pricing.txt
- **Symptom:** Tři source-of-truth pro skill ceny, drift mezi nimi.
- **Root cause:** Hand-edited soubory bez canonical source.
- **Fix:** `x402.json` je canonical. `openapi.json` a documentation generated from it. `pricing.txt` deprecated, removed.
- **Regression check:** `tests/payment/pricing-consistency.test.js` (z PR #1) ověřuje x402 discovery struktury a payTo ATA. Při změně ceny editor jen `x402.json`, ostatní soubory regenerated build stepem.

---

## Scope creep precedents

> Kde agent přestoupil scope, jak se to zachytilo, prevence pro příště. Tato sekce existuje, abychom se neopakovali.

### 2026-05-06: MCP scope creep z colosseum-copilot session (5. 5.) - RESOLVED
- **Co se stalo:** Hans schválil colosseum-copilot agentu, aby provedl audit projektu z hlediska Frontier hackathonu. Audit vyústil v doporučení "přerámovat na Security Oracle pro AI Agenty" plus návrh konkrétních technických featur (Agent SDK, MCP server, frames.ag distribuce). Agent po schválení AUDITU začal sám implementovat MCP server v `/root/x402-server/mcp/` (server.js 1300+ řádků, package.json, package-lock.json) plus přidal související commity (test/registry pro `/skill.md` a `/offer` endpointy, 4 řádky v `.env.example` včetně `INTEGRITY_MOLT_API_KEY` jako MCP bypass).
- **Symptom:** 23 nepushnutých commitů na main, mix legitimních A2A hardenings a MCP scope creep. Hans tomu fakticky nerozuměl bez triáže commit-by-commit.
- **Root cause:** Advisor mode (audit, no edits) přešel do Implementation mode (code) bez explicit Hansova schválení Plan -> Code přechodu. Single-prompt consolidation pravidlo nebylo vynuceno.
- **Resolution (2026-05-06 afternoon):**
  1. Triáž 23 commitů přes Claude Code Advisor: 21 KEEP, 1 ARCHIVE (3770298 feat(mcp), 1363 řádků MCP server), 1 REVIEW (c2d1754 feat(registry) /skill.md a /offer endpointy pro frames.ag distribuci, verified KEEP)
  2. Cleanup commit `dde98e4`: `git rm -r mcp/` plus odstranění 4 MCP řádků z `.env.example`
  3. **Eskalace na rebase + force-push:** cherry-pick 22 KEEP commitů na temp branch, force-push do origin/main. Tím z historie zmizel 3770298 (MCP přidání) i dde98e4 (cleanup) úplně. Origin/main čistá, žádná stopa po MCP.
  4. Physical archive `/root/backups/mcp-scope-creep-2026-05-06/` (server.js + package.json) pro budoucí referenci, pokud MCP integrace přijde do hry s explicit ADR.
  5. CLAUDE.md sekce 7 (Advisor strict no-code-edits) a 12 (zákaz nového surface bez ADR) aktualizovány.
- **Prevention:** Pokud Advisor agent začne sám editovat soubory bez explicit Hansova schválení Plan -> Code přechodu, **stop, eskaluj Hansovi**. CLAUDE.md to teď explicit obsahuje (sekce 7).

---

## Decisions log

> Drobnější rozhodnutí, která nezasluhují formal ADR v `key-decisions.md`. Datum, kontext, decision, trigger pro re-eval.

### 2026-05-06: Frames.ag tool registration jako Frontier deliverable
Aby integrity.molt měl konkrétní distribution proof v Frontier submission (12. května 23:59 UTC), publikovat `intmolt.org/skill.md` ve formátu frames.ag (template na https://frames.ag/skill.md) a založit PR do jejich registry před deadlinem. Implementace = jeden statický soubor plus README update, marginal cost. Re-eval pokud frames.ag změní registry policy. **Stav: c2d1754 commit už přidal `/skill.md` a `/offer` endpointy do server.js, KEEP po triáži 2026-05-06. Verifikovat content vs frames.ag spec zbývá.**

### 2026-05-06: ADR-007 zachovat v key-decisions.md jako historický záznam
Místo odstranění ADR-007 (human funnel primary) byl označen jako SUPERSEDED 2026-05-06 by ADR-009 a ponechán s plnou textací. Audit trail důvodu přepnutí je důležitější než clean log. Re-eval nikdy (historický záznam je permanent).

### 2026-05-06: Rebase + force-push jako resolution pro scope creep, ne jen revert
Pro MCP cleanup byly dvě možnosti: (a) keep commits 3770298 + dde98e4 v historii s comment, nebo (b) rebase + force-push, aby z historie zmizely úplně. Hans rozhodl pro (b), protože: (1) historie integrity.molt je veřejná a má credibility weight, (2) MCP scope creep není reálná evoluce projektu, ale chyba workflow, (3) physical archive v `/root/backups/` zachová audit trail, který historii nepotřebuje. Re-eval: pokud někdy v budoucnu MCP integrace projde ADR a má mít historický koncový bod, můžeme reintroduce z `/root/backups/`. Force-push je výjimka, ne pravidlo.

---

## Gotchas

> Sharp edges objevené během implementace, které ještě nejsou v CLAUDE.md sekci 4. Pokud se některý opakuje, povýšit do CLAUDE.md.

### 2026-05-06: Database path je `data/intmolt.db`, ne root `intmolt.db`
VPS recon ukázal 4 prázdné `.db` soubory v `/root/x402-server/` a `/root/x402-server/data/`. Live database je pouze `data/intmolt.db` (13.5 MB). Pokud kód někde otevírá `intmolt.db` v root, dostane prázdnou DB. K vyčištění stale `.db` souborů (pokud nejsou potřeba pro kompatibilitu) plus explicit path v config.

### 2026-05-06: `Backend.md` velké B vs ostatní lowercase
`/root/x402-server/.claude/agents/Backend.md` má velké B, ostatní (conductor.md, monitor.md, tester.md, web.md) jsou lowercase. Linux je case-sensitive, agent loader hledá lowercase. K přejmenování `git mv .claude/agents/Backend.md .claude/agents/backend.md` před deployem nového CLAUDE.md.

### 2026-05-06: Telegram bot empty response logy
`intmolt-bot.service` běží stabilně ale logy hlásí opakovaně "Empty response from Telegram API, sleeping 5s". Bot odpovídá na příkazy normálně, takže je to noisy log, ne incident. K prošetření po Frontier deadlinu (zda jde ztišit nebo je to skutečný flaky retry).

### 2026-05-06: Force-push s --force-with-lease, ne --force
Při rebase + force-push použil Claude Code správně `--force-with-lease`, ne plain `--force`. Lease verzi rejektne push, pokud někdo mezi tím pushnul nový commit (collaborator safety). Pro solo builder je rozdíl menší, ale držet zvykem `--force-with-lease` je defaultní reflex pro budoucí kolaborace.

---

## Open TODOs (nice-to-have, future ideas)

> Co napadlo během práce a nepatří do `tasks/active/`. Pokud TODO eskaluje na prioritu, převést na task soubor.

- Verifikovat content `intmolt.org/skill.md` (z commit c2d1754) vs aktuální frames.ag spec na https://frames.ag/skill.md. Pokud strukturální rozdíly, fix in separátním commitu.
- Ověřit, že stats endpoint cron alert reálně běží (post-fix audit z 2026-05-06).
- Vyčistit 4 prázdné `.db` artefakty po VPS reconu, pokud nejsou potřeba pro kompatibilitu.
- **Chaos fixes (4 položky, blocker před Game Day):** sign pipeline alert, notifications.js LRU cap, watchlist fallback alert, rpc.js runtime failover — viz chaos audit entry 2026-05-06 night+.
- **Chaos experiments (CE-01, CE-04 jako první):** spustit v off-peak nebo staging po implementaci fixů.
- **AI writing rewrite:** submission texty přepsat před dalším odesláním (grant-application, hackaton-submission, frontier-submission, IRIS whitepaper em dash pass).
- Po Frontier: archivovat `/root/intmolt/` orphan do `/root/backups/intmolt-archived-2026-05-06/`.
- Po Frontier: cleanup stale worktrees (`sharp-bartik-2d2239` z dubna, ověř merged a remove).
- Po Frontier: Telegram bot empty response log fix nebo ztišení.
- Po Frontier: pokud Cursor/Copilot oponent review chain reálně běží, kalibrovat triggery (řádky kódu, file count, modul touchy) podle prvních 3 reálných runs.
- Po Frontier (volitelné): smazat `backup/pre-cleanup-2026-05-06` branch po týdnu, pokud se nic nerozbilo.

---

## Strategic context for next claude.ai session

> Co Hans potřebuje vědět při příští poradě se mnou (Claude na claude.ai). Krátký TL;DR po každém pracovním dni.

**Aktuální fokus:** Frontier hackathon submission deadline 11. května 23:59 UTC (Public Goods Award $10K lane). Framing **agent-native security oracle** plně absorbovaný. Next deliverables: frames.ag tool registration spec verify, video editing, submission text.

**2026-05-07 — dvojitý DB audit (oba koly dokončeny):**
- Dva `voltagent-data-ai:database-optimizer` audity + opravy. Celkem ~20 issues across db.js, autopilot.js, spl-mint-poller.js.
- Klíčové opravy: partial UNIQUE index watchlist (K-1, dříve možné duplicity), rebuildScamCreators atomicita (K-3, crash = prázdná tabulka), 11 nových/opravených indexů, 8-tabulkový TTL cleanup v 6h intervalu, prepared stmt hoisting v autopilot + poller.
- Empiricky verifikováno: `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` přítomen → V-7 (ORDER BY v UPDATE) není bug.
- Test suite: 11/11 gate PASS oba koly. Commity: 28e2a4f (round 1) + 526b31b (round 2).

**Otevřené položky ze security a chaos auditů (2026-05-06, stále neresolvováno):**
- Chaos: 4 kritické opravy před Game Day (sign-report.py alert, notifications.js LRU cap, watchlist DB fallback alert, rpc.js runtime failover)
- Security: H1 (self-fetch quota bypass), H2 (req.ip nekonzistence), H4 (open redirect), H5 (INTERNAL_SCAN_SECRET timing-unsafe), M1–M6
- AI writing: submission texty mají AI-ismy — přepsat před dalším odesláním

**Technický stav (aktuální):**
- Test suite ~187 passing tests + 22 adversarial scenarios. 11/11 gates.
- Origin/main čistá, žádné nepushnuté commity.
- Backup branch `backup/pre-cleanup-2026-05-06` zachován (smazat po týdnu od 2026-05-06 bez incidentu → 2026-05-13).
- `data/intmolt.db` je live (13.5 MB+), root `intmolt.db` je stale artefakt.

**ADR stav:**
- A2A 0.4.1 primary surface, 11 skills fixed, pricing $0.15–$5 USDC.
- Frames.ag distribuce: `/skill.md` + `/offer` endpointy v server.js, content vs spec zbývá verifikovat.
- MCP server NEvznikne bez ADR (history clean po rebase 2026-05-06).

**Otázky pro Hanse (z AI writing auditu):** jsou submission texty již odeslány? Je COPY.md nasazena? Kam míří IRIS whitepaper?
