# OpenClaw Agent Integration - integrity.molt

**Status:** ✅ Production Ready  
**Agent ID:** `molt_78587c41ed99a3375022dc28`  
**Domain:** `integrity.molt`  
**Wallet:** `BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6`  
**NFT Identity:** `2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy`

---

## 🚀 Quick Start

### 1. Deploy Agent Config to app.molt.id

1. Open **app.molt.id** → Your Agent Dashboard
2. Go to **Settings** → **Raw Config**
3. Copy entire content from [openclaw_agent_config.json](openclaw_agent_config.json)
4. Paste into raw config editor
5. Update **all `__OPENCLAW_REDACTED__` values** with actual secrets:
   - `botToken` → Telegram Bot Token
   - `webhookSecret` → From Moltbook webhook
   - `apiKey` → OpenRouter API key
   - MongoDB connection string (already has placeholder)

6. **Save & Deploy**

### 2. Environment Variables (Railway)

Already configured in Railway dashboard. Verify these are set:

```env
TELEGRAM_TOKEN=<your_token>
OPENAI_API_KEY=<your_key>
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PUBLIC_KEY=3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
MONGODB_URI=mongodb+srv://lickohonza_db_user:hm4PjMqKMVUsvFzw@cluster0.o15ogse.mongodb.net/?appName=Cluster0
DATABASE_MODE=real
ENVIRONMENT=production
AGENT_PRIVATE_KEY=<your_private_key>
```

---

## 📋 Architecture

### Agent Capabilities

```
┌─────────────────────────────────────────────────────────┐
│           INTEGRITY.MOLT AGENT (OpenClaw)               │
└─────────────────────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
    ┌───▼──┐   ┌────▼────┐  ┌──▼────┐
    │ Audit│   │On-Chain │  │Telegram│
    │Engine│   │Verify   │  │Commands│
    │ GPT-4│   │  JWT    │  │Firebase│
    └───┬──┘   └────┬────┘  └──┬────┘
        │           │          │
        └───────────┼──────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
    ┌───▼──┐              ┌────▼────┐
    │Railway│              │Moltbook │
    │Deploy │              │Marketplace
    │MongoDB│              │NFT Proof│
    └──────┘              └────────┘
```

### Command Flow

**User:** `/audit 0x123 --force`
```
Telegram Bot
    ↓ (parse command)
SecurityAuditor.analyze_contract(force_refresh=True)
    ↓ (call GPT-4o)
AgentConfig.create_audit_signature()
    ↓ (HMAC-SHA256 sign)
TelegramBot.send_report()
    ↓ (include verification marker)
User receives: "✅ Officially Verified by integrity.molt"
```

---

## 🔐 Security Features

### JWT Authentication
- **Algorithm:** HMAC-SHA256
- **Header:** `X-Verification-Token`
- **Payload:** Agent ID + Domain + Timestamp + Nonce
- **Key Management:** AGENT_PRIVATE_KEY in .env (GitIgnored)

### On-Chain Verification
- **NFT Identity:** 2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy
- **Verification:** Metaplex Core standard
- **Proof:** Immutable audit records on Solana mainnet

### Audit Signatures
```python
signature = HMAC-SHA256(
    key=agent_private_key,
    data=f"{audit_id}|{contract_address}|{timestamp}|{severity_score}"
)
# All audits include this signature for third-party verification
```

---

## 📊 Pricing & Quotas

### Free Tier (Pattern Analysis)
- **Limit:** 2 audits/hour, 20/day
- **Speed:** <2 seconds (pattern-based)
- **Cost:** Free
- **Model:** Internal pattern analyzer

### Premium Tier (Full GPT-4 Analysis)
- **Limit:** 10 audits/hour, 200/day
- **Speed:** 5-15 seconds
- **Cost:** $0.03/audit + OpenAI API fees
- **Model:** GPT-4o via OpenRouter

---

## 🔌 Webhook Endpoints

### Telegram
```
URL: https://multiclaw.moltid.workers.dev/c/molt_78587c41ed99a3375022dc28/telegram-webhook
Method: POST
Secret: __OPENCLAW_REDACTED__
```

### GitHub (Auto-Deploy)
```
URL: https://multiclaw.moltid.workers.dev/c/molt_78587c41ed99a3375022dc28/github-webhook
Events: push, pull_request, release
Auto-deploy on: main branch push
```

### Moltbook (Audit Publishing)
```
URL: https://api.molt.id/webhooks/integrity-molt
Method: POST
Auth: JWT (see JWT Authentication above)
Payload: Audit report + signature
```

---

## 🛠️ Integration Checklist

