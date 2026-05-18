# X Post Draft — ADR-013 token_audit polymorphism launch

## Post 1 (announcement)

integrity.molt token_audit just got polymorphic 🔒

Pass a Metaplex registered agent address → ERC-8004 doc + wallet + claim-vs-reality audit
Pass an SPL token → rug risk, holder distribution, liquidity analysis

Same skill, auto-detected. Ed25519-signed receipt for both.

$0.75 USDC via x402 on Solana mainnet.
intmolt.org | #Solana #AIagents #x402

## Post 2 (technical)

New in integrity-molt-mcp v0.1.1:

verify_signed_receipt now accepts the `receipt` object from token_audit Metaplex agent audits.

Wrapped format: { payload: { subject_type: "metaplex_agent", ... }, signature, verify_key }
verifyLocally() handles it natively — no changes to verifier.js needed.

npm install integrity-molt-mcp
