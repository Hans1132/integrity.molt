# 💰 integrity.molt - Complete Monetization & Autonomous Agent Setup

> **Goal**: Create an autonomous security audit agent that earns SOL on Moltbook

## Quick Summary

Your agent is now **fully configured to earn money** on Moltbook. The system works like this:

```
Moltbook User → Sends audit request to your agent
    ↓
Agent verifies SOL payment on-chain (Solana)
    ↓
✅ Payment confirmed → Agent autonomously runs audit
    ↓
Agent sends results back → User gets audit report
    ↓
💰 Agent keeps the SOL fee (minus Moltbook platform share)
```

## Architecture Overview

Your agent now has **3 parallel components**:

### 1. **Telegram Bot** (User Interface)
- Handles user commands: `/audit`, `/subscribe`, `/history`
- Free tier: Cached audits
- Paid tier: Premium features
- **Thread**: Runs on port via `python-telegram-bot`

### 2. **FastAPI Marketplace API** (Moltbook Integration)
- Receives audit requests from Moltbook
- Verifies SOL payments on-chain
- Routes to autonomous auditor
- **Endpoints**:
  - `POST /webhooks/audit` - Receive audit jobs
  - `POST /webhooks/payment-confirm` - Payment confirmations
  - `GET /earnings` - View earnings dashboard
  - `GET /status` - Agent status
  - **Thread**: Runs on `0.0.0.0:8000`

### 3. **Autonomous Auditor** (Background Processing)
- Processes audit queue concurrently
- Runs up to 3 audits simultaneously (configurable)
- Stores reports to R2 or database
- Anchors proofs on-chain (Metaplex NFT)
- **Thread**: Runs continuously in background

---

## Installation & Setup

### Step 1: Update Dependencies
```bash
pip install -r requirements.txt
```

Now includes:
- `fastapi>=0.100.0` - Web framework
- `uvicorn>=0.23.0` - ASGI server
- `pydantic>=2.0.0` - Data validation

### Step 2: Configure Environment

Add to your `.env` file:

```dotenv
# Marketplace Webhook Security
MOLTBOOK_WEBHOOK_SECRET=your-secure-webhook-secret-key
MOLTBOOK_API_KEY=sk_live_xxxxxxxxxxxxxxxx

# Marketplace API Settings
MARKETPLACE_API_PORT=8000
MARKETPLACE_API_HOST=0.0.0.0
MARKETPLACE_API_URL=https://integrity.molt.app

# Autonomous Settings
MAX_CONCURRENT_AUDITS=3
AUDIT_QUEUE_CHECK_INTERVAL=5

# Environment
ENVIRONMENT=production
```

### Step 3: Start the Agent

**Locally (for testing):**
```bash
python -m src
```

This starts all 3 components:
1. ✅ Telegram bot polling
2. ✅ FastAPI server on `:8000`
3. ✅ Autonomous auditor loop (background)

**On Railway (production):**
```bash
Procfile entry:
web: python -m src
```

---

## How Earnings Work

### Money Flow

```
Moltbook User pays 0.05 SOL for audit
    ↓
Payment goes to: your SOLANA_PUBLIC_KEY
    ↓
Revenue split:
  - 90% to your wallet (0.045 SOL)
  - 10% to Moltbook platform (0.005 SOL)
    ↓
💰 You keep 0.045 SOL per audit
```

### Pricing Model

```python
# From src/payment_processor.py
Base fee: 0.05 SOL (~$3 USD)
+ Token cost: 0.000001 SOL per GPT token
+ Risk multiplier: 1.0x to 3.0x based on findings severity

Examples:
- Simple audit: ~0.05 SOL
- Complex audit: ~0.15 SOL
- Critical findings: ~0.25 SOL
```

### Subscription Model
- Monthly: 0.1 SOL (~$6 USD)
- Unlimited audits for subscribers
- 20% discount on individual audits

---

## Webhook Integration with Moltbook

### 1. Register Webhook with Moltbook

```bash
curl -X POST https://api.molt.id/webhooks/subscribe \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "molt_78587c41ed99a3375022dc28",
    "webhook_url": "https://integrity.molt.app/webhooks/audit",
    "events": ["audit_request", "payment_confirmed"],
    "secret": "'$MOLTBOOK_WEBHOOK_SECRET'"
  }'
```

### 2. Webhook Request Format

When Moltbook sends an audit request:

