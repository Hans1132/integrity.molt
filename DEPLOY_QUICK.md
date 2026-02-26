# 🚀 Quick Start: Deploy to Moltbook OpenClaw

## Installation (One-time Setup)

```bash
# Install OpenClaw CLI
npm install -g @moltbook/openclaw

# Login to Moltbook (opens browser)
openclaw login
```

## Deployment (5 minutes)

### Step 1: Push to GitHub
```bash
cd integrity.molt
git init
git add -A
git commit -m "initial deployment"
git remote add origin https://github.com/YOUR_USERNAME/integrity.molt.git
git branch -M main
git push -u origin main
```

### Step 2: Set Environment Variables
Go to **[app.molt.id](https://app.molt.id)**:
1. Select **integrity.molt**
2. Go to **Settings** → **Environment Variables**
3. Add these 5 variables:
   - `TELEGRAM_TOKEN` = your bot token
   - `OPENAI_API_KEY` = your API key
   - `SOLANA_PUBLIC_KEY` = your wallet address
   - `ENVIRONMENT` = `production`
   - `LOG_LEVEL` = `INFO`

### Step 3: Deploy
```bash
openclaw deploy \
  --domain integrity.molt \
  --git-url https://github.com/YOUR_USERNAME/integrity.molt.git \
  --branch main \
  --dockerfile ./Dockerfile \
  --memory 512MB \
  --instances 1
```

### Step 4: Verify
```bash
openclaw logs --domain integrity.molt --follow
```

Wait for message: `"🤖 integrity.molt bot starting..."`

## Test Immediately

Open Telegram and message your bot:
```
/start
/audit 3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
```

You should get security analysis back in 2-3 seconds!

## Key Commands

```bash
openclaw status --domain integrity.molt           # Check if running
openclaw logs --domain integrity.molt --follow    # View logs
openclaw restart --domain integrity.molt          # Restart agent
openclaw scale --domain integrity.molt --instances 2  # Scale to 2 instances
```

## Files Prepared for Deployment

| File | Purpose |
|------|---------|
| `Dockerfile` | Container image |
| `openclaw.json` | OpenClaw configuration |
| `.github/workflows/deploy.yml` | Auto-deploy on git push |
| `OPENCLAW_DEPLOY.md` | Full deployment guide |
| `requirements.txt` | Python dependencies |
| `src/` | Agent code |

## Next: Phase 2 Features

Once deployed, start working on:
- [ ] Add Cloudflare R2 for report storage
- [ ] Anchor audits on-chain (Metaplex Core)
- [ ] Payment processing (SOL transactions)
- [ ] User subscription tiers
- [ ] Dashboard for analytics

---

**Your bot will be LIVE on Moltbook in ~10 minutes! 🎉**
