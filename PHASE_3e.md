# Phase 3e: Moltbook & OpenClaw Integration

## Overview

Phase 3e integrates **integrity.molt** with:
- **Moltbook Platform** (app.molt.id) - Marketplace for AI agents
- **OpenClaw Infrastructure** - Cloudflare Workers-based deployment
- **Webhook Publishing** - Real-time audit result distribution
- **Agent Profile Management** - On-chain agent metadata

**Status:** In Development  
**Target Deployment:** app.molt.id (Moltbook)  
**Infrastructure:** OpenClaw (Solana + Cloudflare)  
**Estimated Time:** 20-30 minutes

---

## Architecture

```
┌─────────────────────┐
│  integrity.molt     │
│  (Your Telegram Bot)│
└────────────┬────────┘
             │
    ┌────────▼─────────────┐
    │  Moltbook Platform   │
    ├──────────────────────┤
    │ • app.molt.id        │
    │ • Marketplace        │
    │ • Agent registry     │
    │ • Payment processor  │
    └────────┬─────────────┘
             │
    ┌────────▼─────────────┐
    │  OpenClaw Workers    │
    ├──────────────────────┤
    │ • Cloudflare Workers │
    │ • Webhook delivery   │
    │ • Event processing   │
    │ • Auto-scaling       │
    └──────────────────────┘
```

---

## Setup Instructions

### 1. Prerequisites

**Moltbook Account:**
```bash
# Navigate to app.molt.id
# Sign in or create account (connected to Phantom wallet)
# Verify ownership of .molt domain
```

**OpenClaw CLI Installation:**
```bash
npm install -g @moltbook/openclaw

# Verify installation
openclaw --version
# Output: openclaw/v1.x.x
```

**Environment Variables:**
```bash
# Add to .env file:
OPENCLAW_TOKEN=your_openclaw_api_token_here
OPENCLAW_URL=https://integrity.molt.openclaw.io
AGENT_ID=integrity_molt_agent
MOLTBOOK_API_KEY=your_moltbook_api_key
DISCORD_AUDIT_WEBHOOK=https://discord.com/api/webhooks/your_webhook
```

### 2. Get OpenClaw Token

**Step 1: Access Moltbook Dashboard**
1. Go to app.molt.id
2. Navigate to "Agent Settings"
3. Click "Generate OpenClaw Token"
4. Copy and save token securely

**Step 2: Configure Token**
```bash
export OPENCLAW_TOKEN="tok_1234567890abcdef"
export OPENCLAW_URL="https://integrity.molt.openclaw.io"
```

### 3. Register Domain on Moltbook

```bash
# Initialize OpenClaw infrastructure
python -c "from src.openclaw_agent import initialize_openclaw; initialize_openclaw()"

# Expected output:
# [INFO] Initializing OpenClaw infrastructure...
# [INFO]   ✅ deployment: success
# [INFO]   ✅ domain: registered
# [INFO]   ✅ health_check: configured
# [INFO]   ✅ webhooks: enabled
```

### 4. Deploy to OpenClaw

**Option A: Automatic via Moltbook Dashboard**
1. Go to app.molt.id → Deployments
2. Click "Deploy to OpenClaw"
3. Select Docker image or Git repo
4. Click "Deploy"
5. Wait 2-3 minutes for deployment to complete

**Option B: Manual via OpenClaw CLI**
```bash
# From your repository
openclaw deploy \
  --domain integrity.molt \
  --token $OPENCLAW_TOKEN \
  --entrypoint "python -m src"

# Expected output:
# ✅ Deployed to OpenClaw: integrity.molt
# 🌍 Live at: https://integrity.molt.openclaw.io
```

### 5. Setup Marketplace Webhooks

```bash
# Subscribe to marketplace events
python -c "
from src.moltbook_integration import moltbook_integration
import asyncio
asyncio.run(moltbook_integration.subscribe_to_marketplace_events())
"

# Expected output:
# ✅ Subscribed to Moltbook marketplace events
# Listening for: audit_request, payment_confirmed, subscription_updated
```

