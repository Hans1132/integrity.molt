# Rate Limiting & Quotas - integrity.molt

## Overview

The integrity.molt security auditor implements comprehensive rate limiting and quota management to:
- Prevent abuse and DoS attacks
- Manage API costs within budget
- Ensure fair access for free tier users
- Provide premium features for subscribers

## Architecture

### Components

1. **QuotaManager** (`src/quota_manager.py`)
   - Tracks audit usage per user
   - Enforces rate limits (hourly, daily, monthly)
   - Manages budget tracking in SOL
   - Provides tier-based quotas

2. **SecurityAuditor** (`src/security_auditor.py`)
   - Stage -1: Checks quota before starting audit
   - Stage 8: Records quota usage after successful audit
   - Returns `quota_exceeded` status if limits reached

3. **TelegramBot** (`src/telegram_bot.py`)
   - `/quota` command: Show user quota status
   - `/subscribe` command: Upgrade subscription
   - `/audit`: Enhanced with quota feedback

4. **PaymentProcessor** (`src/payment_processor.py`)
   - `create_subscription_payment()`: Generate subscription payment request
   - Tier pricing and benefits

## Subscription Tiers

### Free Tier (Default)
- **Hourly Limit**: 2 audits/hour
- **Daily Limit**: 5 audits/day
- **Monthly Limit**: 20 audits/month
- **Monthly Budget**: 0.1 SOL (~$6 USD)
- **Cost**: Free
- **Features**: Basic security analysis

### Subscriber Tier ($0.1 SOL/month ~$6 USD)
- **Hourly Limit**: 10 audits/hour (5x)
- **Daily Limit**: 50 audits/day (10x)
- **Monthly Limit**: 999 audits (unlimited)
- **Monthly Budget**: 10 SOL (~$600 USD)
- **Cost**: 0.1 SOL (~$6 USD)
- **Features**:
  - Higher rate limits
  - Priority audit queue
  - Audit history retention
  - Email notifications (future)

### Premium Tier ($1.0 SOL/month ~$60 USD)
- **Hourly Limit**: 20 audits/hour
- **Daily Limit**: 100 audits/day
- **Monthly Limit**: 9999 audits (unlimited)
- **Monthly Budget**: 100 SOL (~$6,000 USD)
- **Cost**: 1.0 SOL (~$60 USD)
- **Features**:
  - Highest rate limits
  - Highest monthly budget
  - API access (future)
  - Custom report formats (future)

### Global Limits (DoS Protection)
- **Per Minute**: 100 audits/minute (across all users)
- **Per Hour**: 10,000 audits/hour (across all users)

## Usage Example

### Telegram Bot

```
User: /quota
Bot: 📊 **Your Quota Status**

Tier: 📊 FREE (0/2 audits this hour)

Hourly Limit: 0/2 audits
Daily Limit: 2/5 audits
Monthly Limit: 15/20 audits

Budget: 0.043 SOL / 0.1 SOL (monthly)

💡 Upgrade to /subscribe for 5x more audits!
```

```
User: /subscribe
Bot: ⭐ **Subscribe to Premium**

Amount: 0.1 SOL (~$6 USD)
Duration: 30 days

You'll get:
✅ 5x higher audit limits
✅ Unlimited monthly audits
✅ Priority support

Send 0.1 SOL to: [Phase 3 - Phantom wallet]
```

### Python Code

```python
from src.quota_manager import quota_manager
from src.security_auditor import SecurityAuditor

# Check quota before audit
user_id = 12345
cost_estimate = 0.009

quota_check = quota_manager.can_audit(user_id, cost_estimate)
if not quota_check["allowed"]:
    print(f"Audit blocked: {quota_check['reason']}")
    # Return error to user
    return

# Run audit
result = SecurityAuditor.analyze_contract(
    contract_address="...",
    user_id=user_id
)

# Quota automatically recorded in Stage 8
print(result.get("quota_remaining"))
```

## Implementation Details

### QuotaManager State

```python
class QuotaManager:
    # In-memory storage (Phase 2)
    # Structure: user_id -> {
    #   "tier": "free"|"subscriber"|"premium",
    #   "audits_this_hour": int,
    #   "audits_today": int,
    #   "audits_this_month": int,
    #   "spent_this_month_sol": float,
    #   "last_reset": datetime,
    #   "subscription_expires": datetime
    # }
```

### Quota Reset Schedule
- **Hourly**: Every hour (from first audit in hour)
- **Daily**: Every 24 hours (from first audit in day)
- **Monthly**: Every calendar month (on 1st)

### Cost Tracking

Each audit cost is calculated:
```
Cost = (0.005 SOL base) + (tokens × 1e-6) + (risk multiplier)
```

