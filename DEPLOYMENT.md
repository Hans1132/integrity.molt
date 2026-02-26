# Deployment Guide: integrity.molt

## Option A: Moltbook OpenClaw (Recommended) ⭐

This is the production deployment for your `integrity.molt` NFT.

### Prerequisites
- Moltbook account (via app.molt.id)
- `integrity.molt` NFT minted on Solana
- OpenClaw CLI installed (`npm install -g @moltbook/openclaw`)

### Deployment Steps

#### 1. Login to Moltbook
```bash
openclaw login
# Select your integrity.molt NFT
```

#### 2. Prepare Environment Variables
In your Molt.id dashboard:
1. Go to **Domains** → **integrity.molt**
2. Click **Settings** → **Environment Variables**
3. Add your credentials:
   - `TELEGRAM_TOKEN=your_token`
   - `OPENAI_API_KEY=your_key`
   - `SOLANA_PUBLIC_KEY=your_wallet`
   - `ENVIRONMENT=production`

#### 3. Deploy Container
```bash
openclaw deploy --domain integrity.molt \
  --dockerfile ./Dockerfile \
  --env-file .env \
  --memory 512MB \
  --instances 1
```

#### 4. Monitor Deployment
```bash
openclaw logs integrity.molt --follow
```

**Result:**
- ✅ Bot runs on Moltbook's global infrastructure
- ✅ No monthly VPS bill
- ✅ Auto-scaling if needed
- ✅ Built-in domain signer for transactions
- ✅ Accessible via Telegram (no IP changes)

---

## Option B: clouding.io (Development/Fallback)

Use this for testing or as a backup.

### Prerequisites
- clouding.io account
- SSH access to your server
- 256MB+ free disk space

### Deployment Steps

#### 1. SSH into Server
```bash
ssh root@your-clouding-ip
```

#### 2. Clone and Setup
```bash
cd /opt
git clone https://github.com/YOUR_USERNAME/integrity.molt.git
cd integrity.molt

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

#### 3. Create .env
```bash
cp .env.example .env
# Edit with your credentials
nano .env
```

#### 4. Run with Systemd (Auto-restart)
```bash
# Create service file
sudo tee /etc/systemd/system/integrity-molt.service > /dev/null <<EOF
[Unit]
Description=integrity.molt Security Audit Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/integrity.molt
Environment="PATH=/opt/integrity.molt/venv/bin"
ExecStart=/opt/integrity.molt/venv/bin/python -m src
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable integrity-molt
sudo systemctl start integrity-molt

# Check status
sudo systemctl status integrity-molt

# View logs
sudo journalctl -u integrity-molt -f
```

#### 5. Verify Running
```bash
ps aux | grep "python -m src"
```

---

## Switching Between Deployments

### Stop Local Bot
```bash
# If running in background on your computer
# Press Ctrl+C in the terminal where it's running
```

### Check Which is Active
Message your bot on Telegram. It will respond with whichever instance is running.

---

## Cost Comparison

| Method | Setup | Monthly Cost | Maintenance |
|--------|-------|--------------|-------------|
| **Moltbook** | 5 min | $0 | Minimal |
| **clouding.io** | 15 min | ~$5-10 | Medium |
| **Local Machine** | 2 min | $0 | SSH to local |

---

## Monitoring & Logs

### Moltbook OpenClaw
```bash
openclaw logs integrity.molt --follow
openclaw stats integrity.molt
```

### clouding.io
```bash
sudo journalctl -u integrity-molt -f
tail -f /opt/integrity.molt/bot.log
```

### Local
Check terminal where `python -m src` is running

---

## Next Steps

1. **If choosing Moltbook**: Go to [app.molt.id](https://app.molt.id), navigate to your domain, and set up OpenClaw
2. **If choosing clouding.io**: SSH in and run deployment commands above
3. **Test**: Send `/audit` command to your bot on Telegram
4. **Monitor**: Check logs to verify it's working

**Recommendation**: Start with Moltbook OpenClaw since you already have the NFT infrastructure ready. It's the most aligned with your project vision.
