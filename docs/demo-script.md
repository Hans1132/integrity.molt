# Demo Script — integrity.molt A2A Security Oracle

3 minuty. Live terminal. Žádné slides.

---

## 0:00–0:10 — Problém (10 s)

> "Agents and small Solana protocols can call tools, move funds, and accept counterparties — but most security scans today are human-facing PDFs or dashboards. They're not composable. An agent can't forward a PDF, chain it into a decision, or verify that it came from a trusted oracle."

---

## 0:10–0:30 — Co je integrity.molt (20 s)

> "integrity.molt is a Solana-first A2A security oracle. It issues Ed25519-signed risk receipts that any agent can verify offline — without calling home. The oracle is discoverable via agent-card, payable per-call via x402, and returns structured JSON, not HTML."

---

## 0:30–1:30 — Live demo: scan + verify (60 s)

```bash
# Step 1 — agent asks for a risk score
curl https://intmolt.org/scan/v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  | tee /tmp/receipt.json \
  | jq '{address, iris_score, risk_level, signature: .signature[0:20]}'
```

**Čekaný výstup:**
```json
{
  "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "iris_score": 94,
  "risk_level": "low",
  "signature": "abc123..."
}
```

> "Free, no account, signed. Now the agent wants to verify it's genuinely from this oracle — not a forged receipt injected by a man-in-the-middle."

```bash
# Step 2 — server-side verify with key pinning
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d "{\"envelope\": $(cat /tmp/receipt.json)}" \
  | jq '{valid, key_pinned, reason}'
```

**Čekaný výstup:**
```json
{
  "valid": true,
  "key_pinned": true,
  "reason": "signature_valid"
}
```

> "`key_pinned: true` means this signature came from integrity.molt's own key — not just 'some Ed25519 key'. A foreign-signed envelope returns `key_not_pinned`, so the agent knows."

---

## 1:30–2:15 — Governance monitor (45 s)

```bash
# Step 3 — paid attestation: did this program's governance change?
curl -X POST https://intmolt.org/monitor/v1/governance-change \
  -H "Content-Type: application/json" \
  -H "X-Payment: <x402-envelope-0.15-USDC>" \
  -d '{"program_id": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf"}' \
  | jq '{verdict, findings_count: (.findings | length), signature: .signature[0:20]}'
```

**Čekaný výstup:**
```json
{
  "verdict": "clean",
  "findings_count": 0,
  "signature": "xyz987..."
}
```

> "0.15 USDC, no account, signed verdict. An agent pre-trade can call this and keep the receipt as proof it checked. The receipt is portable — the agent can hand it to an auditor, a smart contract, or another agent."

---

## 2:15–2:35 — Agent-card discovery (20 s)

```bash
# Step 4 — how does an agent discover this oracle?
curl https://intmolt.org/.well-known/agent-card.json \
  | jq '{name, version, skills: [.skills[].id], pricing_tiers: .pricing_tiers | keys}'
```

**Čekaný výstup:**
```json
{
  "name": "integrity.molt",
  "version": "0.5.0",
  "skills": ["verify_receipt", "scan_address", "governance_change", "new_spl_feed"],
  "pricing_tiers": ["discovery", "attestation", "forensic"]
}
```

> "Standard A2A discovery. Any agent registry or ElizaOS plugin can auto-discover the skills, endpoints, and pricing without reading docs."

---

## 2:35–3:00 — Proč je to wedge (25 s)

> "This isn't a broad security platform. It's a narrow wedge:
>
> - **Portable receipts** — composable, not just readable
> - **A2A consumption** — agents call it, not humans
> - **Solana-first** — where agents already move real money
> - **Sub-$10M TVL protocols** — too small for a full audit firm, too risky without any check
>
> The verify endpoint is free. The governance endpoint costs 15 cents. The whole oracle surface fits in a 30-minute integration."

---

## Backup commands (pro Q&A)

```bash
# JWKS — offline key pinning
curl https://intmolt.org/.well-known/jwks.json

# New SPL token feed (last hour)
curl "https://intmolt.org/feed/v1/new-spl-tokens?since=$(date -u -d '1 hour ago' +%FT%TZ)"

# Offline verify (Python, no HTTP)
python3 - <<'EOF'
import json, base64, nacl.signing
receipt = json.load(open('/tmp/receipt.json'))
vk = nacl.signing.VerifyKey(base64.b64decode(receipt['verify_key']))
payload = {k: v for k, v in receipt.items()
           if k not in {'signature','verify_key','key_id','signed_at','signer','algorithm','report'}}
canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
vk.verify(canonical.encode(), base64.b64decode(receipt['signature']))
print("✓ Offline verify: VALID")
EOF
```
