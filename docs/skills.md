# A2A Skills Reference — integrity.molt

All skills are discoverable via `GET /.well-known/agent-card.json` and accessible through the A2A JSON-RPC 2.0 interface at `POST /a2a`.

## Skill Catalog

### Free Tier (5 skills)

| Skill ID | Description | Input | Output | REST Route | Caching | Cache TTL |
|----------|-------------|-------|--------|-----------|---------|-----------|
| `quick_scan` | Fast on-chain scan of a Solana address — account info, balance, basic risk assessment. IRIS-only, no LLM. | `address` (text/plain) | Risk object with IRIS score | `POST /scan/iris` | Yes | 30 min |
| `scan_address` | Oracle lookup with IRIS scoring. Returned as flat JSON envelope signed with Ed25519. | `address` (text/plain) | Signed envelope `{iris_score, risk_level, risk_factors, signature, ...}` | `GET /scan/v1/:address` | Yes | 30 min |
| `new_spl_feed` | Pull feed of newly deployed SPL token mint events. Filter by `?since=ISO8601`. Useful for agent watchlists. | None (optional `?since` param) | Array of `{mint, tx_sig, slot, block_time}` | `GET /feed/v1/new-spl-tokens` | No | N/A |
| `verify_receipt` | Server-side Ed25519 verification of a signed oracle receipt. Returns key pinning result (oracle key vs. foreign key distinguishable). | `envelope` (application/json) | Verification result `{valid, key_pinned, mathematically_valid, reason, ...}` | `POST /verify/v1/signed-receipt` | No | N/A |
| `program_verification_status` | Cross-references OtterSec verify.osec.io for Solana program bytecode attestation. Returns whether deployed code matches a verified source repository. | `program_id` (text/plain or application/json) | Object `{is_verified, on_chain_hash, executable_hash, repo_url, ...}` (signed) | None (A2A-only, internal call) | Yes | 1 hour |

### Paid Tier (6 skills, x402 USDC)

| Skill ID | Price | Description | Input | Output | REST Route | Caching | Cache TTL |
|----------|-------|-------------|-------|--------|-----------|---------|-----------|
| `agent_token_scan` | $0.15 | Metaplex Agent Token security audit. Analyzes Core NFT backing, treasury PDA, update authority risk, creator royalties, DAO governance, activity patterns. Launched 2026-04-13. | `mint` (text/plain) | Audit result `{risk_score, category, findings, [treasury_pda], [governance_structure], ...}` | `/api/v1/scan/agent-token` | Yes | 30 min |
| `governance_change` | $0.15 | Detect governance changes in a Solana program (authority_change, program_upgrade, admin_function_call). Uses Helius Enhanced Transactions API or Alchemy RPC fallback. Returns signed verdict. | `program_id` (application/json) | Governance analysis `{program_id, findings: [{type, signature, time}], verdict, signature, ...}` | `POST /monitor/v1/governance-change` | Yes | 15 min |
| `token_audit` | $0.75 | Polymorphic audit — auto-detects Metaplex registered agent (ERC-8004 registration + wallet + claim validation, signed receipt) or SPL token (liquidity, holder distribution, rug risk assessment, signed receipt). $0.75 USDC fixed price for both audit types. | `address` (text/plain) | Audit result `{risk_score, category, summary, mint_info, concentration, treasury_analysis, findings, signature, receipt, ...}` | `POST /scan/token` | Yes | 60 min |
| `wallet_profile` | $0.75 | Behavioral profiling for a wallet address. Activity age, DeFi exposure, risk classification, reputation score. | `address` (text/plain) | Profile object `{age_days, activity_score, defi_risk, classification, txn_count, ...}` | `POST /scan/wallet` | Yes | 30 min |
| `adversarial_sim` | $4.00 | Full adversarial simulation against a target program. Forks on-chain state and probes 7 attack playbooks (reentrancy, arithmetic overflow, missing validation, etc.). Returns signed risk report. | `program_id` (text/plain), optional `playbook_ids[]` | Simulation results `{program_id, playbooks_tested: [{id, name, vulnerable, evidence}], risk_level, signature, ...}` | `POST /api/v1/adversarial/simulate` | No | N/A |
| `deep_audit` | $5.00 | Comprehensive Solana program security audit. Static analysis, LLM-verified findings, architectural review, signed report. | `address` (text/plain) | Full audit envelope `{target, pipeline, findings: [{severity, title, detail, remediation}], risk_level, signature, ...}` | `POST /scan/deep` | Yes | 60 min |

## A2A JSON-RPC 2.0 Interface

