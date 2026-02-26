# Phase 3: Blockchain Integration & Database Persistence

**Status**: 🔨 In Development  
**Date Started**: February 27, 2026  
**Phase 2 Completion**: ✅ 100%  

---

## Overview

Phase 3 implements **blockchain integration** (Phantom wallet, NFT minting, payment signing) and **database persistence** (MongoDB for audit history and user data). This phase transforms integrity.molt from a stateless API into a fully accountable on-chain security audit platform.

### Key Deliverables

| Component | Status | Files | LOC |
|-----------|--------|-------|-----|
| Phantom Wallet Integration | ✅ Ready | `src/phantom_wallet.py` | 350+ |
| NFT Transaction Signing | ✅ Ready | `src/nft_signer.py` | 380+ |
| Payment Transaction Signing | ✅ Ready | `src/payment_signer.py` | 360+ |
| Solana RPC Client | ✅ Ready | `src/solana_rpc.py` | 400+ |
| MongoDB Client | ✅ Ready | `src/database.py` | 450+ |
| Telegram /history Command | ✅ Ready | `src/telegram_bot.py` | +60 |
| Enhanced /subscribe Flow | ✅ Ready | `src/telegram_bot.py` | +120 |
| **TOTAL** | **✅ 7/7** | **7 modules** | **~2,500 LOC** |

---

## Architecture

### Transaction Flow (Phase 3)

```
User: /audit <contract>
  │
  ├─ [Phases 1-2: Analysis]
  │  ├─ Stage -1: Quota check
  │  ├─ Stage 0: Cache check
  │  ├─ Stage 1: Pattern detection
  │  ├─ Stage 2-3: GPT-4 analysis
  │  ├─ Stage 4: R2 storage
  │  ├─ Stage 5: NFT metadata
  │  ├─ Stage 6: Payment calc
  │  ├─ Stage 7: Cache record
  │  └─ Stage 8: Quota record
  │
  └─ [Phase 3: Blockchain]
     ├─ Create NFT mint transaction
     ├─ Create payment transaction
     ├─ Send to Phantom wallet for signing
     ├─ Verify signature received
     ├─ Submit to Solana RPC
     ├─ Verify on-chain confirmation
     └─ Store in MongoDB
```

---

## 1. Phantom Wallet Integration

**File**: [src/phantom_wallet.py](src/phantom_wallet.py)

### Features

- **Session Management**: Track wallet connections per user
- **Signing Requests**: Create transactions for user approval
- **Transaction Confirmation**: Verify signature received
- **Deep Links**: Support mobile and web wallet connections

### Key Methods

```python
phantom_wallet.create_signing_request(
    user_id=12345,
    transaction_type="nft_audit",  # or "payment_audit", "subscription"
    amount_lamports=5000000,
    contract_address="EvXNCtao...",
    metadata={"audit_id": "audit_123", ...}
)
# Returns: signing_request with deep link + phase 3 status

phantom_wallet.confirm_signature(
    request_id="sign_req_12345_1708...",
    transaction_hash="5KMxXXXXXXXX..."
)
# Returns: signature confirmation ready for blockchain

phantom_wallet.verify_transaction_confirmed(
    transaction_hash="5KMxXXXXXXXX..."
)
# Returns: blockchain confirmation status
```

### Telegram User Flow

```
User: /subscribe
  ↓
Bot: "⭐ SUBSCRIBER SUBSCRIPTION - 0.1 SOL"
Bot: "Next steps: Open Phantom and approve..."
Bot: Deep link provided
  ↓
User: Clicks link → Phantom opens
User: Reviews transaction details
User: Taps "Approve"
  ↓
Phantom: Signs transaction
Phantom: Returns signature to app
  ↓
Bot: "✅ Signature received! Submitting to blockchain..."
```

---

## 2. NFT Transaction Signing

**File**: [src/nft_signer.py](src/nft_signer.py)

### Features

- **Metaplex Core NFT Creation**: Generate NFT metadata
- **Immutable Audit Records**: SHA256 hash verification
- **Risk Score Encoding**: Store risk level in NFT traits
- **On-Chain Proof**: Verifiable audit history

### NFT Metadata Structure

```json
{
  "name": "integrity.molt Audit Report #1234",
  "symbol": "AUDIT",
  "description": "Security audit for 0xEvXNCtao... (Risk: 7/10)",
  "attributes": [
    {"trait_type": "Audit Date", "value": "2026-02-27T..."},
    {"trait_type": "Risk Score", "value": "7"},
    {"trait_type": "Contract Address", "value": "0xEvXNCtao..."},
    {"trait_type": "Audit Hash", "value": "abc123def456..."},
    {"trait_type": "Auditor", "value": "integrity.molt"},
    {"trait_type": "Network", "value": "Solana Mainnet"}
  ],
  "properties": {
    "files": [
      {"uri": "https://integrity.molt.io/audit/{audit_id}.json"}
    ],
    "category": "security_audit",
    "creators": [{"address": "integrity.molt", "share": 100, "verified": true}]
  }
}
```

