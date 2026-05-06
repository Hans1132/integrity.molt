# integrity.molt - Claude Code project rules

> Tento soubor čte Claude Code při každém startu. Drž ho stručný.
> Hluboký kontext žije v `@memory.md` a v knowledge files na claude.ai.
> Pokud něco potřebuješ vědět a není to tady ani v memory.md, **zeptej se Hanse**, neimprovizuj.

## 1. Bootstrap (povinné na začátku každé session)

1. Přečti tento soubor (CLAUDE.md)
2. Přečti `@memory.md` pro recent decisions, fixed bugs, gotchas, scope creep precedents
3. Pokud máš agent role, přečti `.claude/agents/{role}.md`
4. Pokud existuje aktivní task, přečti `tasks/active/*.md`
5. Pro architecture-level otázky jsou knowledge files na claude.ai (architecture.md, current-state.md, key-decisions.md, prompt-caching-token-efficiency.md, competitor-analysis.md, colosseum-submission.md). Pokud Hans relevantní context nepřinesl do Claude Code session, vyžádej si paste konkrétní sekce, neimprovizuj.

## 2. Ground truth (cesty, services, klíče)

| Co | Kde |
|----|-----|
| Repo | `/root/x402-server/` |
| Service (Express) | `integrity-x402.service` (systemd) |
| Service (Telegram bot) | `intmolt-bot.service` (systemd) |
| Env file | `/root/x402-server/.env` (gitignored) |
| Database | `/root/x402-server/data/intmolt.db` (SQLite WAL, 13.5 MB live, **ne** root `intmolt.db`, ten je 0 B stale artefakt) |
| Multi-agent role files | `/root/x402-server/.claude/agents/*.md` (lowercase!) |
| Active tasks | `/root/x402-server/tasks/active/` |
| Test gate | `/root/x402-server/scripts/test-gate.sh` |
| Web frontend | **separátní repo** `integrity-molt-web` (NE tady) |
| Backup branch po cleanup | `backup/pre-cleanup-2026-05-06` (smazat po týdnu, pokud nic nerozbito) |
| Physical archive | `/root/backups/mcp-scope-creep-2026-05-06/` (MCP server pro budoucí referenci) |

App běží na portu 3402 za NGINX (TLS termination) za Cloudflare proxy.

## 3. Bezpečnost (POVINNÉ)

1. NIKDY secrets, API klíče, privátní klíče v kódu nebo gitu.
2. Secrets POUZE v `/root/x402-server/.env` (gitignored). Backup v password manageru.
3. Před commitem POVINNĚ:
   ```bash
   grep -rn "PRIVATE\|SECRET\|sk_\|api_key" --include="*.js" src/ | grep -v node_modules
   ```
4. SOL: 1 SOL = 1_000_000_000 lamports.
5. USDC (Solana): 6 decimals, 1 USDC = 1_000_000 micro-units.
6. NIKDY nemíchej lamports a USDC do jedné proměnné. Explicit typed naming.
7. SPL token destination = ATA (Associated Token Account), NE wallet adresa.
8. Anti-replay: každý `tx_sig` použitelný jen jednou. Insert do `x402_used_signatures` BEFORE issue receipt, fail-on-duplicate.

## 4. Sharp edges (kde modely halucinují nejvíc)