All skills are invoked via the same JSON-RPC 2.0 endpoint: `POST /a2a`

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "method": "tasks/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {"type": "text", "text": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
        {"type": "data", "data": {"skill": "token_audit"}}
      ]
    },
    "metadata": {
      "skill": "token_audit",
      "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "callbackUrl": "https://agent.example.com/callback"
    },
    "sessionId": "optional-session-id"
  }
}
```

**Parameters:**
- `message` — A2A Message object with parts array (role, parts)
  - `parts[].type` — "text" | "data" | "image" | "video" (only text+data are parsed)
  - `parts[].text` — For type="text", the raw text (address, program ID, etc.)
  - `parts[].data.skill` — For type="data", the skill ID (e.g., "token_audit")
- `metadata.skill` — Explicit skill ID (takes precedence over extracted from message)
- `metadata.address` — Explicit target address (takes precedence over extracted)
- `metadata.callbackUrl` — Optional webhook URL for async results (validated, SSRF denied)
- `sessionId` — Optional string for grouping related tasks

### Response Format (Success)

**Inline result (fast skills like quick_scan):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "result": {
    "iris_score": 92,
    "risk_level": "low",
    "risk_factors": [],
    "signed_at": "2026-05-06T10:00:00.000Z",
    "signature": "base64-ed25519-signature",
    "verify_key": "base64-32-byte-pubkey",
    "key_id": "integrity-molt-primary-2026",
    "signer": "integrity.molt",
    "algorithm": "Ed25519"
  }
}
```

**Pending async result (with callbackUrl):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "result": {
    "id": "task-uuid",
    "status": "pending",
    "skill": "token_audit",
    "message": "Task submitted, result will be POSTed to callback URL"
  }
}
```

### Response Format (Error)

**Payment required (402):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "error": {
    "code": -32602,
    "message": "Payment required",
    "data": {
      "x402Version": 1,
      "accepts": [{
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "decimals": 6,
        "amount": 750000
      }],
      "price_usd": 0.75,
      "skill": "token_audit"
    }
  }
}
```

**Invalid address (400):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "error": {
    "code": -32602,
    "message": "Cannot extract Solana address from message parts"
  }
}
```

**Unknown skill (400):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "error": {
    "code": -32602,
    "message": "Unknown skill: invalid_skill_id",
    "data": {
      "available": ["quick_scan", "token_audit", "scan_address", ...]
    }
  }
}
```

## executeSkill() Dispatcher

The `src/a2a/handler.js` module implements a skill router that maps skill IDs to internal REST loopback endpoints:

```javascript
async function executeSkill(skillId, address, options = {}, paymentHeader = null)
```

### Implementation Details

**For each skill:**

1. **Route selection:** Switch on `skillId`
2. **Parameter mapping:** Convert A2A parameters to REST endpoint expectations
3. **Loopback call:** Internal `internalPost()` or `internalGet()` to localhost:3402
4. **Payment forwarding:** If `paymentHeader` present, include in Authorization or x402-payment header
5. **Response flattening:** Merge nested `.data` fields to top level for A2A compatibility
6. **Error handling:** Catch and wrap in JSON-RPC error response

**Key parameter mappings:**

| Skill | REST Endpoint | Parameter Mapping |
|-------|---------------|-------------------|
| `quick_scan` | `POST /scan/iris` | `{address}` |
| `token_audit` | `POST /scan/token` | `{address}` |
| `agent_token_scan` | `POST /api/v1/scan/agent-token` | `{mint: address}` (note: body field is "mint", not "address") |
| `wallet_profile` | `POST /scan/wallet` | `{address}` |
| `deep_audit` | `POST /scan/deep` | `{address}` |
| `adversarial_sim` | `POST /api/v1/adversarial/simulate` | `{program_id: address, playbook_ids: options.playbook_ids, skip_fork: options.skip_fork}` |
| `program_verification_status` | Direct call (no loopback) | Calls `getVerificationStatus(address)`, builds envelope inline |
| `scan_address` | `GET /scan/v1/{address}` | URL-encoded address param |
| `new_spl_feed` | `GET /feed/v1/new-spl-tokens` | No address needed |
| `verify_receipt` | `POST /verify/v1/signed-receipt` | `{envelope: options.envelope}` |
| `governance_change` | `POST /monitor/v1/governance-change` | `{program_id: address}` |

### Loopback Mechanism

The `internalPost()` and `internalGet()` functions communicate with the same server:

```javascript
async function internalPost(path, body, paymentHeader, timeoutMs = 60_000) {
  const headers = {
    'Content-Type': 'application/json',
    'X-A2A-Caller': '1'  // Marks internal call, bypasses rate limiting
  };
  if (paymentHeader) {
    if (paymentHeader.startsWith('Bearer im_') || paymentHeader.startsWith('im_')) {
      // API key → Authorization header
      headers['authorization'] = paymentHeader.startsWith('im_')
        ? `Bearer ${paymentHeader}`
        : paymentHeader;
    } else {
      // x402 payment envelope → x402-payment header
      headers['x402-payment'] = paymentHeader;
    }
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  // ... error handling and JSON parsing
}
```