### Key Methods

```python
nft_signer.create_nft_mint_transaction(
    audit_id="audit_123456",
    contract_address="EvXNCtao...",
    audit_hash="abc123def456...",
    risk_score=7,
    findings_summary="Reentrancy vulnerability detected",
    user_id=12345
)
# Returns: NFT mint transaction ready for Phantom signing

nft_signer.confirm_nft_signature(
    mint_id="nft_mint_12345_1708...",
    transaction_hash="5KMxXXXXXXXX...",
    mint_address="CjMxaURTzXD2Q2ar..."
)
# Returns: NFT minted confirmation

nft_signer.verify_nft_minted(
    transaction_hash="5KMxXXXXXXXX...",
    mint_address="CjMxaURTzXD2Q2ar..."
)
# Returns: on-chain verification result
```

---

## 3. Payment Transaction Signing

**File**: [src/payment_signer.py](src/payment_signer.py)

### Features

- **Multi-Recipient Transactions**: Split revenue (90% integrity.molt, 10% Moltbook)
- **Audit Payment Signing**: Per-audit fee transfers
- **Subscription Payment Signing**: Recurring billing setup
- **Transaction tracking**: Immutable payment records

### Revenue Sharing

```
User pays: 0.009 SOL for audit
    ├─ 90% (0.0081 SOL) → integrity.molt
    └─ 10% (0.0009 SOL) → Moltbook platform fee

User subscribes: 0.1 SOL/month
    ├─ 90% (0.09 SOL) → integrity.molt
    └─ 10% (0.01 SOL) → Moltbook platform fee
```

### Key Methods

```python
payment_signer.create_audit_payment_transaction(
    payment_id="payment_audit_123",
    user_id=12345,
    amount_lamports=9000000,
    contract_address="EvXNCtao...",
    audit_id="audit_123456"
)
# Returns: SOL transfer transaction for signing

payment_signer.create_subscription_payment_transaction(
    payment_id="payment_sub_456",
    user_id=12345,
    amount_lamports=100000000,  # 0.1 SOL
    tier="subscriber",
    duration_days=30
)
# Returns: subscription payment transaction

payment_signer.confirm_payment_signature(
    payment_id="payment_audit_123",
    transaction_hash="5KMxXXXXXXXX..."
)
# Returns: payment submitted confirmation
```

---

## 4. Solana RPC Verification

**File**: [src/solana_rpc.py](src/solana_rpc.py)

### Features

- **Transaction Verification**: Check confirmed/finalized status
- **Account Information**: Get wallet balances
- **NFT Metadata Retrieval**: Verify on-chain NFT data
- **Fee Estimation**: Calculate transaction costs

### Key Methods

```python
solana_mainnet.verify_transaction_confirmed(
    transaction_hash="5KMxXXXXXXXX..."
)
# Returns: {
#   "status": "confirmed",
#   "confirmed": True,
#   "finalized": True,
#   "slot": 200000000,
#   "solscan_link": "https://solscan.io/tx/5KMxXXXXXX..."
# }

solana_mainnet.get_transaction_details(
    transaction_hash="5KMxXXXXXXXX..."
)
# Returns: Full transaction details (recipients, amounts, etc.)

solana_mainnet.verify_nft_minted(
    transaction_hash="5KMxXXXXXXXX...",
    mint_address="CjMxaURTzXD2Q2ar..."
)
# Returns: NFT verification with on-chain proof
```

---

## 5. MongoDB Persistence

**File**: [src/database.py](src/database.py)

### Features

- **Audit History**: User audit records with findings
- **User Profiles**: Tier, subscription, verification status
- **Subscriptions**: Active subscription tracking
- **Transactions**: Payment and NFT transaction records
- **Wallet Sessions**: Phantom wallet connections

### Collections

```
audits:
  - audit_id (primary key)
  - user_id
  - contract_address
  - findings
  - risk_score
  - r2_url (report URL)
  - nft_mint (NFT hash)
  - created_at
  - patterns (detected vulnerabilities)

users:
  - _id: user_id (primary key)
  - tier (free/subscriber/premium)
  - created_at
  - audits_total
  - spend_total_sol

subscriptions:
  - _id: sub_id (primary key)
  - user_id
  - tier
  - started_at
  - expires_at
  - transaction_hash

transactions:
  - _id: tx_hash (primary key)
  - user_id
  - type (payment_audit, subscription, nft_mint)
  - amount_sol
  - status (pending, submitted, confirmed)
  - created_at

wallets:
  - _id: wallet_{user_id}
  - wallet_address
  - session_token
  - connected_at
```

