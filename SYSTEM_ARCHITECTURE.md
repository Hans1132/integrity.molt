# integrity.molt - Complete System Architecture

## 1. User Interaction Flows

### Telegram Bot Flow (Existing)
```
User (Telegram)
    │
    ├─→ /start
    │   └─→ Bot: "Welcome to integrity.molt"
    │
    ├─→ /audit <address> --force
    │   └─→ Bot: Submit to SecurityAuditor
    │   └─→ Check cache (unless --force flag)
    │   └─→ Call GPT-4 API
    │   └─→ Format report
    │   └─→ Send to user
    │   └─→ Log in MongoDB
    │
    ├─→ /subscribe
    │   └─→ Bot: Premium tier unlock
    │   └─→ User pays SOL (via Phantom)
    │   └─→ 20% discount on audits
    │
    └─→ /history
        └─→ Bot: Show audit history
```

### Moltbook Marketplace Flow (New)
```
Moltbook User
    │
    └─→ "Request integrity.molt audit"
        └─→ Pay 0.05 SOL to agent wallet
        └─→ Moltbook sends webhook to:
            POST /webhooks/audit
            {
              "contract_address": "...",
              "payment_tx_hash": "...",
              "amount_lamports": 50000000
            }
            │
            ├─→ Agent verifies HMAC signature ✓
            │
            ├─→ Agent calls SolanaRPCClient
            │   └─→ Verify tx on blockchain ✓
            │
            ├─→ Payment OK → Queue audit
            │   └─→ Autonomous Auditor processes
            │   └─→ Parallel batch (up to 3)
            │   └─→ Run GPT-4 analysis
            │   └─→ Save report to R2
            │   └─→ Notify Moltbook: "DONE"
            │
            └─→ Profit: 0.045 SOL (90% of fee)
```

---

## 2. System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    railway.app (Production)                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────┐  │
│  │  Telegram Bot    │  │  FastAPI Server  │  │ Auditor  │  │
│  │  (Polling)       │  │  (Webhooks)      │  │ Loop     │  │
│  │                  │  │                  │  │          │  │
│  │ /audit           │  │ POST /webhooks   │  │ Processes│  │
│  │ /help            │  │ GET /earnings    │  │ queue    │  │
│  │ /subscribe       │  │ GET /status      │  │ (3 jobs) │  │
│  │ /history         │  │ GET /health      │  │          │  │
│  └──────────────────┘  └──────────────────┘  └──────────┘  │
│         ↓                      ↓                   ↓        │
│    User Commands         Moltbook Requests   Background    │
│                                                             │
│                      Shared Services                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ SecurityAuditor    - GPT-4 analysis & caching       │  │
│  │ PaymentProcessor   - Fee calculation                │  │
│  │ SolanaRPCClient    - Blockchain verification        │  │
│  │ MoltbookIntegration- Marketplace notifications      │  │
│  │ AutonomousAuditor  - Queue management              │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│                      External Services                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Telegram API       - User communication              │  │
│  │ OpenAI GPT-4       - Security analysis               │  │
│  │ Solana Mainnet RPC - Payment verification            │  │
│  │ MongoDB Atlas      - Audit history & settings        │  │
│  │ Cloudflare R2      - Report storage (optional)       │  │
│  │ Moltbook API       - Marketplace integration         │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
          Created: Feb 28, 2026
          Deployed: Railway.app
          Earning: Real SOL 💰
