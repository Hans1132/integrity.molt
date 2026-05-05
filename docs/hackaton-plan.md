# Hackathon plán — integrity.molt × Colosseum

> Datum: 2026-05-05
> Zaměření: Colosseum hackathon (příští ročník po Cypherpunk 2025)
> Strategie: Security oracle plugnutý do MCPay railu — ne konkurence, ale doplněk vítězné infrastruktury

---

## Kontext: proč tato strategie

Analýza 5 400+ Colosseum projektů přes Copilot API ukázala jasný vzorec:

- **4 security scanner projekty** (Pepelock, amIrug, Rug Raider, Pump Guard) — žádný nevyhrál
- **MCPay** (x402 platby pro MCP tools) — 1. místo Stablecoins, $25 000
- **CORBITS** (AI agenti platí API přes x402 + dashboard) — 2. místo Infrastructure, $20 000

Závěr: čistý "scanner" nevyhrává. Vítězi jsou projekty, které staví **protocol-level infrastrukturu** pro AI agenty. Integrity.molt má oboje — security data i x402 rail — ale dosud byl framovaný jako scanner pro lidi, ne jako oracle pro stroje.

**Přerámování:** integrity.molt = security oracle dostupný přes MCPay, AI agenti se ptají před transakcí.

---

## Co je hotovo (k 2026-05-05)

### Jádro — live na intmolt.org

| Komponenta | Stav | Soubor |
|------------|------|--------|
| `GET /scan/v1/:address` — free IRIS scan + Ed25519 podpis | ✅ live | `src/routes/a2a-oracle.js` |
| `POST /verify/v1/signed-receipt` — server-side key-pinned verifikace | ✅ live | `src/routes/a2a-oracle.js` |
| `POST /monitor/v1/governance-change` — 0.15 USDC, signed verdict | ✅ live | `src/routes/a2a-oracle.js` |
| `GET /feed/v1/new-spl-tokens` — pull feed nových SPL mintů | ✅ live | `src/routes/a2a-oracle.js` |
| x402 micropayment paywall (USDC na Solana mainnet) | ✅ live | `server.js` |
| Anti-replay ochrana (SQLite atomic INSERT) | ✅ live | `server.js` |
| API key bypass pro programatické přístupy (`Bearer im_xxx`) | ✅ live | `server.js:659-680` |
| IRIS scoring engine (4 dimenze, trénovaný na 33k scam tokenech) | ✅ live | `src/features/iris-score.js` |
| Ed25519 canonical JSON signing | ✅ live | `src/crypto/sign.js` |
| A2A discovery (`/.well-known/agent-card.json`) | ✅ live | `server.js` |
| Helius webhooks pro live monitoring | ✅ live | `src/monitor/` |
| Telegram bot (`@integrity_molt_bot`) | ✅ live | systemd: intmolt-bot.service |
| 70 unit testů zelených | ✅ pass | `scripts/test-gate.sh` |

### Nově přidáno

| Komponenta | Stav | Soubor |
|------------|------|--------|
| **MCP server** — 4 tools přes stdio pro MCPay registraci | ✅ hotovo | `mcp/server.js` |
| MCPay integrace — popis registrace a governance flow | ✅ hotovo | `mcp/` |

### MCP tools přehled

```
scan_solana_address(address)          → free, IRIS score + Ed25519 receipt
verify_signed_receipt(envelope)       → free, key-pinned verifikace
check_governance_change(program_id)   → 0.15 USDC via MCPay, signed verdict
get_new_spl_tokens(since?)            → free, nové SPL minty za posledních 24h
```

---

## Hackathon strategie

### Pozicionování

**Kategorie:** Infrastructure + Stablecoins (stejné tracky jako MCPay a CORBITS)

**One-liner pro submission:**
> Security oracle for AI agents — IRIS risk scores with Ed25519-signed receipts, available pay-per-call via MCPay on Solana.

**Differenciace od MCPay:**
- MCPay = payment infrastructure (jak platit za MCP tools)
- integrity.molt = data layer (co jsou ta data — security oracle)
- Vztah: MCPay je rail, integrity.molt je jeden z nejvýznamnějších providerů na tomto railu
- Ve submission zdůraznit: "We plug into MCPay's winning payment infrastructure as the security layer"

**Demo story pro judgy:**
```
Agent chce koupit token.
→ zavolá scan_solana_address(mint) přes MCPay
→ dostane { iris_score: 82, risk_level: "high", signature: "..." }
→ odmítne transakci
→ podepsaný receipt jde do on-chain audit logu
```

### Winner patterns — co dělají vítězové

Z gap analýzy (293 vítězů vs 5 428 projektů):

| Co vítězové mají více | Lift |
|-----------------------|------|
| `oracle` primitive | +27% |
| `natural language processing` | +23% |
| `fragmented liquidity` jako problém | +100% |

| Co vítězové vynechávají | Lift |
|--------------------------|------|
| NFT | -66% |
| Token-gating | -55% |
| Smart contract escrow | -100% |
| Tokenized rewards | -100% |

**Závěr:** integrity.molt používá `oracle` primitive (silná pozice) a vynechává vše, co vítězové ignorují. Framing jako oracle je správný.

---

## Plán do submission

### Fáze 1 — MCPay registrace (priorita #1, 1 den)