### Key Methods

```python
db_client.insert_audit(audit_data)
# Store completed audit in database

db_client.get_user_audits(user_id, limit=50)
# Retrieve user's audit history

db_client.set_subscription(user_id, tier="subscriber", duration_days=30)
# Record active subscription

db_client.insert_transaction(tx_data)
# Store payment or NFT transaction

db_client.health_check()
# Verify database connectivity
```

---

## 6. Enhanced Telegram Commands

### `/history [limit]`

Show user's audit history from database.

```
📚 **Your Audit History** (5 audits)

1. 🔴 **Risk 7/10** | 2026-02-27
   Contract: `EvXNCtaoVuC1...`
   📄 View Report (link to R2)

2. 🟨 **Risk 4/10** | 2026-02-26
   Contract: `0x1234567890ab...`
   
... 3 more audits
```

**Features**:
- Pagination (limit up to 50)
- Risk score emoji indicators
- Direct links to R2 reports
- Sorted by date (newest first)

### `/subscribe [tier]`

Subscribe to premium tier with Phantom wallet integration.

```
⭐ **SUBSCRIBER SUBSCRIPTION**

💰 Price: 0.1 SOL (~$6 USD)
📅 Duration: 30 days (auto-renew)

📊 **Your New Limits**:
⏱️ 10 audits per hour
📅 50 audits per day
📆 999 audits per month

🎁 **What You Get**:
✅ 5x higher audit limits
✅ Unlimited monthly audits
✅ Priority support

**Next Steps**:
1️⃣ Open your Phantom wallet app
2️⃣ Look for a signing request
3️⃣ Review and approve
4️⃣ Subscription activated!

🔐 Request ID: sign_req_12345_1708...
```

**Features**:
- Phantom wallet integration
- Deep link support for mobile
- Transaction details  
- Clear next steps
- 5-minute expiry warning

---

## Transaction Flow Example

### Complete Audit → NFT Mint → Payment Flow

```
1. User: /audit 0xEvXNCtao...
   Bot: "🔍 Analyzing..."
   
2. Bot: Runs Stages 1-8 (Phase 2)
   ✅ Pattern detection
   ✅ GPT-4 analysis
   ✅ R2 storage
   ✅ NFT metadata
   ✅ Payment calc
   
3. Bot: "Ready to mint NFT and process payment"
   Bot: "Opening Phantom for signing..."
   
4. User: Phantom signing request appears
   Phantom: Shows transaction details
   - Recipient: integrity.molt (90%)
   - Amount: 0.009 SOL
   - Data: NFT metadata
   
5. User: Approves in Phantom
   Phantom: Signs transaction
   Phantom: Returns signature
   
6. Bot: ✅ Signature received
   Bot: "Submitting to Solana blockchain..."
   
7. Bot: Verifies transaction on RPC
   Bot: "✅ Transaction confirmed!"
   Bot: "NFT minted: CjMxaURTzXD2Q2ar..."
   Bot: "Payment processed: 0.009 SOL"
   
8. Bot: Stores in MongoDB
   Database: Audit record created
   Database: NFT transaction logged
   Database: Payment confirmed
   
9. Bot: Returns summary to user
   "✅ Audit complete!
   📊 Risk: 7/10
   🎨 NFT: CjMxaURTzXD2Q2ar... (Solscan)
   💰 Paid: 0.009 SOL
   📚 View history: /history"
```

---

## Implementation Roadmap

### Phase 3a: Core Blockchain (Weeks 1-2) - 🔨 IN PROGRESS
- ✅ Phantom wallet client
- ✅ NFT transaction signer
- ✅ Payment transaction signer
- ✅ Solana RPC client
- ⏳ Integrate into audit pipeline (NEXT)
- ⏳ Test with devnet (NEXT)

### Phase 3b: Database & Persistence (Weeks 2-3) - 🔨 IN PROGRESS
- ✅ MongoDB client (mock mode ready)
- ✅ `/history` command
- ✅ `/subscribe` flow enhancement
- ⏳ Real MongoDB connection (NEXT)
- ⏳ Migrate audit_cache → database (NEXT)
- ⏳ Migrate quota_manager → database (NEXT)

### Phase 3c: Security & Production (Weeks 3-4) - ⏳ PENDING
- ⏳ Wallet session management
- ⏳ Transaction timeout handling
- ⏳ Error recovery flows
- ⏳ Rate limiting for signing requests
- ⏳ Transaction fee optimization

### Phase 3d: User Experience (Weeks 4-5) - ⏳ PENDING
- ⏳ `/confirm` command (retry signing)
- ⏳ `/remind` command (quota warnings)
- ⏳ Transaction status tracking
- ⏳ Detailed Solscan links
- ⏳ Referral system (earn free audits)

