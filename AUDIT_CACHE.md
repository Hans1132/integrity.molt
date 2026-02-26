# Audit History Caching

## Overview
integrity.molt caches recent security audits for:
- **Deduplication**: Detect when user audits same contract within 24 hours
- **Fast retrieval**: Historical lookups without R2 latency
- **User convenience**: Support `/history` command for users to view past audits
- **Analytics**: Track which contracts are audited most frequently

## Phase Breakdown

### Phase 2: In-Memory LRU Cache (✅ CURRENT)
- Store up to 1,000 recent audits in RAM
- Index by user_id and contract_address
- 72-hour TTL (time-to-live) for cached entries
- Automatic eviction when cache full (FIFO/LRU)
- **Status**: Ready for Phase 3 persistence

### Phase 3: Database Persistence
- Move cache to persistent layer (MongoDB/PostgreSQL)
- Sync audits to R2 and database automatically
- Aggregate analytics queries

### Phase 4: Smart Caching
- ML-based audit relevance scoring
- Contract risk trend analysis
- User audit patterns

## Cache Structure

```
AuditCache (1000 max entries, 72h TTL)
├── main: {audit_id → AuditRecord}
├── user_index: {user_id → [audit_ids]}
└── contract_index: {contract_address → [audit_ids]}

AuditRecord:
  - audit_id, user_id, contract_address
  - timestamp, risk_score
  - findings_summary, tokens_used, cost_sol
  - r2_url, nft_hash (optional)
```

## Deduplication Flow

### Scenario 1: User audits same contract within 24 hours

```
User: /audit EvXNCtao...
    ↓
Check cache: Is this contract + user combo in last 24h?
    ↓
YES → Return cached result
    ├─ Status: "cached"
    ├─ Timestamp of previous audit
    ├─ Risk score
    └─ Suggestion: "/audit <addr> --force to re-audit"
    ↓
OR

NO → Run full audit
    ├─ Save to cache
    └─ Return fresh result
```

### Telegram Display: Cached Result

```
⚡ **Cached Audit Found** (EvXNCtao...)

📅 From: `2026-02-26T10:03:11`
📊 Risk Score: 7
📝 Summary: [First 100 chars of findings...]

🔗 [Full Cached Report on R2](https://...)

💡 To re-audit: `/audit <addr> --force`
📚 View history: `/history`
```

## User History Command

Future `/history` command example:

```
User: /history

Bot Response:

📚 **Your Audit History** (Last 10)

1. EvXNCtao... | Risk 7 | 2026-02-26 10:03 | 0.0072 SOL
2. 5xWgP7h... | Risk 3 | 2026-02-25 14:22 | 0.0051 SOL
3. ABC123... | Risk 9 | 2026-02-24 08:15 | 0.0135 SOL
...

💾 Total audits: 27
💰 Total spent: 0.185 SOL
📊 Avg risk: 5.8
```

## API Reference

### Create Audit Record

```python
from src.audit_cache import AuditRecord, audit_cache

record = AuditRecord(
    audit_id="audit_5940877089_1772105347",
    user_id=5940877089,
    contract_address="EvXNCtao...",
    timestamp="2026-02-26T10:03:11Z",
    risk_score="7",
    findings_summary="Potential reentrancy in withdraw()...",
    tokens_used=1234,
    cost_sol=0.0072,
    r2_url="https://...",
    nft_hash="a3c5e8f2..."
)

audit_cache.add_audit(record)
```

### Get User History

```python
from src.audit_cache import get_user_audit_history

history = get_user_audit_history(user_id=5940877089, limit=10)

# Response:
# [
#   {
#     "audit_id": "audit_5940877089_1772105347",
#     "timestamp": "2026-02-26T10:03:11Z",
#     "contract_address": "EvXNCtao...",
#     "risk_score": "7",
#     "tokens_used": 1234,
#     "cost_sol": 0.0072,
#     ...
#   },
#   ...
# ]
```

### Check Recent Audit (Deduplication)