1. **Cloudflare proxy** sedí PŘED NGINX. Real client IP = `CF-Connecting-IP`, NE `X-Forwarded-For`. Express middleware to musí číst správně, jinak rate limiting a logging vidí Cloudflare edge.
2. **Metaplex canonical URL** = `metaplex.com/agents/{Core_Asset_address}`, NE human-readable slug. V receipt envelope: pole `issuer_metaplex_asset` a `issuer_metaplex_url`.
3. **JWKS kid** = `integrity-molt-primary-2026` (hardcoded, koresponduje s Ed25519 keypair).
4. **Ed25519 přes tweetnacl** s key pinningem a canonical JSON. Žádný libsodium swap bez explicitního ADR.
5. **YAML frontmatter** v `.claude/agents/*.md` vyžaduje **spaces po colons**, jinak Claude Code soubory ignoruje.
6. **Hot path scan pipeline** (latency budget < 1s) NEpoužívá Anthropic. Jen Gemini Flash. Anthropic Sonnet/Opus jsou warm/cold path Advisor escalation.
7. **Prompt cache invalidation:** statický prefix (tools, system, scoring rubric) PŘED dynamic context. Verzuj rubric jako `data/rules-v{N}.json`. Změna i jednoho znaku v prefixu = nová cache write, drahé.
8. **SQLite WAL:** simultánní writes z více procesů jsou OK, ale dlouhé read transactions blokují checkpoint. Krátké queries v hot pathu, dlouhé analytics offline.
9. **Database path:** `data/intmolt.db` (live, 13.5 MB), NE `intmolt.db` v root (0 B stale). VPS recon 2026-05-06 ukázal 4 prázdné `.db` artefakty z migrací, ignoruj je.
10. **Filename case sensitivity:** Linux je case-sensitive. `Backend.md` je jiný soubor než `backend.md`. Agent loader hledá lowercase, takže VŠECHNY agent files musí být lowercase.
11. **Force-push použij `--force-with-lease`, ne plain `--force`.** Lease verzi rejectne push, pokud někdo mezi tím pushnul nový commit. Solo-builder rozdíl je menší, ale držet zvykem pro budoucí kolaborace.

## 5. A2A surface (11 skills, fixed po ADR-009)

**Free (5):** `quick_scan`, `scan_address`, `new_spl_feed`, `verify_receipt`, `program_verification_status`.

**Paid přes x402 USDC (6):** `agent_token_scan` ($0.15), `governance_change` ($0.15), `token_audit` ($0.75), `wallet_profile` ($0.75), `adversarial_sim` ($4.00), `deep_audit` ($5.00).

Discovery dokumenty: `agent.json`, `agent-card.json`, `/agent.json`, `x402.json`, `jwks.json`, `/skill.md` (frames.ag spec), `/offer` (frames.ag registry).

