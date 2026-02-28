# ✅ Autonomous Agent Deployment Checklist

Complete checklist for deploying integrity.molt as a fully autonomous money-earning agent on Moltbook.

**Updated**: February 28, 2026  
**Phase**: Phase 3g - Autonomous & Monetization

---

## 📋 Pre-Deployment (Local Setup)

- [ ] **Clone/pull latest code**
  ```bash
  git pull origin main
  ```

- [ ] **Install dependencies**
  ```bash
  pip install -r requirements.txt
  ```
  - ✅ Includes: FastAPI, Uvicorn, Pydantic

- [ ] **Create/update `.env`**
  ```bash
  cp .env.example .env
  # Edit with your actual values
  ```

- [ ] **Validate all required variables**
  ```bash
  python3 -c "from src.config import validate_config; validate_config()"
  ```
  Must have:
  - [ ] `TELEGRAM_TOKEN`
  - [ ] `OPENAI_API_KEY`
  - [ ] `SOLANA_PUBLIC_KEY`
  - [ ] `MONGODB_URI`
  - [ ] `MOLTBOOK_API_KEY` (new)
  - [ ] `MOLTBOOK_WEBHOOK_SECRET` (new)

- [ ] **Test locally**
  ```bash
  python -m src
  ```
  Should see:
  - ✅ Telegram bot thread started
  - ✅ Marketplace API thread started
  - ✅ Autonomous auditor thread started

- [ ] **Test Telegram bot**
  ```bash
  Send: /help
  Expect: Command list
  ```

- [ ] **Test FastAPI/health check**
  ```bash
  curl http://localhost:8000/health
  Expect: {"status": "healthy"}
  ```

- [ ] **Test earnings endpoint**
  ```bash
  curl http://localhost:8000/earnings
  Expect: {"total_audits": 0, ...}
  ```

---

## 🚀 Deploy to Railway

- [ ] **Commit code changes**
  ```bash
  git add -A
  git commit -m "Deploy autonomous agent with FastAPI marketplace integration"
  ```

- [ ] **Push to GitHub**
  ```bash
  git push origin main
  ```
  - Railway auto-detects changes
  - Auto-builds Docker image
  - Auto-starts new deployment

- [ ] **Verify Railway build succeeded**
  - Go to: https://railway.app/dashboard
  - Select project: `integrity.molt`
  - Check deployments tab
  - Look for green checkmark ✅

- [ ] **Monitor deploy logs**
  ```bash
  railway logs --follow
  ```
  Wait for:
  - "Application startup complete"
  - "integrity.molt is now FULLY OPERATIONAL"

- [ ] **Update/verify environment variables on Railway**
  - Go to: Project → Variables
  - Ensure all variables set (see pre-deployment)
  - Add new variables:
    - [ ] `MARKETPLACE_API_PORT=8000`
    - [ ] `MAX_CONCURRENT_AUDITS=3`
    - [ ] `AUDIT_QUEUE_CHECK_INTERVAL=5`

- [ ] **Find your Railway domain**
  - Go to: Project → Networking
  - Public URL format: `https://integrity-molt--production-XXXX.railway.app`
  - Copy and save this URL

---

## 🔗 Integrate with Moltbook

- [ ] **Register webhook with Moltbook**
  ```bash
  export RAILWAY_DOMAIN="https://integrity-molt--production-XXXX.railway.app"
  export MOLTBOOK_API_KEY="sk_live_xxxxx"
  export WEBHOOK_SECRET="your_secret_here"
  
  curl -X POST https://api.molt.id/webhooks/subscribe \
    -H "Authorization: Bearer $MOLTBOOK_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "agent_id": "molt_78587c41ed99a3375022dc28",
      "webhook_url": "'$RAILWAY_DOMAIN'/webhooks/audit",
      "events": ["audit_request", "payment_confirmed"],
      "secret": "'$WEBHOOK_SECRET'"
    }'
  ```
  Expected: `"status": "active"`

- [ ] **Test webhook connectivity**
  ```bash
  curl -X GET https://api.molt.id/webhooks/list \
    -H "Authorization: Bearer $MOLTBOOK_API_KEY"
  ```
  Should list your webhook

- [ ] **Create audit service listing on Moltbook**
  - Go to: https://app.molt.id/services/create
  - Service type: "Security Audit"
  - Set price: ~0.05 SOL per audit
  -

```bash
# [ ] Initialize git repo in integrity.molt/
git init

# [ ] Add all files
git add -A

# [ ] Initial commit
git commit -m "feat: integrity.molt security audit agent - ready for deployment"

# [ ] Create repo at https://github.com/YOUR_USERNAME/integrity.molt
# [ ] Add remote and push
git remote add origin https://github.com/YOUR_USERNAME/integrity.molt.git
git branch -M main
git push -u origin main
```

**Expected Result:** All files on GitHub (except .env and __pycache__)

### Phase 3: Moltbook Setup

