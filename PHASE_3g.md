# Phase 3g: Deployment Automation & Verification
**Status:** 🟢 COMPLETE | **Date:** Feb 26, 2026

## Overview

Phase 3g provides automated deployment to Railway.app with comprehensive validation and testing. The system validates all environment variables, runs pre-deployment tests, and orchestrates the complete deployment process with a single command.

---

## One-Command Deployment

```bash
# Deploy to production
python deploy.py --environment production

# Or just validate without deploying
python deploy.py --validate-only
```

**What this does:**
1. ✅ Validates all environment variables
2. ✅ Runs pre-deployment tests
3. ✅ Checks Railway setup
4. ✅ Generates deployment config
5. ✅ Pushes to GitHub
6. ✅ Shows next steps for Railway dashboard

---

## Deployment Components

### 1. Environment Validator (`deploy.py`)

**Validates all required variables:**

```python
# Required - All environments
- TELEGRAM_TOKEN
- OPENAI_API_KEY
- SOLANA_RPC_URL
- ENVIRONMENT

# Required - Production only
- MONGODB_URI
- DATABASE_MODE

# Optional but recommended
- SENTRY_DSN (error tracking)
- SLACK_ALERT_WEBHOOK (alerts)
- MOLTBOOK_API_KEY
- OPENCLAW_TOKEN
```

**Usage:**
```bash
# Validate only
python deploy.py --validate-only

# Validate and deploy
python deploy.py --environment production
```

**Output:**
```
🔍 Validating environment configuration...
   Target environment: production
   ✅ TELEGRAM_TOKEN
   ✅ OPENAI_API_KEY
   ✅ SOLANA_RPC_URL
   ✅ ENVIRONMENT
   ✅ MONGODB_URI
   ✅ DATABASE_MODE
   ✅ SENTRY_DSN

✅ Environment validation passed!
```

### 2. Pre-Deployment Tests

**Automatic tests run before deployment:**

```bash
🧪 Running Pre-Deployment Tests

   Testing imports...          ✅
   Testing configuration...     ✅
   Testing Telegram token...    ✅
   Testing OpenAI API key...    ✅
   Testing MongoDB URI...       ✅

📊 Test Results: 5 passed, 0 failed
```

**Tests verify:**
- All Python modules importable
- Configuration loads correctly
- Telegram token format valid
- OpenAI API key format valid
- MongoDB connection string valid

### 3. Railway CLI Check

**Verifies Railway capabilities:**

```bash
✅ Railway CLI found: @railway/cli 5.8.0
✅ Git repository clean
✅ No uncommitted changes
```

**Fallback if CLI not installed:**
```
⚠️  Railway CLI not found.
    Install with: npm install -g @railway/cli
    Or use Railway dashboard: https://railway.app
```

### 4. GitHub Push

**Automatically commits and pushes:**

```bash
📤 Pushing to GitHub...
   ✅ Code pushed to GitHub
```

**What happens:**
1. Detects any uncommitted changes
2. Auto-commits with message "chore: Phase 3g production deployment"
3. Pushes to `origin/main`
4. Railway automatically detects push and starts deployment

### 5. Deployment Config Generated

**Creates production configuration:**

```python
{
  "name": "integrity-molt",
  "buildCommand": "pip install -r requirements.txt",
  "startCommand": "python -m src",
  "healthCheck": {
    "liveness": {
      "path": "/liveness",
      "interval": "10s"
    },
    "readiness": {
      "path": "/readiness",
      "interval": "5s"
    }
  },
  "environment": "production",
  "autoDeploy": True,
  "monitoring": {
    "sentry": True,
    "metrics": True,
    "alerts": True
  }
}
```

---

## Deployment Workflow

```
┌─────────────────────────────┐
│  python deploy.py           │
└────────────┬────────────────┘
             │
    ┌────────▼────────────┐
    │  Validate Env Vars  │
    │  (Required only)    │
    └────────┬────────────┘
             │
    ┌────────▼──────────────────┐
    │  Run Pre-Deploy Tests     │
    │  (imports, config, format)│
    └────────┬──────────────────┘
             │
    ┌────────▼──────────────────┐
    │  Check Railway Setup      │
    │  (git, CLI, clean repo)   │
    └────────┬──────────────────┘
             │
    ┌────────▼──────────────────┐
    │  Generate Config          │
    │  (health checks, etc)     │
    └────────┬──────────────────┘
             │
    ┌────────▼──────────────────┐
    │  Push to GitHub           │
    │  (auto-commit + push)     │
    └────────┬──────────────────┘
             │
    ┌────────▼──────────────────┐
    │  Display Next Steps       │
    │  (Railway dashboard URL)  │
    └────────┬──────────────────┘
             │
    ✅ Ready for Railway deployment
```

---

## End-to-End Testing

### Comprehensive Test Suite (`tests/test_e2e.py`)

**Tests complete audit flows:**

