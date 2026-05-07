# CLAUDE.md - integrity.molt

Solo builder Hans (GitHub Hans1132, X @HLo18147). Production na intmolt.org.
A2A primary positioning (ADR-009). Pricing $0.15-$5 USDC.

## 1. Projekt

Solana-native AI security oracle. A2A 0.4.1 surface, 11 skills (5 free, 6 paid x402 USDC).
Tři composability axes: OtterSec verify.osec.io, Metaplex Agent Registry, open standards (A2A, x402, Ed25519, JWKS).
Middle market mezi free scanners (Rugcheck) a professional audits (OtterSec/Sherlock).

## 2. Stack (fixed, ADR-004, neměnit bez ADR diskuse)

| Vrstva          | Co                                                                   |
|-----------------|----------------------------------------------------------------------|
| Runtime         | Node.js / Express :3402, systemd `integrity-x402.service`            |
| Proxy           | Cloudflare -> NGINX (TLS) -> Express                                 |
| Persistence     | SQLite WAL, better-sqlite3, `data/intmolt.db`                        |
| Solana RPC      | Alchemy primary + public RPC fallback                                |
| Signing         | Ed25519 tweetnacl, kid `integrity-molt-primary-2026`, JWKS RFC 8037  |
| Scan pipeline   | Gemini Flash (Scanner) -> GPT-4o-mini (Analyst) -> Sonnet/Opus (Advisor) |
| Frontend        | Next.js 14, shadcn/ui, Vercel, repo `integrity-molt-web`            |
| Bot             | Telegram @integrity_molt_bot, `intmolt-bot.service`                  |

## 3. Sharp edges (povinné pro všechny agenty)

1. Client IP: čti `CF-Connecting-IP`. NIKDY `X-Forwarded-For` ani `req.ip` přímo. Cloudflare proxy sedí PŘED NGINX.
2. Database: `data/intmolt.db` je live. Root `intmolt.db` je stale artefakt. Neotvírej.
3. Metaplex URL: `metaplex.com/agents/{Core_Asset_address}`, ne human-readable slug.
4. Hot path < 1s: jen Gemini Flash. Anthropic = warm/cold Advisor escalation only.
5. Ed25519 kid: `integrity-molt-primary-2026`, hardcoded v JWKS.
6. SQLite WAL: simultánní writes OK, dlouhé reads blokují checkpoint.
7. `canonicalJSON()`: musí rekurzovat do polí i nested objektů. Jinak sign/verify mismatch.
8. x402 header: klienti posílají `x402-payment`, middleware čte oba (`x-payment` i `x402-payment`).
9. `executeSkill` handler.js: REST endpoint body je snake_case, handler musí matchovat.
10. YAML frontmatter: spaces po colons, jinak Claude Code agent soubory ignoruje.

## 4. Workflow

### Plan before code
Nad ~20 řádků: plán první, kód druhý. Plán: co se mění, které soubory, trade-offs, edge cases, co se NEMĚNÍ. Stop dokud Hans neřekne "approved".

### Malé kroky
Jeden krok plánu na zprávu. Vysvětlení co a proč před code change.

### Pre-commit gate
`scripts/test-gate.sh` MUSÍ projít. Nikdy neobcházej. ~187 tests + 22 adversarial.

### Debug loop
Dvakrát stejný neúspěšný fix: STOP, fresh chat, restate problem.

### Citlivé změny (vždy Hansův manuální review)
Ed25519 signing, x402 receipts, scoring logic, payment flow, agent boundary, schema migrace.

## 5. File ownership

