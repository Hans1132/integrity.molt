# Solana Agent Kit Integration — Design Spec

**Datum:** 2026-05-08  
**Autor:** integrity.molt (Hans)  
**Status:** draft — čeká na implementační plán

---

## 1. Cíl

Zpřístupnit integrity.molt security scanning capabilities každému AI agentovi postaveném na [Solana Agent Kit (SAK)](https://github.com/sendaifun/solana-agent-kit). Primární cíl: platící zákazníci + viditelnost projektu. Sekundární: developer onboarding přes $50 free credit.

---

## 2. Scope

Tři propojené subsystémy:

| Subsystém | Repo | Co se staví |
|---|---|---|
| **A** — SAK plugin | nový `integrity-molt-sak` | TypeScript npm balík `@integrity-molt/plugin-sak` |
| **B** — Backend API | `x402-server` | DB migrace, 4 nové endpointy, credit middleware |
| **C** — Frontend portal | `integrity-molt-web` | `/api` stránka — registrace, docs, usage |

---

## 3. Subsystém A — SAK Plugin (`@integrity-molt/plugin-sak`)

### 3.1 Struktura balíku

```
integrity-molt-sak/
├── src/
│   ├── actions/
│   │   ├── quickScan.ts
│   │   ├── tokenAudit.ts
│   │   ├── agentTokenScan.ts
│   │   ├── walletProfile.ts
│   │   └── programVerification.ts
│   ├── tools/
│   │   └── index.ts          ← HTTP helper callIntmolt()
│   ├── types.ts
│   └── index.ts              ← export IntegrityMoltPlugin
├── package.json
├── tsconfig.json
└── README.md
```

### 3.2 Plugin interface

```ts
import { IntegrityMoltPlugin } from "@integrity-molt/plugin-sak";

const agent = new SolanaAgentKit(wallet, rpcUrl, {
  INTEGRITY_MOLT_API_KEY: process.env.INTEGRITY_MOLT_API_KEY, // "im_xxxx" nebo undefined
}).use(IntegrityMoltPlugin);
```

Plugin shape odpovídá SAK `Plugin` interface:

```ts
export const IntegrityMoltPlugin = {
  name: "integrity-molt",
  actions: [quickScan, tokenAudit, agentTokenScan, walletProfile, programVerification],
  methods: {},
  initialize: (agent) => {
    // bez API key: paid skills vrátí error s CTA, ne throw
  },
};
```

### 3.3 Action mapping

| Action name | Similes (výběr) | Endpoint | Metoda | Body | Cena |
|---|---|---|---|---|---|
| `INTMOLT_QUICK_SCAN` | "scan address", "check wallet", "is this safe" | `POST /scan/free` | POST | `{ address }` | zdarma |
| `INTMOLT_TOKEN_AUDIT` | "audit token", "rug check", "token risk scan" | `POST /scan/token` | POST | `{ address }` | $0.75 |
| `INTMOLT_AGENT_TOKEN_SCAN` | "scan agent token", "check AI agent mint" | `POST /api/v1/scan/agent-token` | POST | **`{ mint }`** | $0.15 |
| `INTMOLT_WALLET_PROFILE` | "profile wallet", "wallet history", "DeFi exposure" | `POST /scan/wallet` | POST | `{ address }` | $0.15 |
| `INTMOLT_PROGRAM_VERIFY` | "verify program", "is program audited", "check program source" | `POST /a2a` (JSON-RPC `tasks/send`) | POST | `skill=program_verification_status` | zdarma |

> **Pozor:** `agent_token_scan` používá `{ mint }` v body, ne `{ address }` — jinak vrátí 400.

### 3.4 HTTP helper

```ts
// src/tools/index.ts
const BASE = "https://intmolt.org";

export async function callIntmolt(
  path: string,
  body: Record<string, unknown> | null,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method: body !== null ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "integrity-molt-plugin-sak/1.0",
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`integrity.molt error ${res.status}: ${err.error ?? res.statusText}`);
  }
  return res.json();
}
```

### 3.5 Error handling

Chybějící API key pro paid skill → handler **nehodí výjimku**, vrátí:

```ts
return {
  status: "error",
  code: "MISSING_API_KEY",
  message: "Get $50 free credit at integritymolt.com/api",
};
```

Vyčerpaný kredit (HTTP 402 z backendu) → vrátí:

```ts
return {
  status: "error",
  code: "CREDIT_EXHAUSTED",
  message: "Top up your credit at integritymolt.com/api#topup",
};
```

### 3.6 Konfigurace a závislosti

`package.json` závislosti: `zod`, `solana-agent-kit` (peer).  
Žádné `@solana/web3.js` přímé závislosti v pluginu — vše jde přes HTTP na intmolt.org.

---

## 4. Subsystém B — Backend (x402-server)

### 4.1 DB migrace

```sql
-- api_keys: rozšíření pro developer onboarding
ALTER TABLE api_keys ADD COLUMN credits_usd_cents  INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE api_keys ADD COLUMN source             TEXT    NOT NULL DEFAULT 'free_trial';
ALTER TABLE api_keys ADD COLUMN email_verified     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN project_name       TEXT;
ALTER TABLE api_keys ADD COLUMN github_repo        TEXT;

-- Pending email verifikace
CREATE TABLE IF NOT EXISTS api_key_verifications (
  id          INTEGER PRIMARY KEY,
  token               TEXT    NOT NULL UNIQUE,
  email               TEXT    NOT NULL,
  key_id              INTEGER NOT NULL REFERENCES api_keys(id),
  expires_at          TEXT    NOT NULL,
  used                INTEGER NOT NULL DEFAULT 0,
  raw_key_encrypted   TEXT,   -- AES-256-GCM, smazáno po /verify (SET NULL)
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Usage log pro statistiky per-klíč
CREATE TABLE IF NOT EXISTS api_key_usage_log (
  id              INTEGER PRIMARY KEY,
  key_id          INTEGER NOT NULL REFERENCES api_keys(id),
  skill           TEXT    NOT NULL,
  address         TEXT,
  cost_usd_cents  INTEGER NOT NULL DEFAULT 0,
  ip              TEXT,
  user_agent      TEXT,
  status          TEXT    NOT NULL DEFAULT 'ok',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_log_key   ON api_key_usage_log (key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_skill ON api_key_usage_log (skill, created_at DESC);
```

Existující záznamy v `api_keys`: `credits_usd_cents = 999999` (neomezeno), `email_verified = 1`, `source = 'subscription'`.

### 4.2 Nové endpointy

#### `POST /api/developer/register`

Vytvoří pending API klíč, pošle verifikační email.

**Rate limit:** 3 req / IP / hodina + 1 klíč / email (aktivní nebo pending).

**Body:**
```json
{
  "email": "dev@example.com",
  "project_name": "MyDeFiBot",
  "github_repo": "https://github.com/user/mydefibot"
}
```

**Validace:**
- `email`: RFC 5321 format, lowercase trim
- `project_name`: 2–80 znaků, povinné
- `github_repo`: nullable, musí začínat `https://github.com/` pokud vyplněno

**Flow:**
1. Zkontroluj duplicate: `SELECT FROM api_keys WHERE email = ? AND active = 1` → pokud existuje verified klíč, vrátí `409 { error: "Email already registered" }`
2. `createApiKey({ email, tier: 'free_trial', label: project_name })` → vygeneruje `im_xxx`, uloží hash
3. Ulož `project_name`, `github_repo`, `email_verified = 0`, `credits_usd_cents = 5000`
4. Vlož do `api_key_verifications`: token = `crypto.randomBytes(32).hex()`, `expires_at = datetime('now', '+24 hours')`
5. Pošli email s odkazem `https://intmolt.org/api/developer/verify?token=XXX`
6. Vrátí `202 { message: "Verification email sent" }`

#### `GET /api/developer/verify?token=X`

Aktivuje klíč, vrátí raw klíč **jednou**.

**Flow:**
1. Načti `api_key_verifications WHERE token = ? AND used = 0 AND expires_at > datetime('now')`
2. Pokud nenalezeno → `400 { error: "Invalid or expired token" }`
3. `UPDATE api_keys SET email_verified = 1 WHERE id = key_id`
4. `UPDATE api_key_verifications SET used = 1 WHERE id = ...`
5. Načti `raw key` — **pozor:** raw klíč se nikdy neukládá, jen hash. Řešení: vygeneruj nový raw token se stejným hashem... **Ne.** Správné řešení: raw klíč se předá do verifikačního emailu jako URL parameter (`?key=im_xxx&token=XXX`), nebo se uloží dočasně (encrypted) do `api_key_verifications.encrypted_key` a smaže po /verify.
6. Vrátí `200 { key: "im_xxx...", credits: "$50.00", message: "Store this key securely — it won't be shown again" }`

> **Implementační poznámka k raw klíči:** `createApiKey()` vrací raw klíč jednou při vytvoření. Uloži ho do `api_key_verifications.raw_key_encrypted` (AES-256-GCM, klíč z `process.env.VERIFY_ENCRYPT_KEY`). Po `/verify` se dekryptuje, vrátí uživateli a `raw_key_encrypted` se smaže (SET NULL).

#### `GET /api/developer/usage`

Vrátí stav kreditu a statistiky. Vyžaduje `Authorization: Bearer im_xxx`.

**Response:**
```json
{
  "key_prefix": "im_a3f92b",
  "project_name": "MyDeFiBot",
  "github_repo": "https://github.com/user/mydefibot",
  "credits_usd_cents": 3250,
  "credits_display": "$32.50",
  "usage_count": 87,
  "skills_breakdown": {
    "quick_scan":       { "calls": 60, "cost_usd_cents": 0 },
    "token_audit":      { "calls": 18, "cost_usd_cents": 1350 },
    "agent_token_scan": { "calls": 9,  "cost_usd_cents": 135 }
  },
  "recent": [
    { "skill": "token_audit", "address": "EPjFW...", "cost_usd_cents": 75, "status": "ok", "created_at": "..." }
  ]
}
```

#### `POST /api/developer/rotate`

Odvolá starý klíč, vydá nový se stejným kreditem. Vyžaduje `Authorization: Bearer im_xxx`.

**Flow:**
1. Načti starý klíč z `req.apiKey`
2. Vygeneruj nový klíč: `createApiKey({ email, tier, label })`
3. Přepiš `credits_usd_cents`, `project_name`, `github_repo` na nový klíč
4. `revokeApiKey(old_id, email)`
5. Vrátí `{ key: "im_newxxx...", message: "..." }`

#### `GET /admin/developer-stats` (interní)

Vyžaduje `requireStatsToken`. Agregovaný přehled přes všechny developer klíče.

```json
{
  "total_keys": 34,
  "verified_keys": 28,
  "total_credits_issued_usd": 1700,
  "total_credits_spent_usd": 312,
  "top_skills": [
    { "skill": "token_audit", "calls": 412 },
    { "skill": "quick_scan",  "calls": 1820 }
  ],
  "top_repos": ["github.com/X/Y", "github.com/A/B"]
}
```

### 4.3 Credit middleware

`requirePayment` se rozšíří o větev pro API key s kreditem:

```js
function requirePayment(accepts, requiredMicroUsdc = 0) {
  return async (req, res, next) => {
    // Subscription API key — přeskočí platební bránu (stávající chování)
    if (req.apiKey && req.apiKey.source === 'subscription') {
      req.paymentVerified = true;
      return next();
    }

    // Free trial API key — odečti kredit
    if (req.apiKey && req.apiKey.source === 'free_trial') {
      const costCents = Math.ceil(requiredMicroUsdc / 10000); // microUSDC → USD cents
      if (req.apiKey.credits_usd_cents < costCents) {
        return res.status(402).json({
          error: 'Credit exhausted',
          topup_url: 'https://integritymolt.com/api#topup',
        });
      }
      db.deductCredit(req.apiKey.id, costCents);
      db.logUsage({ key_id: req.apiKey.id, skill: req.scanType, address: req.body?.address, cost_usd_cents: costCents, ip: req.headers['cf-connecting-ip'], user_agent: req.headers['user-agent'] });
      req.paymentVerified = true;
      return next();
    }

    // Původní x402 flow
    // ...
  };
}
```

Nová DB funkce `db.deductCredit(keyId, cents)` — atomická operace:
```sql
UPDATE api_keys SET credits_usd_cents = credits_usd_cents - ? WHERE id = ? AND credits_usd_cents >= ?
```
Pokud `changes === 0` → race condition, vrátit 402.

### 4.4 Bezpečnost

| Vektor | Ochrana |
|---|---|
| Bot registrace | Rate limit 3/IP/h + email verifikace |
| Kredit zneužití před verifikací | Klíč neaktivní (`email_verified = 0`) dokud neproběhne verify |
| Parallel credit drain (race condition) | Atomický `UPDATE ... WHERE credits >= cost` |
| Raw klíč leak | Ukládá se AES-256-GCM encrypted, smazán po `/verify` |
| Token guessing | 32 bytes = 256 bits entropy, SHA-256 indexed |
| Duplicate registrace | Unique constraint na `key_hash`, 409 na duplicate email |
| Admin endpoint exposure | `requireStatsToken` (stávající pattern) |

---

## 5. Subsystém C — Frontend (`integritymolt.com/api`)

### 5.1 Stránka `/api`

Next.js 14 page, shadcn/ui komponenty. Čtyři sekce:

**Hero:** "Integrate Solana security into your AI agent in 5 minutes. $50 free credit."

**Registration form:**
```
Email:         [dev@example.com         ]
Project name:  [MyDeFiBot               ]
GitHub repo:   [https://github.com/...  ]  (optional)
               [Get Free API Key →      ]
→ success: "Check your email for a verification link (valid 24h)"
```

**Verify landing** (`/api/verified` — server component, načte `?token=` z URL, volá `/api/developer/verify`):
```
Your API key (shown once):
┌─────────────────────────────────────────────────┐
│ im_a3f92b...                              [Copy] │
└─────────────────────────────────────────────────┘
⚠ Store this key securely — it won't be shown again.
$50.00 credit ready · npm install @integrity-molt/plugin-sak
```

**Docs sekce:** instalace (copy-paste), ceník skills, odkaz na GitHub plugin repo.

### 5.2 Usage dashboard (volitelné v1)

`/api/dashboard` — client component, volá `GET /api/developer/usage` s API key z localStorage. Zobrazí kredit, breakdown per skill. Může být v2.

---

## 6. Out of scope (v1)

- Stripe topup (kredit dobití) — free trial only v1
- Usage dashboard (`/api/dashboard`) — v2
- PR do officiálního SAK repa — po validaci s prvními zákazníky
- x402 wallet-based payment v SAK pluginu — API key only v1
- Více klíčů per email — jeden aktivní klíč v1

---

## 7. Testování

| Test | Typ |
|---|---|
| Plugin: každá action s mock HTTP serverem | unit (Jest/Vitest) |
| `POST /api/developer/register` — validace, duplicate, rate limit | integration |
| `/api/developer/verify` — platný token, expirovaný, použitý | integration |
| Credit deduction — atomicita (parallel requests) | integration |
| `requirePayment` — free_trial branch, subscription branch, x402 branch | unit |
| Email odeslání (nodemailer mock) | unit |

---

## 8. Deployment pořadí

1. **DB migrace** (db agent, sekvenční, záloha před migrací)
2. **Backend endpointy + credit middleware** (backend agent)
3. **Frontend `/api` stránka** (frontend agent, Vercel)
4. **SAK plugin** — npm publish `@integrity-molt/plugin-sak` (nový repo)

Subsystémy 3 a 4 mohou běžet paralelně po dokončení 1+2.
