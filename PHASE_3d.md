# Phase 3d: Production Deployment to Railway.app

## Overview

Phase 3d deploys integrity.molt to production on Railway.app with:
- Telegram bot running 24/7
- Real MongoDB Atlas for persistent storage
- Solana mainnet integration
- Monitoring and error tracking
- Zero-downtime deployments

**Status:** Ready for production  
**Deployment Target:** Railway.app  
**Database:** MongoDB Atlas (free tier available)  
**Estimated Time:** 15-20 minutes

---

## Pre-Deployment Checklist

### 1. Local Testing ✅

Verify everything works locally before deploying:

```bash
# Install dependencies
pip install -r requirements.txt

# Run tests
pytest tests/ -v

# Start bot locally
python -m src

# Expected output:
# ============================================================
# 🤖 integrity.molt Security Audit Agent
# ============================================================
# ✅ Configuration validated
# Environment: development
# LLM Model: gpt-4-turbo
# 🚀 Starting Telegram bot...
```

### 2. Environment Variables

Create/verify critical variables for production:

**Required:**
```bash
# Telegram
TELEGRAM_TOKEN=your_telegram_token_here
ENVIRONMENT=production

# OpenAI
OPENAI_API_KEY=sk-proj-your-api-key-here

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PUBLIC_KEY=HNhZiuihyLWbjH2Nm2WsEZiPGybjnRjQCptasW76Z7DY

# MongoDB (NEW)
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/integrity_molt
DATABASE_MODE=real
```

**Optional but Recommended:**
```bash
# Cloudflare R2 (Phase 2)
R2_ACCOUNT_ID=your_account_id_here
R2_ACCESS_KEY_ID=your_access_key_id_here
R2_SECRET_ACCESS_KEY=your_secret_access_key_here

# Logging
LOG_LEVEL=INFO
ENVIRONMENT=production
```

### 3. MongoDB Atlas Setup

1. **Create MongoDB Atlas Account:**
   - Go to https://www.mongodb.com/cloud/atlas
   - Sign up (free tier available)
   - Create organization and project

2. **Create Cluster:**
   - Click "Build a Database"
   - Select "Shared" (free tier)
   - Provider: AWS
   - Region: us-east-1 (or closest to users)
   - Cluster name: `integrity-molt`

3. **Create Database:**
   - Database name: `integrity_molt`

4. **Create Database User:**
   - Username: `integrity_user`
   - Password: Generate strong password
   - Save credentials securely

5. **Get Connection String:**
   ```
   mongodb+srv://integrity_user:your_password@cluster.mongodb.net/integrity_molt
   ```
   - Note: Replace `your_password` with your actual database password

6. **Whitelist IP:**
   - Go to Network Access → IP Whitelist
   - Add IP: `0.0.0.0/0` (allows Railway.app)
   - Or specify Railway's IP range

### 4. Telegram Bot Token

1. Open Telegram, message @BotFather
2. Type `/newbot`
3. Follow prompts:
   - Bot name: `integrity.molt` (or similar)
   - Bot username: `integrity_molt_bot`
4. Copy the token:
   ```
   YOUR_TELEGRAM_BOT_TOKEN_HERE
   ```

### 5. OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Create new API key
3. Copy and save securely
4. Set in environment: `OPENAI_API_KEY=sk-proj-...`

---

## Railway.app Deployment

### Step 1: Connect GitHub Repository

1. Go to https://railway.app
2. Sign in with GitHub
3. Click "Create New Project"
4. Select "Deploy from GitHub repo"
5. Authorize Railway to access your repos
6. Select `Hans1132/integrity.molt` repository

### Step 2: Configure Environment Variables

In Railway Dashboard:

1. Click on the project
2. Go to "Variables" tab
3. Add all production environment variables:

```
TELEGRAM_TOKEN=8781568638:AAHuk9md08...
OPENAI_API_KEY=sk-proj-0B7ECIgj-AQp...
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PUBLIC_KEY=3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
MONGODB_URI=mongodb+srv://lickohonza_db_user:hm4PjMqKMVUsvFzw@cluster.mongodb.net/integrity_molt
DATABASE_MODE=real
ENVIRONMENT=production
LOG_LEVEL=INFO
```

### Step 3: Deploy

Method A - Automatic (Recommended):
```
1. Railway auto-detects railway.toml
2. Builds Docker image using Dockerfile
3. Runs startCommand: python -m src
4. Watch deployment logs in dashboard
```

Method B - Manual Deploy:
```
1. Push to GitHub: git push origin main
2. Railway auto-triggers deployment
3. Monitor in dashboard: Project → Deployments
```

