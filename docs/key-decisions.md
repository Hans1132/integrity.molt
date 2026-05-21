# integrity.molt - key decisions (ADR log)

Lehký ADR formát. Jeden záznam = jedno rozhodnutí, jeho důvod, a co bude signál to přehodnotit.

---

## ADR-001: Solana jako primární řetězec

**Kontext:** A2A agent payments rostou napříč řetězci. Ethereum má ERC-8004 Trustless Agents (živé od ledna 2026), Solana má MIP-13.

**Rozhodnutí:** Build natively na Soloně.

**Důvody:** 65 % A2A x402 traffic na Soloně. Metaplex Agent Tokens launch (13. dubna 2026) s Molt.id jako primary partner. Sub-second finality kompatibilní s hot-path latency budgetem. Solo builder má v ekosystému cestu (`.molt` doména, znalost Molt.id).

**Re-evaluate když:** Ethereum / L2 začnou dominovat agent payment volume, NEBO Solana ekosystém zpomalí investment do agent infra.

---

## ADR-002: x402 jako payment protocol target

**Kontext:** Multiple agent payment standardy (x402, A2A native, on-chain only). Potřeba volby focus.

**Rozhodnutí:** Optimalizovat na x402 (HTTP 402 micropayments) jako primary use case s USDC pricing $0.15 až $5 per skill, plus Stripe pro human-facing subscriptions (sekundární po ADR-009).

**Důvody:** ~50M transakcí již proběhlo přes x402. Inline pre-transaction check = jasný value prop. Cenové rozpětí umožňuje free tier (5 skills) pro discovery + paid tier (6 skills) pro monetizaci. Stripe paralelně pro human-funnel až do dosažení agent traction.

**Re-evaluate když:** A2A native payment standard (mimo x402) získá > 30 % share. POZN. (2026-05-06): frames.ag/datasets `agent-payment-protocol-fragmentation` ukazuje 7 protokolů (Stripe ACP, Visa Trusted Agent, Mastercard Agent Pay, MPP, x402, Coinbase, Google) s ~1 % adopcí dle Morgan Stanley. x402 zůstává náš target ale monitoring fragmentace je teď explicit re-eval signál.

---

## ADR-003: Callable infrastructure, ne consumer dApp

**Kontext:** Většina projektů na Soloně jde po retail uživatelích. Ekosystém má málo infrastruktury.

**Rozhodnutí:** integrity.molt je callable A2A oracle se signed receipts. Marketing site (integritymolt.com) slouží jako entry point pro human funnel, demo a API běží na intmolt.org.

**Důvody:** Žádný direct competitor (Copilot: 5.6 % max similarity). Solo builder nemá bandwidth na full consumer stack. Trust primitive je víc cenný než další dashboard. Middle market mezi free scanners (Rugcheck) a professional audits (OtterSec/Sherlock).

**Re-evaluate když:** Public scan URL ukáže silný retail engagement, který volá po vlastním UI vrstvě. POZN. (2026-05-06): ADR-009 obrátil prioritu na A2A primary, takže consumer dApp už není ani uvažovaný směr. Tento ADR zůstává platný v core (callable infra je pořád správný frame), ale "marketing site" sekce je deprioritized.

---

## ADR-004: Production stack — Node.js/Express na VPS za Cloudflare proxy

**Kontext:** Volba mezi serverless edge compute (Cloudflare Workers, Lambda@Edge) a tradičním Node.js serverem.

**Rozhodnutí:** Node.js/Express na portu 3402 + NGINX (TLS termination) + SQLite WAL na Kamatera VPS (Ubuntu 24.04). Cloudflare jako reverse proxy a CDN, žádné D1/KV/R2.

**Důvody:** Plná kontrola nad runtime (kritické pro Ed25519 signing s key pinningem). SQLite stačí na current scale (33 000+ scam pools, signed receipts archive). Cloudflare proxy řeší DDoS, TLS, CDN bez závislosti na Workers limitech. Kamatera VPS levný, předvídatelný billing. Migrate path na Workers/serverless je otevřená, pokud rate roste.

