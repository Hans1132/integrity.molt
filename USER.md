# User: integrity.molt User Data Model

## User Profile Structure

```json
{
  "user_id": 123456789,
  "username": "john_doe",
  "first_seen": "2026-02-25T10:30:00Z",
  "last_active": "2026-02-25T15:45:00Z",
  "email": null,
  
  "subscription": {
    "status": "active|inactive|expired",
    "tier": "free|starter|pro",
    "started": "2026-02-25T10:30:00Z",
    "expires": null,
    "auto_renew": false
  },
  
  "activity": {
    "total_audits": 42,
    "audits_this_month": 12,
    "audits_this_week": 3,
    "total_spent_sol": 0.5,
    "total_spent_usd": 25.00
  },
  
  "preferences": {
    "report_format": "brief|detailed",
    "telegram_notifications": true,
    "audit_reminders": false,
    "language": "en"
  },
  
  "audit_history": [
    {
      "id": "audit_hash_1",
      "contract": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
      "timestamp": "2026-02-25T15:45:00Z",
      "risk_score": 6,
      "report_url": "https://r2-bucket/users/123456789/audit_hash_1.json",
      "on_chain_proof": "metaplex_nft_address"
    }
  ]
}
```

## User Tiers (Phase 2)

### Free Tier
- ✅ Max 3 audits/month
- ✅ Basic report (1 page)
- ❌ No history retention
- ❌ No priority support
- **Cost:** $0 / month

### Starter Tier
- ✅ Max 20 audits/month
- ✅ Detailed report
- ✅ 6-month history
- ✅ Email support
- **Cost:** 1 SOL (~$160) / month

### Pro Tier
- ✅ Unlimited audits
- ✅ Real-time alerts
- ✅ Custom reports
- ✅ 1-year history
- ✅ Priority support
- **Cost:** 5 SOL (~$800) / month

## User Privacy

**Data Collection:**
- Telegram user ID (required)
- Telegram username (optional)
- Audit history (transactional)
- Spending data (for billing)

**Data NOT Collected:**
- Email (optional, for future)
- Phone number
- Location
- Personal information beyond audit requests

**Retention:**
- User profile: Indefinite (for returning users)
- Audit history: 1 year minimum
- Payment records: 7 years (legal requirement)
- Metadata: Auto-purge after 2 years inactivity

**Rights:**
- Users can request audit history export
- Users can request data deletion (Phase 2)
- Users can opt-out of non-essential features

## User Segmentation

### By Activity
- **Active:** Last audit < 7 days ago
- **Churned:** No audit in 30+ days
- **New:** First audit < 7 days ago

### By Spending
- **Free tier:** 0 SOL spent
- **Light users:** < 1 SOL spent
- **Heavy users:** > 10 SOL spent

### By Trust
- **Verified:** Paid for ≥ 5 audits
- **Reputation:** 50+ audits, avg score > 7
- **Contributor:** Submitted audit feedback

## User Engagement

**In-App Events Logged:**
- `/start` command (new user)
- `/audit` request (engagement)
- `/subscribe` success (conversion)
- Payment confirmation (monetization)
- `/help` command (support)

**Metrics Tracked:**
- Daily active users (DAU)
- Monthly active users (MAU)
- Churn rate (users inactive 30 days)
- Lifetime value (LTV = total spend)
- Average audit cost ($)

## User Support

**Common Questions:**
- Q: How much does an audit cost?
  A: Varies by complexity. Display estimate before confirming.

- Q: Can I get my audit report verified?
  A: Yes! Every audit has on-chain proof on Solscan.

- Q: What if the audit is wrong?
  A: Contact support (Phase 2). Provide contract address + audit ID.

**Escalation Path:**
1. Bot help messages → `/help` command
2. Email support → [support@integrity.molt]
3. Discord community → [Moltbook Discord]
4. Payment disputes → Phantom wallet transaction history