1. Vydat API klíč pro MCP server v dashboardu
   ```bash
   # V .env nastavit:
   INTEGRITY_MOLT_API_KEY=im_your_key_here
   ```
2. Zaregistrovat server na https://mcpay.tech/register
   - URL serveru: `https://intmolt.org` (nebo dedikovaná subdoména)
   - Governance tool cena: 0.15 USDC
3. Ověřit proxy URL: `https://mcpay.tech/v1/mcp/integrity-molt`
4. Otestovat end-to-end: Claude → MCPay proxy → integrity.molt scan

### Fáze 2 — Demo video (priorita #1, 2 dny)

Natočit 3minutový terminál + screen demo:

```
Scéna 1: Agent v Claude Desktop
  - Přidat integrity-molt jako MCP server
  - Zavolat scan_solana_address na podezřelý token
  - Ukázat { iris_score: 87, risk_level: "critical", risk_factors: [...] }
  - Agent odmítne "transakci"

Scéna 2: Governance check (paid)
  - Zavolat check_governance_change přes MCPay
  - Zobrazit platba 0.15 USDC proběhla (MCPay dashboard)
  - Vrácen signed verdict s findings

Scéna 3: Verify receipt
  - Vzít envelope ze scény 1
  - Zavolat verify_signed_receipt
  - { valid: true, key_pinned: true } — tamper-proof audit trail
```

### Fáze 3 — Submission text (1 den)

Upravit `docs/frontier-submission.md` o:
- MCPay integrace jako hlavní příběh
- MCP server jako důkaz implementace
- Odkaz na mcpay.tech/servers registry
- Demo video URL

### Fáze 4 — Nice-to-have (pokud zbyde čas)

Řazeno podle dopadu na judgy:

| Feature | Popis | Odhadovaná náročnost |
|---------|-------|----------------------|
| **Agent SDK wrapper** | `npm install @integrity-molt/sdk` — 3 funkce, TypeScript typy | 2 dny |
| **Transparency log** | Veřejný feed podepsaných receiptů (prokazuje provoz oracles) | 3 dny |
| **On-chain anchor** | Solana program ukládající hash receiptu (demonstrace composability) | 5 dní |
| **Claude Desktop config** | Hotový `claude_desktop_config.json` pro okamžité testování | 1 hodina |
| **MCP inspector screenshot** | Vizuální důkaz fungujících tools | 30 minut |

---

## Další kroky (konkrétní)

### Toto týden

- [ ] MCPay registrace a end-to-end test (`claude → mcpay → intmolt.org`)
- [ ] Přidat `claude_desktop_config.json` do `mcp/` pro snadný onboarding testerů
- [ ] Natočit demo video (scéna 1 je nejdůležitější — scan + odmítnutí transakce)

### Příští týden

- [ ] Upravit submission text v `docs/frontier-submission.md`
- [ ] Agent SDK (`mcp/sdk.js` nebo separátní npm balíček) — volitelné
- [ ] Aktualizovat `/.well-known/agent-card.json` o MCP server URL

### Před submission deadline

- [ ] Stress test MCP serveru (100 paralelních tool calls)
- [ ] Ověřit že governance tool funguje na mainnet programech (ne jen na testovacích adresách)
- [ ] Připravit pitch: "We are the security layer for MCPay's payment infrastructure"

---

## Technická architektura (pro submission)

```
AI Agent (Claude / ElizaOS / custom)
    │
    ▼
MCPay Proxy (mcpay.tech/v1/mcp/integrity-molt)
    │  x402 platba: 0.15 USDC (governance tool)
    │  free tools: bez platby
    ▼
integrity.molt MCP Server (mcp/server.js, stdio)
    │  INTEGRITY_MOLT_API_KEY bypass pro paid tools
    ▼
integrity.molt API (intmolt.org, Express/Node.js)
    │
    ├─ GET  /scan/v1/:address       → IRIS 0-100 + Ed25519 podpis
    ├─ POST /verify/v1/signed-receipt → key-pinned verifikace
    ├─ POST /monitor/v1/governance-change → Helius/Alchemy scan
    └─ GET  /feed/v1/new-spl-tokens → nové SPL minty (24h)
         │
         ├─ IRIS scoring (src/features/iris-score.js)
         ├─ RugCheck + SolanaTracker enrichment
         ├─ Scam DB lookup (33k+ known scams)
         └─ Ed25519 signing (PyNaCl via sign-report.py)
```

---

## Klíčové metriky pro pitch

- **33 000+** potvrzených rug pull vzorů v trénovací sadě IRIS
- **4 dimenze** IRIS scoringu (Inflows, Rights, Imbalance, Speed)
- **Ed25519** podpis každého výsledku — tamper-proof, verifiable offline
- **0.15 USDC** per governance check — pay-per-call, žádné subscription
- **4 MCP tools** — okamžitě použitelné v Claude Desktop, Cursor, libovolném MCP klientovi
- **MCPay compatible** — plugnutý do vítězné payment infrastruktury z Cypherpunk 2025

---

## Reference

- MCPay (1. místo Stablecoins, $25k): https://arena.colosseum.org/projects/explore/mcpay
- CORBITS (2. místo Infrastructure, $20k): https://arena.colosseum.org/projects/explore/corbits.dev
- MCPay registrace: https://mcpay.tech/register
- integrity.molt live API: https://intmolt.org
- MCP server: `mcp/server.js` (tento repozitář)