### 6. Test Integration

**Test 1: Verify OpenClaw Deployment**
```bash
# From CLI
openclaw status \
  --domain integrity.molt \
  --token $OPENCLAW_TOKEN

# Expected output:
# Status: ACTIVE
# Uptime: 99.9%
# Version: production
```

**Test 2: Verify Moltbook Connection**
```bash
# Check agent profile on Moltbook
curl -H "Authorization: Bearer $MOLTBOOK_API_KEY" \
  https://api.moltbook.io/v1/agents/integrity_molt_agent

# Expected: Agent metadata and stats
```

**Test 3: Send Audit to Marketplace**
```python
from src.moltbook_integration import publish_audit_to_marketplace
import asyncio

audit_result = {
    "audit_id": "test_123",
    "contract_address": "Test...Contract",
    "risk_score": 7,
    "findings": [{"type": "reentrancy", "severity": "high"}],
    "report_url": "https://app.molt.id/audits/test_123",
    "cost_usd": 0.05,
    "user_id": 12345
}

asyncio.run(publish_audit_to_marketplace(audit_result))
# Expected: Audit published to marketplace and announced in Discord
```

---

## Features Implemented

### Moltbook Integration (`src/moltbook_integration.py`)

**Key Methods:**
- `publish_audit_report()` - Publish audit to marketplace
- `update_agent_profile()` - Update stats on Moltbook
- `subscribe_to_marketplace_events()` - Listen for webhook events
- `announce_audit_in_discord()` - Post to Molt Discord channel

**Automated Workflows:**
- ✅ Each audit automatically published to marketplace
- ✅ Risk score visualized with emoji (🟩 🟨 🟧 🔴)
- ✅ Discord notifications for new audits
- ✅ Agent profile auto-updated hourly

### OpenClaw Integration (`src/openclaw_agent.py`)

**Key Methods:**
- `deploy_to_openclaw()` - Deploy to OpenClaw infrastructure
- `register_agent_domain()` - Register integrity.molt domain
- `setup_health_check()` - Configure /health endpoint
- `get_deployment_status()` - Monitor active deployment
- `rollback_deployment()` - Instant rollback to previous version
- `enable_webhooks()` - Setup event webhooks
- `get_agent_metrics()` - Fetch performance metrics

**Auto-Features:**
- ✅ Zero-downtime deployments
- ✅ Instant rollback capability
- ✅ Health monitoring every 30 seconds
- ✅ Webhook event delivery
- ✅ Performance metrics tracking

---

## Configuration Examples

### Moltbook API (.env)
```bash
# Required
MOLTBOOK_API_KEY=key_abc123def456
AGENT_ID=integrity_molt_agent

# Optional but recommended
DISCORD_AUDIT_WEBHOOK=https://discord.com/api/webhooks/123/abc
```

### OpenClaw Configuration (.env)
```bash
# Required for OpenClaw deployment
OPENCLAW_TOKEN=tok_cloudflare_token_here
OPENCLAW_URL=https://integrity.molt.openclaw.io

# Health check settings
HEALTH_CHECK_INTERVAL=30
HEALTH_CHECK_TIMEOUT=10
```

---

## Usage Examples

### Publish Audit Automatically
```python
# Called after every audit completion
from src.security_auditor import SecurityAuditor
from src.moltbook_integration import publish_audit_to_marketplace

audit_result = SecurityAuditor.analyze_contract(...)

# Automatically publish to Moltbook
await publish_audit_to_marketplace(audit_result)
```

### Monitor OpenClaw Deployment
```python
from src.openclaw_agent import openclaw_agent

# Check deployment status
status = openclaw_agent.get_deployment_status()
print(f"Status: {status['status']}")

# Get performance metrics
metrics = openclaw_agent.get_agent_metrics()
print(f"Response time: {metrics['response_time_ms']}ms")
```

### Update Agent Profile
```python
from src.moltbook_integration import moltbook_integration
import asyncio

# Update profile with latest stats
profile = await moltbook_integration.update_agent_profile()
print(f"Profile updated: {profile['last_updated']}")
```

