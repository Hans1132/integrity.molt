# x402 Payments Protocol — integrity.molt

integrity.molt uses the open-standard x402 protocol for Solana USDC micropayments. No account creation, no subscription, no API key required — just sign a transaction and call.

## x402 Protocol Overview

[x402](https://github.com/cheapay/x402) is an HTTP status code + protocol for machine-readable payment requests. When a resource requires payment:

1. Server responds with **402 Payment Required** status
2. Response body contains payment instructions (mint, amount, etc.)
3. Client signs a transaction on-chain and retries with payment envelope
4. Server verifies on-chain transfer, responds with resource

**Advantages:**
- No account or API key needed
- Atomic payment verification (on-chain state is truth)
- Agent-to-agent payments (no human wallet interaction)
- Open standard (multiple implementations available)

## Payment Flow

### Step 1: Request Paid Skill (No Payment)

```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [{"type": "text", "text": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}]},
      "metadata": {"skill": "token_audit", "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}
    }
  }'
```

**Response (402 Payment Required):**
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": -32602,
    "message": "Payment required",
    "data": {
      "x402Version": 1,
      "accepts": [
        {
          "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "decimals": 6,
          "amount": 750000
        }
      ],
      "price_usd": 0.75,
      "skill": "token_audit"
    }
  }
}
```

### Step 2: Build & Sign x402 Payment Envelope

The `x402-payment` header contains a base64-encoded JSON object:

```json
{
  "version": 1,
  "tx": "<base64-encoded-serialized-tx>",
  "tx_sig": "<base58-transaction-signature>"
}
```

**Building the envelope:**

```javascript
// 1. Create USDC transfer transaction
const tx = new Transaction()
  .add(
    createTransferInstruction(
      senderATA,                    // Sender's ATA for USDC
      intmolt.USDC_ATA,             // integrity.molt USDC wallet
      senderWallet,                 // Sender's public key
      750000,                       // 0.75 USDC (6 decimals)
      []                            // No signers yet
    )
  );

// 2. Sign with sender's keypair
const signedTx = await senderWallet.signTransaction(tx);
const txSignature = base58.encode(tx.signature);

// 3. Build x402 envelope
const envelope = {
  version: 1,
  tx: signedTx.serialize().toString('base64'),
  tx_sig: txSignature
};

const x402Payment = Buffer.from(JSON.stringify(envelope)).toString('base64');
```

### Step 3: Retry with Payment Header

```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -H "x402-payment: <base64-envelope>" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [{"type": "text", "text": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}]},
      "metadata": {"skill": "token_audit", "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}
    }
  }'
```

**Response (200 OK with result):**
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "risk_score": 42,
    "category": "moderate",
    "summary": "Token shows concentration risk...",
    "findings": [...],
    "signature": "<base64-ed25519-sig>",
    "verify_key": "<base64-pubkey>",
    "signed_at": "2026-05-06T10:00:00.000Z"
  }
}
```

## Server-Side Payment Verification

The `requirePayment` middleware in `server.js` handles verification:

```javascript
function requirePayment(acceptsArray, priceUSDC) {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x402-payment'];
    
    if (!paymentHeader) {
      return res.status(402).json({
        x402Version: 1,
        error: 'Payment required',
        accepts: acceptsArray,
        price_usd: priceUSDC / 1_000_000
      });
    }

    try {
      // 1. Decode x402-payment header
      const envelope = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
      
      // 2. Deserialize transaction
      const tx = Transaction.from(Buffer.from(envelope.tx, 'base64'));
      
      // 3. Verify on-chain (via RPC call to check commitment)
      const txSig = envelope.tx_sig;
      const confirmed = await rpc('getSignatureStatuses', [[txSig]]);
      
      if (!confirmed[0] || !confirmed[0].confirmationStatus) {
        return res.status(402).json({error: 'Transaction not confirmed'});
      }
      
      // 4. Anti-replay check — CRITICAL
      const alreadyUsed = markSignatureUsed(txSig);
      if (!alreadyUsed) {
        return res.status(402).json({error: 'Signature already used (replay detected)'});
      }
      
      // 5. Parse & verify transfer amount
      const instruction = tx.instructions[0];
      const amount = instruction.data.readUInt64LE(0);
      if (amount < priceUSDC) {
        return res.status(402).json({error: 'Insufficient amount'});
      }
      
      // 6. Verify recipient is integrity.molt USDC ATA
      const destinationPK = new PublicKey(instruction.keys[1].pubkey);
      if (!destinationPK.equals(USDC_ATA)) {
        return res.status(402).json({error: 'Incorrect recipient'});
      }
      
      // 7. Log payment
      logPayment({
        tx_sig: txSig,
        resource: req.path,
        required_micro_usdc: priceUSDC,
        micro_usdc: amount,
        verified: 1,
        ip: getRealClientIP(req)
      });
      
      // 8. Set context for route handler
      req.paymentVerified = true;
      req.txSender = senderPublicKey;
      req.txAmount = amount;
      
      next();
    } catch (err) {
      console.error('[payment] verification failed:', err.message);
      return res.status(402).json({error: 'Payment verification failed'});
    }
  };
}
```

