# A2A Integration Plan — integrity.molt × OpenClaw
Datum: 2026-04-14  
Priorita: P0 — hlavní strategický směr

## Kontext

integrity.molt security scanner je explicitně jmenovaný jako modul v OpenClaw ekosystému
(@moltdotid Twitter post 2026-04-14). Cíl: AI agenti (.molt domain tokeny) volají naše
scan skills a platí přes x402 z jejich Asset Signer PDA walletů — bez lidského prostředníka.

Existující základ (`src/a2a/handler.js`):
- Google A2A protokol (JSON-RPC 2.0): tasks/send, tasks/get, tasks/cancel
- /.well-known/agent.json (agent card)
- 6 skills: quick_scan, token_audit, agent_token_scan, wallet_profile, deep_audit, adversarial_sim
- x402-payment header passthrough
- In-memory task store (1h TTL)

---

## PHASE 1 — Persistent task store + SSE streaming
**Backend agent | ~1 den**

### Problém
Tasks jsou in-memory — při restartu serveru všechny zmizí. OpenClaw agenti, kteří
čekají na výsledek `deep_audit` (2+ min), ztratí task ID a nemohou získat výsledek.
Polling (tasks/get) je neefektivní pro long-running scans.

### Co implementovat

**1a. SQLite task store** (`src/a2a/task-store.js`)
- Persistovat tasks do SQLite (tabulka `a2a_tasks`)
- Schema: id, skill_id, params_json, status_json, artifacts_json, history_json, created_at, expires_at
- TTL cleanup job (1h, cron každých 10 min)
- API: `createTask()`, `getTask()`, `updateTask()`, `listTasksBySession()`

**1b. SSE streaming** (`tasks/sendSubscribe`)
- Nový JSON-RPC method: `tasks/sendSubscribe`
- Response: `text/event-stream`
- Events: `task_created`, `task_working`, `task_completed`, `task_failed`
- Caller drží SSE connection místo pollingu
- Timeouty: 30s pro quick_scan, 150s pro token_audit, 330s pro deep_audit

**1c. Webhook callback**
- V `tasks/send` params: `callbackUrl?: string`
- Po dokončení POST výsledek na callbackUrl
- Pro OpenClaw: agent zaregistruje svůj webhook endpoint, nedělá polling

**Soubory:** `src/a2a/task-store.js` (nový), `src/a2a/handler.js` (rozšíření)

---

## PHASE 2 — Agent identity + PDA payment verifikace
**Backend agent | ~1 den**

### Problém
Aktuálně: x402-payment header se jen přeposílá na REST endpoint. Nevíme KDO platí
— jestli je to legitimní AI agent s .molt doménou nebo člověk. OpenClaw Asset Signer PDA
je program-derived account (PDA) — naše ověření musí akceptovat tx z PDA, ne jen z EOA walletů.

### Co implementovat

**2a. Agent identity header**
- Nový header: `x-agent-mint: <Metaplex Agent Token mint address>`
- `x-agent-domain: <.molt domain>`
- Logovat do a2a_tasks: kdo volal (identita agenta)
- Rate limiting per agent mint (100 req/den free, neomezeno s API klíčem)

**2b. PDA payment verifikace** (`src/payment/verify-pda.js`)
- Rozšířit `requirePayment()` middleware:
  - Pokud je sender PDA (derivovaný z programu), akceptovat pokud:
    - Program authority = Metaplex Asset Signer program ID
    - Platba je jinak validní (amount, recipient ATA, ne replay)
  - Logovat: `payment_source: 'pda' | 'wallet'`

**2c. Per-agent billing log**
- Tabulka `agent_billing`: agent_mint, skill_id, amount_usdc, timestamp
- Základ pro budoucí agregované reporty agentům

**Soubory:** `src/payment/verify-pda.js` (nový), `src/a2a/handler.js`, `src/middleware/payment.js`

---

## PHASE 3 — AutoPilot: Auto-sign AI agent transactions
**Backend agent | ~1 den**
**Status: Metaplex Agent Registry registrace je HOTOVA (2026-04-14)**

### Kontext
Agent je zaregistrován v Metaplex Agent Registry. Teď je potřeba zapnout
AutoPilot — mechanismus, kdy AI agent autonomně podepisuje transakce (platby,
token operace) bez lidského schválení, ale v rámci předem definovaných pravidel.

### Co implementovat