**Sharp edge:** Cloudflare proxy přepisuje client IP. Express middleware MUSÍ číst `CF-Connecting-IP`, ne `X-Forwarded-For`, jinak rate-limiting a logging vidí Cloudflare edge IP místo skutečné klienta.

**Re-evaluate když:** Concurrent request load překročí ~100 req/s sustained, NEBO když latency od evropského VPS k US-based Solana RPC začne tlačit nad 1s budget.

---

## ADR-005: Tři composability axes jako moat

**Kontext:** Konkurenční prostor (RugCheck, Range, GoPlus, Blockaid) je obsazený, ale žádný hráč nestaví na vícero nezávislých vrstvách integrace.

**Rozhodnutí:** Postavit moat na třech ortogonálních composability axes:
1. **OtterSec verify.osec.io** — live source verification per program scan
2. **Metaplex Agent Registry** — Core Asset cross-reference v každém signed receipt
3. **Open standards** — A2A 0.4.1, x402, Ed25519, JWKS RFC 8037, vendor-neutral primitives

**Důvody:** Každá osa snižuje pravděpodobnost full replication konkurentem. OtterSec po Asymmetric Research mergeru má vlastní oracle ambice → integrace teď, before they compete. Metaplex Registry nově launchnutý (13. dubna), first-mover advantage v cross-referencingu. Open standards = žádný vendor lock-in pro konzumery → nižší adoption friction.

**POZN. (2026-05-17):** ADR-013 rozšířil composability axis #2 na bi-directional Metaplex integration (token_audit polymorphism, registered agents jako first-class subjects, ne jen issuer cross-reference).

**Re-evaluate když:** Konkurent replikuje 2+ axes do 6 měsíců (deep-dive trigger v `competitor-analysis.md`), NEBO některá z os ztratí ekosystémovou váhu.

---

## ADR-006: Multi-LLM scan pipeline s Anthropic Advisor pattern

**Kontext:** Skenování agentů a programů vyžaduje reasoning nad nestrukturovanými signály (audit reports, governance proposals, contract metadata). Single-LLM stack je drahý a brittle.

**Rozhodnutí:** Tři-stupňová pipeline s confidence gating:
- **Scanner:** Gemini 2.5 Flash via OpenRouter, fast first-pass classification
- **Analyst:** GPT-4o-mini via OpenRouter, structured analysis nad Scanner výstupem
- **Advisor (escalation only):** Anthropic Sonnet 4.6 default, Opus 4.7 pro edge cases

**Důvody:** Cost optimization přes model tier (Gemini Flash levný, Anthropic drahý ale jen na hard cases). Provider diversification (žádný single point of failure / billing). Confidence gating zajišťuje že drahý Advisor se volá < 20 % requestů. Anthropic má nejlepší reasoning kvalitu pro edge cases, vhodné pro pomalé adversarial_sim a deep_audit skills.

**Critical constraint:** Hot path budget `/scan/v1/:address` musí zůstat pod 1 sekundu P95. Anthropic NEpoužívat v hot pathu, adaptive thinking je latency-unpredictable. Anthropic běží jen na warm/cold path (paid skills s vyšší tolerancí latence).

**Re-evaluate když:** OpenRouter latency začne dominovat nad reasoning quality benefits, NEBO když některý provider rapidly vylepší cost/quality (Gemini 3, Sonnet 5).

---

## ADR-007: Human funnel před agent economy [SUPERSEDED 2026-05-06 by ADR-009]

> **Status (2026-05-06): SUPERSEDED.** ADR-009 inverzí priority říká že A2A je teď primary, human funnel je sekundární nebo deprecated. Tento záznam zůstává jako historický audit trail proč jsme původně volili human-first (predictable willingness-to-pay, agent ekosystém raný) a proč jsme tu volbu obrátili (audit Colosseum Copilotu, frames.ag/datasets potvrzení agent payment protocol fragmentace, čistý security scanner nevyhrává).

