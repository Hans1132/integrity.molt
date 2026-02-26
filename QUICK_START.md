# Quick Start Guide - integrity.molt

## What is integrity.molt?

An autonomous AI security auditor deployed on Moltbook (Solana blockchain). It analyzes smart contracts using GPT-4 and pattern-based detection, accessible via Telegram bot.

**Status:** Production-ready as of February 26, 2026  
**Current Phase:** 3d - Production Deployment

---

## 5-Minute Setup (Local)

```bash
# 1. Clone repo
git clone https://github.com/Hans1132/integrity.molt.git
cd integrity.molt

# 2. Create Python environment
python3.11 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Copy template env
cp .env.example .env

# 5. Run tests
pytest tests/ -v

# 6. Start bot (local mode)
python -m src

# 7. Open Telegram and send /start to your bot
```

---

## What's Inside?

```
integrity.molt/
├── src/
│   ├── telegram_bot.py          # User interface
│   ├── security_auditor.py       # GPT-4 analysis + routing
│   ├── free_analyzer.py          # Free tier pattern detection
│   ├── database.py               # MongoDB persistence
│   ├── phantom_wallet.py         # Solana wallet integration
│   └── ... (10+ more modules)
├── tests/                         # Test suite (4/4 passing)
├── requirements.txt              # Python dependencies
├── Dockerfile                    # Container configuration
├── railway.toml                  # Railway.app config
├── PHASE_3d.md                   # Deployment guide
├── DEPLOYMENT_READY.md           # Pre-flight checklist
└── README.md                     # This file
```

---

## Features

### ✅ Implemented (Production Ready)

| Feature | Phase | Status |
|---------|-------|--------|
| Telegram bot | 1 | ✅ Working |
| GPT-4 security analysis | 2 | ✅ Working |
| Vulnerability pattern detection | 2 | ✅ 8 patterns |
| Cloudflare R2 storage | 2 | ✅ Optional |
| Metaplex NFT anchoring | 2 | ✅ Optional |
| Payment processing | 2 | ✅ Implemented |
| Audit history caching | 2 | ✅ Working |
| Rate limiting & quotas | 2 | ✅ 3 tiers |
| Phantom wallet integration | 3 | ✅ Ready |
| Transaction signing | 3 | ✅ Ready |
| Solana RPC verification | 3 | ✅ Ready |
| Free tier pattern analysis | 3b | ✅ $0/audit |
| Tier-based LLM routing | 3b | ✅ Cost-optimized |
| MongoDB persistence | 3c | ✅ Real + mock |
| Dual-mode database | 3c | ✅ Auto-fallback |

### 🚀 Deployment Ready

| Component | Status | Details |
|-----------|--------|---------|
| Railway.app | ✅ | Auto-deploy on git push |
| Docker | ✅ | Production image ready |
| MongoDB | ✅ | Free tier available |
| Environment config | ✅ | Template provided |
| Tests | ✅ | 4/4 passing |

---

## Usage

### Telegram Commands

```
/start          # Welcome message
/help           # Show all commands
/audit <addr>   # Analyze contract
/history [n]    # View last N audits (default: 10)
/quota          # Check usage limits
/subscribe <tier>  # Upgrade subscription
```

### Example Flow

```
User: /audit EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf

Bot: 🔍 Analyzing EvXNCtao... Please wait...

[Analysis happens - free users get pattern-based, paid get GPT-4]

Bot: ✅ **Security Analysis Report** (Risk: 7/10)

     🔴 CRITICAL Issues (2):
     • Reentrancy detected in withdraw()
     • Unchecked external call in transfer()

     🟡 MEDIUM Issues (1):
     • Missing access control on admin function

     Recommendations:
     1. Use checks-effects-interactions pattern
     2. Implement access controls
     ...
```

---

## Cost Breakdown

### Free Tier
- **Price:** $0.00
- **Analysis:** Pattern-based (instant)
- **Audits/month:** 5
- **Storage:** Database only

### Subscriber Tier
- **Price:** $9.99/month
- **Analysis:** Full GPT-4 + patterns
- **Audits/month:** Unlimited
- **Storage:** Database + R2 + NFT

### Premium Tier
- **Price:** $49.99/month
- **Analysis:** Full GPT-4 + patterns
- **Audits/month:** Unlimited
- **Storage:** Database + R2 + NFT + priority

---

## Deployment

### To Railway.app (Production)

```bash
# Prerequisites
# - Have git repo pushed to GitHub
# - Have .env variables ready
# - Have MongoDB Atlas account

# 1. Connect Railway to GitHub
#    Go to railway.app → New Project → GitHub

# 2. Set environment variables in Railway dashboard
#    TELEGRAM_TOKEN=...
#    OPENAI_API_KEY=...
#    MONGODB_URI=...
#    (See .env.example for complete list)

# 3. Push to deploy
git push origin main

# 4. Monitor deployment
#    railway.app dashboard → Deployments → View Logs
```

**Estimated time:** 15-20 minutes  
**Cost:** Free tier (or ~$5-50/month for prod resources)

---

## Architecture

