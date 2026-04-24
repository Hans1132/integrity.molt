# Integration Plan — integrity.molt oracle

## Cíl
Dostat oracle do rukou agentů přes existující distribuční kanály.
Priorita: **SendAI plugin** (první) → **ElizaOS plugin** (fallback).

---

## SendAI Plugin

### Co přidat
Jeden action: `check_solana_address`

### Input schema
```typescript
interface CheckSolanaAddressInput {
  address: string;       // Solana base58 pubkey (32–44 chars)
  verify?: boolean;      // default true — verify receipt after scan
}
```

### Output schema
```typescript
interface CheckSolanaAddressOutput {
  address: string;
  iris_score: number;       // 0–100
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  risk_factors: string[];
  verified: boolean;        // true if server-side verify passed with key_pinned
  receipt: {
    signature: string;
    verify_key: string;
    key_id: string;
    signed_at: string;
  };
}
```

### Example call
```typescript
const result = await sendai.run('check_solana_address', {
  address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  verify: true,
});
// result.risk_level === 'low'
// result.verified === true
```

### Pricing expectation
- Free — `GET /scan/v1/:address` + `POST /verify/v1/signed-receipt` — no x402
- Plugin does not need to handle payments for the basic flow
- Governance attestation (0.15 USDC) can be a separate action in v2

### Minimum for PR
- [ ] Action file: `src/actions/check-solana-address.ts`
- [ ] Calls `GET https://intmolt.org/scan/v1/:address`
- [ ] Calls `POST https://intmolt.org/verify/v1/signed-receipt` with envelope
- [ ] Returns normalized output schema
- [ ] Unit test with mocked HTTP (no live API key required)
- [ ] README section in plugin docs

### What NOT to do in v1
- Do NOT implement x402 payment signing in the plugin (too complex, separate action later)
- Do NOT implement governance-change action (separate, paid)
- Do NOT implement offline Ed25519 verify in the plugin (server verify is sufficient)
- Do NOT add retry logic — oracle is idempotent, let the framework handle retries

---

## ElizaOS Plugin (fallback / parallel)

### What to add
Character plugin: `@integrity-molt/elizaos`

### Action
```typescript
{
  name: 'SCAN_SOLANA_ADDRESS',
  description: 'Check risk level of a Solana address using integrity.molt oracle',
  validate: async (runtime, message) => {
    return message.content.text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  },
  handler: async (runtime, message, state, options, callback) => {
    const address = /* extract from message */;
    const scan = await fetch(`https://intmolt.org/scan/v1/${address}`).then(r => r.json());
    callback({
      text: `${address}: ${scan.risk_level} (IRIS ${scan.iris_score}/100). Signed: ${!!scan.signature}`,
      content: scan,
    });
  }
}
```

### Minimum for PR
- [ ] Plugin package: `packages/plugin-integrity-molt/`
- [ ] One action: `SCAN_SOLANA_ADDRESS`
- [ ] Character example showing how to include the plugin
- [ ] Unit test (mocked fetch)

### What NOT to do in v1
- No paid actions
- No governance monitor
- No streaming / SSE
- No local signing — all calls go to `https://intmolt.org`

---

## Distribution Timeline

| Week | Action |
|---|---|
| 1 | Open SendAI plugin PR with `check_solana_address` |
| 1 | Post to ElizaOS Discord #plugins with demo link |
| 2 | If SendAI PR merged → announce on X + Solana DevRel |
| 2 | ElizaOS plugin PR (if interest confirmed) |

---

## Oracle endpoint reference for integrators

| Endpoint | Method | Auth | Price | Returns |
|---|---|---|---|---|
| `/scan/v1/:address` | GET | none | free | signed IRIS envelope |
| `/verify/v1/signed-receipt` | POST | none | free | `{valid, key_pinned, reason}` |
| `/feed/v1/new-spl-tokens` | GET | none | free | signed mint feed |
| `/monitor/v1/governance-change` | POST | x402 | 0.15 USDC | signed verdict |
| `/.well-known/agent-card.json` | GET | none | free | skills + pricing |
| `/.well-known/jwks.json` | GET | none | free | Ed25519 public key |
| `/.well-known/receipts-schema.json` | GET | none | free | envelope JSON Schema |