**Kontext:** Pre-revenue solo builder s omezeným bandwidth. Volba mezi paralelní investicí do A2A/agent ekosystému a human-facing produktu.

**Původní rozhodnutí:** Primární monetizační priorita je human-facing free scan → paid upsell flow přes integritymolt.com a Stripe. A2A/x402 surface je secondary, dokud human funnel nedoručuje paying customers.

**Re-evaluate když (původní):** Human funnel přestane růst (MoM revenue stagnuje 2+ měsíce), NEBO A2A traffic samostatně překročí 100 paid calls/day. **Trigger sepnul fakticky 2026-05-06**, ne výkonem human funnelu, ale strategickou re-evaluací po Colosseum auditu.

---

## ADR-008: Build-in-public přes X / GitHub / live demo

**Kontext:** Solo builder, žádný track record, potřeba trust signalu.

**Rozhodnutí:** Veřejné publikování progressu (X handle `@HLo18147`, public MIT repo `Hans1132/integrity.molt`, live demo na intmolt.org, signed receipts s verifiable issuer).

**Důvody:** Transparency je trust primitive samo o sobě (kongruence se security messaging). Public repo + signed receipts = každý si může ověřit že produkt dělá co tvrdí.

**Re-evaluate když:** Veřejnost vede k bezpečnostním rizikům (signaling attack vectors), NEBO open-source kopie začnou kanibalizovat paid skills.

---

## ADR-009: Inverze priorit, A2A primary, human funnel sekundární [supersedes ADR-007]

**Datum:** 2026-05-06

**Kontext:** Po VPS reconu a auditu s colosseum-copilot agentem na hackathon Frontier potřeba revidovat ADR-007. Audit konsolidoval výsledky podobných projektů: žádný čistý security scanner (Pepelock, amIrug.xyz, Rug Raider, Pump Guard) nezískal cenu na Solana hackathonech v posledních cyklech. Naopak projekty kombinující x402 + AI agent infrastrukturu vyhrály konzistentně (CORBITS 2. místo Cypherpunk Infrastructure $20k, MCPay/frames.ag 1. místo Cypherpunk Stablecoins $25k).

**Rozhodnutí:** A2A 0.4.1 surface je teď primary monetizační i positioning priorita. Human funnel přes integritymolt.com + Stripe je sekundární. **Pricing tier zůstává $0.15 až $5 USDC pro 6 paid skills**, ne snížení k $0.01.

**Důvody:**
1. **Vítězná data:** x402 + agent infra vyhrává, čistý security scanner ne. Integrity.molt je unikátní v tom že kombinuje obě.
2. **Frames.ag distribuce:** registrovat integrity.molt jako tool v jejich agent registry je nízká marginal investment a otevírá konkrétní agent ekosystém s aktivním wallet networkem.
3. **Solo builder bandwidth:** dva paralelní funely (human + agent) jsou neudržitelné. Fokus na jeden je rychlejší shipping.
4. **SF grant Milestone 3** (distribuce do agent platforem) zapadá organicky, ne v tenzi.

**Co se nemění:** A2A surface area (11 skills, fixed), pricing, scoring pipeline, multi-LLM Advisor pattern, signed receipt envelope, JWKS kid, Metaplex composability, OtterSec composability.

**Co se mění:** Marketing důraz na integritymolt.com (Stripe subscriptions, human onboarding) je paused. Veškerá nová work invest jde do A2A surface hardening, frames.ag/SendAI/ElizaOS distribuce a agent-native messaging.

**Re-evaluate když:**
- A2A traffic stagnuje 2+ měsíce po onboarding 3 distribučních targets, NEBO
- Human funnel organicky generuje > 10 paying customers/měsíc bez aktivní práce (signál že trh existuje navzdory deprio), NEBO
- Agent payment protocol fragmentace dosáhne stavu kde x402 ztratí dominantní share na Solaně.

---