### Step 4: Monitor Deployment

Deployment logs show progress:

```
[BUILD] Building Docker image...
[BUILD] Installing dependencies...
[BUILD] Running: CMD ["python", "-u", "-m", "src"]
[DEPLOY] Deploying container...
[START] 🤖 integrity.molt Security Audit Agent
[START] ✅ Configuration validated
[START] 🚀 Starting Telegram bot...
[SUCCESS] Deployment complete!
```

**If stuck:** Access Railway logs tab for debugging

---

## Production Verification

### 1. Telegram Bot Test

Send command in Telegram:
```
/start
```

Expected response:
```
👋 Welcome to integrity.molt!
I perform security audits on Moltbook contracts.

Commands:
/audit <contract_address> - Analyze a contract
/help - Show this message
```

### 2. Database Connection

Check MongoDB Atlas dashboard:
```
Deployment → Logs
Look for: "✅ Real MongoDB connected successfully!"
```

Or via Railway logs:
```
🔄 Connecting to MongoDB: mongodb+srv://...
✅ Real MongoDB connected successfully!
```

### 3. Audit Flow Test

Send audit command:
```
/audit EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf
```

Expected sequence:
1. Bot: "🔍 Analyzing EvXNCtao... Please wait..."
2. Bot analyzes with free tier or GPT-4
3. Bot returns audit report with risk score
4. Database stores audit in MongoDB

---

## Architecture Diagram

```
┌─────────────────┐
│  Telegram User  │
└────────┬────────┘
         │
         ├─ /audit <address>
         │
    ┌────▼──────────────────┐
    │   Telegram Bot        │
    │  (Railway.app)        │
    ├──────────────────────┤
    │ • Webhook ingestion   │
    │ • Command parsing     │
    │ • Rate limiting       │
    └────┬──────────────────┘
         │
    ┌────┴──────────────────┐
    │   Tier Detection      │
    ├──────────────────────┤
    │ Free? → Pattern Analyzer ($0)
    │ Paid? → GPT-4 API ($0.03+)
    └────┬──────────────────┘
         │
    ┌────▼──────────────────┐
    │    Database Layer     │
    ├──────────────────────┤
    │ • MongoDB Atlas       │
    │ • Audit history       │
    │ • User profiles       │
    │ • Transactions        │
    └────┬──────────────────┘
         │
    ┌────▼──────────────────┐
    │  Blockchain Layer     │
    ├──────────────────────┤
    │ • Solana mainnet      │
    │ • Payment processing  │
    │ • NFT anchoring       │
    │ • Phantom wallet      │
    └──────────────────────┘
```

---

## Error Handling & Fallbacks

### MongoDB Connection Down
- ✅ **Automatic fallback** to mock mode
- ✅ **No service interruption** (uses in-memory storage)
- ⚠️ **Data loss risk** if Railway container restarts
- 🔄 **Auto-reconnect** every 5 seconds

### OpenAI API Timeout
- ✅ **User message**: "Analysis failed. Try again later."
- ✅ **Automatic retry** (3 attempts max)
- ⚠️ **Free tier affected** falls back to pattern analyzer
- 💰 **Premium tier**: Gets refund or free retry

### Solana RPC Error
- ✅ **Payment processing fails** gracefully (marked pending)
- ✅ **User notified** to retry payment
- 🔄 **Retry mechanism** built in
- 📊 **Logged for monitoring**

---

## Monitoring & Logging

### Railway Dashboard

**Project Overview:**
- ✅ Deployment status
- ✅ Resource usage (CPU, memory)
- ✅ Network activity
- ✅ Recent events

**Logs Tab:**
```
[2024-02-26T10:30:00] ✅ Audit stored: audit_123 | Cost: $0.03
[2024-02-26T10:31:00] 🤖 Free tier user 1234 - pattern analyzer
[2024-02-26T10:32:00] ✅ Payment confirmed: 0.05 SOL
[2024-02-26T10:33:00] 📊 Retrieved 5 audits for user 1234
```

### Production Alerts

Critical issues that should trigger alerts:
1. **Bot not responding** → Check TELEGRAM_TOKEN
2. **MongoDB disconnected** → Verify MONGODB_URI
3. **GPT-4 API errors** → Check OPENAI_API_KEY
4. **High error rate** → Check logs for patterns

---

## Scaling & Performance

### Current Setup (Tier)
- **Rating:** Suitable for ~100 concurrent users
- **Max audits/day:** 5,000 (free quota limits)
- **Max storage:** MongoDB Atlas free = 512MB

### Upgrade Path