```json
POST /webhooks/audit

{
  "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
  "requester_wallet": "wallet123...",
  "amount_lamports": 5000000,
  "payment_tx_hash": "4mxjnyq8bMZEhLF...",
  "request_id": "req_123_456",
  "metadata": {
    "source": "moltbook-marketplace",
    "audit_type": "security"
  }
}

Header: X-Moltbook-Signature: <HMAC-SHA256>
```

### 3. Verification Steps

Your agent performs these checks before running audit:

1. **Signature verification** (HMAC-SHA256)
   ```python
   # From marketplace_api.py
   verify_moltbook_signature(payload, signature, secret)
   ```

2. **On-chain payment verification** (Solana RPC)
   ```python
   # Confirms transaction exists and was paid to AGENT_WALLET
   solana_client.verify_transaction_confirmed(payment_tx_hash)
   ```

3. **Amount validation**
   ```python
   # Ensures amount matches request
   if tx_amount != request.amount_lamports:
       raise PaymentMismatch()
   ```

4. **Recipient validation**
   ```python
   # Ensures payment went to integrity.molt wallet
   if tx_recipient != AGENT_WALLET:
       raise WrongRecipient()
   ```

---

## Request/Response Flow

### Complete Audit Lifecycle

```
1. REQUEST (Moltbook → Your Agent)
   POST /webhooks/audit
   ├─ contract_address: "Evx..."
   ├─ amount_lamports: 5000000
   ├─ payment_tx_hash: "4mx..."
   └─ request_id: "req_123"

2. IMMEDIATE RESPONSE
   ├─ status: "received"
   ├─ request_id: "req_123"
   ├─ message: "Audit queued"
   └─ estimated_time_seconds: 30

3. BACKGROUND PROCESSING
   ├─ Verify payment → OK ✅
   ├─ Queue audit job
   ├─ Run GPT-4 analysis
   ├─ Calculate risk score
   ├─ Store report to R2
   └─ Anchor on Metaplex (future)

4. NOTIFICATION (Your Agent → Moltbook)
   POST https://api.molt.id/audits/report
   ├─ audit_id: "req_123"
   ├─ risk_score: 7
   ├─ findings_count: 4
   ├─ report_url: "https://..."
   ├─ cost_sol: 0.009
   └─ timestamp: "2026-02-28T..."

5. USER GETS REPORT
   ├─ View on Moltbook marketplace
   ├─ Verify on Solscan
   ├─ Download full report
   └─ Verify on-chain signature
```

---

## Monitoring & Earnings Dashboard

### Real-time Earnings Tracker

```bash
curl http://localhost:8000/earnings
```

Response:
```json
{
  "agent": "integrity.molt",
  "period": "all-time",
  "total_audits": 42,
  "total_earnings_sol": 0.315,
  "total_earnings_usd": 18.90,
  "average_per_audit_sol": 0.0075,
  "audits_per_hour": 2.1,
  "timestamp": "2026-02-28T14:32:00Z"
}
```

### Job Queue Status

```bash
curl http://localhost:8000/status
```

### Retrieve Completed Audit

```bash
curl http://localhost:8000/reports/req_123
```

---

## Autonomous Auditor Details

### How It Works

1. **Queue Management** (`AutonomousAuditor`)
   - Incoming audits → Added to queue
   - Background loop checks every 5 seconds
   - Runs 3 audits concurrently (default)

2. **Audit Execution Pipeline**
   ```python
   # From autonomous_auditor.py
   
   async def process_audit_job(job):
       # 1. Analyze contract with GPT-4
       result = SecurityAuditor.analyze_contract(...)
       
       # 2. Calculate actual fee
       fee = calculate_audit_fee(tokens, risk_score)
       
       # 3. Store report
       report_hash = r2_storage.save_report(...)
       
       # 4. Anchor on-chain (optional)
       nft_mint = create_audit_nft(...)
       
       # 5. Notify Moltbook
       publish_to_marketplace(...)
       
       # 6. Record earnings
       total_earnings_sol += job.payment
   ```

3. **Error Handling**
   - Failed audits: Issue automatic refund
   - Network issues: Retry with backoff
   - Timeout: Escalate to monitoring

---

## Deployment Guide

### Option 1: Railway (Recommended)

```bash
# Your processes.yml on Railway should look like:
web: python -m src
```

This **single command** starts all 3 components (bot, API, auditor).

### Option 2: Docker Compose (Local)

```bash
docker-compose up
```

### Option 3: Moltbook OpenClaw (Future)

```bash
openclaw deploy integrity.molt
```

---

## Security Checklist