---

## Webhook Events

### Marketplace Event Types

**audit_request**
```json
{
  "type": "audit_request",
  "contract_address": "EvXNCtao...",
  "user_id": 12345,
  "timestamp": "2026-02-26T14:30:00Z"
}
```

**payment_confirmed**
```json
{
  "type": "payment_confirmed",
  "amount_sol": 0.5,
  "user_id": 12345,
  "audit_id": "audit_123"
}
```

**subscription_updated**
```json
{
  "type": "subscription_updated",
  "user_id": 12345,
  "tier": "premium",
  "expires_at": "2026-03-26T14:30:00Z"
}
```

---

## Monitoring & Alerts

### Key Metrics to Track

**Agent Health:**
- Uptime (target: 99.5%)
- Response time (target: < 5s)
- Error rate (target: < 1%)

**Marketplace Activity:**
- Audits published (track growth)
- Revenue per audit
- User acquisition rate

**OpenClaw Performance:**
- Deployment success rate
- Rollback frequency
- Webhook delivery success

### Alert Thresholds

```
CRITICAL:
- Agent down > 5 minutes
- Error rate > 5%
- Marketplace API unreachable

WARNING:
- Response time > 10s
- Deployment failed
- Webhook backlog > 100
```

---

## Troubleshooting

### "OpenClaw CLI not found"
```bash
# Install OpenClaw CLI
npm install -g @moltbook/openclaw

# Verify
openclaw --version
```

### "Moltbook API credentials not configured"
```bash
# Check .env file has required variables
cat .env | grep MOLTBOOK
# Output should show: MOLTBOOK_API_KEY=...

# If missing, add to .env and restart bot
```

### "Deployment failed on OpenClaw"
```bash
# Check deployment logs
openclaw logs --domain integrity.molt --token $OPENCLAW_TOKEN

# Rollback if needed
openclaw rollback --domain integrity.molt --token $OPENCLAW_TOKEN
```

### "Webhook events not being delivered"
```bash
# Verify webhook URL is accessible
curl -X POST https://integrity.molt.openclaw.io/webhooks/moltbook \
  -H "Content-Type: application/json" \
  -d '{"test": "true"}'

# Check webhook subscription status
python -c "
from src.moltbook_integration import moltbook_integration
import asyncio
# (Would need to add method to check status)
"
```

---

## Post-Deployment Checklist

- [ ] OpenClaw CLI installed and verified
- [ ] OPENCLAW_TOKEN configured in .env
- [ ] MOLTBOOK_API_KEY configured in .env
- [ ] Agent domain registered on Moltbook
- [ ] Deployment successful (`openclaw status` shows ACTIVE)
- [ ] Health check endpoint responding (/health → 200 OK)
- [ ] Webhooks subscribed and receiving events
- [ ] Audit published to marketplace test
- [ ] Discord announcement received
- [ ] Agent profile visible on app.molt.id

---

## Cost Analysis

| Service | Cost | Notes |
|---------|------|-------|
| OpenClaw | $5-50/month | Based on usage (Cloudflare pricing) |
| Moltbook | Free | Agent listing is free |
| Marketplace | 2% fee | On audit revenue (automatic) |
| Discord | Free | Webhook announcements |
| **Total** | **$5-50/month** | Scales with usage |

---

## Next Steps (Phase 3f)

1. **Multi-currency Payments**
   - Support SOL, USDC, USDT on Solana
   - Auto-conversion pricing

2. **Custom Audit Rules**
   - Allow users to configure pattern detection
   - Custom risk scoring

3. **Advanced Dashboards**
   - Real-time audit metrics on app.molt.id
   - User statistics and analytics

4. **API Rate Scaling**
   - Faster OpenClaw deployment
   - Dedicated agent instances

---

**Status:** ✅ Phase 3e Documentation Complete  
**Implementation:** In Progress  
**Estimated Completion:** Feb 27, 2026  
**Next Phase:** 3f - Custom audit rules & advanced features
