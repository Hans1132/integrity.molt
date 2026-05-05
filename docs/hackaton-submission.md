# Colosseum Hackathon — Submission Text

> Přesné texty pro zkopírování do submission formuláře.
> Vychází z analýzy vítězných projektů (MCPay, CORBITS) a Copilot gap analýzy.
> Placeholder hodnoty označeny `[DOPLNIT]`.

---

## Project Name

```
integrity.molt
```

---

## One-liner

> Jedno věta zobrazená v katalogu projektů. Max ~120 znaků. Nesmí začínat "A" nebo "The".

```
Security oracle for AI agents — IRIS risk scores with Ed25519-signed receipts, pay-per-call via MCPay on Solana.
```

---

## Track(s)

Zaškrtnout **obě**:

- ✅ **Infrastructure**
- ✅ **Stablecoins**

> Důvod: MCPay vyhrál Stablecoins ($25k), CORBITS vyhrál Infrastructure ($20k). Oba projekty měly stejnou kombinaci. Integrity.molt je jejich security layer — správné tracky.

---

## Problem

> Popis problému, který projekt řeší. ~200–400 slov. Konkrétní, bez jargonu.

```
AI agents on Solana need to assess token safety and program risk before executing transactions. Today there is no machine-native security primitive for this.

Existing security tools — dashboards, PDFs, browser extensions — produce human-readable output. An agent cannot parse a rug pull report, chain a risk score into a conditional swap, or cryptographically verify that a security verdict was not tampered with in transit. When an agent needs to know whether to trust a token, it has no composable, verifiable data source to call.

The result: agents either skip security checks entirely, or rely on heuristics baked into their own prompts — with no auditability and no accountability when something goes wrong.

The problem is structural. There is no pay-per-call security oracle on Solana that returns signed, machine-verifiable JSON. There is no standard way for an agent to prove, after the fact, that it performed a security check before a transaction. And there is no existing oracle that integrates with the x402 payment standard that MCPay and CORBITS established as the infrastructure layer for agent commerce.

integrity.molt fills that gap.
```

---

## Solution

> Co projekt dělá a jak to řeší problém. ~200–400 slov. Technicky konkrétní.

```
integrity.molt is a security oracle for AI agents, accessible pay-per-call via MCPay on Solana.

Agents call four MCP tools:

- scan_solana_address(address) — free IRIS risk scan (0–100 score, low/medium/high/critical) with Ed25519-signed receipt
- check_governance_change(program_id) — 0.15 USDC via MCPay, detects authority transfers and upgrade events in Solana programs
- verify_signed_receipt(envelope) — free, server-side key-pinned verification that a receipt was issued by this oracle
- get_new_spl_tokens(since) — free feed of new SPL mints in the last 24 hours

Every oracle response is signed with Ed25519 using canonical JSON (sorted keys, deterministic serialization). Signed receipts are flat JSON envelopes — passable between agents without re-signing, verifiable offline against the published JWKS, and composable as on-chain audit trail entries.

The IRIS scoring engine (Inflows + Rights + Imbalance + Speed) was calibrated against 33,000+ confirmed rug pull patterns from the SolRPDS dataset. It runs in under 200ms for cached addresses.

Payment works via MCPay: agents call the tool through the MCPay proxy, MCPay handles x402 payment routing, and integrity.molt receives the call with a pre-issued API key. No custom wallet integration needed on the agent side — MCPay's existing infrastructure handles it.

The oracle is also directly A2A-discoverable via /.well-known/agent-card.json for frameworks that use the Google A2A protocol.

Demo flow: agent wants to buy a token → calls scan_solana_address → receives {iris_score: 82, risk_level: "high", signature: "..."} → refuses the transaction → signed receipt becomes the audit log entry.
```

---

## What makes it different

> Technical differentiators. ~150–250 slov.

```
1. Key-pinned verification — valid:true requires matching the oracle's own JWKS key, not just Ed25519 math. Prevents forged-receipt injection attacks where a malicious agent substitutes a favorable verdict.

2. Canonical JSON signing — sorted-key deterministic serialization on both sign and verify sides. Receipts are byte-identical regardless of consumer language (Go, Python, TypeScript, Rust).

3. MCPay-native integration — integrity.molt plugs into the payment infrastructure established by Cypherpunk's winning projects. We are the security data layer; MCPay is the payment rail. Composable by design, not by accident.

4. Anti-replay protection — each x402 payment transaction signature is recorded atomically in SQLite before the scan runs. The same tx_sig cannot pay twice.

5. 33,000+ rug pull training patterns — IRIS scoring is calibrated against the SolRPDS dataset (Alhaidari et al. 2025, arXiv:2504.07132), the largest publicly available confirmed rug pull dataset for Solana.
```

---

## GitHub