## Anti-Replay Protection

**Critical security invariant:** Each x402 transaction signature is usable exactly once.

### Implementation

**1. Mark signature used BEFORE response:**

```javascript
// In requirePayment middleware, AFTER on-chain verification, BEFORE next():
const txSig = envelope.tx_sig;
const alreadyUsed = !markSignatureUsed(txSig);

if (alreadyUsed) {
  return res.status(402).json({error: 'Signature already used'});
}

// Only reach next() if atomically claimed the signature
next();
```

**2. Atomic claim in SQLite:**

```javascript
function markSignatureUsed(sig) {
  const r = db.prepare(
    'INSERT OR IGNORE INTO used_signatures (sig) VALUES (?)'
  ).run(sig);
  return r.changes === 1;  // true = atomic claim won, false = duplicate
}
```

**Why atomic?** SQLite's PRIMARY KEY constraint + single writer lock ensures that only ONE request can successfully insert the signature. All other parallel requests (replays) see the duplicate key error and return false.

**3. Table schema:**

```sql
CREATE TABLE IF NOT EXISTS used_signatures (
  sig        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS used_signatures_created ON used_signatures (created_at DESC);
```

**Cleanup:** Signatures older than 30 days are periodically deleted (via maintenance script).

## Pricing Reference

All prices are stored in `config/pricing.js` in **micro-USDC** (1 USDC = 1,000,000 micro-units, 6 decimal places).

```javascript
const PRICING = {
  quick:               500_000,   // 0.50 USDC — not paid via A2A (free)
  deep:              5_000_000,   // 5.00 USDC
  token:               750_000,   // 0.75 USDC (REST legacy route)
  wallet:              750_000,   // 0.75 USDC
  pool:                750_000,   // 0.75 USDC
  'evm-token':         750_000,   // 0.75 USDC
  'evm-scan':          750_000,   // 0.75 USDC
  contract:          5_000_000,   // 5.00 USDC
  'token-audit':       750_000,   // 0.75 USDC — A2A skill `token_audit`
  'agent-token':       150_000,   // 0.15 USDC — A2A skill `agent_token_scan`
  delta:             1_000_000,   // 1.00 USDC
  adversarial:       4_000_000,   // 4.00 USDC
  'governance-change': 150_000,   // 0.15 USDC — A2A skill `governance_change`
};

// Human-readable display (derived)
const PRICING_DISPLAY = {
  quick:               '0.50 USDC',
  deep:                '5.00 USDC',
  'token-audit':       '0.75 USDC',
  'agent-token':       '0.15 USDC',
  'governance-change': '0.15 USDC',
  // ... etc
};
```

### Skill-to-Price Mapping

| Skill ID | Config Key | Price (USDC) | Price (micro-USDC) |
|----------|------------|--------------|-------------------|
| `token_audit` | `token-audit` | 0.75 | 750,000 |
| `agent_token_scan` | `agent-token` | 0.15 | 150,000 |
| `governance_change` | `governance-change` | 0.15 | 150,000 |
| `wallet_profile` | `wallet` | 0.75 | 750,000 |
| `deep_audit` | `deep` | 5.00 | 5,000,000 |
| `adversarial_sim` | `adversarial` | 4.00 | 4,000,000 |

**NEVER hard-code prices.** Always read from `PRICING[key]` or use the `PRICING_DISPLAY` helper.

## Transaction Details

### USDC Token Details

- **Mint:** `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Circle USDC on Mainnet)
- **Decimals:** 6 (1 USDC = 1,000,000 smallest units)
- **Network:** Solana Mainnet-Beta

### ATAs (Associated Token Accounts)

The sender and integrity.molt both need ATAs (Associated Token Accounts) for the USDC mint:

```javascript
const senderATA = getAssociatedTokenAddressSync(
  new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  senderWallet,
  false,
  TOKEN_PROGRAM_ID
);

const intmoltATA = process.env.USDC_ATA;  // Pre-created, stored in .env
```

**Important:** The ATA must be explicitly created beforehand. If a sender doesn't have an ATA, the transfer fails with a "token account does not exist" error.

## Fee Management

integrity.molt does not charge transaction fees separately — the USDC amount is purely the service cost. The sender is responsible for paying Solana network fees (typically ~5,000 lamports).

```javascript
// When building the transaction:
const recentBlockhash = await connection.getLatestBlockhash();
tx.recentBlockhash = recentBlockhash.blockhash;
tx.feePayer = senderWallet;  // Sender pays network fees

// Estimated cost to caller:
// ├─ Network fee: ~0.00025 SOL (~$0.03 at $150/SOL)
// └─ Service cost: 0.15–5.00 USDC (depending on skill)
```

## Alternative Authentication: API Keys

Instead of per-call x402 payments, pre-funded API keys can be used for paid skills:

```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer im_xxxxxxxxxxxxxxxxxxxx" \
  -d '{...skill: "token_audit"...}'
