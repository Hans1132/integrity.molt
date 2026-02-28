# 🚀 Deployment Guide - integrity.molt on Railway

Complete step-by-step guide to deploy the autonomous agent and start earning SOL.

## Current Status

✅ Your bot is already live on Railway  
✅ Database is connected (MongoDB Atlas)  
✅ Telegram commands working (`/audit`, `/help`, etc.)  

**What's new:**
- FastAPI marketplace server (receives Moltbook requests)
- Autonomous audit processing (background)
- Payment verification (Solana blockchain)
- Earnings dashboard

---

## Deployment Overview

Your agent now runs **3 components in parallel**:

| Component | Port | Purpose |
|-----------|------|---------|
| **Telegram Bot** | N/A | User commands via Telegram |
| **FastAPI API** | 8000 | Receives Moltbook marketplace requests |
| **Autonomoou Auditor** | N/A | Background audit processing |

All three start with a **single command**:
```bash
python -m src
```

---

## Step 1: Push Code to GitHub

```bash
cd ~/Documents/integrity.molt

# Add all changes
git add -A

# Commit with descriptive message
git commit -m "Add autonomous audit agent with FastAPI + Moltbook integration"

# Push to GitHub (triggers Railway auto-deploy)
git push origin main
```

Railway will automatically:
1. Detect changes
2. Build Docker image
3. Install `requirements.txt` (including FastAPI, Uvicorn)
4. Start the app with your Railway config

---

## Step 2: Update Railway Config

Your `railway.toml` should look like:

```toml
[build]
dockerfile = "Dockerfile"

[deploy]
startCommand = "python -m src"
restartPolicyMaxRetries = 5

[web]
healthcheckPath = "/health"
healthcheckTimeout = 30
```

If you don't have `railway.toml`, create it:

```bash
touch railway.toml
cat > railway.toml << 'EOF'
[build]
dockerfile = "Dockerfile"

[deploy]
startCommand = "python -m src"

[web]
healthcheckPath = "/health"
EOF
```

---

## Step 3: Verify Environment Variables on Railway

Go to: https://railway.app/dashboard

1. Select your project: `integrity.molt`
2. Click "Variables"
3. Ensure these are set:

```
TELEGRAM_TOKEN=8781568638:AAFDwqrFjlNM9QHlUQjlymj6Xa0kDF8l0P0
OPENAI_API_KEY=sk-or-v1-...
SOLANA_PUBLIC_KEY=3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
MONGODB_URI=mongodb+srv://...
DATABASE_MODE=real
```

**Add these NEW variables:**

```
MOLTBOOK_API_KEY=sk_live_xxxxx
MOLTBOOK_WEBHOOK_SECRET=your_secure_secret_key_here
MARKETPLACE_API_PORT=8000
MAX_CONCURRENT_AUDITS=3
AUDIT_QUEUE_CHECK_INTERVAL=5
```

---

## Step 4: Set Domain for Webhook

Your FastAPI server will run on Railway's auto-assigned domain.

### Find Your Domain

```bash
railway logs
```

Look for:
```
🌐 Starting Marketplace API server...
INFO:     Application startup complete [POST] http://0.0.0.0:8000
```

Or in Railway dashboard:
- Project → Settings → Networking → Public URL
- Format: `https://integrity-molt--production-XXXX.railway.app`

### Register Webhook with Moltbook

```bash
export RAILWAY_DOMAIN="https://integrity-molt--production-XXXX.railway.app"
export MOLTBOOK_API_KEY="sk_live_xxxxx"
export WEBHOOK_SECRET="your_secure_secret_key_here"

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

Expected response:
```json
{
  "schema": "https://api.molt.id/v1/",
  "id": "webhook_123abc",
  "status": "active"
}
```

---

## Step 5: Test Components

Once deployed, test all 3 components:

### Test 1: Health Check (verify server is running)

```bash
curl https://integrity-molt--production-XXXX.railway.app/health

Response:
{
  "status": "healthy",
  "agent": "integrity.molt",
  "environment": "production"
}
```

### Test 2: Telegram Bot (existing command)

```bash
Send to bot: /help

Expected response:
✅ integrity.molt Security Auditor

Commands:
/audit <address> - Analyze contract
/help - Show this message
...
```

### Test 3: Check Earnings Dashboard

```bash
curl https://integrity-molt--production-XXXX.railway.app/earnings

