# Heartbeat: integrity.molt Health Monitoring

## Agent Status Signals

### Startup Signal
When the agent starts, it signals:
```json
{
  "event": "agent_startup",
  "timestamp": "2026-02-25T10:00:00Z",
  "version": "0.1.0",
  "environment": "production|development",
  "checks": {
    "telegram_api": "✅ connected",
    "openai_api": "✅ connected",
    "solana_rpc": "✅ connected",
    "r2_storage": "⏭️ skipped (phase 2)",
    "metaplex_core": "⏭️ skipped (phase 2)"
  }
}
```

### Periodic Heartbeat (Every 5 minutes)
```json
{
  "event": "heartbeat",
  "timestamp": "2026-02-25T10:05:00Z",
  "uptime_seconds": 300,
  "stats": {
    "audits_completed": 5,
    "audits_failed": 0,
    "avg_response_time_ms": 2400,
    "api_errors": 0,
    "telegram_messages_sent": 8
  },
  "resources": {
    "memory_mb": 124,
    "cpu_percent": 5.2,
    "disk_gb_free": 45.8
  },
  "costs": {
    "today_usd": 0.34,
    "month_usd": 12.50,
    "remaining_budget_usd": 3.16
  }
}
```

### Cost Alert Signal
Triggered when total_usd > API_COST_THRESHOLD_USD:
```json
{
  "event": "cost_alert",
  "severity": "warning",
  "message": "API cost approaching threshold",
  "current_cost_usd": 4.45,
  "threshold_usd": 4.50,
  "action": "STOP_ACCEPTING_NEW_AUDITS",
  "timestamp": "2026-02-25T14:30:00Z"
}
```

### Error Signal
When critical failure occurs:
```json
{
  "event": "error",
  "severity": "critical",
  "component": "openai_api",
  "error_code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests to GPT-4",
  "retry_after_seconds": 60,
  "timestamp": "2026-02-25T14:31:00Z"
}
```

## Monitoring Dashboard (Phase 3)

**Metrics to Track:**
1. **Uptime**: % time agent is responding to Telegram
2. **Latency**: Time from /audit request → report delivered
3. **Accuracy**: User feedback on audit quality (phase 2)
4. **Cost/Audit**: USD spent per completed analysis
5. **User Growth**: New users per day, DAU, MAU
6. **Revenue**: SOL received from subscriptions

**Dashboards:**
- Public (Molt.id): Agent status, audit count
- Private (admin): Cost, errors, user metrics
- Telegram: `/status` command shows uptime + today's cost

## Alerting Strategy

### Alert Thresholds
| Metric | Threshold | Action |
|--------|-----------|--------|
| API Cost | > 4.50 USD | Pause new audits + notify |
| Response Time | > 5s | Log + continue |
| Error Rate | > 5% in 10 min | Alert ops + log |
| Uptime | < 95% daily | Investigate |
| Telegram Lag | > 3s | Check bot polling |

### Alert Delivery
- **Cost alerts**: Log + Telegram bot status message
- **Error alerts**: Log to console, tag in monitoring
- **Uptime alerts**: Email (phase 2), Discord webhook

## Health Checks

### Telegram Bot Check (Every 60 sec)
```python
def check_telegram_health():
    try:
        bot.get_me()  # Simple API call
        return "healthy"
    except Exception as e:
        return f"degraded: {e}"
```

### OpenAI API Check (Every 5 min)
```python
def check_openai_health():
    try:
        response = client.chat.completions.create(
            model="gpt-4-turbo",
            messages=[{"role": "user", "content": "Test"}],
            max_tokens=1
        )
        return "healthy"
    except Exception as e:
        return f"degraded: {e}"
```

### Solana RPC Check (Every 5 min)
```python
def check_solana_health():
    try:
        client.get_health()
        return "healthy"
    except Exception as e:
        return f"degraded: {e}"
```

## Logging Format

All logs include:
```python
logger.info("audit_completed", extra={
    "user_id": 123456789,
    "contract_address": "...",
    "audit_id": "hash",
    "duration_ms": 2400,
    "tokens_used": 1250,
    "cost_usd": 0.045,
    "risk_score": 6,
    "status": "success"
})
```

**Daily Log Summary (23:59 UTC):**
```
=== Daily Audit Report ===
Date: 2026-02-25
Audits completed: 125
Audits failed: 2 (1.6% error rate)
Total users: 87 (15 new)
Revenue: 12.5 SOL
API cost: 3.80 USD
Avg response time: 2.2s
Best performing hour: 14:00-15:00 (34 audits)
```

## Degradation Path

**If OpenAI API fails:**
- ✅ Still accept audit requests
- ✅ Queue them for retry
- ❌ Don't process new ones
- 📢 Tell users: "Analysis delayed, will complete soon"

**If Solana RPC fails:**
- ✅ Telegram bot still works
- ✅ Still analyze contracts (local)
- ❌ Can't verify payments (phase 2)
- 📢 Tell users: "Verification unavailable, try later"

**If Telegram API fails:**
- ❌ No user communication possible
- ✅ Continue analyzing in background
- ✅ Queue messages for retry
- 📢 No way to notify (log to monitoring service)

## Recovery Procedures

**Automatic Restart (if needed):**
1. Monitor detects agent down
2. Moltbook OpenClaw auto-restarts container
3. Agent performs startup checks
4. Resume audit processing

**Manual Recovery:**
```bash
# View logs
docker logs integrity-molt --tail 100

# Restart agent
docker restart integrity-molt

# Check status
curl http://localhost:8000/health
```
