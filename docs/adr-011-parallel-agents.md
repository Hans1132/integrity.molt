# ADR-011: Paralelní agenti — Hybrid Model

**Datum:** 2026-05-07
**Status:** Accepted
**Nahrazuje:** CLAUDE.md sekce 9 ("Sekvenční práce, žádné git worktrees")

## Kontext

Sekvenční model byl zaveden po scope creep incidentu (2026-05-05), kdy agent implementoval 1300+ řádků bez schválení. Je bezpečný, ale zbytečně pomalý pro agenty bez file overlap — zejména `frontend` (separátní repo) a `qa` (jen `tests/**`).

## Rozhodnutí: Hybrid model (Fast path + Matrix path)

### Fast path — vždy povoleno bez ověření

| Agent | Důvod |
|-------|-------|
| `frontend` | Separátní repo `/root/integrity-molt-web/`, nulový overlap |
| `qa` | Vlastní pouze `tests/**` |
| `conductor` | Vlastní pouze `CLAUDE.md`, `docs/`, `.claude/agents/` |

### Matrix path — file ownership check

**Povolené páry (nulový file overlap):**
- `monitor` + `llm-economist`
- `monitor` + `security`
- `llm-economist` + `security`
- `backend` + `monitor` (podmíněně: ověřit, že backend nezasahuje monitor routes v server.js)
- `backend` + `llm-economist` (podmíněně: ověřit, že backend nezasahuje LLM call sites)

**Zakázané páry (nikdy):**
- `db` + cokoliv — live SQLite WAL sdílená přes worktrees, schema migration risk
- `backend` + `security` — Ed25519 integrovaný v server.js, merge conflict + security risk
- `backend` + `db` — schema changes mění patterns v server.js

### Worktree lifecycle

```bash
# Conductor vytvoří worktree
git worktree add /root/worktrees/[agent]-[task] -b [agent]/[task-slug]

# Agent pracuje ve svém worktree
cd /root/worktrees/[agent]-[task]

# Guardian reviewuje každý worktree zvlášť před mergem
git -C /root/worktrees/[agent]-[task] diff main

# Conductor merguje sekvenčně po PASS, pak cleanup
git worktree remove /root/worktrees/[agent]-[task]
git branch -d [agent]/[task-slug]
```

### Guardian flow

1. Conductor oznámí dokončení paralelních agentů
2. Guardian reviewuje KAŽDÝ worktree zvlášť (ne najednou)
3. Verdikt per worktree: PASS / CONCERN / BLOCK
4. Navíc: cross-worktree semantic conflict check
5. Conductor merguje jen PASS worktrees, sekvenčně

### Pravidlo 24h

Worktree live max 24h. Pokud agent nedokončí: merge partial / abandon / extend — vždy s Hansovým souhlasem.

## Trade-offs

| Aspekt | Benefit | Riziko |
|--------|---------|--------|
| Rychlost | Frontend + QA paralelně s backend prací | Guardian review je stále sekvenční |
| Bezpečnost | DB agent vždy sekvenční, forbidden pairs jasné | Podmíněné páry vyžadují conductor judgement |
| Komplexita | Matrix je mechanická (file ownership z CLAUDE.md) | Worktree cleanup je manuální odpovědnost conductora |

## Implementace

- `CLAUDE.md` sekce 9: ADR-011 pravidla
- `.claude/agents/*.md`: `parallel: fast_path / matrix_path / never` frontmatter
- `/root/worktrees/`: adresář vytvořen na VPS
