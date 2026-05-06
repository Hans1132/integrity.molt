# integrity.molt - memory.md

> Living log Claude Code. Sem se zapisují rozhodnutí, fixed bugs, gotchas, recent changes, scope creep precedents.
> Hans stahuje pravidelně a uploaduje do project files na claude.ai pro strategický kontext.
> Stručnost > úplnost. Jeden entry typicky 3 až 5 řádků.

**Last updated:** 2026-05-06 (regresní testy + rozšíření npm test scope, commit 5230e3b)

---

## Recent changes (top of stack, newest first)

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

**Aktuální fokus:** Frontier hackathon submission deadline 11. května 23:59 UTC (Public Goods Award $10K lane). Po 2026-05-06 strategické poradě je framing **agent-native security oracle** plně absorbovaný. Origin/main je clean (rebase done, MCP cleanup done, PR #1 merged). Next deliverables: frames.ag tool registration spec verify, video editing, submission text.

**Nové poznatky z auditů (2026-05-06 night+):**
- Chaos audit odhalil 5 kritických SPOF — nejrizikovější: sign-report.py (paid tier SPOF), notifications.js OOM (alert storm), RPC bez runtime failover. Opravy by měly předcházet dalšímu traffic spike (frames.ag distribuce = více A2A load).
- AI writing audit: submission texty (grant, hackaton, frontier) mají AI-ismy, které snižují credibilitu u judges/grantérů. Přepsat před dalším odesláním. Technická docs je čistá.
- Otázky pro Hanse: jsou submission texty již odeslány? Je COPY.md nasazena? Kam míří IRIS whitepaper?

**Po pivotu ADR-009 + ADR-010:**
- A2A 0.4.1 je primary surface, 11 skills fixed, pricing $0.15 až $5 USDC drží.
- Frames.ag distribuce schválena (registrace v jejich registry plus citation z frames.ag/datasets).
- MCP server NEvznikne (scope creep z 5. 5. archivován a vyrebasen z historie).
- Human funnel přes integritymolt.com plus Stripe deprio, ne aktivně rozvíjený.
- SF grant Milestone 3 absorbuje frames.ag jako třetí distribuční target vedle SendAI plus ElizaOS.

**Technický stav po cleanu:**
- Test suite ~187 passing tests + 22 adversarial scenarios (z 113 před cleanupem, +74 z PR #1).
- Origin/main čistá historie bez MCP stop.
- Backup branch `backup/pre-cleanup-2026-05-06` plus archive `/root/backups/mcp-scope-creep-2026-05-06/` zachovány.
- Žádné nepushnuté commity, repo synced.

**Open questions, které čekají strategický input:** žádné po dnešní session.

**Heads-up pro příští workflow change:** Jakmile Hans poprvé projde celý gating cycle (Trivial -> Medium -> Large na reálném change po deploy CLAUDE.md), zaznamenat sem co fungovalo a co ne, abychom kalibrovali triggery.