## ADR-010: Frames.ag jako čtvrtá distribuční integrace + research source [DEPRIORITIZED 2026-05-13]

**Datum:** 2026-05-06

> **Status (2026-05-13):** Frames.ag tým rejectnul integrity.molt tool registration. Distribuční vrstvu nahradil ADR-011 (open MCP server). Research source část zůstává platná (citovat frames.ag/datasets v positioning).

**Kontext:** Frames.ag (rebrand MCPay, vítěz Cypherpunk Stablecoins) provozuje AgentWallet + tool registry + open research datasets. Hans má registrovanou wallet na https://frames.ag/u/hanslicko.

**Původní rozhodnutí:** Integrovat frames.ag na třech úrovních (distribuce, payment proxy, research source).

**Co se stalo:** Distribuční integrace neproběhla (rejection). Research source role pokračuje, frames.ag/datasets entity stále citovatelné v pitchích.

**Re-evaluate když:** Frames.ag změní registry policy nebo otevře re-application, NEBO frames.ag/datasets přestane být udržovaný (signál pro stažení citation závislosti).

---

## ADR-011: Open MCP server jako třetí distribuční kanál

**Datum:** 2026-05-13

**Kontext:** Frames.ag rejection (2026-05-13) uzavřel ADR-010 distribuční vrstvu. SendAI research ukázal 153-star MCP precedent (sendaifun/solana-mcp) a prázdnou Security kategorii v Solana MCP ekosystému. Externí testeři potřebují lowest-friction install path.

**Rozhodnutí:** Thin MCP wrapper kolem 5 free A2A skills publikovaný jako npm balík `integrity-molt-mcp`. Paid skills A2A-only, MCP server NEduplikuje paid surface. Default URL https://intmolt.org (production), local backend optional.

**Důvody:**
- Distribuční kanál #3 po deprioritizaci frames.ag (ADR-010).
- One-snippet Claude Desktop config pro externí testery (zero setup time).
- 5 free skills jsou natural fit (scan_solana_address, quick_scan, verify_signed_receipt, get_new_spl_tokens, check_program_verification).
- Prázdná Security kategorie v Solana MCP ekosystému = first-mover advantage.
- MIT license, public repo = stejná filozofie jako zbytek projektu.

**Co se NEMĚNÍ:** A2A surface area, paid pricing, scoring pipeline, signed receipt envelope. MCP je thin wrapper, ne nová funkcionalita.

**Co se mění:** `mcp/` subpackage v repu, samostatný `package.json` a publish cycle. Test gate rozšířen o MCP test suite (72 testů po Fáze 4c).

**Success metric (30-day review gate 15-16. června 2026):** 10 unique installs + 1 externí interaction (issue, PR, mention). Pokud nesplněno, MCP server deprecated.

**Re-evaluate když:** 30-day gate metrics nesplněno, NEBO MCP protokol konsoliduje na alternativní transport (zatím stdio dominantní), NEBO security audit najde unfixable trust model issue.

---

## ADR-012: MCP local Ed25519 verify, opt-out pattern

**Datum:** 2026-05-13

**Kontext:** První MCP server verze (před hardening) měla circular trust model: MCP klient ověřoval signed receipty voláním backend `/verify` endpointu. To znamenalo že MCP klient důvěřuje stejnému issuerovi že vydaný receipt skutečně vydal sám sebe (tautologie). Externí audit (9 agentů, 2026-05-13) identifikoval issue C1.

**Rozhodnutí:** MCP klient implementuje lokální Ed25519 verifikaci s pinnutým verify_key (`integrity-molt-primary-2026`). Backend round-trip je opt-out přes `INTEGRITY_MOLT_LOCAL_VERIFY=0`. Custom BASE_URL vždy vynutí local verify (zabraňuje útoku kdy attacker přesměruje verify na vlastní backend).

**Důvody:**
- Eliminuje circular trust model.
- Snižuje latenci verify operace (no network round-trip).
- Snižuje failure modes (no DNS, no TLS, no backend uptime dependency).
- Pinned public key v MCP balíku je explicit trust anchor, ne implicit přes URL.