```bash
pytest tests/test_e2e.py -v

# Sample output:
test_free_tier_audit_complete_flow       PASSED
test_premium_tier_audit_complete_flow    PASSED
test_quota_enforcement                   PASSED
test_error_recovery_flow                 PASSED
test_free_tier_detection                 PASSED
test_subscriber_tier_detection           PASSED
test_cost_calculation                    PASSED
test_audit_storage_and_retrieval         PASSED
test_user_audit_history                  PASSED
test_telemetry_collection                PASSED
test_health_score_calculation            PASSED
test_database_fallback_to_mock           PASSED
test_api_retry_logic                     PASSED
```

### Test Categories

#### 1. Full Audit Flow Tests
- ✅ Free tier: Telegram cmd → Pattern analysis → DB storage → Response
- ✅ Premium tier: Telegram cmd → GPT-4 analysis → DB storage → Response
- ✅ Quota enforcement: User exceeds limit → Blocked with message
- ✅ Error recovery: Bad input → Logged → User notified → Retry OK

#### 2. Tier Detection Tests
- ✅ New user → Free tier (default)
- ✅ Subscriber → Premium tier
- ✅ Cost calculation: Free $0, Premium $0.03+

#### 3. Database Persistence Tests
- ✅ Store audit → Retrieve by ID
- ✅ Retrieve user's audit history
- ✅ Database fallback to mock if connection fails

#### 4. Monitoring & Alerts Tests
- ✅ Telemetry collection: Track audits, errors, response time
- ✅ Health score: Calculate from metrics (0-100)
- ✅ Alert thresholds: Critical and warning levels

#### 5. Error Handling Tests
- ✅ Database graceful fallback
- ✅ API retry logic
- ✅ Exception handling and logging

### Running Tests

```bash
# Run all tests
pytest tests/ -v

# Run only end-to-end tests
pytest tests/test_e2e.py -v

# Run with output
pytest tests/test_e2e.py -v -s

# Run specific test
pytest tests/test_e2e.py::TestFullAuditFlow::test_free_tier_audit_complete_flow -v
```

---

## Railway Deployment Steps

After `python deploy.py` completes:

### Step 1: Open Railway Dashboard
```
https://railway.app/dashboard
```

### Step 2: Create New Project
1. Click "Create New Project"
2. Select "Deploy from GitHub repo"
3. Authorize Railway to access GitHub
4. Select: `Hans1132/integrity.molt`

### Step 3: Configure Variables
Go to "Variables" tab and add:

```env
TELEGRAM_TOKEN=8781568638:AAHuk9md08...
OPENAI_API_KEY=sk-proj-0B7ECIgj-AQp...
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PUBLIC_KEY=3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/integrity_molt
DATABASE_MODE=real
ENVIRONMENT=production
LOG_LEVEL=INFO
SENTRY_DSN=https://your-key@sentry.io/123456
```

### Step 4: Monitor Deployment

Railway Dashboard shows:
```
Deployment: In Progress...

[BUILD] Building Docker image...
[BUILD] Installing dependencies from requirements.txt
[BUILD] Collecting python-telegram-bot==21.0
[BUILD] Collecting openai>=1.0.0
[BUILD] ... (more packages)

[DEPLOY] Deploying container...
[START] 🤖 integrity.molt Security Audit Agent
[START] ✅ Configuration validated
[START] 🐕 MongoDB connection: mongodb://...
[START] ✅ Real MongoDB connected successfully!
[START] 🚀 Starting Telegram bot...

✅ Deployment successful!
```

---

## Verification Checklist

After deployment goes live:

### Immediate Tests (5 minutes)
- [ ] Telegram bot responds to `/start` command
- [ ] Railway dashboard shows "running" status
- [ ] No critical errors in logs
- [ ] `/health` endpoint responds (200 OK)

### Functional Tests (15 minutes)
- [ ] `/audit <valid_address>` returns analysis
- [ ] Audit is stored in MongoDB
- [ ] Free user gets pattern-based analysis
- [ ] Response includes risk score
- [ ] Audit appears in audit history

### Monitoring Tests (30 minutes)
- [ ] `/metrics` endpoint returns data
- [ ] Telemetry tracking audits
- [ ] Health score calculating
- [ ] No Sentry errors (or expected errors only)
- [ ] Slack/Discord alerts working (if configured)

### Performance Tests (60 minutes)
- [ ] Average response time < 5 seconds
- [ ] Error rate < 1%
- [ ] Database connection stable
- [ ] CPU/memory usage acceptable

---

## Deployment Configuration

### Dockerfile (Auto-generated by Railway)
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["python", "-m", "src"]
```

### railway.toml (Auto-generated)
```toml
[build]
builder = "dockerfile"

[deploy]
startCommand = "python -m src"
```

---

## Monitoring & Health Checks

### Health Check Endpoints

**Kubernetes Liveness Probe:**
```bash
GET /liveness HTTP/1.1
Host: integrity-molt.railway.app

Response:
200 OK
{
  "status": "alive",
  "timestamp": "2026-02-26T10:30:00"
}
```

**Kubernetes Readiness Probe:**
```bash
GET /readiness HTTP/1.1
Host: integrity-molt.railway.app