If user exceeds monthly budget:
- **Free tier**: 0.1 SOL limit
  - If exceeded → Return "Budget exceeded" error
- **Subscriber**: 10 SOL limit
  - If exceeded → Warn user, still allow audit
- **Premium**: 100 SOL limit
  - If exceeded → Warn user, still allow audit

## Phase 2 Implementation

✅ **Completed**:
- Basic rate limiting (hourly, daily, monthly)
- Tier-based quotas
- Budget tracking per user
- Global DoS protection
- In-memory quota storage
- `can_audit()` check in SecurityAuditor
- `record_audit()` recording in SecurityAuditor
- `/quota` Telegram command
- `/subscribe` command (payment generation)

## Phase 3+ Roadmap

📋 **Planned**:
1. **Database Persistence** (MongoDB/PostgreSQL)
   - Replace in-memory QuotaManager
   - Add quota history and analytics

2. **Subscription Management**
   - Payment confirmation via Solana RPC
   - Auto-renew subscription
   - Cancel subscription command

3. **Advanced Features**
   - Usage alerts (80% quota consumed)
   - Auto-downgrade on subscription expiry
   - Referral bonuses (free audits for invites)
   - Audit package bundles (5 audits, 10 audits)

4. **Analytics & Reporting**
   - User usage dashboard
   - Revenue tracking
   - Quota optimization recommendations

5. **Integration**
   - `/remind` command for quota warnings
   - Email notifications
   - Discord webhook for usage events

## Error Handling

### Quota Exceeded Responses

```python
# Hourly limit reached
{
    "status": "quota_exceeded",
    "reason": "Hourly audit limit reached (2/2)",
    "quota_info": {
        "audits_this_hour": 2,
        "hourly_limit": 2,
        "audits_remaining_hour": 0
    }
}

# Budget exceeded
{
    "status": "quota_exceeded",
    "reason": "Monthly budget exceeded (0.101/0.1 SOL)",
    "quota_info": {
        "spent_this_month_sol": 0.101,
        "budget_limit_sol": 0.1
    }
}
```

### Telegram Bot Response

```
❌ **Audit Limit Reached**

Reason: Hourly audit limit reached (2/2)

📊 Your Limits:
⏱️ Hourly: 2/2 (reset in 45 minutes)
📅 Daily: 4/5 (reset tomorrow)
📆 Monthly: 18/20 (reset Feb 28)

💡 Upgrade to /subscribe for higher limits!
```

## Testing

### Unit Tests
```bash
python -m pytest tests/test_quota_manager.py -v
```

### Integration Test
```bash
python -c "
from src.quota_manager import quota_manager
user_id = 999
for i in range(3):  # Try 3 audits
    can_audit = quota_manager.can_audit(user_id, 0.009)
    print(f'Audit {i+1}: Allowed = {can_audit[\"allowed\"]}')
    if can_audit['allowed']:
        quota_manager.record_audit(user_id, 0.009)
"
```

### Telegram Bot Test
```
/help    # Show commands
/quota   # Check current limits
/audit EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf  # First audit
/quota   # Check usage updated
```

## Monitoring

### Key Metrics to Track
1. **User Tier Distribution**: % Free vs Subscriber vs Premium
2. **Quota Enforcement**: # Times rate limit hit
3. **Budget Health**: Avg spend vs limit per tier
4. **Subscription Churn**: % of subscribers renewing
5. **Cache Hit Rate**: % of audits from cache vs new

### Alerts
- ⚠️ Alert if > 50% free users hitting rate limits
- ⚠️ Alert if global rate limit hit (100/min)
- ⚠️ Alert if subscriber churn > 10%
- 🔴 Alert if budget tracking inconsistency

## Files

| File | Purpose |
|------|---------|
| [src/quota_manager.py](src/quota_manager.py) | Core quota logic |
| [src/security_auditor.py](src/security_auditor.py) | Quota integration (Stage -1 & Stage 8) |
| [src/telegram_bot.py](src/telegram_bot.py) | Quota commands & feedback |
| [src/payment_processor.py](src/payment_processor.py) | Subscription payment creation |
| [tests/test_quota_manager.py](tests/test_quota_manager.py) | Quota unit tests |

## See Also
- [PAYMENTS.md](PAYMENTS.md) - Payment processing details
- [.github/copilot-instructions.md](.github/copilot-instructions.md) - Phase roadmap
- [AGENTS.md](AGENTS.md) - Agent architecture

---

**Last Updated**: February 27, 2026  
**Phase**: Phase 2 (In-Memory Quotas) + Phase 3 Roadmap  
**Status**: ✅ Phase 2 Complete, 📋 Phase 3 Planned
