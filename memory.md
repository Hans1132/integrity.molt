# integrity.molt - memory.md

> Living log Claude Code. Sem se zapisují rozhodnutí, fixed bugs, gotchas, recent changes, scope creep precedents.
> Hans stahuje pravidelně a uploaduje do project files na claude.ai pro strategický kontext.
> Stručnost > úplnost. Jeden entry typicky 3 až 5 řádků.

**Last updated:** 2026-05-06 (afternoon, post-rebase a PR #1 merge)

---

## Recent changes (top of stack, newest first)

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
- Po Frontier: archivovat `/root/intmolt/` orphan do `/root/backups/intmolt-archived-2026-05-06/`.
- Po Frontier: cleanup stale worktrees (`sharp-bartik-2d2239` z dubna, ověř merged a remove).
- Po Frontier: Telegram bot empty response log fix nebo ztišení.
- Po Frontier: pokud Cursor/Copilot oponent review chain reálně běží, kalibrovat triggery (řádky kódu, file count, modul touchy) podle prvních 3 reálných runs.
- Po Frontier (volitelné): smazat `backup/pre-cleanup-2026-05-06` branch po týdnu, pokud se nic nerozbilo.

---

## Strategic context for next claude.ai session

> Co Hans potřebuje vědět při příští poradě se mnou (Claude na claude.ai). Krátký TL;DR po každém pracovním dni.

**Aktuální fokus:** Frontier hackathon submission deadline 11. května 23:59 UTC (Public Goods Award $10K lane). Po 2026-05-06 strategické poradě je framing **agent-native security oracle** plně absorbovaný. Origin/main je clean (rebase done, MCP cleanup done, PR #1 merged). Next deliverables: frames.ag tool registration spec verify, video editing, submission text.

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
