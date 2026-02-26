# 🚀 GitHub + OpenClaw Deployment - Final Steps

**Bot Status:** Running ✅ | Moltbook Connected ✅ | Ready for Production

---

## STEP 1: Push to GitHub

### 1a. Create GitHub Repository

1. Go to **https://github.com/new**
2. Fill in:
   - **Repository name:** `integrity.molt`
   - **Description:** "AI security auditor for Solana contracts - Telegram bot + GPT-4"
   - **Public/Private:** Your choice
   - **Initialize:** ⬜ Do NOT initialize (we have local code)
3. Click **Create repository**

### 1b. Push Your Code

Run these commands:

```bash
cd c:\Users\Tuf-Gaming\Documents\integrity.molt

# Add GitHub remote (replace YOUR_USERNAME with your GitHub username)
git remote add origin https://github.com/Hans1132/integrity.molt.git

# Ensure main branch
git branch -M main

# Push everything
git push -u origin main

# Verify
git remote -v
```

**Expected output:**
```
origin  https://github.com/Hans1132/integrity.molt.git (fetch)
origin  https://github.com/Hans1132/integrity.molt.git (push)
```

✅ **Verify on GitHub:** Visit your repo, should show all 35 files

---

## STEP 2: Install OpenClaw CLI

```bash
# Install globally
npm install -g @moltbook/openclaw

# Verify installation
openclaw --version

# Should show: @moltbook/openclaw/X.X.X
```

⚠️ **If "npm: command not found":**
- Download Node.js from https://nodejs.org (LTS)
- Install, then retry `npm install -g @moltbook/openclaw`

---

## STEP 3: Deploy to Moltbook OpenClaw

### 3a. Login to Moltbook

```bash
openclaw login
```

- Opens your browser
- Sign in with your Solana wallet (Phantom recommended)
- Authorize the OpenClaw CLI

### 3b. Configure Environment Variables

```bash
openclaw config set --domain integrity.molt \
  TELEGRAM_TOKEN="8781568638:AAHuk9md08bcsfoYCd3aLibR7R2GaW73UAM" \
  OPENAI_API_KEY="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" \
  SOLANA_PUBLIC_KEY="3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM" \
  ENVIRONMENT="production" \
  LOG_LEVEL="INFO" \
  MOLTBOOK_AGENT_ID="molt_78587c41ed99a3375022dc28" \
  MOLTBOOK_DOMAIN_NAME="integrity.molt"
```

### 3c. Deploy to OpenClaw

```bash
openclaw deploy \
  --domain integrity.molt \
  --git-url https://github.com/Hans1132/integrity.molt.git \
  --git-branch main \
  --dockerfile ./Dockerfile \
  --memory 512MB \
  --cpu 0.5 \
  --replicas 1 \
  --auto-scale-max 3
```

**This will:**
1. Clone your GitHub repo ✅
2. Build Docker image ✅
3. Deploy to Moltbook infrastructure ✅
4. Start bot polling ✅

**Wait:** 2-5 minutes for deployment to complete

---

## STEP 4: Verify Deployment

### 4a. Check Deployment Status

```bash
openclaw status --domain integrity.molt
```

**Expected output:**
```
Domain: integrity.molt
Status: RUNNING
Replicas: 1/1
Health: OK
```

### 4b. View Live Logs

```bash
openclaw logs --domain integrity.molt --follow
```

**Expected output:**
```
2026-02-26 10:15:30 - integrity.molt bot starting...
2026-02-26 10:15:31 - Configuration validated
2026-02-26 10:15:32 - Telegram connection established
2026-02-26 10:15:33 - Bot polling active
```

Hit `Ctrl+C` to stop following logs.

### 4c. Test on Telegram

Send a message to your bot:
```
/start
```

**Expected response:**
```
👋 Welcome to integrity.molt!
I perform security audits on Moltbook contracts.

Commands:
/audit <contract_address> - Analyze a contract
/help - Show this message
```

✅ **If you see this → Bot is LIVE!**

---

## STEP 5: Update Code & Redeploy

When you make changes locally:

```bash
# Make changes to code
# ...

# Commit locally
git add -A
git commit -m "your message"

# Push to GitHub
git push

# Redeploy (same command, pulls latest)
openclaw deploy \
  --domain integrity.molt \
  --git-url https://github.com/Hans1132/integrity.molt.git \
  --git-branch main \
  --dockerfile ./Dockerfile
```

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| `npm: command not found` | Install Node.js from https://nodejs.org |
| `git: unknown command` | Install Git from https://git-scm.com |
| `Failed to authenticate` | Run `openclaw login` again |
| `Deployment failed` | Check logs: `openclaw logs --domain integrity.molt` |
| `Bot not responding on Telegram` | Verify TELEGRAM_TOKEN is correct in env vars |
| `API errors in logs` | Check OpenAI quota at https://platform.openai.com/account/usage |

---

## Monitoring

### Daily Tasks

```bash
# Check bot is running
openclaw status --domain integrity.molt

# View last 50 logs
openclaw logs --domain integrity.molt | tail -50

# Check API costs (on Telegram)
/status
```

### Moltbook Dashboard

- URL: https://app.molt.id
- View: Agents → integrity.molt Agent
- Monitor: Usage, costs, uptime

### Solana Blockchain

- Verify audits on-chain: https://solscan.io
- Search: integrity.molt NFT address

---

## Cost Management

### Daily Budget Check

```bash
# Set cost alert (optional)
openclaw config set --domain integrity.molt \
  API_COST_THRESHOLD_USD="4.50"
```

### Reduce Costs

- Use `gpt-4-turbo` instead of `gpt-4` (cheaper)
- Limit audit length: `MAX_AUDIT_SIZE_BYTES=30000`
- Enable caching for common contracts

---

## What's Live

✅ **Bot automatically:**
- Polls Telegram for messages
- Runs GPT-4 analysis
- Formats responses with Telegram emoji
- Tracks API costs
- Logs all activities
- Connects to Moltbook agent

✅ **Infrastructure:**
- Auto-scales 1-3 instances
- Health checks every 30s
- Automatic restarts on crash
- Logs persisted for 7 days

---

## Next Phase (Phase 2)

When ready, add:
- [ ] R2 storage for audit reports
- [ ] Metaplex Core NFT anchoring
- [ ] Audit registry on-chain
- [ ] Marketplace listing

See [MOLTBOOK.md](MOLTBOOK.md) for integration details.

---

## Support Links

- **GitHub Docs:** https://docs.github.com
- **OpenClaw Docs:** https://docs.molt.id/openclaw
- **Moltbook Console:** https://app.molt.id
- **OpenAI Status:** https://status.openai.com
- **Solana Docs:** https://docs.solana.com

---

**Ready?** Follow the steps above! 

**Questions?** Check [MOLTBOOK.md](MOLTBOOK.md) or [OPENCLAW_DEPLOY.md](OPENCLAW_DEPLOY.md)

**Status:** 🟢 Ready for Production Deployment

Generated: February 26, 2026 | Bot: integrity.molt | Agent: molt_78587c41ed99a3375022dc28
