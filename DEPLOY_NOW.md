# 🚀 Deploy to Moltbook OpenClaw - 3 Steps

**Status:** Bot tested ✅ | Code committed ✅ | Ready for production

---

## Step 1: Push to GitHub (5 min)

### 1a. Create GitHub Repository
1. Go to **https://github.com/new**
2. Repository name: `integrity.molt`
3. Description: "AI security auditor for Solana contracts"
4. **Don't initialize** (code already committed locally)
5. Click **Create repository**

### 1b. Push Your Code
```bash
cd c:\Users\Tuf-Gaming\Documents\integrity.molt

# Add GitHub remote
git remote add origin https://github.com/YOUR_USERNAME/integrity.molt.git

# Rename to main branch
git branch -M main

# Push
git push -u origin main
```

**Verify:** Check your GitHub repo shows all 31 files ✓

---

## Step 2: Install OpenClaw CLI (2 min)

```bash
# Install globally
npm install -g @moltbook/openclaw

# Verify
openclaw --version
```

**If Node.js not installed:** Download from https://nodejs.org (LTS)

---

## Step 3: Deploy to Moltbook OpenClaw (10 min)

### 3a. Login to Moltbook
```bash
openclaw login
```
- Opens browser for wallet authentication
- Authorize with your Solana wallet (Phantom, etc.)

### 3b. Set Environment Variables
```bash
openclaw config set --domain integrity.molt \
  TELEGRAM_TOKEN=YOUR_TELEGRAM_TOKEN_HERE \
  OPENAI_API_KEY=YOUR_OPENAI_API_KEY_HERE \
  SOLANA_PUBLIC_KEY=3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM \
  ENVIRONMENT=production \
  LOG_LEVEL=INFO
```

### 3c. Deploy
```bash
openclaw deploy \
  --domain integrity.molt \
  --git-url https://github.com/YOUR_USERNAME/integrity.molt.git \
  --git-branch main \
  --dockerfile ./Dockerfile \
  --memory 512MB \
  --cpu 0.5 \
  --replicas 1
```

**Wait 2-5 minutes for deployment...**

### 3d. Verify Deployment
```bash
# Check status
openclaw status --domain integrity.molt

# View logs (live)
openclaw logs --domain integrity.molt --follow
```

**Expected output:**
```
✅ Application started
✅ Bot polling active
```

---

## Done! 🎉

Your bot is now:
- ✅ Running on Moltbook OpenClaw (production)
- ✅ Accessible 24/7 on Telegram
- ✅ Connected to OpenAI GPT-4
- ✅ Processing audits at scale

---

## Next Steps

1. **Monitor logs:** `openclaw logs --domain integrity.molt --follow`
2. **Scale up:** Increase `--replicas` if needed
3. **Updates:** Update code, push to GitHub, redeploy with same command
4. **Costs:** Monitor spending at app.molt.id dashboard

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Command not found: openclaw` | Run `npm install -g @moltbook/openclaw` |
| `Deployment failed` | Check `openclaw logs --domain integrity.molt` |
| `Telegram not responding` | Verify `TELEGRAM_TOKEN` in env vars |
| `GPT-4 errors` | Check `OPENAI_API_KEY` and quota at openai.com |

---

**Questions?** See [OPENCLAW_DEPLOY.md](OPENCLAW_DEPLOY.md) for detailed guide.

Generated: Feb 26, 2026