```bash
# [ ] Navigate to app.molt.id
# [ ] Click "My Domains" → "integrity.molt"
# [ ] Go to Settings → Environment Variables
# [ ] Add 5 variables:

  [ ] TELEGRAM_TOKEN = 8488646935:AAE2hXdjBLPr-8QJboEPXsidlR8BIETEXJ0
  [ ] OPENAI_API_KEY = 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
  [ ] SOLANA_PUBLIC_KEY = 3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
  [ ] ENVIRONMENT = production
  [ ] LOG_LEVEL = INFO

# [ ] Click "Save" for each variable
```

**Expected Result:** All 5 variables shown in UI

### Phase 4: Install OpenClaw CLI

```bash
# [ ] Install CLI
npm install -g @moltbook/openclaw

# [ ] Verify installation
openclaw --version

# [ ] Login
openclaw login
# (Follows browser flow, select integrity.molt)
```

**Expected Result:** You see login success message

### Phase 5: Deploy

```bash
# [ ] Navigate to project directory
cd integrity.molt

# [ ] Deploy
openclaw deploy \
  --domain integrity.molt \
  --git-url https://github.com/YOUR_USERNAME/integrity.molt.git \
  --branch main \
  --dockerfile ./Dockerfile \
  --memory 512MB \
  --instances 1

# [ ] Wait for deployment (2-5 minutes)
# Look for: "✅ Deployment successful"
```

**Expected Result:** Deployment completes without errors

### Phase 6: Verify Deployment

```bash
# [ ] Check status
openclaw status --domain integrity.molt
# Expected: Status: RUNNING

# [ ] View logs
openclaw logs --domain integrity.molt --follow
# Expected: "🤖 integrity.molt bot starting..."
# Wait ~10 seconds, should see polling activity
```

**Expected Result:** Logs show bot is online and polling

### Phase 7: Test on Telegram

```bash
# [ ] Open Telegram
# [ ] Search for your bot (Molt_Auditor or similar)
# [ ] Send: /start
# [ ] Expected response: Welcome message

# [ ] Send: /audit 3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
# [ ] Expected: GPT-4 analysis response within 2-3 seconds
# [ ] Should include: Risk findings, severity levels, recommendations
```

**Expected Result:** Bot responds with real security audit analysis

---

## 📊 Post-Deployment

### Monitoring
```bash
# [ ] Set up log monitoring
openclaw logs --domain integrity.molt --follow

# [ ] Check daily metrics
openclaw stats --domain integrity.molt

# [ ] Monitor costs (should be ~$0 Moltbook + minimal OpenAI usage)
```

### Future Updates
```bash
# [ ] Make code changes locally
# [ ] Commit and push to GitHub
git push origin main

# [ ] Auto-deploy via GitHub Actions (configured in .github/workflows/deploy.yml)
# OR manual redeploy:
openclaw redeploy --domain integrity.molt
```

---

## ❌ Troubleshooting

### Bot not responding on Telegram
```bash
openclaw logs --domain integrity.molt --tail 50
# Look for error messages
# Common issues: Invalid credentials, network timeout
```

### Deployment failed
```bash
# Check Docker build
docker build -t integrity-molt .

# Review logs
openclaw logs --domain integrity.molt --tail 100
```

### High costs
```bash
# Check OpenAI api usage (logs should show cost per audit)
# Typical: $0.03-0.10 per scan
# Budget: Keep API key credit > $2 to avoid surprises
```

---

## 📈 What's Next

### Phase 2 (After Beta Testing)
- [ ] Add Cloudflare R2 storage
- [ ] Anchor reports on Metaplex Core NFTs
- [ ] Implement cost tracking per user
- [ ] Add audit history persistence

### Phase 3 (Monetization)
- [ ] Payment processing (SOL transactions)
- [ ] Subscription tiers (Free, Starter, Pro)
- [ ] Marketplace integration
- [ ] Revenue sharing with ecosystem

---

## 📞 Support Links

| Issue | Resource |
|-------|----------|
| Moltbook Questions | https://docs.molt.id |
| OpenClaw CLI Help | `openclaw --help` |
| Telegram Bot API | https://core.telegram.org/bots |
| OpenAI API | https://platform.openai.com/docs |
| Python Issues | https://python.org/docs |

---

## ✨ Summary

**What You Have:**
- ✅ Fully functional security audit agent
- ✅ Live Telegram integration
- ✅ GPT-4 powered analysis
- ✅ Production-ready Docker setup
- ✅ Moltbook OpenClaw configuration
- ✅ Cost tracking and monitoring

**Time to Deploy:**
- 5 min: GitHub setup
- 5 min: Moltbook configuration
- 5 min: OpenClaw deploy command
- 2 min: Verification
- **Total: ~17 minutes to live bot!**

**Monthly Cost:**
- Moltbook: **$0** (included with NFT)
- OpenAI: **~$1-5** (pay-as-you-go)
- Solana: **$0** (free public RPC)
- **Total: $0-5/month**

---

**Ready to go live? 🚀**

Next step: Follow Phase 2 steps in OPENCLAW_DEPLOY.md