# Response: 200 OK (no payment required)
```

**API keys are:**
- Email-specific (created via `/api/v1/auth/apikey`)
- Tied to a tier (dev, pro, enterprise)
- Rate-limited per month
- Deduct from pre-funded balance on each call

API keys are NOT used for A2A; they're a convenience for REST clients that want to avoid managing wallets.

## frames.ag AgentWallet Integration

Agents operating in the frames.ag ecosystem can use the AgentWallet x402/fetch proxy:

```bash
curl -X POST https://frames.ag/api/wallets/USERNAME/actions/x402/fetch \
  -H "Authorization: Bearer FRAMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://intmolt.org/a2a",
    "method": "POST",
    "body": {...}
  }'
```

**Flow:**
1. frames.ag proxy receives the request
2. Signs x402 payment on behalf of the agent (using agent's wallet)
3. Forwards the request with x402-payment header to integrity.molt
4. Deducts USDC from agent's frames.ag wallet account

**Benefits:**
- Agent doesn't manage its own wallet (frames.ag handles key rotation)
- Batched payments (frames.ag may batch multiple requests)
- Optional spending cap per agent

## Payment Errors & Debugging

### 402 Errors

| Error | Cause | Remediation |
|-------|-------|-------------|
| `Transaction not confirmed` | On-chain confirmation failed | Retry after 10+ slots (~4 seconds) |
| `Insufficient amount` | Sent less USDC than required | Check `price_usd` in 402 response, resend |
| `Incorrect recipient` | USDC sent to wrong wallet | Verify `intmolt.USDC_ATA` is correct |
| `Signature already used` | Replay of same tx signature | Generate new transaction, sign again |
| `Payment verification failed` | Generic error | Check transaction is valid Solana TX, try again |

### Debugging a Failed Payment

```bash
# 1. Verify sender has enough USDC balance
solana account <SENDER_ATA_PUBKEY> -um

# 2. Verify integrity.molt USDC ATA is correct
solana account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v -um

# 3. Check transaction on Solana Explorer
# https://explorer.solana.com/tx/<TX_SIGNATURE>?cluster=mainnet-beta

# 4. If transaction doesn't appear in Explorer, it failed to broadcast
# Likely causes: invalid recent blockhash, wrong fee payer, missing signature

# 5. If 402 says "Signature already used", that tx was already processed
# Sign and submit a new transaction (same parameters)
```

## Payment Monitoring

integrity.molt logs all payment attempts (successful and failed) to the `payments` table:

```sql
SELECT 
  tx_sig, 
  resource, 
  required_micro_usdc, 
  micro_usdc, 
  verified, 
  created_at 
FROM payments 
WHERE created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;
```

**Columns:**
- `tx_sig` — Transaction signature (unique, PRIMARY KEY)
- `resource` — API endpoint that was called
- `required_micro_usdc` — Price of the skill
- `micro_usdc` — Amount actually sent (should match required)
- `verified` — 1 if confirmed on-chain, 0 if failed
- `ip` — Client IP (from CF-Connecting-IP or X-Forwarded-For)
- `created_at` — Timestamp

## Security Considerations

### Keys & Wallets

- **Sender's keypair:** Client manages (NOT sent to server)
- **integrity.molt USDC ATA:** Public knowledge (stored in `.env`)
- **integrity.molt withdrawal keys:** Kept in `/root/.secrets/` (not committed)

### On-Chain Verification

- Every 402 payment requires RPC call to verify transfer commitment status
- Commitment level: `'confirmed'` (not `'finalized'`, trades off latency vs. certainty)
- If Solana RPC is down/slow, payment verification times out and returns 504

### Rate Limiting

Payment verification does NOT bypass rate limits. Both free and paid endpoints are rate-limited per IP+date:

```javascript
// Free tier: 10 scans/min per IP
// Paid tier: unlimited (per-call charge prevents spam)
```

### PDA-Based Payment (AI Agents)

When an agent sends the `x-agent-mint` header, payment must come from the Agent's PDA:

```javascript
const agentMint = req.headers['x-agent-mint'];  // Metaplex Agent Token mint
const expectedPDA = deriveAssetSignerPDA(agentMint);

if (txSender !== expectedPDA) {
  return res.status(402).json({error: 'PDA mismatch'});
}
```

This prevents one agent from paying on behalf of another.

## Testing Payments Locally

For development, use a testnet USDC mint and RPC:

```bash
# 1. Create test USDC mint on devnet
solana program deploy spl-token.so --program-id TokenkegQfeZyiNwAJsyFbPVwwQQfuM --url devnet

# 2. Create ATA on devnet
spl-token create-account <MINT_PUBKEY> --url devnet

# 3. Mint test USDC
spl-token mint <MINT_PUBKEY> 1000000 <ATA_PUBKEY> --url devnet

# 4. Point integrity.molt to devnet
export SOLANA_RPC_URL=https://api.devnet.solana.com
export USDC_ATA=<TEST_ATA_ON_DEVNET>

# 5. Sign and submit test transaction
# (Use solana CLI or SDK of choice)
```

**Test helpers in `tests/payment/`:**
- `anti-replay.test.js` — Tests double-spend detection
- `pricing-consistency.test.js` — Verifies all prices sync between config and handlers

Run tests before deploying payment changes:

```bash
npm run test:anti-replay
npm run test:pricing
```
