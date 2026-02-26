# Copilot Instructions for integrity.molt

## Project Overview
**integrity.molt** is an autonomous security audit agent deployed on Moltbook (Solana blockchain). It performs continuous smart contract security analysis, accessible via Telegram, with audits verified on-chain as Metaplex Core NFTs.

- **Domain Mint**: `integrity.molt` (NFT on Solana, Metaplex Core)
- **Infrastructure**: Moltbook OpenClaw (Cloudflare Moltworker) + clouding.io fallback
- **Primary Interface**: Telegram Bot
- **Monetization**: Per-audit fees + subscription model + ecosystem revenue share

## Tech Stack
- **Agent Language**: Python 3.11+
- **LLM Provider**: OpenAI GPT-4 API (5 USD credit available)
- **Blockchain**: Solana (via Solders or Web3.py)
- **Bot Framework**: python-telegram-bot
- **Storage**: Cloudflare R2 (via Molt.id) + Metaplex Core (on-chain)
- **Hosting**: Moltbook OpenClaw (containerized) + clouding.io for testing
- **Secrets Management**: `.env` file (never commit)

## Project Structure
```
integrity.molt/
├── soul.md              # Mission, value prop, monetization model
├── skill.md             # Technical capabilities, stack details
├── .github/
│   └── copilot-instructions.md    # This file
├── src/
│   ├── agent.py         # Main agent logic + request dispatcher
│   ├── telegram_bot.py  # Telegram integration & commands
│   ├── security_auditor.py  # GPT-4 audit logic
│   ├── solana_client.py # Solana RPC wrapper
│   ├── storage.py       # R2 + on-chain persistence
│   └── config.py        # Environment & API config
├── tests/
│   ├── test_auditor.py
│   └── test_telegram.py
├── requirements.txt     # Python dependencies
├── .env.example         # Template (repo-safe)
└── docker-compose.yml   # Local dev environment (future)
```

## Critical Development Workflows

### 1. Telegram Command Flow
When a user messages `/audit <contract_address>`:
1. `telegram_bot.py`: Parse message → extract contract address
2. `agent.py`: Validate address on Solana, queue audit job
3. `security_auditor.py`: Call GPT-4 with contract bytecode/source
4. `storage.py`: Save report to R2 + hash to Metaplex Core
5. `telegram_bot.py`: Send report link + on-chain proof to user
6. **User pays audit fee** (SOL) → fund wallet address

### 2. OpenAI Integration
- Model: `gpt-4` (or `gpt-4-turbo` for cost efficiency)
- Max tokens: 4000 (keep audit reports concise)
- Temperature: 0.3 (deterministic security analysis)
- **Cost tracking**: Log all API calls; stop if credit threshold exceeded

### 3. Solana On-Chain Verification
- Audits stored as **Metaplex Core NFTs** (not metadata JSON)—use `metaplex-program-library`
- Authority: `integrity.molt` domain NFT signer
- Immutable audit records prove agent authenticity
- Users verify reports via Solscan/Metaplex explorer

## Key Conventions & Patterns

### Error Handling
```python
# Pattern: User-friendly errors + server logging
try:
    audit_result = run_audit(contract_addr)
except SolanaRPCError as e:
    telegram_send("❌ Network error. Retrying...")
    logger.error(f"Solana RPC failed: {e}", extra={"user_id": user_id})
except OpenAIError as e:
    telegram_send("🤔 Analysis failed. Try again later.")
    logger.error(f"GPT-4 API error: {e}")
```

### Configuration
- Use `config.py` for all secrets (loaded from `.env`)
- Never hardcode API keys, wallet addresses, or thresholds
- Environment-specific configs: `ENVIRONMENT=production|development`

### Naming Conventions
- Functions: `snake_case` (e.g., `audit_Contract`, `parse_Telegram_message`)
- Classes: `PascalCase` (e.g., `SecurityAuditor`, `SolanaClient`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `GPT4_MODEL`, `MAX_AUDIT_SIZE`)
- Telegram commands: lowercase (e.g., `/audit`, `/subscribe`, `/history`)

### Logging
Every audit and payment must be logged:
```python
logger.info(f"Audit completed", extra={
    "contract": contract_addr,
    "audit_id": report_hash,
    "user_telegram_id": user_id,
    "duration_sec": elapsed,
    "tokens_used": gpt_tokens
})
```

## Integration Points

### Telegram Bot Setup
1. Create bot via BotFather (@BotFather on Telegram)
2. Get API token → store in `.env` as `TELEGRAM_TOKEN`
3. Set webhook or polling mode (polling for testing, webhook for production)
4. Commands: `/audit`, `/subscribe`, `/status`, `/history`, `/help`

### Solana Wallet Setup
- Driver: Phantom or similar (co-sign with Molt.id domain)
- Public key stored in `.env` as `SOLANA_PUBLIC_KEY`
- Never expose private keys; use domain signer via Metaplex CPI

### OpenAI API
- Key stored as `OPENAI_API_KEY` in `.env`
- Track token usage daily; alert if approaching 5 USD credit limit
- Use `cost_tracker.py` module to log expenses

### Moltbook Integration
- Subscribe to `.molt` marketplace events (webhooks)
- Announce new audits in Molt Discord channel
- Link audit reports in agent profile (on app.molt.id)

## Development Roadmap

### Phase 1: MVP (Weeks 1–2)
- [ ] Telegram bot with `/audit` command
- [ ] Integrate OpenAI GPT-4 (dummy audit logic first)
- [ ] Solana wallet integration (read-only account data)
- [ ] Local R2 mock storage
- [ ] Deploy on clouding.io for testing

### Phase 2: Security & Storage (Weeks 3–4)
- [ ] Implement real security analysis (contract pattern matching)
- [ ] Metaplex Core on-chain report anchoring
- [ ] Payment processing (SOL transactions)
- [ ] Audit history persistence in R2

### Phase 3: Production & Scaling (Weeks 5+)
- [ ] Move to Moltbook OpenClaw
- [ ] Telegram webhook setup (production mode)
- [ ] Subscription tiers & recurring billing
- [ ] Rate limiting & quota management
- [ ] Monitoring & alerting (Sentry or similar)

## Testing Strategy
- **Unit tests**: Security auditor logic, config parsing
- **Integration tests**: Telegram → Solana → R2 flow
- **Manual tests**: Whitelist test contracts on devnet first
- **Telegram testing**: Use BotFather's test channel or a personal group

**Run tests locally**:
```bash
python -m pytest tests/ -v --cov=src
```

## File References for Common Tasks
| Task | File(s) |
|------|---------|
| Add new Telegram command | [src/telegram_bot.py](src/telegram_bot.py) |
| Implement audit logic | [src/security_auditor.py](src/security_auditor.py) |
| Configure API keys | [.env.example](.env.example), [src/config.py](src/config.py) |
| Test audit flow | [tests/test_auditor.py](tests/test_auditor.py) |
| Deploy to OpenClaw | [docker-compose.yml](docker-compose.yml) |

## Next Steps for AI Agents
1. **Start with MVP**: Build `/audit` command first (skeleton audit logic OK)
2. **Test Telegram integration**: Verify bot receives messages, sends responses
3. **Mock Solana calls**: Use devnet; don't make mainnet writes until Phase 2
4. **Document payloads**: Track request/response formats between modules
5. **Update this file**: Add learnings, architectural decisions, integration gotchas

---
*Last updated: February 25, 2026*
*Contact: integrity.molt on Solana Mainnet*