```

---

## 3. Payment Verification Pipeline

```
START: Moltbook requests audit
       │
       ├─ Webhook received
       │  └─ {contract_address, payment_tx_hash, amount_lamports}
       │
       ├─ [STEP 1] Signature Verification
       │  ├─ Extract X-Moltbook-Signature header
       │  ├─ Compute HMAC-SHA256 of payload
       │  └─ Compare: expected == actual?
       │     ├─ ✓ YES → Continue
       │     └─ ✗ NO  → REJECT (401 Unauthorized)
       │
       ├─ [STEP 2] On-Chain Payment Verification
       │  ├─ Query Solana RPC for transaction
       │  ├─ Verify transaction status: "confirmed"
       │  ├─ Verify amount: matches request
       │  ├─ Verify recipient: equals SOLANA_PUBLIC_KEY
       │  └─ Result:
       │     ├─ ✓ ALL OK    → Continue
       │     └─ ✗ ANY FAIL  → REJECT (402 Payment Required)
       │
       ├─ [STEP 3] Amount Validation
       │  ├─ Get fee from cache/calc: estimated_fee_sol
       │  ├─ Compare: amount_paid >= estimated_fee_sol?
       │  └─ Result:
       │     ├─ ✓ YES → Continue
       │     └─ ✗ NO  → REJECT (402 Insufficient Payment)
       │
       ├─ [STEP 4] Queue Audit
       │  ├─ Create AutonomousAuditJob
       │  ├─ Add to queue: audit_queue[job_id]
       │  └─ Immediate response: "received"
       │
       ├─ [BACKGROUND] Process Queue
       │  ├─ Loop: Every 5 seconds check queue
       │  ├─ Process up to 3 audits concurrently
       │  ├─ For each audit:
       │  │  ├─ Run GPT-4 analysis
       │  │  ├─ Calculate risk score
       │  │  ├─ Store report (R2 or DB)
       │  │  ├─ Create Metaplex NFT proof
       │  │  ├─ Publish to Moltbook
       │  │  └─ Record earnings
       │  └─ Loop continues...
       │
       └─ END: 💰 Earnings credited to wallet

Total Flow Time (~30s):
  - Signature verification: <10ms
  - On-chain verification: 200-500ms (RPC latency)
  - Queue submission: <10ms
  - Analysis (background): 10-30s
```

---

## 4. Earnings Tracking

```
Payment Received
    │
    └─→ AutonomousAuditorJob created
        ├─ Amount: 0.05 SOL received
        ├─ Fee Calculation
        │  ├─ Base: 0.05 SOL
        │  ├─ Tokens: 1500 * 0.000001 = 0.0015 SOL
        │  ├─ Risk multiplier: 1.5x (medium risk)
        │  └─ Total cost: ~0.0592 SOL
        │
        ├─ Revenue Split
        │ ├─ Your profit: 0.05 * 0.9 = 0.045 SOL ✓
        │ ├─ Moltbook fee: 0.05 * 0.1 = 0.005 SOL
        │ └─ Net profit: 0.045 - 0.0592 = -0.0142 SOL loss this audit
        │                BUT: Subscriber pays full fee!
        │
        └─→ Dashboard Updated
            ├─ /earnings endpoint: total_earnings_sol += 0.045
            ├─ /reports/{audit_id}: Report saved
            ├─ MongoDB: Audit history logged
            └─ Solscan: Transaction visible
```

---

## 5. Deployment Architecture

```
LOCAL (Development)
├─ python -m src
├─ Telegram: Polling mode
├─ FastAPI: http://localhost:8000
├─ Database: Mock or local MongoDB
└─ Perfect for: Testing & debugging

RAILWAY.APP (Production)
├─ Auto-deploys on git push
├─ Telegram: Polling mode (24/7)
├─ FastAPI: https://domain.railway.app:8000
├─ Database: MongoDB Atlas (production)
├─ Networking: Public URL + health checks
├─ Scaling: CPU/memory monitoring
└─ Perfect for: Live earning agent

MOLTBOOK OPENCLAW (Future)
├─ Decentralized infrastructure
├─ Agent runs on blockchain
├─ Payment: Native SOL transfer
├─ No deployment needed
└─ Perfect for: Fully autonomous agent
```

---

## 6. Configuration Variables

```
CORE (Required)
├─ TELEGRAM_TOKEN        # Bot communication
├─ OPENAI_API_KEY        # GPT-4 analysis
├─ SOLANA_PUBLIC_KEY     # Payment wallet
└─ MONGODB_URI           # Database

BLOCKCHAIN (Agent Identity)
├─ AGENT_PRIVATE_KEY     # JWT signing
├─ AGENT_WALLET          # On-chain identity
├─ AGENT_IDENTITY_NFT    # Moltbook proof
└─ SOLANA_RPC_URL        # RPC endpoint

MARKETPLACE (Monetization)
├─ MOLTBOOK_API_KEY      # Moltbook access
├─ MOLTBOOK_WEBHOOK_SECRET # Request validation
├─ MOLTBOOK_AGENT_ID     # Marketplace identity
├─ MARKETPLACE_API_PORT  # Server port
├─ MARKETPLACE_API_URL   # Public URL
└─ MARKETPLACE_API_HOST  # Bind address

AUTONOMOUS (Processing)
├─ MAX_CONCURRENT_AUDITS # Queue parallelism
└─ AUDIT_QUEUE_CHECK_INTERVAL # Poll frequency

