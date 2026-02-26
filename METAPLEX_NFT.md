# Metaplex Core NFT Anchoring

## Overview
integrity.molt anchors each security audit as an immutable Metaplex Core NFT on Solana, providing:
- **Proof of audit**: Deterministic audit hash stored on-chain
- **Audit trail**: Linked to contract address and auditor (integrity.molt)
- **Verification**: Auditors can prove legitimacy via NFT metadata
- **Transparency**: Public NFT record on Solscan/Metaplex explorer

## Phase Breakdown

### Phase 1-2: NFT Preparation (✅ CURRENT)
- Generate NFT metadata with audit findings
- Create deterministic audit hash (SHA256)
- Calculate risk scores from vulnerability patterns
- Prepare transaction payloads
- **Status**: Ready for Phase 3 signing

### Phase 3: NFT Minting & On-Chain Anchoring (🔜 PENDING)
- Sign NFT creation with `integrity.molt` domain wallet
- Submit to Metaplex Core program on Solana mainnet
- Mint address returned and stored in audit record
- Telegram user gets Solscan link to proof

### Phase 4: Marketplace Integration
- List audits in Metaplex marketplace
- NFT tradeable + sellable
- Profit sharing from secondary sales

## NFT Metadata Structure

Each audit NFT includes:

```json
{
  "name": "Audit Report: EvXNCtao",
  "symbol": "AUDIT",
  "description": "Security audit of Solana contract EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
  "uri": "https://account-id.r2.dev/audits/EvXNCtao/...",
  "attributes": [
    {
      "trait_type": "Audit Hash",
      "value": "a3c5e8f2b1d9..."
    },
    {
      "trait_type": "Contract Address",
      "value": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
    },
    {
      "trait_type": "Risk Score",
      "value": "7"
    },
    {
      "trait_type": "Tokens Used",
      "value": "1234"
    },
    {
      "trait_type": "Cost USD",
      "value": "$0.0370"
    },
    {
      "trait_type": "Auditor",
      "value": "integrity.molt"
    }
  ],
  "properties": {
    "creators": [
      {
        "address": "3vDc6RTAmWGuvpbT6n6DdNgwafRE88nJAx7YXA64wojM",
        "verified": true,
        "share": 100
      }
    ]
  },
  "image": "https://app.molt.id/integrity-molt-logo.png",
  "external_url": "https://app.molt.id/audits/EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
}
```

## Audit Hash Calculation

Deterministic SHA256 hash ensures immutability:

```python
hash_input = {
    "contract_address": "EvXNCtao...",
    "findings": "GPT-4 findings text",
    "pattern_findings": [...],
    "tokens_used": 1234,
    "cost_usd": 0.037,
    "timestamp": "2026-02-26T10:03:11Z"
}
audit_hash = SHA256(json.dumps(hash_input, sort_keys=True))
```

If ANY data changes → different hash → easily detectable fraud

## Telegram Report Display

Example Telegram message with NFT proof info:

```
📋 **Security Audit Report for EvXNCtaoVuC1NQLQswAnqsbQK...** (EvXNCtao...)

⚠️ **Pre-Analysis Detections**:
🔴 1 CRITICAL pattern(s) detected
🟠 2 HIGH pattern(s) detected

**Detailed Analysis**:
[GPT-4 findings...]

📊 Code size: 4,521 bytes | Tokens: 1,234 | Cost: $0.0370

🔗 [Full Report on R2](https://account-id.r2.dev/audits/...)
🔐 **On-Chain NFT Proof** (Phase 3): Audit hash a3c5e8f2... ready for Metaplex Core
```

## Risk Score Calculation

Risk score (1-10) calculated from vulnerability patterns:

```
Base Score: 1
+ 3 points per CRITICAL finding
+ 1.5 points per HIGH finding
+ 0.5 points per MEDIUM finding
Max: 10, Min: 1
```

Example:
- 0 findings → Risk 1 (low risk, good code)
- 1 CRITICAL, 2 HIGH → Risk 6.5 → 7 (medium-high risk)
- 2 CRITICAL, 3 HIGH → Risk 10 (do not deploy!)

## API Reference

### Create Audit NFT Anchor
```python
from src.metaplex_nft import create_audit_nft_anchor

result = create_audit_nft_anchor(
    contract_address="EvXNCtao...",
    audit_result=audit_dict,
    r2_report_url="https://..."
)

# Phase 2 Response:
# {
#     "status": "prepared",
#     "contract_address": "EvXNCtao...",
#     "audit_hash": "a3c5e8f2b1d9...",
#     "metadata": {...NFT metadata...},
#     "program_id": "4XKv23WzTb9Z...",
#     "creator": "3vDc6RTAmWGupbT6n6...",
#     "timestamp": "2026-02-26T10:03:11Z"
# }
```

### Verify Audit NFT
```python
from src.metaplex_nft import verify_audit_nft

result = verify_audit_nft("Audit_NFT_Mint_Address")

# Phase 3+ Response:
# {
#     "status": "verified",
#     "mint_address": "Audit_NFT...",
#     "solscan_url": "https://solscan.io/token/Audit_NFT...",
#     "metaplex_url": "https://www.metaplex.com/explore/Audit_NFT..."
# }
```

## Integration with Audit Flow

```
1. User: /audit contract_address
   ↓
2. GPT-4 Analysis
   ↓
3. Pattern Detection
   ↓
4. R2 Upload ✅
   ↓
5. NFT Metadata Generation ✅
   ├─ Calculate audit hash
   ├─ Set risk score
   └─ Link to R2 report
   ↓
6. [Phase 3] Sign & Submit to Minting (pending)
   ├─ Sign transaction with integrity.molt wallet
   ├─ Submit to Metaplex Core
   └─ Get mint address
   ↓
7. Telegram: Report + NFT link
```

## Development Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Audit analysis | ✅ |
| 2 | R2 storage | ✅ |
| 2 | NFT metadata prep | ✅ |
| 3 | NFT minting (requires signing) | 🔜 |
| 3 | Payment processing | 🔜 |
| 4 | Marketplace listing | 🔜 |
| 4 | Secondary sales revenue | 🔜 |

## Phase 3 Next Steps

To implement actual NFT minting in Phase 3:

1. **Setup Phantom Wallet** or similar (for signing)
2. **Implement transaction signing**:
   ```python
   from solders.transaction import Transaction
   from solders.system_program import TransferParams, transfer
   
   tx = create_metaplex_nft_transaction(metadata, creator_keypair)
   signed_tx = creator_keypair.sign_transaction(tx)
   ```

3. **Submit to Solana RPC**:
   ```python
   tx_hash = rpc_client.send_transaction(signed_tx)
   mint_address = extract_mint_from_tx(tx_hash)
   ```

4. **Store mint address**:
   ```python
   audit_result["nft_mint_address"] = mint_address
   # Update R2 report with mint address
   # Send Telegram link: https://solscan.io/token/{mint_address}
   ```

## Security Considerations

- **Audit hash immutability**: Any change to findings → different hash detected
- **Creator verification**: All NFTs signed by `integrity.molt` domain account
- **Report integrity**: R2 + on-chain hash provides dual proof
- **Audit trail**: Each audit timestamped and attributable to auditor

## Testing

```bash
# Test NFT metadata generation (Phase 2)
python -m src.metaplex_nft

# Run all audit flow tests
python -m pytest tests/ -v

# Manual test
python -c "from src.metaplex_nft import create_audit_nft_anchor; print(create_audit_nft_anchor('EvXNCtao...', {...}, 'https://...'))"
```

---
Last updated: February 26, 2026
**Implementation**: Phase 2 preparation → Phase 3 minting ready
