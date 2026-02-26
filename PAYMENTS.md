# Solana Payment Processing

## Overview
integrity.molt charges SOL for security audits, with pricing based on:
- **Audit complexity**: Number of GPT-4 tokens used
- **Risk level**: Contract risk score determines multiplier
- **User type**: Subscribers get 20% discount

## Phase Breakdown

### Phase 2: Payment Request Generation (✅ CURRENT)
- Calculate audit fee based on complexity
- Generate payment request with 15-minute expiry
- Prepare transaction payload (unsigned)
- Track payment history in memory
- **Status**: Ready for Phase 3 signing

### Phase 3: Payment Processing
- User signs payment transaction in Phantom/web3
- Submit transaction to Solana blockchain
- Confirm payment received
- Unlock audit report
- Update subscription usage

### Phase 4: Advanced Features
- Refunds on failed/repeated audits
- Bulk purchasing discounts
- Tiered subscription plans
- Revenue sharing with marketplace

## Pricing Model

```
Base fee: 0.005 SOL

Token cost: (tokens_used / 1,000,000) SOL
            (negligible for most audits)

Risk multiplier:
1-2: 1.0x   (low risk)
3-4: 1.1x   (medium risk)
5: 1.2x     (medium-high)
6-7: 1.5x-1.8x (high risk)
8-10: 2.0x-3.0x (critical risk)

Subscriber discount: -20%
Monthly subscription: 0.1 SOL (~$6 USD)
```

## Fee Examples

### Low-Risk Contract (Risk Score 2)
- Base: 0.005 SOL
- Tokens: 1,000 → +0.000001 SOL
- Multiplier: 1.0x
- **Total: 0.005001 SOL (~$0.30 USD)**

### High-Risk Contract (Risk Score 7)
- Base: 0.005 SOL
- Tokens: 1,234 → +0.000001 SOL
- Multiplier: 1.8x
- **Total: 0.009002 SOL (~$0.54 USD)**

### With Subscription (20% off)
- High-risk contract: 0.009002 SOL
- Discount: -0.0018004 SOL
- **Total: 0.0072016 SOL (~$0.43 USD)**

## Integration with Audit Flow

```
1. User: /audit contract_address
   ↓
2. GPT-4 Analysis + Pattern Detection
   ↓
3. R2 Upload (report storage)
   ↓
4. NFT Anchor (audit hash)
   ↓
5. Fee Calculation ✅
   ├─ Tokens used: 1,234
   ├─ Risk score: 7
   └─ User type: subscriber
   ↓
6. Payment Request Created ✅
   ├─ Amount: 0.0072 SOL
   ├─ Expiry: 15 minutes
   └─ Payment ID: payment_5940877089_1772105347
   ↓
7. [Phase 3] User signs in Phantom
   ↓
8. [Phase 3] Transaction submitted to Solana
   ↓
9. [Phase 3] Payment confirmed
   ↓
10. Telegram: Report + Payment confirmation
```

## API Reference

### Calculate Audit Fee

```python
from src.payment_processor import calculate_audit_fee

result = calculate_audit_fee(
    tokens_used=1234,
    risk_score="7",
    is_subscriber=True
)

# Response:
# {
#     "status": "calculated",
#     "fee_sol": 0.0072,
#     "fee_lamports": 7200000,
#     "breakdown": {
#         "base_fee_sol": 0.005,
#         "token_fee_sol": 0.000001,
#         "risk_multiplier": 1.8,
#         "discount_sol": 0.0018,
#         "is_subscriber": True
#     }
# }
```

### Create Payment Request

```python
from src.payment_processor import payment_processor

request = payment_processor.create_payment_request(
    contract_address="EvXNCtao...",
    user_id=5940877089,
    tokens_used=1234,
    risk_score="7",
    is_subscriber=True
)

# Response:
# {
#     "payment_id": "payment_5940877089_1772105347",
#     "status": "pending",
#     "amount_sol": 0.0072,
#     "amount_lamports": 7200000,
#     "expiry": "2026-02-26T12:44:07Z",
#     "phase": "2-pending-signature"
# }
```

### Confirm Payment (Phase 3+)

```python
result = payment_processor.confirm_payment(
    payment_id="payment_5940877089_1772105347",
    transaction_hash="4z9zzz..."
)

# Response:
# {
#     "status": "confirmed",
#     "payment_id": "payment_5940877089_1772105347",
#     "amount_sol": 0.0072,
#     "transaction_hash": "4z9zzz...",
#     "confirmed_at": "2026-02-26T12:30:15Z"
# }
```

### Add Subscription

