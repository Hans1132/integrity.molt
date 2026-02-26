# R2 Storage Integration

## Overview
integrity.molt audits are automatically persisted to Cloudflare R2 storage for audit trail, proof-of-work, and user history.

## Setup

### 1. Create Cloudflare R2 Bucket
1. Go to https://dash.cloudflare.com/ → Account Home
2. R2 → Create Bucket
3. Bucket name: `integrity-molt-audits` (or custom name)
4. Copy bucket name for `.env`

### 2. Generate R2 API Tokens
1. R2 → Settings → API Tokens
2. Create API token with:
   - **Permissions**: Object Read/Write/Delete
   - **Bucket**: Select `integrity-molt-audits`
   - **TTL**: 180 days (or custom)
3. Copy credentials:
   - Account ID (UUID format)
   - Access Key ID
   - Secret Access Key

### 3. Configure .env
```dotenv
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=integrity-molt-audits
```

### 4. Environment Variable Setup (Railway)
In Railway dashboard:
1. Select your project → Railway_Bot service
2. Go to **Variables** tab
3. Add the 4 R2 variables above
4. Save → Container restarts

## API Reference

### Upload Audit Report
```python
from src.r2_storage import upload_audit_to_r2

result = upload_audit_to_r2(
    contract_address="EvXNCtao...",
    audit_result=audit_dict,
    report_text="Formatted report text"
)

# Returns:
# {
#     "status": "success",
#     "report_url": "https://account-id.r2.dev/audits/EvXNCtao/...",
#     "object_key": "audits/EvXNCtao/...",
#     "size_bytes": 4521
# }
```

### Retrieve Audit Report
```python
from src.r2_storage import r2_storage

result = r2_storage.get_audit_report("audits/EvXNCtao/2026-02-26T10:03:11.json")

# Returns:
# {
#     "status": "success",
#     "data": {...full audit report...}
# }
```

### List Audits
```python
result = r2_storage.list_audits(contract_address="EvXNCtao", limit=10)

# Returns:
# {
#     "status": "success",
#     "audits": [
#         {
#             "key": "audits/EvXNCtao/...",
#             "url": "https://account-id.r2.dev/audits/EvXNCtao/...",
#             "size": 4521,
#             "last_modified": "2026-02-26T10:03:11+00:00"
#         }
#     ],
#     "count": 5
# }
```

## Telegram Report Display

When `/audit` is run, the Telegram message now includes:
- ✅ Vulnerability pattern pre-analysis
- ✅ GPT-4 detailed findings
- ✅ Pre-analysis detections with severity badges
- ✅ 🔗 Link to full report on R2 (public URL)

Example message:
```
📋 **Security Audit Report for EvXNCtaoVuC1NQLQswAnqsbQK...** (EvXNCtao...)

⚠️ **Pre-Analysis Detections**:
🔴 1 CRITICAL pattern(s) detected
🟠 2 HIGH pattern(s) detected

**Detailed Analysis**:
[Full GPT-4 findings...]

📊 Code size: 4,521 bytes | Tokens: 1,234 | Cost: $0.0370
🔗 [Full Report on R2](https://account-id.r2.dev/audits/EvXNCtao/...)
```

## Storage Structure

```
integrity-molt-audits/
├── audits/
│   ├── EvXNCtao/
│   │   ├── 2026-02-26T10:03:11.json
│   │   ├── 2026-02-26T11:45:22.json
│   │   └── ...
│   ├── 5xWgP7h/
│   │   └── ...
│   └── ...
```

Each audit JSON includes:
```json
{
  "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
  "timestamp": "2026-02-26T10:03:11.000Z",
  "audit_result": {
    "status": "success",
    "findings": "...",
    "pattern_findings": [...],
    "tokens_used": 1234,
    "cost_usd": 0.037,
    "code_size_bytes": 4521
  },
  "report_summary": "Formatted report...",
  "environment": "production"
}
```

## Fallback Behavior

If R2 credentials are missing or invalid:
- **Local mode**: Warnings logged but audit continues
- **Database**: All audit results still stored in memory
- **Telegram**: User still gets full audit report (just no persistent storage)

This allows Phase 1 to work independently while Phase 2 seamlessly adds storage.

## Costs

Cloudflare R2 pricing (February 2026):
- **Storage**: $0.015 per GB-month
- **API calls**: First 1M free, then $0.36 per M requests
- **Typical audit report**: 4-5 KB JSON
- **Monthly cost estimate**: ~$0.50 for 1000 audits

## Testing

```bash
# Test R2 storage locally (requires .env credentials)
python -m src.r2_storage

# Run all tests including R2 validation
python -m pytest tests/ -v
```

## Phase 3 Integration

- Payment tracking per contract
- Audit history by user (Telegram ID)
- Report expiry policies (e.g., delete reports >90 days old)
- Bulk export for compliance

---
Last updated: February 26, 2026