---

## Integration Points

### With Phase 2

**security_auditor.py**: 
- Stage 9 (new): Create NFT mint transaction
- Stage 10 (new): Request Phantom signature
- Stage 11 (new): Verify blockchain confirmation
- Stage 12 (new): Store in MongoDB

**payment_processor.py**:
- Enhanced with `create_subscription_payment()`
- Returns transaction data for signing

**quota_manager.py** → MongoDB (Phase 3b):
- Replace in-memory tracking
- Query historical usage
- Support subscription auto-renewal

**audit_cache.py** → MongoDB (Phase 3b):
- Replace LRU cache
- Query user history
- Support pagination

### New Dependencies

**Python Packages**:
```
pymongo>=4.5.0           # MongoDB driver
solders>=0.18.0          # Solana transaction building
solana>=0.30.0           # Solana RPC client
phantomjs2pdf>=1.0.0     # (Future) Phantom wallet SDK
```

**External Services**:
```
MongoDB Atlas               # Production database
Solana Mainnet RPC          # Blockchain verification
Metaplex Program            # NFT minting
Phantom Wallet API          # Transaction signing
```

---

## Testing Checklist

### Unit Tests
- [ ] Phantom wallet signing requests
- [ ] NFT metadata generation
- [ ] Payment transaction creation
- [ ] Solana RPC verification
- [ ] MongoDB CRUD operations

### Integration Tests
- [ ] End-to-end audit → NFT → payment flow
- [ ] Phantom wallet signing simulation
- [ ] Database audit retrieval
- [ ] `/history` command output

### Manual Tests (Devnet)
- [ ] Phantom wallet connection (mobile + web)
- [ ] NFT mint transaction signing
- [ ] Payment transaction confirmation
- [ ] Verify transaction on Solscan (devnet)
- [ ] Database persistence across restarts

### Production Checklist
- [ ] Phantom wallet address whitelisting
- [ ] Solana Network upgrades handled
- [ ] Transaction fee optimization
- [ ] Database backup strategy
- [ ] Error recovery procedures
- [ ] Monitoring and alerts

---

## Monitoring & Analytics

### Key Metrics

- **NFT Minting Success Rate**: % of audits with NFT
- **Payment Confirmation Time**: Avg blockchain confirmation
- **Phantom Wallet Adoption**: % of users using wallet
- **Subscription Conversion Rate**: Free → Premium tier
- **Transaction Cost Average**: SOL spent per audit
- **Database Query Performance**: Avg history retrieval time

### Alerts

- 🔴 NFT minting failure rate > 5%
- 🔴 Payment confirmation timeout > 2 minutes
- 🔴 Database response time > 500ms
- ⚠️ Signature request expiry rate > 20%
- ⚠️ Free tier → Premium conversion < 5%

---

## Security Considerations

### Wallet Security
- Never request user private keys
- Use Phantom's native signing flow
- Verify signatures before blockchain submission
- Implement session timeouts

### Payment Security
- Verify amount matches quoted price
- Check recipient addresses (integrity.molt hotword)
- Store transaction hashes immutably
- Implement replay attack protection

### Database Security
- Encrypt sensitive fields (audit findings, balance)
- Use MongoDB access control lists
- Implement audit logging
- Regular backup testing

---

## Files Modified

| File | Changes |
|------|---------|
| `src/phantom_wallet.py` | NEW - Phantom wallet integration |
| `src/nft_signer.py` | NEW - NFT transaction signing |
| `src/payment_signer.py` | NEW - Payment transaction signing |
| `src/solana_rpc.py` | NEW - Solana blockchain verification |
| `src/database.py` | NEW - MongoDB persistence layer |
| `src/telegram_bot.py` | +`/history` & enhanced `/subscribe` |
| `.env.example` | Add MONGODB_URI, SOLANA_RPC (future) |
| `requirements.txt` | Add pymongo, solders, solana (Phase 3b) |

---

## Next Steps

### Immediate (Next 24 hours)
1. ✅ Create core Phase 3 modules (DONE)
2. ⏳ Test modules locally
3. ⏳ Commit to GitHub
4. ⏳ Update requirements.txt

### This Week
1. ⏳ Integrate Phase 3 into audit pipeline
2. ⏳ Test with Solana devnet
3. ⏳ Setup MongoDB Atlas (production)
4. ⏳ Deploy enhanced Telegram bot to Railway

### Next Week
1. ⏳ Migrate caches to MongoDB
2. ⏳ Implement auto-renewal subscriptions
3. ⏳ Add payment retry logic
4. ⏳ Performance optimization

---

**Date**: February 27, 2026  
**Phase**: Phase 3 - 25% Complete  
**Next Review**: March 3, 2026  
**Status**: 🔨 In Active Development