```python
sub = payment_processor.add_subscription(
    user_id=5940877089,
    duration_days=30,
    transaction_hash="5a0aaa..."
)

# Response:
# {
#     "user_id": 5940877089,
#     "status": "active",
#     "expires_at": "2026-03-28T12:30:15Z",
#     "cost_sol": 0.1,
#     "audits_included": 30,
#     "audits_used": 0
# }
```

### Get User Balance

```python
info = payment_processor.get_user_balance_info(user_id=5940877089)

# Response:
# {
#     "user_id": 5940877089,
#     "is_subscriber": True,
#     "total_payments": 5,
#     "total_spent_sol": 0.042,
#     "audits_completed": 5,
#     "payment_history": [...]
# }
```

## Telegram Payment Display

Example Telegram message after audit:

```
📋 **Security Audit Report for EvXNCtaoVuC1NQLQswAnqsbQK...** (EvXNCtao...)

⚠️ **Pre-Analysis Detections**:
🔴 1 CRITICAL pattern(s) detected

**Detailed Analysis**:
[GPT-4 findings...]

💰 **Payment Required**
Amount: `0.0072000 SOL` (20% subscriber discount applied)
Payment ID: `payment_5940877089_1772105347`
⏰ Expires in 15 minutes
```

## Payment Flow Diagram

### Phase 2 (Current)
```
User Telegram Message
    ↓
Calculate Audit Fee
    ↓
Generate Payment Request
    ↓
Send Telegram: "Fee: 0.0072 SOL"
    ↓
⏳ Wait for Phase 3 (User signs payment)
```

### Phase 3 (Implementation)
```
User clicks "Pay in Phantom"
    ↓
Phantom opens payment dialog
    ↓
User confirms + signs transaction
    ↓
Transaction submitted to Solana RPC
    ↓
Bot confirms payment received
    ↓
Telegram: "Audit confirmed! Access report..."
```

## Solana RPC Integration (Phase 3)

To implement Phase 3 payment confirmation:

```python
from solders.rpc.responses import SendTransactionResp
from solana.rpc.api import Client

# Verify transaction on Solana
rpc = Client("https://api.mainnet-beta.solana.com")
tx_sig = "4z9zzz..."

# Check transaction status
status = rpc.get_transaction(tx_sig)
if status.value and status.value.transaction.meta.err is None:
    # Payment successful
    payment_processor.confirm_payment(payment_id, tx_sig)
```

## Wallet Configuration (Phase 3)

1. Create `integrity.molt` Solana wallet (mainnet)
2. Store public key in environment
3. Use Molt.id domain signer for receiving payments
4. Implement transaction verification

## Payment History Example

```json
{
  "payment_id": "payment_5940877089_1772105347",
  "user_id": 5940877089,
  "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
  "timestamp": "2026-02-26T12:30:15Z",
  "amount_sol": 0.0072,
  "amount_lamports": 7200000,
  "status": "confirmed",
  "transaction_hash": "4z9zzz...",
  "fee_breakdown": {
    "base_fee_sol": 0.005,
    "token_fee_sol": 0.000001,
    "risk_multiplier": 1.8,
    "discount_sol": 0.0018,
    "is_subscriber": true
  }
}
```

## Security Considerations

- **Non-custodial**: User signs payments with their own wallet
- **No private keys**: System never handles user private keys
- **Open verification**: All payments visible on Solscan
- **Immutable records**: Payment history in memory (DB in Phase 3+)
- **Subscriber trust**: Repeating audits same contract = free (verified)

## Error Handling

```python
# Expired payment request (15 min timeout)
{
    "status": "expired",
    "message": "Payment request expired (15 minutes)"
}

# Failed fee calculation
{
    "status": "error",
    "error": "Invalid risk score"
}

# User not found
{
    "status": "error",
    "error": f"Payment {payment_id} not found"
}
```

## Testing

```bash
# Test payment processor
python -m src.payment_processor

# Run all tests
python -m pytest tests/ -v

# Manual fee calculation
python -c "from src.payment_processor import calculate_audit_fee; print(calculate_audit_fee(1234, '7', True))"
```

## Roadmap

| Feature | Phase | Status |
|---------|-------|--------|
| Fee calculation | 2 | ✅ |
| Payment request generation | 2 | ✅ |
| Subscription management | 2 | ✅ |
| User balance tracking | 2 | ✅ |
| Telegram payment display | 2 | ✅ |
| Payment signing (Phantom) | 3 | 🔜 |
| Transaction verification | 3 | 🔜 |
| Payment confirmation | 3 | 🔜 |
| Refund processing | 3 | 🔜 |
| Revenue analytics | 4 | 🔜 |
| Secondary payment split | 4 | 🔜 |

---
Last updated: February 26, 2026
**Implementation**: Phase 2 complete → Phase 3 ready for signing integration
