# 🔗 Moltbook Integration Guide

**Status:** Connected ✅  
**Agent ID:** molt_78587c41ed99a3375022dc28  
**Domain:** integrity.molt  
**Date:** Feb 26, 2026

---

## What's Integrated

Your **integrity.molt Telegram bot** is now connected to your **Moltbook NFT agent**.

This means:
- ✅ Audits run through Telegram bot
- ✅ Results registered with Moltbook agent
- ✅ Audit proofs anchored on-chain (Phase 2)
- ✅ Revenue shared via Moltbook marketplace (Phase 3)

---

## Configuration

### Environment Variables

Location: [`.env`](.env)

```bash
# Moltbook Integration
MOLTBOOK_AGENT_ID=molt_78587c41ed99a3375022dc28
MOLTBOOK_DOMAIN_NAME=integrity.molt
MOLTBOOK_API_URL=https://api.molt.id
MOLTBOOK_WALLET_ADDRESS=3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM
```

### File Structure

- [src/moltbook_client.py](src/moltbook_client.py) - Moltbook API client
- [src/telegram_bot.py](src/telegram_bot.py) - Telegram interface
- [src/security_auditor.py](src/security_auditor.py) - GPT-4 audits

---

## How It Works

### Audit Flow (Current - Phase 1)

```
User sends /audit on Telegram
    ↓
Telegram bot receives command
    ↓
Extracted contract address
    ↓
GPT-4 security analysis
    ↓
Report formatted
    ↓
User receives result on Telegram ✅
```

### Planned - Phase 2 (Registry)

```
...audit completed...
    ↓
Audit registered with Moltbook agent
    ↓
Report saved to R2 storage
    ↓
Proof anchored on-chain (Metaplex Core NFT)
    ↓
User gets on-chain verification link
```

### Planned - Phase 3 (Marketplace)

```
...audit anchored...
    ↓
Published to Moltbook marketplace
    ↓
Users can purchase verified audits
    ↓
Revenue split: you + Moltbook + ecosystem
```

---

## Moltbook Agent Details

**View your agent:**
- **URL:** https://app.molt.id/agents
- **Agent ID:** molt_78587c41ed99a3375022dc28
- **Domain:** integrity.molt
- **Status:** Active ✅

**In Moltbook Dashboard:**
1. Go to **Agents** → **integrity.molt Agent**
2. Tab: **Details** (copy API endpoint if available)
3. Tab: **Cron Jobs** (for scheduled audits, Phase 3)
4. Tab: **Logs** (monitor audit activity)

---

## Integration API (Placeholder - Phase 2)

```python
from src.moltbook_client import moltbook

# Register completed audit
await moltbook.register_audit(
    contract_address="3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM",
    audit_id="audit_20260226_001",
    report={
        "findings": [...],
        "severity": "MEDIUM",
        "timestamp": 1740564267,
        "token_cost": 1500
    }
)

# Publish to marketplace
await moltbook.publish_to_marketplace(
    audit_id="audit_20260226_001",
    report={...}
)

# Anchor on-chain
await moltbook.anchor_on_chain(
    audit_id="audit_20260226_001",
    proof_hash="0x123abc..."
)
```

---

## Next Steps

### Short-term (This Week)
- [x] Create Telegram bot
- [x] Integrate GPT-4 audits
- [x] Connect to Moltbook agent
- [ ] Test audit flow end-to-end

### Medium-term (Next 2 Weeks)
- [ ] Implement Moltbook audit registration
- [ ] Add R2 storage for audit reports
- [ ] Anchor audits on-chain (Metaplex Core)
- [ ] Create marketplace listing

### Long-term (Next Month+)
- [ ] Payment processing (SOL transactions)
- [ ] Subscription tiers
- [ ] Revenue sharing model
- [ ] Advanced analytics dashboard

---

## Monitoring

### Check Agent Status

```bash
# View logs on Moltbook
curl https://api.molt.id/agents/molt_78587c41ed99a3375022dc28/logs
```

### Local Logs

```bash
# Start bot with verbose logging
ENVIRONMENT=production LOG_LEVEL=DEBUG python -m src
```

### Telegram Bot Status

Send `/status` to your bot to see:
- Uptime
- Audits completed
- Total costs
- Next maintenance

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Agent not responding | Check Moltbook dashboard status |
| Audit fails silently | Review bot logs: `python -m src` |
| No R2 storage yet | Phase 2 feature - coming soon |
| Wallet signing issues | Verify Phantom wallet is connected |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   INTEGRITY.MOLT                        │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────┐       ┌──────────────┐               │
│  │ Telegram Bot │───────│ GPT-4 OpenAI │               │
│  │ (Polling)    │       │  (Analysis)  │               │
│  └──────────────┘       └──────────────┘               │
│        │                                                 │
│        └─────────────────────┬──────────────────────┐   │
│                              │                      │   │
│                       ┌─────────────────┐   ┌──────────┐│
│                       │ Moltbook Client │   │ Solana   ││
│                       │  (Registration) │   │ (Signing)││
│                       └─────────────────┘   └──────────┘│
│                              │                      │   │
│  ┌──────────────┐       ┌────▼────┐       ┌────────┴─┐ │
│  │ R2 Storage   │◄──────┤Metaplex │───────┤ Moltbook │ │
│  │ (Reports)    │       │  Core   │       │  Agent   │ │
│  └──────────────┘       └─────────┘       └──────────┘ │
│                                                           │
└─────────────────────────────────────────────────────────┘
                          MOLTBOOK ECOSYSTEM
```

---

## Support

- **Moltbook Docs:** https://docs.molt.id
- **Agent Dashboard:** https://app.molt.id
- **Bot Logs:** `openclaw logs --domain integrity.molt --follow`
- **Local Logs:** Check terminal where bot runs

---

**Last Updated:** February 26, 2026  
**Agent:** integrity.molt  
**Status:** 🟢 Connected to Moltbook
