# Memory: integrity.molt Agent State & Persistence

## Memory Architecture
integrity.molt maintains state across conversations using hierarchical storage:

### Volatile Memory (Runtime)
- Current audit queue (in-process)
- Active Telegram sessions
- API rate limit counters
- Conversation context (last 10 messages per user)

### Persistent Memory (R2 + On-chain)

#### User Memory (Per Telegram User)
```json
{
  "user_id": 123456789,
  "username": "user_handle",
  "first_seen": "2026-02-25T10:30:00Z",
  "audit_count": 42,
  "total_spent_sol": 0.5,
  "subscription_status": "active|inactive",
  "last_audit_timestamp": "2026-02-25T15:45:00Z",
  "audit_history": [
    {
      "contract_address": "...",
      "timestamp": "2026-02-25T15:45:00Z",
      "risk_score": 6,
      "report_hash": "..."
    }
  ]
}
```

#### Audit Memory (Per Completed Audit)
```json
{
  "audit_id": "hash_sha256",
  "contract_address": "...",
  "timestamp_requested": "2026-02-25T10:00:00Z",
  "timestamp_completed": "2026-02-25T10:02:15Z",
  "user_id": 123456789,
  "gpt4_findings": "...",
  "risk_score": 7,
  "tokens_used": 1250,
  "cost_usd": 0.045,
  "on_chain_hash": "metaplex_core_nft_id",
  "status": "completed|failed"
}
```

#### Agent Memory (Global)
```json
{
  "agent_id": "integrity.molt",
  "mint_address": "...",
  "uptime_seconds": 864000,
  "total_audits_all_time": 1543,
  "total_cost_usd": 45.23,
  "total_users": 187,
  "active_users_month": 42,
  "ecosystem_trust_score": 8.5,
  "last_restart": "2026-02-25T00:00:00Z",
  "version": "0.1.0"
}
```

## Storage Locations

### R2 Bucket Structure
```
integrity-molt-audits/
├── users/
│   └── {user_id}/
│       ├── profile.json          # User memory
│       └── {audit_id}.json       # Audit reports
├── cache/
│   └── {contract_address}.json   # Contract analysis cache
└── logs/
    └── {date}.jsonl              # Daily audit logs
```

### On-Chain Storage (Metaplex Core)
- Audit proof-of-completion stored as NFT
- Hash of full report (stored in R2)
- Signer: integrity.molt domain NFT
- Creator fee: 0% (open ecosystem)

## Memory Operations

### Write Audit Result
```python
# 1. Save to R2
save_to_r2(f"users/{user_id}/{audit_id}.json", audit_data)

# 2. Update user profile in R2
update_user_profile(user_id)

# 3. Anchor on-chain (Phase 2)
anchor_to_metaplex_core(audit_id, report_hash)

# 4. Log to audit trail
log_audit_event(audit_data)
```

### Retrieve User History
```python
# 1. Load user profile from R2
user_profile = load_from_r2(f"users/{user_id}/profile.json")

# 2. Sort audits by timestamp
audits = sorted(user_profile["audit_history"], key=lambda x: x["timestamp"], reverse=True)

# 3. Return last 5 audits for Telegram display
return format_for_telegram(audits[:5])
```

## Data Retention Policy
- User profiles: Retained indefinitely (PII compliance TBD)
- Audit reports: Retained 1 year minimum
- Logs: Retained 90 days
- Cache: Auto-purged after 30 days of no access

## Cost Tracking
Every API call is logged to memory:
```json
{
  "timestamp": "2026-02-25T10:00:00Z",
  "api_service": "openai|solana|r2",
  "cost_usd": 0.045,
  "tokens_used": 1250,
  "status": "success|error"
}
```

**Daily budget check**:
- Alert if daily_cost + yesterday_cost > API_COST_THRESHOLD_USD
- Stop accepting new audits if total > 4.50 USD

## Memory Consistency
- R2 is source-of-truth for persistent data
- Volatile memory is cache only
- No dual-write: Always R2 first, then cache
- Conflict resolution: Reload from R2 on startup
