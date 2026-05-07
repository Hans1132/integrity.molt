# CLAUDE.md - integrity.molt

Solo builder Hans (GitHub Hans1132, X @HLo18147).
Production: intmolt.org (backend). Marketing: integritymolt.com (frontend, Vercel).
A2A primary (ADR-009). Pricing $0.15-$5 USDC.

## 1. Projekt

Solana-native AI security oracle. A2A 0.4.1, 11 skills (5 free, 6 paid x402 USDC).
Tři composability axes: OtterSec verify.osec.io, Metaplex Agent Registry, open standards.
Middle market mezi free scanners (Rugcheck) a professional audits (OtterSec/Sherlock).

## 2. Stack (fixed, ADR-004)

| Vrstva      | Co                                                                |
|-------------|-------------------------------------------------------------------|
| Runtime     | Node.js / Express :3402, systemd `integrity-x402.service`         |
| Proxy       | Cloudflare -> NGINX (TLS) -> Express                              |
| Persistence | SQLite WAL, better-sqlite3, `data/intmolt.db`                     |
| Solana RPC  | Alchemy primary + public RPC fallback                             |
| Signing     | Ed25519 tweetnacl, kid `integrity-molt-primary-2026`, JWKS 8037   |
| Scan        | Gemini Flash -> GPT-4o-mini -> Sonnet/Opus (Advisor escalation)   |
| Frontend    | Next.js 14, shadcn/ui, Vercel (repo `/root/integrity-molt-web/`)  |
| Bot         | Telegram @integrity_molt_bot (`intmolt-bot.service`)              |

Neměň stack bez ADR diskuse s Hansem.

## 3. Dual-repo mapa

| Repo                           | Cesta na VPS                  | Deploy            |
|--------------------------------|-------------------------------|--------------------|
| integrity.molt (backend)       | `/root/x402-server/`          | systemd, NGINX     |
| integrity-molt-web (frontend)  | `/root/integrity-molt-web/`   | Vercel auto-deploy |

Frontend agent `cd`-uje do `/root/integrity-molt-web/` pro frontend práci.
Vercel CLI dostupná globálně (`vercel`, `vercel --prod`, `vercel env pull`).
v0.dev (předplacené) pro rapid UI prototyping v browseru.

## 4. Sharp edges

1. Client IP: `CF-Connecting-IP`. NIKDY `X-Forwarded-For` ani `req.ip`.
2. Database: `data/intmolt.db` je live. Root `intmolt.db` = stale artefakt.
3. Metaplex URL: `metaplex.com/agents/{Core_Asset_address}`, ne slug.
4. Hot path < 1s: jen Gemini Flash. Anthropic = Advisor escalation only.
5. Ed25519 kid: `integrity-molt-primary-2026`, hardcoded v JWKS.
6. SQLite WAL: simultánní writes OK, dlouhé reads blokují checkpoint.
7. `canonicalJSON()`: rekurze do polí i nested objektů. Jinak sign/verify mismatch.
8. x402 header: klienti posílají `x402-payment`, middleware čte oba.
9. `executeSkill`: REST body snake_case, handler musí matchovat.
10. YAML frontmatter: spaces po colons.

## 5. File ownership