```
[DOPLNIT — URL veřejného GitHub repozitáře]
```

> Pokud repo není veřejné, zpřístupnit alespoň `mcp/server.js` a `src/routes/a2a-oracle.js` jako ukázku implementace. Judgy vždy zkontrolují GitHub.

---

## Demo (Live URL)

```
https://intmolt.org
```

> Záložní quickstart příkaz pro judgy (vložit do submission description nebo README):
> ```
> curl https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
> ```

---

## Presentation Video (Loom)

```
[DOPLNIT — Loom URL]
```

**Co natočit (doporučená struktura, 3–5 minut):**

```
0:00 – 0:30  Problem setup
  "Agents on Solana have no way to verify token safety before transacting."

0:30 – 1:30  Live demo — Claude Desktop + MCP tool
  - Přidat integrity-molt MCP server do Claude Desktop
  - Zavolat scan_solana_address na podezřelý token (iris_score > 70)
  - Ukázat signed receipt: { iris_score: 87, risk_level: "critical", signature: "..." }
  - Agent říká: "I cannot proceed — this token is high risk."

1:30 – 2:30  Paid tool — governance check přes MCPay
  - Zavolat check_governance_change na real Solana program
  - Ukázat MCPay payment flow (0.15 USDC)
  - Ukázat findings + signed verdict

2:30 – 3:00  Verify receipt
  - Vzít envelope z dema
  - Zavolat verify_signed_receipt
  - { valid: true, key_pinned: true } — tamper-proof

3:00 – 3:30  Architektura (30 sec)
  - Diagram: Agent → MCPay → integrity.molt MCP server → IRIS oracle
  - "We are the security layer for MCPay's payment infrastructure."
```

---

## Technical Demo Video (YouTube)

```
[DOPLNIT — YouTube URL]
```

**Obsah technického dema (5–8 minut, terminál):**

```
1. curl /scan/v1/<risky_token> — ukázat raw signed JSON response
2. curl /verify/v1/signed-receipt — ukázat { valid: true, key_pinned: true }
3. Ukázat MCP server: echo '{"method":"tools/list",...}' | node mcp/server.js
4. curl /monitor/v1/governance-change s X-Payment headrem
5. Ukázat anti-replay: stejný tx_sig podruhé → 402
```

---

## Twitter / X

```
[DOPLNIT — @twitter_handle projektu]
```

---

## Team

```
[DOPLNIT — jméno / GitHub handle / role]
```

> Příklad formátu (Colosseum zobrazuje jako karty):
> - Name: [jméno]
> - GitHub: [github.com/username]
> - Twitter: [@handle]
> - Role: Founder / Engineer

---

## Additional Links (volitelné, ale doporučené)

| Co | URL |
|----|-----|
| Live API | `https://intmolt.org` |
| Agent card (A2A discovery) | `https://intmolt.org/.well-known/agent-card.json` |
| JWKS (verify key) | `https://intmolt.org/.well-known/jwks.json` |
| OpenAPI spec | `https://intmolt.org/openapi.json` |
| MCPay proxy (po registraci) | `https://mcpay.tech/v1/mcp/integrity-molt` |

---

## Checklist před odesláním

- [ ] GitHub repo je veřejný (nebo alespoň `mcp/` složka)
- [ ] `https://intmolt.org/scan/v1/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` vrací JSON (judgy testují live)
- [ ] Loom demo video je nahráno a link funguje bez přihlášení
- [ ] YouTube technical demo je veřejné
- [ ] MCPay registrace dokončena — proxy URL funguje
- [ ] `mcp/server.js` je v repozitáři a spustitelný (`npm install && node server.js`)
- [ ] Twitter/X handle je funkční
- [ ] Team sekce vyplněna

---

## Poznámky ke strategii

**Co nezdůrazňovat:**
- "Security scanner" — toto nevyhrává (4 projekty bez ceny)
- UI/dashboard/browser extension
- "For retail investors" — přehlcená cílová skupina (433 projektů)

**Co zdůrazňovat:**
- MCPay integrace — vítězná infrastruktura z Cypherpunk 2025
- Ed25519 signed receipts — klíčová differenciace od všech konkurentů
- oracle primitive — +27% lift u vítězů oproti průměru
- "Security layer for the AI agent economy on Solana"
- 33 000+ rug pull vzorů — credibilita datové sady

**One-liner alternativy (pokud chceš otestovat variace):**

```
# Varianta A — technická
Ed25519-signed security oracle for Solana AI agents — IRIS risk scores, pay-per-call via MCPay.

# Varianta B — jednoduchá
AI agents on Solana can now check token safety before transacting — signed receipts, 0.15 USDC via MCPay.

# Varianta C — MCPay-first
The security data layer for MCPay: signed IRIS risk scores that AI agents can verify and chain.
```