**If reaching resource limits:**

1. **MongoDB:**
   - Upgrade to paid tier (M0 → M2)
   - Enable backups
   - Consider sharding at 10GB+ data

2. **Railway:**
   - Increase instance size
   - Add more build/deploy workers
   - Enable autoscaling

3. **Telegram:**
   - Switch to webhook mode (faster than polling)
   - Implement message queuing (Redis)
   - Load balance multiple bot instances

4. **GPT-4 Costs:**
   - Continue using free tier pattern analyzer
   - Only route premium users to GPT-4
   - Cache popular contract analyses

---

## Deployment Commands

### Local Testing Before Deploy
```bash
# Install dependencies
pip install -r requirements.txt

# Run tests
pytest tests/ -v

# Check environment
python -c "from src.config import Config; print(f'ENV: {Config.ENVIRONMENT}')"

# Start locally
python -m src

# Test in separate terminal
# Open Telegram and type /start
```

### Deploy to Railway
```bash
# 1. Commit changes
git add -A
git commit -m "feat: Phase 3d production deployment"

# 2. Push to GitHub
git push origin main

# 3. Watch Railway dashboard
# https://railway.app/projects/your-project-id

# 4. Railway auto-detects push and deploys!
```

### Revert if Issues
```bash
# Go to Railway dashboard → Deployments
# Click previous version → "Redeploy"
# Or push to GitHub with git revert command
```

---

## Post-Deployment Checklist

- [ ] Telegram bot responds to /start
- [ ] /audit command works
- [ ] Audits are stored in MongoDB
- [ ] Free tier gets pattern-based analysis
- [ ] Premium tier gets GPT-4 analysis
- [ ] Payment flow works (test with small amount)
- [ ] Database health check passes
- [ ] No critical errors in logs
- [ ] Web dashboard accessible (future)
- [ ] Monitoring alerts configured

---

## Troubleshooting

### Bot not responding to Telegram commands

**Check:**
1. TELEGRAM_TOKEN is correct
2. Railway logs show "20 OK" responses
3. Webhook registered properly

**Fix:**
```bash
# Re-register webhook
curl -X POST https://api.telegram.org/botYOUR_TOKEN/setWebhook \
  -d url=https://your-railway-app.railway.app/webhook
```

### "MongoDB connection failed" in logs

**Check:**
1. MONGODB_URI is correct format
2. Database user password correct
3. IP whitelist includes Railway IPs

**Fix:**
1. Test connection string locally
2. Verify MongoDB Atlas cluster is running
3. Check Network Access whitelist

### OpenAI API errors

**Check:**
1. OPENAI_API_KEY is not expired
2. API quota not exceeded
3. Account has credits

**Fix:**
1. Generate new API key
2. Check usage dashboard
3. Add payment method

### High memory usage

**Check:**
1. MongoDB queries efficient
2. Audit cache not growing unbounded
3. No memory leaks in main loop

**Fix:**
1. Increase Railway instance size
2. Enable database indexing
3. Clear old audit cache entries

---

## Maintenance

### Weekly
- [ ] Review error logs
- [ ] Check API cost trends
- [ ] Monitor database size

### Monthly
- [ ] Test disaster recovery
- [ ] Update dependencies
- [ ] Review user feedback

### Quarterly
- [ ] Performance optimization
- [ ] Security audit
- [ ] Capacity planning

---

## Success Metrics

**In first week of deployment:**
- Bot responds to 100% of commands
- 0 critical outages
- < 1% error rate
- Average response time < 5 seconds
- Database connection 99.9% uptime

---

## Support & Monitoring

### Real-time Status
- Railway Dashboard: https://railway.app
- MongoDB Atlas: https://cloud.mongodb.com
- Telegram: https://web.telegram.org

### Logs
```bash
# Railway logs (last 100 lines)
railway logs -f

# Or via dashboard: Deployments → View Logs
```

### Emergency Contacts
- Railway Support: support@railway.app
- MongoDB Support: support@mongodb.com
- Telegram Bot: @BotFather

---

## Git Deployment Flow

```
Local: git commit & push
   ↓
GitHub: triggerswebhook
   ↓
Railway: Auto-detects push
   ↓
Railway: Builds Docker image (docker build)
   ↓
Railway: Runs container (python -m src)
   ↓
Railway: Health check passes
   ↓
✅ Live in production!
```

---

**Status:** ✅ Phase 3d READY FOR DEPLOYMENT  
**Next Phase:** 3e - Production monitoring & optimization  
**Estimated Production Time:** 15-20 minutes  
**Cost to Run:** Free tier ($0/month initially)  

