# 🚀 Deploy integrity.molt to Moltbook OpenClaw

## Prerequisites Checklist
- ✅ `integrity.molt` NFT minted on Solana
- ✅ Moltbook account (via app.molt.id)
- ✅ GitHub account with your project repo
- ✅ Node.js 16+ installed locally
- ✅ Your credentials ready (Telegram token, OpenAI key, Solana address)

---

## Step 1: Install OpenClaw CLI (LOCAL)

```bash
# Install OpenClaw command line tool
npm install -g @moltbook/openclaw

# Verify installation
openclaw --version
```

---

## Step 2: Login to Moltbook (LOCAL)

```bash
# Login with your Solana wallet
openclaw login

# This will:
# 1. Open browser to app.molt.id
# 2. Connect your wallet (Phantom/Magic Eden)
# 3. Select your integrity.molt domain
# 4. Return auth token to CLI
```

---

## Step 3: Push Project to GitHub

```bash
# Initialize git (if not already done)
cd integrity.molt
git init
git add -A
git commit -m "feat: initial integrity.molt deployment"

# Create repo on GitHub and push
git remote add origin https://github.com/YOUR_USERNAME/integrity.molt.git
git branch -M main
git push -u origin main
```

**Note:** The `.env` file is in `.gitignore` (good!) - credentials stay local until deployment.

---

## Step 4: Configure Environment Variables in Moltbook UI

### Via Web Dashboard:
1. Go to [app.molt.id](https://app.molt.id)
2. Click **My Domains** → **integrity.molt**
3. Go to **⚙️ Settings** → **Environment Variables**
4. Add each variable and click **Save**:

```
TELEGRAM_TOKEN = 8488646935:AAE2hXdjBLPr-8QJboEPXsidlR8BIETEXJ0

OPENAI_API_KEY = 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

SOLANA_PUBLIC_KEY = 3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM

ENVIRONMENT = production

LOG_LEVEL = INFO
```

---

## Step 5: Deploy via OpenClaw CLI (LOCAL)

```bash
# From your local integrity.molt directory
cd integrity.molt

# Deploy to Moltbook
openclaw deploy \
  --domain integrity.molt \
  --git-url https://github.com/YOUR_USERNAME/integrity.molt.git \
  --branch main \
  --dockerfile ./Dockerfile \
  --memory 512MB \
  --instances 1

# Wait for deployment to complete (2-5 minutes)
```

**What this does:**
- Clones your repo from GitHub
- Builds Docker image on Moltbook infrastructure
- Deploys container with your environment variables
- Assigns a public URL to your agent
- Starts health monitoring

---

## Step 6: Verify Deployment

```bash
# Check deployment status
openclaw status --domain integrity.molt

# Expected output:
# Status: RUNNING
# Instance: 1 active
# Logs: Available
# Health: ✅ Healthy
```

---

## Step 7: View Live Logs

```bash
# Stream logs from your deployed agent
openclaw logs --domain integrity.molt --follow

# You should see:
# 2026-02-26 08:15:32 - integrity.molt - INFO - 🤖 Agent started
# 2026-02-26 08:15:33 - telegram - INFO - Bot polling active
# 2026-02-26 08:15:34 - openai - INFO - Ready for audits
```

---

## Step 8: Test Your Live Bot

Open Telegram and message your bot:

```
/start
```

You should see:
```
👋 Welcome to integrity.molt!
I perform security audits on Moltbook contracts.

Commands:
/audit <contract_address> - Analyze a contract
/help - Show this message
```

Then test an audit:
```
/audit 3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
```

Wait 2-3 seconds for GPT-4 to analyze, then you should see real security findings!

---

## Monitoring Commands

```bash
# View real-time logs
openclaw logs --domain integrity.molt --follow

# View performance metrics
openclaw stats --domain integrity.molt

# View configuration
openclaw config --domain integrity.molt

# Restart agent
openclaw restart --domain integrity.molt

# Stop agent
openclaw stop --domain integrity.molt

# Start agent
openclaw start --domain integrity.molt
```

---

## Updating Your Agent

Whenever you make code changes:

```bash
# 1. Commit and push to GitHub
git add -A
git commit -m "your change description"
git push origin main

# 2. Redeploy (OpenClaw auto-pulls latest)
openclaw deploy --domain integrity.molt --git-url https://github.com/YOUR_USERNAME/integrity.molt.git --branch main

# Or manually trigger:
openclaw redeploy --domain integrity.molt
```

---

## Troubleshooting

### Bot not responding
```bash
# Check if it's running
openclaw status --domain integrity.molt

# View error logs
openclaw logs --domain integrity.molt --tail 50

# Restart
openclaw restart --domain integrity.molt
```

### High CPU usage
```bash
# Check metrics
openclaw stats --domain integrity.molt

# Scale up if needed
openclaw scale --domain integrity.molt --instances 2
```

### Container won't start
```bash
# Check logs for startup errors
openclaw logs --domain integrity.molt --tail 100

# Docker build errors? Verify Dockerfile:
docker build -t integrity-molt .
```

---

## Cost & Resources

| Metric | Allocation | Cost |
|--------|-----------|------|
| **Memory** | 512 MB | Included |
| **Compute** | 0.5 CPU | Included |
| **Storage** | 1 GB | Included |
| **Bandwidth** | 100GB/month | Included |
| **OpenAI API** | Pay-as-you-go | ~$0.03 per audit |
| **Telegram API** | Free | Free |
| **Solana RPC** | Free (public) | Free |
| **Monthly Cost** | **$0** | **Free!** |

*Note: You only pay for OpenAI API usage (~$0.03-0.10 per audit)*

---

## Next Steps

1. ✅ Deploy to Moltbook
2. ✅ Test `/audit` command on Telegram
3. ⏳ Phase 2: Add R2 storage for report persistence
4. ⏳ Phase 3: Implement payment processing (SOL transactions)
5. ⏳ Scale: Deploy multiple instances for load balancing

---

## Getting Help

**Moltbook Docs:** https://docs.molt.id  
**OpenClaw CLI Help:** `openclaw --help`  
**Telegram Bot Docs:** https://core.telegram.org/bots  
**OpenAI API:** https://platform.openai.com/docs

---

**Status:** ✅ Ready to Deploy!
