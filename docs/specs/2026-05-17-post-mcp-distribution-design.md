# Post-MCP Distribution Strategy — Design Spec

**Datum:** 2026-05-17
**Autor:** integrity.molt (Hans)
**Status:** schváleno — čeká na implementační plány
**Session:** post-mcp

---

## 1. Kontext

MCP balík `integrity-molt-mcp@0.1.0` je live na npm od 2026-05-16.
ADR-011 gate: 10 unique installs + 1 external interaction do **2026-06-15**.

Bottleneck: **distribuce** — málo lidí ví o projektu.
Řešení: dvě fáze — A (outreach, nulový nový engineering) → B (SAK plugin, po A gate).

---

## 2. Fáze A — MCP outreach + ElizaOS character snippet

**Deadline:** před ADR-011 gate (2026-06-15)
**Engineering:** minimální — jen A5 instrumentace (~2-3h backend)
**Texty a message drafty:** píše `voltagent-qa-sec:ai-writing-auditor` subagent

### Deliverables

| # | Úkol | Popis |
|---|------|-------|
| A1 | PR do `punkpeye/awesome-mcp-servers` | Security kategorie, stručný popis + npm install snippet |
| A2 | PR do dalších relevantních awesome-mcp listů | Alternativy: `appcypher/awesome-mcp-servers`, `TomSuzuki/awesome-claude` |
| A3 | Discord outreach | Helius, SendAI, Metaplex, Solana Tech servery — MCP config snippet + demo link |
| A4 | ElizaOS character snippet | `.json` character config s integrity-molt MCP, post do ElizaOS `#plugins` Discord |
| A5 | NGINX instrumentace | Logovat requesty s `User-Agent: *MCP*` nebo rozlišit MCP sessions pro ADR-011 měření |
| A6 | Anthropic showcase pitch | Email/form na MCP showcase — krátký pitch s use-case pro Solana security |

### A5 — Instrumentace (jediný backend kód)

Implementace přes NGINX access log filtr — žádná změna v kritické cestě MCP serveru:

```nginx
# /etc/nginx/sites-available/intmolt
map $http_user_agent $is_mcp {
    ~*MCP  1;
    default 0;
}
# logovat do separátního souboru pro ADR-011 měření
access_log /var/log/nginx/mcp-sessions.log combined if=$is_mcp;
```

Alternativa B: přidat volitelný `X-MCP-Session` header do `mcp/lib/client.js` a logovat v Express middlewaru — jen pokud NGINX log nestačí.

### A4 — ElizaOS character snippet (není plugin)

Toto **není** ElizaOS plugin — je to příklad `.json` character configu, který ukazuje jak použít `integrity-molt-mcp` z existujícího ElizaOS projektu. Maximální leverage, nulový nový balík.

```json
{
  "name": "SecurityOracle",
  "mcpServers": {
    "integrity-molt": {
      "command": "npx",
      "args": ["-y", "integrity-molt-mcp"]
    }
  }
}
```

### Princip Fáze A

Žádná nová integrace. Aktivace toho, co je hotové. ElizaOS character snippet ≠ ElizaOS plugin — jde o 30minutovou práci, ne 2-denní projekt.

---

## 3. Fáze B — SAK plugin (po Fázi A)

**Předpoklady:** Fáze A proběhla, MCP gate má alespoň 2-3 týdny dat.
**Základ:** Existující spec `docs/specs/2026-05-08-solana-agent-kit-integration-design.md`
**Scope:** Pouze Subsystém A (npm balík) — Subsystémy B (backend endpointy) a C (frontend portal) jsou v2.

### Deliverables

| Deliverable | Detail |
|-------------|--------|
| `integrity-molt-sak/` TypeScript balík | 5 akcí (viz níže) |
| HTTP helper `callIntmolt()` | Volá `/scan/v1/:address` a `/a2a` — bez x402 signing |
| Unit testy (mocked HTTP) | CI-safe, žádný live API key |
| PR do `sendaifun/solana-agent-kit` | `plugins/integrity-molt/` se README sekcí |
| npm publish `@integrity-molt/plugin-sak` | Až po PR review/merge |

### Akce v1

| Action | Endpoint | Cena |
|--------|----------|------|
| `INTMOLT_QUICK_SCAN` | `GET /scan/v1/:address` | zdarma |
| `INTMOLT_TOKEN_AUDIT` | `POST /scan/token` (x402 placeholder v1) | v1: zdarma |
| `INTMOLT_AGENT_TOKEN_SCAN` | `POST /api/v1/scan/agent-token` | v1: zdarma |
| `INTMOLT_WALLET_PROFILE` | `POST /scan/wallet` (x402 placeholder v1) | v1: zdarma |
| `INTMOLT_PROGRAM_VERIFY` | `POST /a2a` (tasks/send, skill=program_verification_status) | zdarma |

### Co v B není (v1 scope guard)

- x402 payment signing v pluginu
- Developer API key portál
- Frontend usage stránka
- ElizaOS plugin (oddělená větev, případně B2)

### Success kritérium B

PR mergenutý do `sendaifun/solana-agent-kit` + package na npm + ≥1 veřejný SAK agent použije integrity-molt scan do 30 dní od merge.

### Poznámka k sendai riziku

Frames.ag (sendai ekosystém) odmítl 2026-05-13 (ADR-010). SAK je jiný tým, jiný repo (SDK vs. hosting). Data point si pamatujeme, ale neblokuje PR pokus.

---

## 4. Timeline

```
2026-05-17  Design schválen
2026-05-17  Fáze A: implementační plán
2026-05-17  Fáze A spuštěna (outreach, instrumentace)
2026-06-01  Mid-check: kolik MCP installs/sessions
2026-06-15  ADR-011 gate (10 installs + 1 external interaction)
2026-06-16  Vyhodnocení → Fáze B implementační plán
2026-07-01  Fáze B: SAK PR otevřen
```

---

## 5. Architekturální principy

- **Fáze A ≠ nová integrace.** Aktivace existujícího kanálu (MCP), ne budování nového.
- **ElizaOS character snippet ≠ ElizaOS plugin.** Minimální práce, maximální reach.
- **Paid skills zůstávají A2A-only** (ADR-009, ADR-011). MCP i SAK plugin v1 = free tier.
- **ADR-011 gate platí.** Nespouštět Fázi B paralelně s Fází A — signál by byl smíchán.