Response:
{
  "agent": "integrity.molt",
  "total_audits": 0,
  "total_earnings_sol": 0.0,
  "average_per_audit_sol": 0.0,
  "timestamp": "2026-02-28T14:32:00Z"
}
```

### Test 4: Check API Status

```bash
curl https://integrity-molt--production-XXXX.railway.app/status

Response:
{
  "status": "active",
  "agent_id": "molt_78587c41ed99a3375022dc28",
  "marketplace": "moltbook",
  "network": "solana-mainnet"
}
```

---

## Step 6: Monitor Logs

Watch for startup sequence:

```bash
railway logs

# Look for these lines:
# ✅ integrity.molt Autonomous Security Audit Agent
# ✅ Configuration validated
# ✅ Telegram bot thread started
# ✅ Marketplace API thread started
# ✅ Autonomous auditor thread started
# ✅ integrity.molt is now FULLY OPERATIONAL
```

---

## Troubleshooting Deployment

### Issue: "Module not found: fastapi"

**Solution**: 
```bash
# Ensure requirements.txt is updated and committed
git add requirements.txt
git commit -m "Add FastAPI and Uvicorn"
git push origin main

# Force redeploy on Railway
railway redeploy
```

### Issue: Port 8000 already in use

**Solution**: FastAPI server will run on Railway's assigned port (usually 3000+).  
The `8000` in `.env` is only for local development.

### Issue: Webhook not receiving requests

**Solution**:
1. Verify cloudflare DNS resolves your domain:
   ```bash
   dig integrity-molt--production-XXXX.railway.app
   ```

2. Check webhook registration:
   ```bash
   curl -X GET https://api.molt.id/webhooks/list \
     -H "Authorization: Bearer $MOLTBOOK_API_KEY"
   ```

3. Enable debug logging:
   ```
   LOG_LEVEL=DEBUG
   ```
   Then redeploy

### Issue: Payment verification failing

**Solution**:
1. Verify Solana RPC endpoint can connect:
   ```bash
   curl https://api.mainnet-beta.solana.com \
     -X POST \
     -H "Content-Type: application/json" \
     -d '{"method":"getHealth","jsonrpc":"2.0","id":1}'
   ```

2. Check SOLANA_PUBLIC_KEY matches the wallet receiving payments

3. Verify transaction actually exists on mainnet

---

## Monitoring in Production

### Real-time Logs

```bash
# Watch live logs
railway logs --follow

# Search for specific messages
railway logs | grep "Autonomous audit completed"
```

### Earnings Tracking

```bash
# Check earnings every minute
watch -n 60 'curl https://your-domain/earnings | jq "."'
```

### Alert on High Error Rate

```bash
# Count errors in last 5 minutes
railway logs | grep ERROR | wc -l
```

If > 10 errors → check logs immediately

---

## Auto-scaling (Optional)

If you get overwhelmed with audit requests:

1. Increase `MAX_CONCURRENT_AUDITS`:
   ```
   MAX_CONCURRENT_AUDITS=5  (from 3)
   ```

2. Add a second worker process (costs more):
   ```bash
   # In railway.toml
   [workers]
   auditor = "python src/autonomous_auditor.py"
   ```

3. Increase Railway plan if needed

---

## Next: Register on Moltbook Marketplace

1. Go to https://app.molt.id
2. Sign in with your wallet
3. Create "Audit Service" listing
4. Set price: ~0.05 SOL per audit
5. Connect your API endpoint
6. Start earning!

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `railway logs` | View live logs |
| `railway env` | View environment variables |
| `railway redeploy` | Force redeployment |
| `railway stop` | Stop the app |
| `railway start` | Start the app |

---

## Success Criteria

✅ You'll know it's working when you see:

```
🤖 integrity.molt Autonomous Security Audit Agent
✅ Configuration validated
✅ Telegram bot thread started
✅ Marketplace API thread started
✅ Autonomous auditor thread started

🎯 integrity.molt is now FULLY OPERATIONAL

Components running:
  ✅ Telegram Bot - User commands
  ✅ Marketplace API - Moltbook requests
  ✅ Autonomous Auditor - Background processing

Earning money on Moltbook marketplace...
```

Once you see this in logs → **You're earning SOL!** 💰

---

## Support

- **Issues?** Check `MONETIZATION_GUIDE.md`
- **Questions?** See `soul.md` for mission/values
- **Debug?** Enable `LOG_LEVEL=DEBUG` and redeploy

---

**Status**: 🚀 Ready to deploy and earn!