**Sharp edge:** `INTEGRITY_MOLT_TEST_VERIFY_KEY` env var je gated za `NODE_ENV=test`. Bez tohoto guardu by attacker v Claude Desktop config snippetu mohl nahradit pinned klíč vlastním → `valid:true, key_pinned:true` pro forged receipty.

**Re-evaluate když:** Klíčový rotation event (změna `kid` na jiný než `integrity-molt-primary-2026`), NEBO klíč compromise (rebuild + republish balíku s novým pinned klíčem).

---

## ADR-013: Token_audit polymorphism, Metaplex agent registry jako first-class subject

**Datum:** 2026-05-17

**Kontext:** Po ADR-005 composability axis #2 (Metaplex Agent Registry jako cross-reference v signed receipts) zbývala otevřená otázka: co když subject scanu JE registered Metaplex agent, ne SPL token? Současný `token_audit` flow předpokládal SPL token a Metaplex jen cross-referencoval issuera.

**Rozhodnutí:** `token_audit` skill je teď polymorfní:
1. **Detection-first:** před scanning logikou detekuj jestli adresa je Metaplex registered agent (cache 6h).
2. **Branch A (metaplex_agent):** ERC-8004 document fetch + wallet check + claim vs reality assessment. Vlastní scoring (`computeAgentScore`), vlastní signed receipt payload (`buildMetaplexAgentPayload`).
3. **Branch B (SPL):** existing SPL token audit flow, nezměněn.
4. **Cache key discrimination:** `scan_type = "token_agent"` vs `"token"` v scan_history.

**Důvody:**
- Bi-directional Metaplex integration: agenty mohou být subjects, ne jen issuers.
- ERC-8004 cross-chain compatibility (Trustless Agents na Ethereum používají stejný document format).
- Žádný nový A2A skill surface (11 skills zachováno), polymorphism uvnitř existing skill.
- Claim vs reality assessment = unique value prop pro registered agents (mohou tvrdit cokoli v registry, ale on-chain wallet behavior je truth).

**Re-evaluate když:** ERC-8004 spec major version bump (current 1.0), NEBO Metaplex Agent Registry deprecates Core Asset model, NEBO claim/reality false positive rate překročí 5% v production.

---

## ADR-014: IRIS v2.0 — 8 dim + GoPlus + continuous scoring [DRAFT, 2026-05-19 — SUPERSEDED by FINALIZED entry below 2026-05-21]

**Datum:** 2026-05-19 (draft, pending Code fáze + kalibrace)

> **Status:** Draft. Plan dokument v `docs/superpowers/specs/2026-05-19-iris-v2-scope-a-plan.md`. Po Code fázi a kalibraci se z Planu udělá retrospektivní finální ADR s skutečnými čísly (P95/P99, precision/recall, weight tuning).

**Kontext:** IRIS v1 scoring má 4 dimenze, step floors, hard whitelist, 2 enrichment sources (rugcheck, solana_tracker). Token 5pdyeWSC případ z 2026-05-09 ukázal že step threshold (75/50) způsobuje "all-or-nothing" skóre, drobné posuny v score_norm fire-ovaly nebo nefireovaly floor s 27-point swing. Continuous scoring řeší.

**Rozhodnutí (Scope A):**
1. Rewrite `src/features/iris-score.js` na 8 dimensí s evidence-based weights z SolRPDS frequency analysis (váhy sumují na 100):
   - liquidity: 18, authority: 15, concentration: 13, lineage: 13, reputation: 12, trading: 11, honeypot: 10, age: 8