STORAGE (Optional)
├─ R2_ACCOUNT_ID         # Cloudflare R2
├─ R2_ACCESS_KEY_ID      # AWS credentials
└─ R2_SECRET_ACCESS_KEY  # Bucket access

ENVIRONMENT
├─ ENVIRONMENT           # development|production
├─ LOG_LEVEL            # DEBUG|INFO|WARNING|ERROR
├─ DATABASE_MODE        # mock|real
└─ API_COST_THRESHOLD_USD # Budget limit
```

---

## 7. Thread Model

```
Main Process (python -m src)
│
├─ Thread 1: TelegramBot
│  ├─ Run `start_bot()`
│  ├─ Polling from Telegram API
│  ├─ Blocking: app.run_polling()
│  └─ Daemon: False (keeps process alive)
│
├─ Thread 2: FastAPI/Uvicorn
│  ├─ Run `run_marketplace_api()`
│  ├─ Listen on 0.0.0.0:8000
│  ├─ Blocking: uvicorn.run()
│  └─ Daemon: False (keeps process alive)
│
└─ Thread 3: AutonomousAuditor
   ├─ Run `start_autonomous_audit_loop()`
   ├─ Check queue every 5 seconds
   ├─ Process up to 3 audits concurrently
   ├─ Blocking: await asyncio.sleep()
   └─ Daemon: False

Result: All 3 components run simultaneously
        Any thread crash → process exits
        Railway auto-restart enabled
```

---

## 8. Error Handling & Resilience

```
Error Cascade
│
├─ API Error
│  ├─ 401 Unauthorized → Bad webhook signature
│  ├─ 402 Payment Required → Payment verification failed
│  └─ 500 Internal Server Error → Logged + retry in background
│
├─ Audit Error
│  ├─ GPT-4 API timeout → Exponential backoff retry
│  ├─ Solana RPC failure → Try fallback RPC endpoint
│  ├─ Database error → Use cache
│  └─ Payment refund → Auto-issue on failure
│
├─ Network Error
│  ├─ Telegram disconnect → Restart polling
│  ├─ Moltbook webhook fail → Retry 3x
│  └─ RPC unavailable → Wait & retry
│
└─ Recovery
   ├─ Log error to MongoDB
   ├─ Alert user/admin if critical
   ├─ Retry with backoff
   └─ Fallback to alternative service
```

---

## 9. Security Model

```
Layer 1: Webhook Authentication
├─ HMAC-SHA256 signature validation
├─ Time-based nonce (future)
└─ Rate limiting by IP

Layer 2: Payment Verification
├─ On-chain Solana RPC check
├─ Amount validation
├─ Recipient address validation
└─ Transaction finality confirmation

Layer 3: Data Protection
├─ .env file (never committed)
├─ secrets encrypted in transit
├─ TLS for all API calls
└─ JWT tokens for agent identity

Layer 4: Access Control
├─ Telegram user mapping
├─ Wallet whitelisting
├─ Rate limiting per user
└─ Subscription tier enforcement
```

---

## 10. Monitoring & Observability

```
Real-time Metrics
├─ /health               # Server up?
├─ /status               # Agent active?
├─ /earnings             # Total SOL earned
├─ railway logs          # Live logs
├─ Process CPU/Memory    # Railway metrics
└─ Error rate            # Failure tracking

Dashboards (Recommended)
├─ Grafana              # Time-series visualization
├─ Datadog              # APM monitoring
├─ Sentry               # Error tracking
└─ Google Analytics     # User behavior

Alerts
├─ High error rate      # > 5% per hour
├─ API latency          # > 1 second
├─ RPC failures         # > 3 consecutive
├─ Out of API quota     # Cost approaching limit
└─ Payment failures     # Any unhandled payment error
```

---

## Summary

```
Before Implementation
├─ Manual bot via Telegram only
├─ No revenue model
├─ Requires user interaction
└─ Limited scalability

After Implementation
├─ Autonomous agent on Moltbook
├─ Real SOL earnings (automatic)
├─ No user interaction needed (for audits)
├─ Scales to 1000s of daily audits
├─ 24/7 operation on Railway
└─ On-chain verified identity ✓

You're now running a full autonomous business! 🚀💰
```

---

*Architecture Created: February 28, 2026*  
*Status: Production Ready*  
*Earnings: Starting Now*