- [x] HMAC signature verification on webhook
- [x] On-chain payment verification (Solana RPC)
- [x] JWT agent identity tokens
- [x] Wallet address validation
- [x] Amount validation
- [x] Rate limiting (configurable)
- [x] Error isolation (failed audits don't crash others)
- [ ] Rate limiting by wallet
- [ ] Suspicious pattern detection
- [ ] Rate limiting by contract address

---

## Troubleshooting

### API not receiving requests?

1. Check webhook URL is registered in Moltbook
   ```bash
   curl https://api.molt.id/webhooks/list \
     -H "Authorization: Bearer $MOLTBOOK_API_KEY"
   ```

2. Verify signature secret matches
   ```bash
   # In .env:
   MOLTBOOK_WEBHOOK_SECRET=xxx
   
   # In Moltbook:
   Secret: xxx  (must match)
   ```

3. Check firewall/port forwarding
   ```bash
   curl http://localhost:8000/health
   ```

### Payment verification failing?

1. Check Solana RPC endpoint
   ```python
   solana_client.verify_transaction_confirmed(tx_hash)
   # Should return: {"status": "confirmed"}
   ```

2. Verify wallet addresses
   ```bash
   # Requester paid to:
   SOLANA_PUBLIC_KEY=$AGENT_WALLET
   ```

3. Check amount precision
   ```python
   # Lamports precision
   amount_requested = 5000000  # lamports
   amount_received = 5000000   # lamports (must match exactly)
   ```

### Audits not running?

1. Check autonomous auditor loop
   ```bash
   # In logs:
   "🔄 Starting autonomous audit loop"
   "Processing X queued audits"
   ```

2. Check concurrent limit
   ```python
   MAX_CONCURRENT_AUDITS=3  # Can run 3 simultaneously
   ```

3. Monitor GPT-4 costs
   ```bash
   # Check cost threshold
   API_COST_THRESHOLD_USD=4.50
   ```

---

## Revenue Projections

### Conservative Scenario
- 10 audits/day
- 0.05 SOL average per audit
- × 365 days/year
- × 90% (Moltbook fee)
= **1.64 SOL/year** (~$99 USD)

### Moderate Scenario
- 50 audits/day
- 0.05 SOL average
- × 365 days
- × 90%
= **8.21 SOL/year** (~$493 USD)

### Aggressive Scenario
- 200 audits/day
- 0.05 SOL average
- × 365 days
- × 90%
= **32.85 SOL/year** (~$1,971 USD)

**Plus**: Subscription revenue from premium users

---

## Next Steps

1. **Deploy to production**
   ```bash
   git push railway main
   ```

2. **Register with Moltbook marketplace**
   - Sign up at https://app.molt.id
   - Create audit service listing
   - Set pricing (e.g., 0.05 SOL per audit)

3. **Monitor earnings**
   - Check `/earnings` endpoint regularly
   - Log into Moltbook dashboard
   - Verify transactions on Solscan

4. **Scale up**
   - Adjust `MAX_CONCURRENT_AUDITS` if needed
   - Add caching for popular contracts
   - Implement refund handling

---

## API Reference

### Health Check
```
GET /health
Response: {"status": "healthy", "agent": "integrity.molt"}
```

### Agent Status
```
GET /status
Response: {
  "status": "active",
  "agent_id": "molt_...",
  "network": "solana-mainnet"
}
```

### Submit Audit Request
```
POST /webhooks/audit
Request: {
  "contract_address": "...",
  "requester_wallet": "...",
  "amount_lamports": 5000000,
  "payment_tx_hash": "..."
}
Response: {
  "status": "received",
  "request_id": "req_123"
}
```

### Get Audit Report
```
GET /reports/{audit_id}
Response: {
  "audit_id": "req_123",
  "risk_score": 7,
  "findings": [...]
}
```

### View Earnings
```
GET /earnings
Response: {
  "total_audits": 42,
  "total_earnings_sol": 0.315,
  "average_per_audit_sol": 0.0075
}
```

---

## Support & Questions

- **GitHub**: Check `AGENTS.md` for architecture details
- **Logs**: Check Railway logs: `railway logs`
- **Discord**: Join Moltbook Discord for support
- **Docs**: See `soul.md` for mission/values

---

**Status**: ✅ READY TO EARN MONEY

Your agent will now:
- Listen for Moltbook audit requests
- Verify payments on-chain
- Run audits autonomously
- Collect fees in real SOL
- Track earnings in real-time

🚀 Deploy and start earning!