2. Continuous scoring 0-100 bez step floors.
3. Soft floor: `score = max(score, 50 + scam_db_confidence × 40)`, aktivní jen pokud `scam_db_confidence > 0.5`.
4. Soft whitelist: `score = score × (1 - whitelist_strength × 0.7)`, tier-1 whitelist drží 30% skóre, ne nula.
5. GoPlus enrichment jako 4. source (`src/enrichment/goplus.js`), separate `goplus_cache` tabulka, TTL pattern jako `rugcheck_cache`.
6. Externalizace vah do `data/rules-v2.json`, načítané při startu, refresh přes systemd restart.
7. Circuit breaker s renormalization: pokud enrichment source selže, dimenze se vyhodí, zbývající weights se přepočítají proporčně na 100.
8. Test gate v2: labeled test set z SolRPDS (scam/legit/unknown ground truth).
9. Backward compat: `iris_version: '2.0'` field, `iris_score` int 0-100 zachováno, additive `iris_breakdown` shape.

**Mimo Scope A (samostatné sessions):**
- Birdeye integrace (volume, volatility, lp_age).
- Helius async enrichment worker (creator history, fresh wallets, wash trading proxy).
- Graph analytics (related_wallets, syndicate detection) → potenciální Scope C samostatný ADR.
- Advisor LLM v free `/scan/v1/` (Mode C: advisor jen v paid skills, free zůstává rule-based, respect ADR-006 hot path budget).
- DexScreener fallback.
- Migration backfill existing scan_history records (v1 records zůstávají historical, marker přes `iris_version` field).

**Důvody (Approach 2 evidence-based weights):**
- 4 dim → 8 dim: SolRPDS ukazuje že liquidity_drain + inactive_pool je 79% rugů. Současná 4-dim agregace tuhle granularitu ztrácí.
- Continuous scoring: eliminuje "narrow miss" cases jako 5pdyeWSC (score_norm=71 minul threshold 75 o 4 body).
- Soft floor s confidence gate: scam_db match s low confidence (např. 0.3) nesmí přepnout neutral token do MEDIUM zóny. Threshold 0.5 zabrání false positives.
- GoPlus jako 4. source: dopolňuje honeypot detection (can_buy/can_sell) co rugcheck a solana_tracker přímo neposkytují.
- Externalizace vah: refresh-able bez code change. Audit trail v parallel `rules-v2.weights.md` dokumentu.
- Circuit breaker: graceful degradation při výpadku enrichment source. Renormalization zachová proporci, ale `confidence_level: low` při 2+ source fail.

**Hard constraints (z ADR-006, ADR-004):**
- Hot path P95 `/scan/v1/:address` zůstává < 1 sekunda.
- Žádné Anthropic v hot pathu, free scan rule-based only.
- `CF-Connecting-IP`, ne `X-Forwarded-For`.
- canonicalJSON byte-identical při sign + verify.
- Žádný nový endpoint, žádný nový A2A skill surface.

**Open questions (pending conductor measurements):**
- P99 baseline + projekce v2 (P95 baseline = 636ms měřený, v2 projekce 825ms, headroom 175ms je tight).
- v1 precision baseline na SolRPDS labeled set (rozhoduje target precision pro v2, 95% nebo 97%+).
- Lineage Scope A boundary: je `creator_age_days` přes sync RPC `getAccountInfo` v Scope A, nebo odložené na Helius async?
- Morgan response-time token (1-line server.js, význam k vyjasnění).

**Re-evaluate když (po Code fázi):**
- Calibration v test gate v2 selže (precision/recall pod target).
- P99 v production překročí 1s (porušení ADR-006).
- GoPlus rate limit (free tier 30 RPM) bottleneck v peak hours (circuit breaker open state > 10% času).
- SolRPDS dataset získá majoritní new labels (kvartální re-fit weights).
- Klient feedback ukazuje že `iris_breakdown` nested shape je hard to parse.

---

## ADR-014: IRIS v2.0 — 8-dim continuous scoring + external oracle floor + 3-tier risk_level (FINALIZED 2026-05-21)

**Status**: Accepted, shipped to production 2026-05-21 (Phase 5 merge commit `5f03e40` + amendments + fix-ups + frontend Phase 2.5).