**3a. Co-signing rules config** (`config/autopilot.js`)
- Pravidla pro auto-sign:
  - Max USDC per transakci (např. 5 USDC)
  - Max USDC per den celkově
  - Whitelist skill IDs které mohou být auto-signed
  - Blacklist příjemců (hardcoded bezpečnostní seznam)
- Config načítán z `.env`: `AUTOPILOT_MAX_TX_USDC`, `AUTOPILOT_MAX_DAILY_USDC`

**3b. AutoPilot middleware** (`src/a2a/autopilot.js`)
- `canAutoSign(agentMint, tx)` — ověří zda tx splňuje pravidla
- Logování každého auto-sign rozhodnutí (audit trail)
- Daily spending tracker per agent mint (SQLite: `autopilot_spending`)
- Odmítne pokud: překročen limit, příjemce na blacklistu, neznámý skill

**3c. Asset Signer PDA integrace**
- Identifikovat Asset Signer PDA pro každý agent mint
- `deriveAssetSignerPDA(agentMint)` — derivace PDA adresy
- Při x402 payment verifikaci: pokud sender = Asset Signer PDA → projde autopilot kontrolou
- Podpis transakce přes Metaplex Asset Signer program (ne přímý keypair)

**3d. AutoPilot status endpoint** (`GET /api/v1/autopilot/status`)
- Vrátí: `{ enabled, daily_spent_usdc, daily_limit_usdc, pending_txs, rules }`
- Pouze pro autorizované agenty (x-agent-mint header + ověření)

**Soubory:** `config/autopilot.js` (nový), `src/a2a/autopilot.js` (nový), `src/payment/verify-pda.js` (nový)

---

## PHASE 4 — Multi-hop A2A (náš agent volá jiné agenty)
**Backend agent | ~1 den**

### Kontext
OpenClaw umožňuje agentům "mluvit" s jinými agenty. Náš scanner může:
- Volat price oracle agent pro real-time ceny (místo jen on-chain dat)
- Volat social scoring agent pro Twitter/X sentiment tokenu
- Volat DAO governance agent pro proposal kontext

### Co implementovat

**4a. Outbound A2A client** (`src/a2a/client.js`)
- `callAgent(agentCardUrl, skill, address, options)` 
- Načte agent card, najde skill, zavolá tasks/send, polluje tasks/get nebo drží SSE
- Timeout + fallback (pokud externí agent nedostupný, scan pokračuje bez dat)
- Platí z naší fee walletky (malé množství USDC pro outbound calls)

**4b. Integrace do scan pipeline**
- `token_audit` volá price oracle agent pro aktuální MC/volume
- `agent_token_scan` volá social scoring pokud dostupný
- Výsledky zahrnuty v `enrichment.external_agents[]` sekci response

**4c. Agent discovery cache**
- Cache agent cards (Redis nebo SQLite, TTL 1h) — nevolat /.well-known/ na každý scan

**Soubory:** `src/a2a/client.js` (nový), `src/enrichment/index.js` (rozšíření)

---

## Pořadí implementace

```
Phase 1 (task persistence + SSE)   ← ZAČÍNÁME TADY
    ↓
Phase 2 (agent identity + PDA pay) ← závisí na Phase 1
    ↓
Phase 3 (registry registration)    ← závisí na Phase 2
    ↓
Phase 4 (multi-hop)                ← závisí na Phase 1 + 3
```

## Kritické závislosti / bloky

| Blok | Popis | Řešení |
|------|-------|--------|
| Metaplex Agent Registry API | Endpoint pro registration nemusí být ještě veřejný | Připravit script, spustit až bude dostupné |
| Asset Signer PDA program ID | Potřebujeme oficiální program ID od Metaplex | Doplnit až bude v docs |
| OpenClaw module API | Jak se modul registruje do OpenClaw | Sledovat @moltdotid pro dokumentaci |

## Metriky úspěchu

- [ ] AI agent může zavolat `tasks/sendSubscribe`, dostat SSE stream, task přežije restart serveru
- [ ] Payment z PDA walletu je správně ověřen (ne odmítnut jako neznámý sender)
- [ ] Agent card je v Metaplex Agent Registry
- [ ] OpenClaw může náš scanner modul discovernout automaticky
- [ ] Multi-hop: token_audit vrací external_agents data pokud dostupná

---

Začínáme: **Phase 1 — task-store.js + SSE streaming**