```python
from src.audit_cache import audit_cache

recent = audit_cache.is_recent_audit(
    user_id=5940877089,
    contract_address="EvXNCtao...",
    within_hours=24
)

if recent:
    print(f"Recent audit found: {recent.timestamp}")
else:
    print("No recent audit, run fresh analysis")
```

### Get Contract History

```python
contract_audits = audit_cache.get_contract_history(
    contract_address="EvXNCtao...",
    limit=5
)

# Returns list of audits for this contract
# across ALL users (reverse chronological)
```

### Cache Statistics

```python
stats = audit_cache.get_cache_stats()

# Response:
# {
#     "cache_size": 347,
#     "max_size": 1000,
#     "users_tracked": 156,
#     "contracts_tracked": 892,
#     "cache_hits": 1234,
#     "cache_misses": 567,
#     "hit_rate": "68.5%",
#     "evictions": 12
# }
```

## Integration with SecurityAuditor

When `analyze_contract()` is called:

```python
result = SecurityAuditor.analyze_contract(
    contract_address="EvXNCtao...",
    user_id=5940877089,
    is_subscriber=True
)

# Internally:
# 1. Check cache for recent audit
# 2. If found → return cached result (status="cached")
# 3. If not found → run full audit
# 4. Cache the new result
# 5. Return audit_result with cache info
```

## LRU Eviction Policy

When cache reaches max_size (1000):

1. Remove oldest entry (FIFO)
2. Update user_index (remove audit_id from list)
3. Update contract_index (remove audit_id from list)
4. Log eviction: `"Evicted: audit_123 (LRU, size at max)"`
5. Continue adding new audit

```
Cache before: 1000 entries
  Add new audit
  Cache full → evict oldest
Cache after: 1000 entries (oldest removed)
```

## TTL (Time-To-Live)

Default: 72 hours

Behavior:
- Audits cached for 72 hours max
- After 72h, entry considered "expired"
- Not deleted immediately (lazy evaluation)
- Skipped when checking recent audits
- Fully cleared only on LRU eviction or explicit clear

To check expired-aware:

```python
history = audit_cache.get_user_history(
    user_id=5940877089,
    include_expired=False  # Skip expired entries
)
```

## Performance Impact

**Deduplication savings** (typical user):
- Check cache: ~1 millisecond
- Detection of recent audit: ~50ms
- Savings per skipped audit: ~3-5 seconds (no GPT-4 call)

**Hit rate target**: 60-80%

**Cache memory**: 
- Per audit: ~500 bytes
- 1000 audits: ~500 KB
- Negligible on modern systems

## Testing

```bash
# Test cache functionality
python -m src.audit_cache

# Run all tests
python -m pytest tests/ -v

# Manual: Check deduplication
python -c "
from src.audit_cache import audit_cache, AuditRecord
record = AuditRecord('test_id', 123, 'contract', '2026-02-26T10:03:11Z', '5', 'Summary', 1000, 0.005)
audit_cache.add_audit(record)
recent = audit_cache.is_recent_audit(123, 'contract')
print('Found recent:', recent is not None)
"
```

## Telegram Commands (Phase 3)

Proposed new commands:

```
/history [limit]          - Show your audit history (last 10 by default)
/history <addr>           - Show audits for a specific contract
/stats                    - Your audit stats (count, total spent, avg risk)
/cache clear              - Clear your personal cache entries
/audit <addr> --force     - Force re-audit even if cached
```

## Privacy Considerations

- Cache is **in-memory and temporary** (cleared on bot restart)
- User history visible **only to that user**
- Contract history **visible to all users** (aggregate across auditors)
- No persistent user tracking (Phase 2)
- Phase 3: Consider GDPR compliance with persistent DB

## Roadmap

| Feature | Phase | Status |
|---------|-------|--------|
| In-memory cache | 2 | ✅ |
| User history retrieval | 2 | ✅ |
| Deduplication detection | 2 | ✅ |
| Telegram `/history` command | 3 | 🔜 |
| Database persistence | 3 | 🔜 |
| Analytics dashboard | 4 | 🔜 |
| Smart cache preprocessing | 4 | 🔜 |

---
Last updated: February 26, 2026
**Implementation**: Phase 2 in-memory caching complete → Phase 3 DB persistence ready
