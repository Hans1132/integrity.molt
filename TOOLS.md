# Tools: integrity.molt API & Integration Reference

## External APIs

### OpenAI GPT-4
**Purpose:** Security contract analysis

**Endpoint:** `https://api.openai.com/v1/chat/completions`

**Authentication:** Bearer token in `OPENAI_API_KEY`

**Rate Limits:**
- 3,500 requests/min
- 200,000 tokens/min

**Cost:** ~$0.03 per 1K tokens (input)

**Usage in integrity.molt:**
```python
from openai import OpenAI
client = OpenAI(api_key=config.OPENAI_API_KEY)
response = client.chat.completions.create(
    model="gpt-4-turbo",
    messages=[{"role": "user", "content": prompt}],
    max_tokens=4000,
    temperature=0.3
)
```

**Key Methods:**
- `chat.completions.create()` - Analyze contract
- Usage counts for cost tracking

---

### Telegram Bot API
**Purpose:** User interface

**Endpoint:** `https://api.telegram.org/bot{TOKEN}`

**Authentication:** Bot token in `TELEGRAM_TOKEN`

**Rate Limits:** 30 messages/sec per chat

**Key Methods:**
- `sendMessage()` - Send audit results
- `getMe()` - Verify bot identity
- Polling mode (Phase 1) vs Webhook (Phase 3)

**Usage in integrity.molt:**
```python
from telegram.ext import Application
app = Application.builder().token(token).build()
await update.message.reply_text("Your audit report...")
```

---

### Solana RPC
**Purpose:** Fetch contract code, verify transactions

**Endpoint:** `https://api.mainnet-beta.solana.com` (or custom)

**Authentication:** None (public)

**Rate Limits:** 100 requests/sec (public endpoint)

**Key Methods:**
- `getAccountInfo()` - Fetch contract bytecode
- `getTransaction()` - Verify payment tx
- `sendTransaction()` - Submit transactions (Phase 2)

**Usage in integrity.molt:**
```python
from solders.rpc.requests import GetAccountInfo
response = client.get_account_info(pubkey)
```

---

### Cloudflare R2
**Purpose:** Store audit reports + user data

**Endpoint:** `https://{account_id}.r2.cloudflarestorage.com`

**Authentication:** AWS S3 SDK via access keys

**Cost:** $0.015/GB stored

**Usage in integrity.molt:**
```python
import boto3
s3 = boto3.client('s3', 
    endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
    aws_access_key_id=access_key,
    aws_secret_access_key=secret_key
)
s3.put_object(Bucket=bucket, Key=path, Body=data)
```

---

### Metaplex Core (On-Chain)
**Purpose:** Anchor audit proof-of-completion NFTs

**Program ID:** `4XKv23WzTb9ZpwLCxfQ3k2ChFmQwrUuuazpDKq3ikVSJ`

**Signer:** `integrity.molt` domain NFT

**Usage (Phase 2):**
- Create NFT for each audit (proof)
- Anchor report hash on-chain
- Users verify via Solscan

---

## Internal Tools

### Logging
```python
import logging
logger = logging.getLogger(__name__)
logger.info("Audit completed", extra={
    "contract": address,
    "tokens": 1250,
    "cost_usd": 0.045
})
```

**Log Levels:**
- `DEBUG`: Detailed internal state
- `INFO`: Audit events, user actions
- `WARNING`: Quota approaching, slow responses
- `ERROR`: API failures, validation errors
- `CRITICAL`: Service unavailable

---

### Configuration
**File:** `src/config.py`

**Usage:**
```python
from src.config import Config, validate_config
validate_config()  # Raises if missing required vars
print(Config.SOLANA_RPC_URL)  # Access any setting
```

---

### Testing
```bash
pytest tests/ -v                    # Run all tests
pytest tests/test_auditor.py -v    # Single test file
pytest --cov=src                   # With coverage report
```

**Test patterns:**
- Mock external APIs (OpenAI, Solana)
- Use devnet for integration tests
- Test error cases (missing address, API timeout, etc.)

---

## Moltbook Integration (Future)
- **Webhook events**: Subscribe to marketplace activity
- **Domain storage**: Use Molt.id R2 for audit cache
- **Authority signer**: Co-sign transactions via domain NFT
- **Payment channel**: Receive MOLT tokens, pay affiliates