Response:
200 OK
{
  "ready": true,
  "health_score": 85,
  "timestamp": "2026-02-26T10:30:00"
}
```

### Health Status Interpretation

```
Ready = true    → Accepting traffic ✅
Ready = false   → Remove from load balancer 🔴

Liveness = 200  → Container alive ✅
Liveness != 200 → Restart container 🔄
```

---

## Rollback Procedure

**If deployment has issues:**

### Option 1: Via Railway Dashboard
1. Go to: https://railway.app/dashboard
2. Click "Deployments" tab
3. Find previous working version
4. Click "Redeploy"
5. Confirm rollback

### Option 2: Via Git
```bash
# Revert last commit
git revert HEAD

# Push (triggers automatic redeploy)
git push origin main

# Wait for Railway to detect new push
```

### Option 3: Emergency Stop
1. Railway Dashboard → Settings
2. Disable auto-deploy temporarily
3. Fix issue locally
4. Re-enable auto-deploy
5. Push fix to GitHub

---

## Cost Analysis

### Railway Pricing
```
Free Tier:    $0/month (includes $5 credit)
Hobby Plan:   $10/month (better for scale)
Pro Plan:     $20/month+ (multiple projects)
```

### Monthly Cost Estimate
```
Infrastructure (Railway):    $0-10/month
Database (MongoDB Atlas):    $0-10/month
LLM API (OpenAI):           $0-50/month (depends on usage)
Storage (Cloudflare R2):    $0-5/month

Total:                      $0-75/month
(With 95% free tier usage:  $5-10/month)
```

---

## Troubleshooting

### Deployment Stuck in "Building"

**Check:**
1. Railway logs for build errors
2. requirements.txt has no conflicts
3. Python version compatible

**Fix:**
```bash
# Run locally to verify
pip install -r requirements.txt

# If working locally, restart deployment
# Railway Dashboard → Deployments → Redeploy
```

### Bot Not Responding

**Check:**
1. TELEGRAM_TOKEN is correct
2. Webhook registered with Telegram
3. Bot receiving messages in Railway logs

**Fix:**
```bash
# Register webhook manually
curl -X POST https://api.telegram.org/botTOKEN/setWebhook \
  -d "url=https://integrity-molt.railway.app/webhook"
```

### Database Not Connected

**Check:**
1. MONGODB_URI format correct
2. MongoDB Atlas cluster running
3. IP whitelist includes Railway IPs

**Fix:**
1. Test connection string locally
2. Verify database user credentials
3. Check MongoDB whitelist settings

### High Error Rate

**Check Railway logs for:**
```
- API rate limits (GPT-4)
- Database timeouts
- Network errors
- Memory issues
```

**Debug:**
```bash
# Check health endpoint
curl https://integrity-molt.railway.app/health

# Check metrics
curl https://integrity-molt.railway.app/metrics

# View Sentry errors
https://sentry.io (if configured)
```

---

## Files Created This Phase

1. **deploy.py** (600+ LOC)
   - Environment validator
   - Pre-deployment tests
   - Railway integration
   - Orchestration logic

2. **tests/test_e2e.py** (400+ LOC)
   - Full audit flow tests
   - Tier detection tests
   - Database persistence tests
   - Monitoring tests
   - Error handling tests

3. **PHASE_3g.md** (This file - 700+ LOC)
   - Deployment guide
   - Test documentation
   - Troubleshooting
   - Cost analysis

---

## Quick Start

### For Users (No Coding)

```bash
# 1. Set environment variables
#    Copy .env.example to .env
#    Fill in required variables
#    (See section: Environment Variables)

# 2. Deploy
python deploy.py

# 3. Go to Railway dashboard
#    https://railway.app/dashboard

# 4. Follow on-screen instructions
# 5. Monitor logs
# 6. Wait for "✅ Deployment successful!"
```

### For Developers (Testing)

```bash
# 1. Run end-to-end tests
pytest tests/test_e2e.py -v

# 2. Run all tests
pytest tests/ -v

# 3. Deploy locally first
ENVIRONMENT=development python -m src

# 4. Test in Telegram
# 5. Then do production deployment
```

---

## Next Steps (Phase 3h - Optional)

**Post-deployment enhancements:**
- [ ] Custom audit rules engine
- [ ] Advanced analytics dashboard
- [ ] Audit anomaly detection
- [ ] Cost forecasting
- [ ] Multi-region deployment
- [ ] Load balancing setup

---

## Production Checklist

- [ ] Environment variables validated
- [ ] All pre-deployment tests passing
- [ ] Code pushed to GitHub
- [ ] Railway project created
- [ ] Variables configured in Railway
- [ ] Deployment monitoring active
- [ ] Health checks responding
- [ ] Telegram bot working
- [ ] End-to-end tests completed
- [ ] No critical errors in logs

---

**Status:** 🟢 Phase 3g COMPLETE - Ready for production deployment
**Next:** Deploy to Railway using one-command automation
**Estimated Time:** 5 minutes setup + 10 minutes deployment = 15 minutes to live