**Why loopback?**
- Avoids circular requires (scan logic lives in server.js)
- All middleware (rate limits, logging, auth) runs normally
- Prevents double-signing (A2A handler only signs final envelope)
- Centralized error handling and timeouts per skill

## Caching Patterns

### Cache TTL by Skill

| Skill | Cache TTL | Rationale |
|-------|-----------|-----------|
| `quick_scan` | 30 min | Fast, IRIS-only, called frequently |
| `scan_address` | 30 min | Signed oracle envelope, address-focused |
| `program_verification_status` | 1 hour | OtterSec API calls are rate-limited |
| `token_audit` | 60 min | Medium cost, mid-tier analysis |
| `wallet_profile` | 30 min | Activity-based, wallet behavior changes often |
| `deep_audit` | 60 min | Expensive, results stable over time |
| `agent_token_scan` | 30 min | NFT-specific, metadata can change |
| `governance_change` | 15 min | Time-critical, governance events need freshness |
| `adversarial_sim` | No cache | Each run is unique (forks on-chain state) |
| `new_spl_feed` | No cache | Real-time feed of mints |
| `verify_receipt` | No cache | Verification is stateless |

### Cache Lookup Pattern

```javascript
// 1. Check cache first
const cached = getCachedScanFromDb(address, scanType, TTL_MS);
if (cached) {
  console.log(`[${scanType}] cache hit for ${address}`);
  return cached;
}

// 2. Cache miss — compute
const result = await expensiveOperation(address);

// 3. Store in cache
logScanToHistory(email, address, scanType, result);
return result;
```

**Functions:**

```javascript
getCachedScanFromDb(address, scan_type, ttl_ms)
// Queries: SELECT result_json FROM scan_history 
// WHERE address=? AND scan_type=? AND created_at > datetime('now', '-X minutes')
// Returns: parsed result_json or null

logScanToHistory(email, address, scan_type, result)
// INSERT INTO scan_history (email, address, scan_type, risk_score, risk_level, 
//   summary, cached, result_json, created_at)
// VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
```

## Authentication & Payment

### Free Skills

No authentication required. Rate-limited by IP+date (10 req/min for scans, 20 req/min for feeds).

```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [{"type": "text", "text": "EPjFWdd5..."}]},
      "metadata": {"skill": "quick_scan", "address": "EPjFWdd5..."}
    }
  }'
```

### Paid Skills (x402)

Three authentication methods:

#### 1. x402 USDC Payment (Per-Call)

```bash
# Step 1: Call without payment, get 402 response
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{...skill: "token_audit"...}'
# Response: 402 with x402 payment instructions

# Step 2: Sign USDC transfer on Solana, retry with payment envelope
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -H "x402-payment: <base64-encoded-x402-envelope>" \
  -d '{...skill: "token_audit"...}'
# Response: 200 with result + signature
```

#### 2. API Key (Subscription)

Pre-funded API keys can be used instead of per-call x402:

```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer im_xxx" \
  -d '{...skill: "token_audit"...}'
# Response: 200 with result
```

#### 3. frames.ag AgentWallet Proxy

For agents operating in the frames.ag ecosystem:

```bash
curl -X POST https://frames.ag/api/wallets/USERNAME/actions/x402/fetch \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://intmolt.org/a2a",
    "method": "POST",
    "body": {
      "jsonrpc": "2.0", "id": "1", "method": "tasks/send",
      "params": {
        "message": {"role": "user", "parts": [...]},
        "metadata": {"skill": "token_audit", "address": "..."}
      }
    }
  }'
# frames.ag proxy handles payment, forwards x402 header to integrity.molt
```

## AutoPilot Co-Signing (AI Agents)

AI agents identified by the `x-agent-mint` header are subject to spending limits:

```javascript
const agentMint = req.headers['x-agent-mint'];  // e.g., "2tWPw22bqgLdYCwe7599f7guQudwKpCCta4gvhgZZy"

if (skill.priceUSDC > 0 && agentMint) {
  const decision = await canAutoSign(agentMint, skill.priceUSDC);
  if (!decision.allowed) {
    return rpcError(rpcId, -32602, `AutoPilot spending limit exceeded for ${agentMint}`);
  }
  // Log the decision
  logAutoSignDecision(agentMint, skillId, decision);
}
```

**Spending limits (per agent, per day):**
- Maximum per-transaction: $5.00 (prevents runaway single call)
- Maximum daily: $50.00 (adjustable per agent)
- Each decision is logged to `autopilot_spending` table for audit

## Webhook Callbacks