**Context**: IRIS v1 used 4-dim (Inflows/Rights/Imbalance/Speed) × 25 score + step floors (76 known_scam, 51 RC danger, 0 whitelist) → bimodal output collapse. Random tokens flat-scored 5, scam tokens 76, no spread between.

**Decision** (per primary spec + Amendment v2 [3-tier 40/70] + Amendment v3 [external oracle floor]):
- 8 dimensions: Liquidity, Authority, Concentration, Lineage, Reputation, Trading, Honeypot, Age. Evidence-based weights (18/15/13/13/12/11/10/8 = 100) per SolRPDS frequency analysis.
- Continuous scoring 0-100 with soft_floor (50 + scam_db_confidence × 40 when conf ≥ 0.5), soft_whitelist (0.7 reduction for tier-1), external_oracle_floor (51 + max(0, score_normalised − 50) × 0.6 for RC `danger` without internal scam_db match).
- 3-tier risk_level enum lowercase: `safe (<40) | caution (40-69) | danger (≥70) | unknown (null score, ≥3 dims down)`. Threshold 40/70 preserved from existing `scoreToRisk` per Hansova výhrada Amendment §1.3 (no evidence base for shifting; deferred to post-deploy calibration cycle).
- New enrichment source: GoPlus Token Security API for Honeypot dimension (circuit breaker 3-fail/600ms timeout, 1h success / 5min negative cache, module-level Map 5min mirror rugcheck pattern).
- HTTP 503 + `Retry-After: 30` + `X-Insufficient-Data: <count>` headers when ≥3 dims fail (spec §5 R5 compliance).
- `IRIS_VERSION=1` env flag for graceful rollback to v1 path (R5 mitigation proven during Phase 5 RugCheck 401 incident).
- token_audit paid skill migrated to v2 + goplus; 5 ostatních paid paths preserve v1 behavior via `calculateIRIS` alias to v1 (Decision 3 c2 MODIFIED DEFER).

**Empirical validation (2026-05-21 post-deploy test-gate)**:
- Bucket A (50 SolRPDS-confirmed scams): 50/50 score ≥70 (soft_floor activation) ✅
- Bucket B (15 tier-1 whitelist): 15/15 score ≤39 (soft_whitelist reduction) ✅
- Bucket D (5pdyeWSC regression, score_normalised=71, no known_scam entry): score 64 caution (`external_oracle_floor` fired, Amendment v3 §3.3 math `51 + (71-50) × 0.6 = 63.6 → 64` reality-confirmed, `risk_factors` includes `external_oracle_danger_floor_applied`) ✅
- Bucket C (30 random unlabeled spl_mints): mean 23.5, stddev 0.8 — tight safe-band cluster.

**Limitation / open follow-up**: v2 continuous design validated **within scored signals** (cluster 20-29 vs v1's flat 5 — broader signal coverage), but synthetic random-token spread test (≥30% in [40,70]) was insufficient baseline — random unlabeled tokens correctly classify as safe (no scam signals), not as grey-zone. Production-data labeled calibration replaces synthetic test in post-deploy 2-4 week cycle per Amendment §1.4. See memory.md Open TODOs (Bucket C labeled grey-zone replacement; 503 rate monitoring).

**Signal to revisit**: 24h+ production P95 latency exceeds 1s ADR-006 budget; 503 insufficient_data rate >5%; labeled grey-zone Bucket C calibration produces persistent ≥30% in [40,70] miss after retuning. Each independently triggers ADR-014 review.

**References**: 
- `docs/superpowers/specs/2026-05-19-iris-v2-scope-a-plan.md` (primary spec)
- `docs/superpowers/specs/2026-05-19-iris-v2-amendment-q3-3tier.md` (Amendment v2)
- `docs/superpowers/specs/2026-05-19-iris-v2-amendment-v3-external-oracle-floor.md` (Amendment v3 + errata header)
- `data/rules-v2.json` + `data/rules-v2.weights.md` (config + audit trail)
- `memory.md` Phase 1-5 entries