**Test suite po cleanup 2026-05-06: ~187 passing tests** (113 baseline + 74 z PR #1 merge: iris-score, free-quota, pricing-consistency, report-validator, a2a/task-store) **plus 22 adversarial scenarios**.

**Frames.ag distribuce (ADR-010)** přidává: `intmolt.org/skill.md` ve formátu, který frames.ag vyžaduje (viz https://frames.ag/skill.md jako template), plus `/offer` endpoint pokud frames.ag spec ho mandate-uje. Tyto dva endpointy jsou legitimní rozšíření discovery vrstvy, **NE nový surface**.

**Přidat nový skill** = ADR diskuse s Hansem, ne self-service. **Přidat nový surface** (MCP, gRPC, GraphQL, REST mirror) = ZAKÁZÁNO bez ADR (precedent: 2026-05-06 MCP scope creep, viz memory.md sekce Scope creep precedents, RESOLVED přes rebase + force-push).

## 6. File ownership

| Agent | SCOPE (smí měnit) |
|-------|-------------------|
| backend | `src/middleware/*`, `src/payment/*`, `src/routes/api*`, `src/a2a/*`, `server.js`, `config/*` |
| web | **NIC tady** (web žije v separátním repu `integrity-molt-web`) |
| monitor | `src/monitor/*`, `src/watchlist/*`, `src/delta/*`, `src/notifications/*` |
| tester | `tests/*`, `scripts/test-*.sh` |
| conductor | `tasks/*`, `.claude/agents/*.md`, `CLAUDE.md` (jen metadata, ne kód), `memory.md` |

**Sdílené** (změna vyžaduje test-gate plus opt-in od Hanse): `package.json`, `.env.example`.

**Cross-boundary změna:** vyzdvihnout nahlas, počkat na potvrzení od Hanse. Neexpanduj scope sám. Včerejší MCP scope creep (2026-05-06) ukázal, kde tohle pravidlo selhalo.

## 7. Workflow loop

Šestikrokový cyklus na netriviální changes:

```
Context -> Plan -> Code -> Review -> Test -> Iterate -> Commit
```

**Phase split podle modelu:**

| Fáze | Model | Co dělá |
|------|-------|---------|
| Context, Plan | Advisor (Opus 4.7 doporučený, **strict no code edits**) | Načte knowledge files, navrhne plán, identifikuje trade-offs a edge cases |
| Code, Review, Test, Iterate, Commit | Implementation (Sonnet 4.6 default) | Implementuje plán krok po kroku |

**Advisor mode = strict no-code-edits.** Pokud Advisor agent (např. colosseum-copilot, conductor) začne sám editovat soubory bez explicit Hansova schválení Plan -> Code přechodu, je to **scope creep precedent z 2026-05-06**. Stop, eskaluj Hansovi.

Plán první, kód druhý. Kód až po explicitním "approved" od Hanse.

**Strategická porada s Hansem na claude.ai PŘEDCHÁZÍ tento loop** pro větší změny. Z claude.ai přijde direction (co a proč), Claude Code Advisor pak rozpracuje file-level plan.

**Single-prompt consolidation:** implementační instrukce vždy v jednom self-contained bloku, ne rozdrobeně.

**Stop pravidlo:** dva po sobě jdoucí failed fixy na stejný problém = fresh chat, restate problem with narrower context. Long chats drift.

## 8. Externí review chain (gating podle change size)

| Velikost | Trigger | Required gates |
|----------|---------|----------------|
| **Trivial** | 1 soubor, < 20 řádků, žádné secrets/payment/signing/scoring | Claude Code + `test-gate.sh` |
| **Medium** | Více souborů, 20 až 100 řádků, NEBO scan logic, monitor, telegram | Trivial gates + Cursor/Copilot oponent review s read access do repa, otevírá GitHub Issue s findings |
| **Large/Risky** | 100+ řádků, NEBO Ed25519/x402/scoring rubric/payment flow/DB schema, NEBO surface change (nový endpoint, agent.json edit), NEBO Hans označí "risky" | Medium gates + DataGrip AI DB check (indexy, query plány, migration safety) + v0 sanity (jen pokud UI affected, web repo) + Playwright MCP E2E + QA checklist |

**QA checklist kategorie (PASS / WARN / BLOCK per kategorii):**
- **Functional**: dělá to, co má, podle plánu
- **Security**: žádný leak, anti-replay drží, validation
- **Performance**: latency budget, žádné regrese, prompt cache nerozbitý
- **Compatibility**: existing skills funkční, signed receipts backward-compatible, API contract dodržený
- **Documentation**: `memory.md` updated, `agent-card.json`/`x402.json` synced pokud relevant

`BLOCK` v jakékoliv kategorii = nemerguj, dokud není resolved. `WARN` = log do `memory.md`, merguj jen po Hansově explicit go.

**Branch flow:** Claude Code commitne do feature branch `feat/{name}` nebo `fix/{name}`. Merge do `main` až po splnění příslušné gate chain.

## 9. Commit konvence

- Anglicky, conventional commits: `feat|fix|refactor|test|docs|chore(scope): message`.
- Scope = agent role nebo modul: `feat(payment): add ATA verification`.
- Single-purpose commits, NE "fix everything".
- Pokud test-gate FAIL: NECOMMITUJ, zapiš důvod do task souboru, přesuň do `tasks/failed/`. Hans rozhodne další krok.
- **Push do origin pravidelně.** Více než 10 nepushnutých commitů = riziko ztráty (precedent: 2026-05-06 audit našel 23 nepushnutých commitů, vyřešeno triage + rebase + force-push).
- **Force-push jen v krajních případech** (precedent: rebase 2026-05-06 pro odstranění scope creep z historie). Vždy `--force-with-lease`, nikdy plain `--force`. Backup branch před force-pushem (`git branch backup/pre-X-YYYY-MM-DD`).

## 10. Memory.md interakce

`memory.md` je living log, který Claude Code sám aktualizuje. Patří tam:

- **Decisions** mimo formal ADR (drobnější volby, datum, krátký důvod)
- **Fixed bugs** (mini post-mortem: co bylo špatně, co je teď správně, jak rozpoznat regresi)
- **Gotchas** během implementace, které stojí za to si pamatovat
- **Scope creep precedents** (kdy agent přestoupil scope, jak se to zachytilo, prevence)
- **Open TODOs** typu nice-to-have, které nepatří do `tasks/`
- **Recent changes summary** pro příští strategickou poradu Hanse na claude.ai

NEPATŘÍ tam: secrets, plain API responses s PII, dlouhé code dumps (link na commit místo toho).

**Frequency:** po každém merged change na main. Krátký entry: 3 až 5 řádků, datum, kategorie.

**Hans workflow:** stahuje `memory.md` pravidelně a uploaduje do project files na claude.ai pro strategický kontext. Piš proto tak, aby Hans po týdenní pauze pochopil za 2 minuty, co se dělo.

## 11. Agent řád (sekvence kroků v session)

1. Přečti CLAUDE.md (tento soubor)
2. Přečti `memory.md`
3. Přečti svůj `.claude/agents/{role}.md`
4. Přečti aktivní task v `tasks/active/*.md` (pokud existuje)
5. Pracuj POUZE na souborech ve svém SCOPE
6. Po dokončení: spusť `bash scripts/test-gate.sh`
7. Pokud PASS:
   - Commit + přesuň task do `tasks/done/`
   - Append entry do `memory.md`
   - Pokud Medium+ change: otevři GitHub Issue v Cursor/Copilot s diffem k oponentnímu review PŘED mergem do main
8. Pokud FAIL: necommituj, zapiš důvod do task, přesuň do `tasks/failed/`, eskaluj Hansovi

## 12. Co NEDĚLAT bez explicit ADR diskuse s Hansem

- Změnit stack (Node -> jiný runtime, SQLite -> Postgres, Express -> Fastify, VPS -> Cloudflare Workers)
- Změnit `kid` pro Ed25519 nebo strukturu signed receipts
- Změnit pricing v `x402.json` ($0.15 až $5 USDC tier je fixed po ADR-009)
- Vytvořit nový skill (existing 11 jsou fixed, viz `architecture.md`)
- Migrovat scoring rubric mezi versions bez bumpu `rules-v{N}.json`
- Měnit cokoli v `integrity-molt-web` (separátní repo, separátní PR flow)
- Nahradit Anthropic Sonnet/Opus jiným providerem v Advisor pathu (provider diversification je úmyslná, viz ADR-006)
- **Rozšiřovat A2A surface o jiné protokoly (MCP, GraphQL, gRPC, REST mirror)** bez explicit ADR diskuse. **Precedent: 2026-05-06 MCP scope creep** (colosseum-copilot agent kódoval celý MCP server v `/root/x402-server/mcp/` po Hansově schválení auditu, ne implementace). Audit s prohledáním ekosystému je OK, code change vyžaduje separate go.
- Reaktivovat Stripe / human funnel work (deprio po ADR-009)
- Měnit knowledge files na claude.ai přímo (Hans je owner, agent je read-only consumer)
- **Force-push do main bez backup branch** (precedent: 2026-05-06 rebase byl bezpečný díky `backup/pre-cleanup-2026-05-06`)

## 13. Reference (knowledge files na claude.ai)

| Soubor | Obsah |
|--------|-------|
| `architecture.md` | Komponenty, dataflow, stack constraints |
| `current-state.md` | Co je hotové, blockery, deadliny, next 2 weeks |
| `key-decisions.md` | ADR log s důvody a re-evaluate triggery |
| `prompt-caching-token-efficiency.md` | LLM economics, cache strategy |
| `competitor-analysis.md` | Positioning, gap analysis, same-frame projekty plus adjacent validators |
| `colosseum-submission.md` | Pitch texty, messaging |
| `update-protocol.md` | Jak se refreshuje current-state.md |

Pokud Claude Code potřebuje sekci, kterou nezná, požádat Hanse o paste relevantní části. Neimprovizovat.