Skills with long execution times (deep_audit, adversarial_sim) support asynchronous delivery via webhook:

```javascript
"params": {
  "message": {...},
  "metadata": {
    "skill": "deep_audit",
    "address": "...",
    "callbackUrl": "https://agent.example.com/callback"
  }
}
```

**Callback delivery:**
1. Task is stored in `a2a_tasks` table with 10-minute TTL
2. Handler returns `{id, status: "pending"}`
3. Computation runs in background
4. When complete, POST result to callbackUrl:
   ```bash
   POST https://agent.example.com/callback
   Content-Type: application/json
   X-A2A-Task: <task-id>
   
   {result payload}
   ```
5. Callback failure is retried once, then logged

**Validations:**
- callbackUrl must be valid HTTPS (not http://)
- SSRF deny-list blocks localhost, 10.x, 169.254, etc.
- Callback request timeout: 10 seconds
- 1 automatic retry on failure

## Error Codes & Remediation

| Code | Meaning | Remediation |
|------|---------|-------------|
| `-32600` | Invalid JSON-RPC | Check request format against spec |
| `-32602` | Invalid params | Verify skill ID, address format, payload |
| `-32700` | Parse error | Ensure valid JSON body |
| `402` | Payment required | Sign USDC transfer or use API key |
| `429` | Rate limited | Wait until next quota window (IP+date based) |
| `500` | Server error | Skill computation failed; retry or contact support |

## Monitoring & Observability

All skill executions are logged:

```javascript
db.logAdvisorUsage(scanId, scanType, { advisorUsed, usage: {input_tokens, output_tokens} });
db.logScanToHistory(email, address, scanType, result);
```

**Tables for observability:**
- `scan_history` — Every scan result (free or paid)
- `advisor_calls` — LLM invocations with token counts
- `autopilot_spending` — Autonomous agent spending
- `payments` — x402 USDC transfers (successful and failed)

**Metrics to track:**
- Cache hit ratio per skill
- Average latency per skill
- Error rate by error type
- Payment failure rate
- AutoPilot rejection rate

## Discovery & Integration

Integrate integrity.molt into your AI agent framework:

### 1. Discover Available Skills

```bash
curl https://intmolt.org/.well-known/agent-card.json
```

Response includes:
- All 11 skill definitions (name, description, pricing, input/output modes)
- Pricing tiers in micro-USDC
- Contact/support URLs

### 2. Integrate with A2A Framework

Use the skill list to construct JSON-RPC 2.0 requests dynamically:

```javascript
const skills = await fetch('https://intmolt.org/.well-known/agent-card.json').then(r => r.json());
const skill = skills.find(s => s.id === 'token_audit');

const request = {
  jsonrpc: '2.0',
  id: crypto.randomUUID(),
  method: 'tasks/send',
  params: {
    message: {
      role: 'user',
      parts: [
        {type: 'text', text: tokenMint},
        {type: 'data', data: {skill: 'token_audit'}}
      ]
    },
    metadata: {
      skill: 'token_audit',
      address: tokenMint,
      callbackUrl: 'https://myagent.example.com/callbacks'
    }
  }
};

const response = await fetch('https://intmolt.org/a2a', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(paymentEnvelope && {'x402-payment': paymentEnvelope})
  },
  body: JSON.stringify(request)
});
```

### 3. Verify Signatures Offline

All responses include Ed25519 signatures. Verify without calling back:

```python
import json, base64, nacl.signing

receipt = response_json
vk = nacl.signing.VerifyKey(base64.b64decode(receipt['verify_key']))
payload = {k: v for k, v in receipt.items()
           if k not in {'signature', 'verify_key', 'key_id', 'signed_at', 'signer', 'algorithm'}}
canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
vk.verify(canonical.encode(), base64.b64decode(receipt['signature']))
print("Valid")
```

## Frequently Asked Questions

**Q: Can I cache scan results client-side?**
A: Yes. Responses include `signed_at` timestamp. You can use your own TTL, but server-side caching (via `scan_history` table) is recommended for cost efficiency.

**Q: What happens if a skill times out?**
A: Timeouts vary by skill (30-300 seconds). If async callback is configured, task is retried. Otherwise, a 504 error is returned and should be retried by the client.

**Q: Can I use an API key for AutoPilot agents?**
A: API keys bypass AutoPilot checks. Only x402 payment envelopes with `x-agent-mint` header trigger co-signing.

**Q: Is there a bulk scan endpoint?**
A: No. Batch requests via multiple A2A calls in parallel. x402 is per-call.

**Q: Can I rescan without paying if it's still cached?**
A: Yes. Cache hit returns immediately (and signed), no payment required. TTLs are per-skill and vary from 15 min (governance_change) to 1 hour (program_verification_status).
