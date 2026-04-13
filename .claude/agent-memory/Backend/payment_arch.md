---
name: Payment verification architecture
description: How anti-replay, ATA, and pricing fit together in server.js and db.js
type: project
---

Anti-replay uses a dedicated SQLite table `used_signatures (sig TEXT PRIMARY KEY, created_at INTEGER)`.
`db.markSignatureUsed(sig)` is called inside `verifyPayment()` immediately after on-chain balance check passes — before returning ok:true — to close the race window.
`db.isAlreadyUsed(sig)` queries `used_signatures` (not `payments`) for fast PK lookup.

USDC ATA is derived at startup: `getAssociatedTokenAddressSync(USDC_MINT, WALLET, false, TOKEN_PROGRAM_ID)` from `@solana/spl-token` (available as transitive dep in node_modules). Result stored in `USDC_ATA` const. All x402 payment accepts use `payTo: USDC_ATA`.

USDC balance verification (pre/post token balances) checks `post.owner === WALLET` — this is correct and intentional. The ATA is only in `payTo`; verification stays balance-based.

**Why:** prior code had race condition (isAlreadyUsed checked before logPayment INSERT) and was using wallet address as payTo instead of ATA.
**How to apply:** any future payment endpoint additions must use PRICING constants from config/pricing.js and USDC_ATA for payTo.
