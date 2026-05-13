# ADR-012: Ed25519 Local Verification at MCP Boundary

**Status:** Accepted (2026-05-13)
**Decider:** Hans Lička
**Context:** MCP security audit — architect-reviewer HIGH-2 finding

## Problem

The existing `verify_signed_receipt` MCP tool sends the signed envelope back to
`https://intmolt.org/verify/v1/signed-receipt` for verification. This creates a
circular trust model: the oracle vouches for receipts it issued itself. If an
attacker redirects `INTEGRITY_MOLT_BASE_URL` (see audit finding H1), the
attacker's server can forge "verified" receipts.

The trust anchor today is the **URL**. It should be the **Ed25519 key**.

## Decision

Add opt-in local Ed25519 verification at the MCP boundary via `mcp/lib/verifier.js`.

### Activation

```
INTEGRITY_MOLT_LOCAL_VERIFY=1
```

When set, `verify_signed_receipt` verifies the envelope locally using the pinned
public key for `kid: integrity-molt-primary-2026`. No network round-trip to the
backend. The trust anchor becomes the key, not the URL.

When unset (default), the existing backend call is preserved (backward compatible).

### Pinned public key

```
kid:  integrity-molt-primary-2026
x:    qzppeeRmbyQ4hE4BYOW-4VbQ5muyplTP4GP4uxIhVwY  (base64url, Ed25519)
src:  https://intmolt.org/.well-known/jwks.json
```

Key is hardcoded in `mcp/lib/verifier.js:PINNED_KEY_B64URL`. On rotation,
`PINNED_KEY_B64URL` must be updated and a new MCP version released. The JWKS
endpoint serves as source-of-truth for the current key.

### Verification algorithm

Mirrors the backend (`src/routes/a2a-oracle.js` lines 263–316):

1. Reconstruct canonical signed payload:
   - Wrapped format (`{ payload: {...}, signature, ... }`): sign input = `canonicalJSON(payload)`
   - Flat format (most endpoints): strip METADATA keys, sign input = `canonicalJSON(rest)`
2. Decode `verify_key` (base64 → 32-byte raw Ed25519 key)
3. Construct SPKI DER: `302a300506032b6570032100` || raw_key
4. `crypto.verify(null, canonicalText, spkiKey, sigBytes)` — Node.js 18+ built-in, no deps
5. Check `verify_key` matches pinned key → `key_pinned: true`
6. `valid: true` requires BOTH mathematical validity AND key pinned

### Response shape

Same as `/verify/v1/signed-receipt` plus:
- `verified_locally: true` — distinguishes local from remote verification
- `local_verify_kid: "integrity-molt-primary-2026"` — which pinned key was used

## Consequences

- **Eliminates circular trust**: attacker controlling the base URL can no longer
  forge "verified" receipts — they don't hold the Ed25519 private key.
- **No new dependency**: uses Node.js built-in `crypto` (Ed25519 support in 18+).
- **Key rotation risk**: on key rotation, old MCP installs will reject new receipts
  until updated. Mitigate by publishing `kid` mismatch in error response.
- **Opt-in**: default remains backward compatible.

## Key rotation protocol (follow-up)

When `integrity-molt-primary-2026` rotates:
1. Add new key to JWKS (with new `kid`)
2. Update `PINNED_KEY_B64URL` in `mcp/lib/verifier.js`
3. Bump MCP package version (semver minor)
4. Announce via changelog with old `kid` → new `kid` mapping
5. Old `kid` stays in JWKS for ≥12 months so old receipts remain verifiable