```
┌─────────────────────┐
│   Telegram User     │
└──────────┬──────────┘
           │ /audit command
           ▼
┌──────────────────────────────────┐
│     Telegram Bot                 │
│  (Railway.app container)         │
│  - Async polling/webhooks        │
│  - Command parsing               │
│  - Rate limiting                 │
└──────────┬───────────────────────┘
           │
    ┌──────┴──────────┐
    │                 │
    ▼                 ▼
┌──────────┐    ┌──────────────┐
│ Free     │    │     Paid     │
│ Analyzer │    │   GPT-4      │
│$0/audit  │    │ $0.03/audit  │
└──────┬───┘    └──────┬───────┘
       │                │
       └────────┬───────┘
                ▼
        ┌──────────────────┐
        │  Database Layer  │
        │  MongoDB Atlas   │
        │  - Audits        │
        │  - Users         │
        │  - Transactions  │
        └────────┬─────────┘
                 │
        ┌────────▼──────────┐
        │  Blockchain       │
        │  Solana mainnet   │
        │  - Payments       │
        │  - NFT anchoring  │
        │  - Phantom wallet │
        └───────────────────┘
```

---

## Development

### Setup Development Environment

```bash
# 1. Create venv
python3.11 -m venv venv
source venv/bin/activate

# 2. Install deps
pip install -r requirements.txt

# 3. Copy env template
cp .env.example .env
# Edit .env with your test API keys

# 4. Run tests
pytest tests/ -v

# 5. Start locally
DATABASE_MODE=mock python -m src
```

### Run Tests

```bash
# All tests
pytest tests/ -v

# Specific test file
pytest tests/test_auditor.py -v

# With coverage
pytest tests/ --cov=src/
```

### Code Organization

- **`src/telegram_bot.py`** - User commands, message handling
- **`src/security_auditor.py`** - Routing (free vs paid), GPT-4 calls
- **`src/free_analyzer.py`** - Pattern-based vulnerability detection
- **`src/database.py`** - MongoDB persistence layer
- **`src/config.py`** - Environment configuration
- **`src/*_processor.py`** - Payment, rate limiting, caching
- **`src/*_signer.py`** - Blockchain transaction signing
- **`tests/`** - Test suite

---

## Troubleshooting

### Bot not responding

**Check:**
```bash
# 1. Is TELEGRAM_TOKEN set?
echo $TELEGRAM_TOKEN

# 2. Is bot running?
ps aux | grep "python -m src"

# 3. Check logs
railway logs -f  # (if deployed)
```

### Database connection failed

```bash
# 1. Is MONGODB_URI correct?
echo $MONGODB_URI

# 2. Is MongoDB cluster running?
# Check MongoDB Atlas dashboard

# 3. Test connection
mongodb+srv://user:pass@cluster.mongodb.net

# 4. Fallback to mock mode
DATABASE_MODE=mock python -m src
```

### GPT-4 API errors

```bash
# 1. Check API key
openai api models.list

# 2. Check quota
# Go to platform.openai.com/account/billing/usage

# 3. Check rate limits
# Max: 3,500 RPM (free) or 90,000 RPM (paid)
```

---

## Monitoring

### Check Bot Status

```bash
# Railway logs (last 50 lines with follow)
railway logs -f

# Or via web dashboard
# https://railway.app/projects/YOUR_PROJECT_ID
```

### Key Metrics

```
✅ Bot responding to commands
✅ Database storing audits
✅ Free users getting pattern analysis ($0)
✅ Paid users getting GPT-4 analysis
✅ < 1% error rate
✅ Audit average response time < 5s
```

---

## Security

⚠️ **Never commit:**
- `.env` file with real API keys
- Private keys
- Database passwords
- Telegram tokens

✅ **Always use:**
- Environment variables for secrets
- Railway/Vercel secret management
- `.env.example` as template

---

## Contributing

1. Fork repository
2. Create feature branch: `git checkout -b feature/my-feature`
3. Make changes and test: `pytest tests/ -v`
4. Commit: `git commit -m "feat: description"`
5. Push: `git push origin feature/my-feature`
6. Create Pull Request

---

## Support

- **Issues:** GitHub Issues
- **Documentation:** See PHASE_3d.md
- **Deployment:** See DEPLOYMENT_READY.md
- **Architecture:** See AGENTS.md and skill.md

---

## License & Attribution

**integrity.molt** - Security Audit Agent for Moltbook  
**Creator:** Hans1132  
**Date:** February 26, 2026  
**Status:** Production-Ready

---

## Next Steps

### For Users
1. Get Telegram bot token
2. Add bot to Telegram
3. Send `/audit <contract>` to analyze

### For Operators
1. Review PHASE_3d.md deployment guide
2. Follow DEPLOYMENT_READY.md checklist
3. Deploy to Railway.app
4. Monitor production dashboard

### For Developers
1. Clone repository: `git clone ...`
2. Install dependencies: `pip install -r requirements.txt`
3. Run tests: `pytest tests/ -v`
4. Make contributions and submit PR

---

**Status:** ✅ READY FOR PRODUCTION  
**Phase:** 3d - Deployment  
**Version:** 1.0.0  
**Last Updated:** February 26, 2026