| Agent         | Soubory                                                          | Repo     |
|---------------|------------------------------------------------------------------|----------|
| backend       | server.js, handler.js, config/, src/a2a/, src/rpc.js             | backend  |
| db            | db.js, data/*, autopilot.js, src/spl-mint-poller.js              | backend  |
| security      | src/crypto/*, src/delta/*, .env.example                          | backend  |
| qa            | tests/**                                                         | backend  |
| frontend      | app/, components/, lib/, public/, tailwind/next config            | frontend |
| frontend      | scan-view.html, public/ (jen tyto dva)                           | backend  |
| monitor       | src/monitor/*, Telegram bot, health endpoint                     | backend  |
| llm-economist | src/llm/*, data/rules-v*.json                                    | backend  |
| guardian      | ŽÁDNÉ. Read-only. Výjimka: append do memory.md.                  | oba      |
| conductor     | CLAUDE.md, docs/*, .claude/agents/*                              | backend  |

Sdílené (package.json, scripts/test-gate.sh): změny jen s explicit potvrzením.

## 6. Workflow

Plan before code (nad ~20 řádků). Stop dokud Hans neřekne "approved".
Malé kroky (jeden krok plánu na zprávu).
Pre-commit gate: `scripts/test-gate.sh` MUSÍ projít. ~187 tests + 22 adversarial.
Debug loop: dvakrát stejný neúspěšný fix = STOP, fresh chat.
Citlivé změny (Ed25519, x402, payment, schema): Hansův manuální review.

## 7. Scope creep prevence

Žádný nový surface (endpoint, npm balík, service, MCP server) bez ADR + Hansovo schválení.
Audit/review NIKDY nepřechází do implementation bez explicit "approved" na plán.
Precedent 2026-05-05: 1300 řádků MCP server po schválení auditu. Ztracený den.

## 8. Commit konvence

`fix(scope)`, `feat(scope)`, `refactor(scope)`, `test(scope)`, `docs(scope)`
Scope: a2a, payment, scan, db, auth, monitor, security, web, llm
Žádné secrets v diffu. Force-push jen `--force-with-lease`.

## 9. Paralelní agenti (ADR-011)

### Fast path (vždy povoleno, bez matrix check)

Frontend, QA, Conductor mohou běžet paralelně s kýmkoliv.
Důvod: frontend je separátní repo, qa vlastní jen tests/**, conductor needituje kód.

### Matrix path (file ownership check)

Povolené páry (nulový file overlap):
- monitor + llm-economist (src/monitor/* vs src/llm/*)
- monitor + security (src/monitor/* vs src/crypto/*)
- llm-economist + security (src/llm/* vs src/crypto/*)
- backend + monitor (PODMÍNĚNĚ: jen pokud backend task nezasahuje do monitor route registrace v server.js)
- backend + llm-economist (PODMÍNĚNĚ: jen pokud backend task nezasahuje do LLM pipeline call sites)

Podmíněné páry: conductor před spuštěním popíše scope obou tasků a ověří no-overlap.

### Zakázané páry (nikdy paralelně)

- db + cokoliv (live SQLite WAL sdílená přes worktrees, schema migration risk)
- backend + security (Ed25519 integrovaný v server.js, merge conflict + security risk)
- backend + db (schema changes mění patterns v server.js)

### Worktree lifecycle

```bash
# Conductor vytvoří worktree pro agenta
git worktree add /root/worktrees/[agent]-[task] -b [agent]/[task-slug]

# Agent pracuje ve svém worktree
cd /root/worktrees/[agent]-[task]

# Po dokončení: Guardian review KAŽDÉHO worktree zvlášť
# Conductor merguje sekvenčně po Guardian PASS

# Cleanup
git worktree remove /root/worktrees/[agent]-[task]
git branch -d [agent]/[task-slug]
```

Guardian reviewuje PŘED mergem. Sekvenční review i když práce běžela paralelně.
DB agent NIKDY v worktree. Vždy na main, vždy sekvenční.

### Pravidlo

Worktree nesmí být live déle než 24h. Pokud agent nedokončí, conductor rozhodne: merge partial, abandon, nebo extend s Hansovým souhlasem.

## 10. Memory protocol

`memory.md` v rootu repa je living log. KAŽDÝ agent po práci zapíše entry.

### Formát

```
### YYYY-MM-DD: Stručný titulek - [role]
- **Změny:** soubory, funkce, řádky
- **Důvod:** proč
- **Dopad:** downstream efekty
- **Test:** pokrývající test
- **Backup:** cesta k záloze (pokud vytvořena)
- **Gotcha:** sharp edge (pokud objevena)
```

### Pravidla

- Newest VŽDY nahoře v "Recent changes"
- Append-only. NIKDY nemazej entries.
- Max 10 řádků per entry. Stručnost > úplnost.
- Guardian: loguje CONCERN a BLOCK (ne PASS)
- Opakující se gotcha: "Povýšit do CLAUDE.md sekce 4"

### Sekce memory.md

1. Recent changes (všichni po každé práci)
2. Fixed bugs (root cause + lesson learned)
3. Scope creep precedents (guardian, conductor)
4. Decisions log (pod-ADR úroveň)
5. Gotchas (sharp edges)
6. Open TODOs (nice-to-have)
7. Strategic context (TL;DR pro příští session)

## 11. Backup protokol

### Povinné zálohy PŘED destruktivní operací

| Operace              | Příkaz                                                                      |
|----------------------|-----------------------------------------------------------------------------|
| Schema migrace       | `sqlite3 data/intmolt.db ".backup /root/backups/intmolt-pre-migration-$(date +%Y%m%d-%H%M).db"` |
| Rebase / force-push  | `git branch backup/pre-rebase-$(date +%Y%m%d)`                             |
| Bulk DELETE v DB     | `sqlite3 data/intmolt.db ".backup /root/backups/intmolt-pre-delete-$(date +%Y%m%d-%H%M).db"`    |
| server.js refactor   | `cp server.js /root/backups/server-pre-$(date +%Y%m%d-%H%M).js`            |
| .env change          | `cp .env /root/backups/env-$(date +%Y%m%d-%H%M).bak`                       |
| Scoring rubric change| `cp data/rules-v*.json /root/backups/`                                      |
| Chaos experiment     | DB snapshot + service config backup                                         |

DB zálohy přes SQLite `.backup` (konzistentní snapshot), NIKDY `cp` na WAL DB.
Zálohy starší 30 dní: vyčistit při guardian periodic auditu.
Memory.md entry s cestou k záloze je POVINNÁ.

```bash
# Quick backup příkazy
sqlite3 data/intmolt.db ".backup /root/backups/intmolt-$(date +%Y%m%d-%H%M).db"
tar czf /root/backups/x402-server-$(date +%Y%m%d-%H%M).tar.gz --exclude=node_modules --exclude=.git -C /root x402-server/
git branch backup/pre-$(date +%Y%m%d)
```