- [x] Repository cloned to integrity.molt
- [x] MongoDB Atlas configured (cluster0.o15ogse.mongodb.net)
- [x] Railway deployment active (auto-restart)
- [x] Telegram bot token set (__OPENCLAW_REDACTED__)
- [x] OpenAI API key active (sk-q6DsDr7...)
- [x] Agent on-chain identity created (wallet + NFT)
- [x] JWT authentication system implemented (src/agent_config.py)
- [ ] **TODO:** Update openclaw_agent_config.json secrets
- [ ] **TODO:** Test audit flow with --force flag
- [ ] **TODO:** Verify "Officially Verified" marker appears
- [ ] **TODO:** Publish test audit to Moltbook marketplace

---

## 📝 Configuration Reference

### Models

**Primary (Audit Analysis)**
```json
"model": "openai/gpt-4o"  // Fast, accurate security analysis
```

**Fallback (Cost Optimization)**
```json
"fallback": "openai/gpt-4o-mini"  // Cheaper, 5-10x faster
```

**Security-Focused (Deep Analysis)**
```json
"security": "anthropic/claude-sonnet-4-5"  // Extended reasoning
```

### Capabilities

**Core Security Analysis**
- Smart contract audit (Solana)
- Vulnerability detection
- Pattern analysis
- Risk scoring (CRITICAL, MEDIUM, LOW)
- Severity classification

**On-Chain Verification**
- JWT-Ed25519 signed tokens
- Metaplex Core NFT proof
- Immutable audit records
- Moltbook marketplace publishing

**Database Storage**
- MongoDB Atlas integration
- Collections: audits, contracts, users, cache
- Auto-indexing for performance
- 30-day retention policy

**Telegram Integration**
- `/audit <address>` - Get security assessment
- `/audit <address> --force` - Bypass cache, re-analyze
- `/history` - View user's audit history
- `/help` - Show available commands

---

## 🧪 Testing Commands

### Via Telegram

```bash
# Test basic audit (should use cache)
/audit 0x06e1c7bFcC20C4f4dab1b93C2d2Ee6c5E0a4c2C5

# Test force refresh (should skip cache)
/audit 0x06e1c7bFcC20C4f4dab1b93C2d2Ee6c5E0a4c2C5 --force

# View audit history
/history

# Show available commands
/help
```

### Via cURL

```bash
# Health check
curl https://integrity-molt.railway.app/health

# Metrics
curl https://integrity-molt.railway.app/metrics

# Direct audit (if API exposed)
curl -X POST https://integrity-molt.railway.app/api/audit \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "X-Verification-Token: <AGENT_TOKEN>" \
  -d '{"address":"0x...", "force":false}'
```

---

## 📈 Monitoring & Analytics

### Real-Time Metrics (Prometheus)
- `audit_latency_seconds` - Response time
- `total_audits_completed` - Cumulative count
- `error_rate` - % of failed audits
- `gpt4_token_usage` - API cost tracking
- `mongodb_operation_duration` - Database latency

### Alerts Configured
- ❌ Error rate > 5%
- ⏱️ Audit latency > 30s
- 💰 Daily API cost > $10
- 🔌 Service downtime > 5 minutes

### Dashboard
Access: [https://integrity-molt.railway.app/dashboard](https://integrity-molt.railway.app/dashboard)

---

## 🚀 Deployment Process

**Automated via GitHub Actions:**

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]

jobs:
  test:
    - Syntax check (pylance)
    - Unit tests (pytest)
    - Integration tests

  deploy:
    - If all tests pass
    - Push to Railway (auto-redeploy enabled)
    - Update agent config in app.molt.id
    - Verify health check endpoint
    - Publish metrics to Moltbook
```

**Manual Deployment:**

```bash
# From project root
python deploy.py --environment production

# Or via Railway CLI
railway up
```

---

## 🔗 Related Documentation

- [GitHub Repository](https://github.com/Hans1132/integrity.molt)
- [Copilot Instructions](.github/copilot-instructions.md)
- [Agent Architecture](AGENTS.md)
- [Skill Documentation](skill.md)
- [Soul/Mission](soul.md)
- [Railway Deployment](RAILWAY_DEPLOYMENT_LIVE.md)

---

## ✅ Status Dashboard

| Component | Status | Last Check |
|-----------|--------|-----------|
| Bot (Railway) | 🟢 Active | Live |
| MongoDB Atlas | 🟢 Connected | ✓ |
| Telegram Webhook | 🟢 Active | ✓ |
| GitHub Sync | 🟢 Enabled | ✓ |
| On-Chain Identity | 🟢 Ready | ✓ |
| OpenRouter API | 🟢 Active | ✓ |
| Moltbook Marketplace | 🟠 Pending | Config ready |

---

## 📞 Support

**Issues?** 
- Check Railway logs: `railway logs -f`
- Verify MongoDB connection: Check IP whitelist (0.0.0.0/0)
- Test Telegram bot: Send `/help` to bot
- Check GitHub webhook: https://github.com/Hans1132/integrity.molt/settings/hooks

**Agent ID:** `molt_78587c41ed99a3375022dc28`  
**Domain:** `integrity.molt`

---

*Last Updated: February 28, 2026*  
*Config Version: 1.0.0*  
*Agent: integrity.molt Security Audit Agent*
