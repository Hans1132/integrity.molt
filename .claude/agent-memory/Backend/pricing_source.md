---
name: Pricing source of truth
description: config/pricing.js is canonical for all scan prices; token=0.75, wallet=0.50 USDC
type: project
---

`/root/x402-server/config/pricing.js` is the single source of truth for all USDC scan prices.

Canonical prices (micro-USDC, 6 decimals):
- quick:       500_000   (0.50 USDC)
- deep:      5_000_000   (5.00 USDC)
- token:       750_000   (0.75 USDC)
- wallet:      500_000   (0.50 USDC)
- pool:        500_000   (0.50 USDC)
- evm-token:   750_000   (0.75 USDC)
- evm-scan:    750_000   (0.75 USDC)
- contract:  5_000_000   (5.00 USDC)
- token-audit: 500_000   (0.50 USDC)
- delta:     1_000_000   (1.00 USDC)
- adversarial: 10_000_000 (10.00 USDC)

**Why:** previously token=1.00 and wallet=1.00 in routes but 0.75/0.50 in /info endpoint — a billing bug that allowed underpayment. config/pricing.js was created to prevent future drift.
**How to apply:** always import `{ PRICING, PRICING_DISPLAY }` from `./config/pricing` when adding new paid endpoints.
