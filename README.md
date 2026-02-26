# integrity.molt - Quick Start Guide

## What This Project Is
An autonomous AI security audit agent for the Moltbook ecosystem (Solana blockchain). Users request smart contract audits via Telegram; the agent analyzes code with GPT-4 and returns findings with on-chain verification.

## Prerequisites
✅ **You have:**
- `integrity.molt` NFT minted on Solana
- OpenAI API key (5 USD credit)
- clouding.io server access
- Telegram account

✅ **You need:**
- Python 3.11+
- Git
- A Telegram bot token (from @BotFather)

## Setup (5 Minutes)

### 1. Clone & Install Dependencies
```bash
cd integrity.molt
python -m venv venv
source venv/Scripts/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Create `.env` File
```bash
cp .env.example .env
# Edit .env with your actual credentials:
# - TELEGRAM_TOKEN (from @BotFather)
# - OPENAI_API_KEY (your 5 USD credit key)
# - SOLANA_PUBLIC_KEY (your integrity.molt wallet)
```

### 3. Test Basic Bot Setup
```bash
python -c "import telegram; print('✅ Telegram library OK')"
python -c "import openai; print('✅ OpenAI library OK')"
python -c "import solders; print('✅ Solana library OK')"
```

## Phase 1: Build the MVP (What to Start With)

### Phase 1 Scope (✅ What Works Now)
- ✅ Telegram bot receives `/audit` commands
- ✅ OpenAI GPT-4 analyzes contracts
- ✅ Reports returned to Telegram
- ✅ Cost tracking (API usage logged)
- ✅ Solana address validation

### Phase 2 Scope (Not needed yet)
- ⏳ Cloudflare R2 storage (audit persistence)
- ⏳ Metaplex Core NFT anchoring
- ⏳ SOL payment processing
- ⏳ User subscription tiers
- ⏳ Audit history per user

### Step 1: Create Bot Skeleton
Create `src/telegram_bot.py`:
- Listen for `/audit <contract_address>` command
- Echo back: "Auditing {address}... (dummy response)"
- Test by messaging your bot on Telegram

**Key function to implement:**
```python
async def audit_command(update, context):
    # Extract contract address from /audit <address>
    # Validate Solana address format
    # Return "Audit queued for {address}"
```

### Step 2: Add OpenAI Integration
Create `src/security_auditor.py`:
- Take a contract address
- Call GPT-4 with a test prompt
- Return a dummy audit report (5-10 lines)

**Key function to implement:**
```python
def analyze_contract(contract_address, contract_code=""):
    # Use GPT-4 to analyze security issues
    # Return findings with severity scores
```

### Step 3: Wire Them Together
Create `src/agent.py`:
- Import bot and auditor
- Route `/audit` commands → auditor → return results to Telegram

## Next Milestones

### Phase 2: Real Solana Integration
- [ ] Fetch actual contract code from Solana
- [ ] Store audit reports in Cloudflare R2
- [ ] Anchor report hashes on-chain (Metaplex Core)

### Phase 3: Production
- [ ] Payment processing (SOL transactions)
- [ ] Deploy to Moltbook OpenClaw
- [ ] Set up subscription tiers

## Important Notes
- **Never commit `.env` or private keys**
- **Cost tracking**: Log every GPT-4 call; stop at 4.50 USD (leave 0.50 USD buffer)
- **Test on Solana devnet first** before mainnet transactions
- **Use Telegram bot test mode** while developing (@BotFather → settings)

## File Structure You'll Create
```
src/
├── config.py           # Load .env, validate settings
├── telegram_bot.py     # Telegram UI
├── security_auditor.py # GPT-4 audit logic
├── agent.py            # Orchestration layer
├── solana_client.py    # [Phase 2] Solana RPC calls
└── storage.py          # [Phase 2] R2 + on-chain storage

tests/
├── test_auditor.py
└── test_telegram.py

__main__.py            # Entry point: `python -m src` starts bot
```

## Run Tests
```bash
pytest tests/ -v
```

## Getting Help
- Solana docs: https://docs.solana.com
- Telegram bot: https://python-telegram-bot.readthedocs.io
- OpenAI GPT-4: https://platform.openai.com/docs/guides/gpt
- Moltbook docs: https://docs.molt.id

---
**Ready to start?** → Create `src/config.py` first to load your `.env` file.