| Agent        | Vlastní soubory                                                          |
|--------------|--------------------------------------------------------------------------|
| backend      | server.js, handler.js, config/, src/a2a/, src/rpc.js                     |
| db           | db.js, data/*, autopilot.js, src/spl-mint-poller.js, migrace             |
| security     | src/crypto/*, src/delta/*, .env.example                                  |
| qa           | tests/**                                                                 |
| frontend     | integrity-molt-web repo, scan-view.html, public/                         |
| monitor      | src/monitor/*, Telegram bot, health endpoint, logging pipeline           |
| llm-economist| src/llm/*, data/rules-v*.json, prompt templates, LLM provider config     |
| guardian     | ŽÁDNÉ soubory. Read-only přístup ke všemu. Nikdy needituje kód.          |
| conductor    | CLAUDE.md, docs/*, .claude/agents/* (orchestrace, ne code)               |

Sdílené: package.json, scripts/test-gate.sh. Změny jen s explicit potvrzením.
Cross-boundary change: agent vyzdvihne nahlas, čeká na Hansovo potvrzení.

## 6. Scope creep prevence

ŽÁDNÝ agent nesmí vytvořit nový surface area (endpoint, npm balík, service, MCP server) bez ADR diskuse a Hansova schválení. Audit/review NIKDY nepřechází do implementation bez explicit "approved" na konkrétní plán.

Precedent 2026-05-05: colosseum-copilot vytvořil 1300+ řádků MCP serveru po schválení auditu, ne implementace. Rebase + force-push cleanup, ztracený den.

## 7. Commit konvence

Format: `fix(scope): popis`, `feat(scope): popis`, `refactor(scope)`, `test(scope)`, `docs(scope)`
Scope: a2a, payment, scan, db, auth, monitor, security, web
Žádné secrets v diffu. Force-push jen s `--force-with-lease`.

## 8. Mapa repozitáře

| Co                        | Kde                                              |
|---------------------------|--------------------------------------------------|
| Live database             | data/intmolt.db (WAL mode)                        |
| Env variables             | .env (NIKDY commitovat)                            |
| Agent soubory             | .claude/agents/*.md                                |
| Test suite                | tests/** (~187 + 22 adversarial)                   |
| Pre-commit gate           | scripts/test-gate.sh                               |
| Docs                      | docs/ (architecture, skills, payments, db, signing) |
| Frontend (separátní repo) | integrity-molt-web na Vercelu                      |

## 9. Agent orchestrace

Conductor deleguje práci specializovaným agentům. Žádný agent nespouští jiného agenta přímo.
Guardian má právo veta: pokud guardian identifikuje problém, conductor musí vyřešit před merge.
Sekvenční práce (žádné git worktrees), jeden agent v čase.
Mezi agenty: stručné handoff summary ("Co jsem udělal, co zbývá, na co pozor").

## 10. Memory protocol

`memory.md` v rootu repa je living log projektu. KAŽDÝ agent po dokončení práce zapíše entry.

### Formát entry (povinný)

```
### YYYY-MM-DD: Stručný titulek - [role agenta]
Co se stalo (1-3 řádky). Konkrétní soubory, funkce, čísla.
- **Změny:** co se změnilo (soubory, řádky, funkce)
- **Důvod:** proč (bug, feature, refactor, audit finding)
- **Dopad:** co to ovlivňuje downstream
- **Gotcha:** sharp edge objevený během práce (pokud existuje)
- **Test:** jaký test pokrývá change (pokud relevantní)
```

### Pravidla

- Newest entry VŽDY nahoře v sekci "Recent changes (top of stack, newest first)"
- Stručnost > úplnost. Entry typicky 3-5 řádků, max 10.
- NIKDY nemazej existující entries. Memory je append-only log.
- Pokud entry odhaluje gotcha, která se opakuje, poznamenej "Povýšit do CLAUDE.md sekce 3"
- Guardian: loguje CONCERN a BLOCK verdikty do memory.md (PASS neloguje)
- Conductor: loguje delegační rozhodnutí a milestone updates
- Při scope creep: entry do sekce "Scope creep precedents" s what/why/prevention

### Sekce v memory.md

1. **Recent changes** - co se stalo (každý agent po každé práci)
2. **Fixed bugs** - root cause + lesson learned (backend, db, security)
3. **Scope creep precedents** - kde agent přestoupil scope (guardian, conductor)
4. **Decisions log** - drobná rozhodnutí pod ADR level (conductor)
5. **Gotchas** - sharp edges objevené during work (všichni)
6. **Open TODOs** - nice-to-have, future ideas (všichni)
7. **Strategic context** - TL;DR pro příští session (conductor)

## 11. Backup protokol

### Povinné zálohy (PŘED destruktivní operací)

| Operace                        | Backup příkaz                                                    | Kam                                          |
|--------------------------------|------------------------------------------------------------------|----------------------------------------------|
| Schema migrace (DB agent)      | `cp data/intmolt.db /root/backups/intmolt-pre-migration-$(date +%Y%m%d-%H%M).db` | `/root/backups/`             |
| Rebase / force-push            | `git branch backup/pre-rebase-$(date +%Y%m%d)` PŘED rebase      | git branch                                   |
| Bulk DELETE v DB               | `sqlite3 data/intmolt.db ".backup /root/backups/intmolt-pre-delete-$(date +%Y%m%d-%H%M).db"` | `/root/backups/` |
| server.js refactor (> 50 řádků)| `cp server.js /root/backups/server-pre-refactor-$(date +%Y%m%d).js` | `/root/backups/`                           |
| .env change                    | `cp .env /root/backups/env-$(date +%Y%m%d-%H%M).bak`            | `/root/backups/`                             |
| Package.json dependency change | `cp package.json /root/backups/package-pre-deps-$(date +%Y%m%d).json` | `/root/backups/`                        |

### Pravidla

- `/root/backups/` adresář musí existovat. Pokud ne: `mkdir -p /root/backups/`
- Backup PŘED operací, ne po. Pořadí je kritické (stejně jako anti-replay).
- Zálohy starší 30 dní: vyčistit při periodickém auditu (guardian úkol).
- memory.md entry při každé záloze: "Backup vytvořen: [cesta], důvod: [operace]"
- Při rollbacku: memory.md entry s "Rollback z [cesta], důvod: [co se rozbilo]"
- DB záloha přes SQLite `.backup` příkaz (konzistentní snapshot), ne `cp` na WAL DB (riskantní při aktivním write).

### Quick backup příkazy

```bash
# DB snapshot (bezpečný i při aktivním provozu)
sqlite3 data/intmolt.db ".backup /root/backups/intmolt-$(date +%Y%m%d-%H%M).db"

# Celý repo stav (lightweight, jen working tree)
tar czf /root/backups/x402-server-$(date +%Y%m%d-%H%M).tar.gz --exclude=node_modules --exclude=.git -C /root x402-server/

# Git branch backup (před rebase/force-push)
git branch backup/pre-$(date +%Y%m%d)
```
