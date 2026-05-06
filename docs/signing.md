# Ed25519 Signing & Verification — integrity.molt

Every oracle response from integrity.molt is signed with Ed25519 to enable offline verification. The signature is verifiable by any downstream consumer without calling back to the server.

## Signing Overview

### Keys

**Keypair:** Stored in `/root/.secrets/`
- `signing_key.bin` — 32-byte Ed25519 private key (secret)
- `verify_key.bin` — 32-byte Ed25519 public key (public, published in JWKS)

**Key ID:** `integrity-molt-primary-2026` (hardcoded in all signed responses)

**Not committed to git:** `.env` and `.secrets/` are in `.gitignore` to prevent accidental exposure.

### Implementation: `src/crypto/sign.js`

```javascript
/**
 * asyncSign — Async Ed25519 signing without blocking event loop
 * 
 * @param {string} reportText  Text or JSON to sign
 * @returns {Promise<object>}  Envelope: {report, signature, verify_key, key_id, signed_at, signer, algorithm}
 */
async function asyncSign(reportText) {
  // ... spawns python3 sign-report.py subprocess ...
  // Bounded concurrency: max 8 parallel signing processes
  // 10-second timeout per call
}

/**
 * canonicalJSON — Deterministic JSON serialization
 * 
 * @param {*} obj  JSON-serializable object
 * @returns {string}  Compact JSON with sorted keys, no whitespace
 */
function canonicalJSON(obj) {
  // Sort all object keys alphabetically
  // Recurse into nested objects
  // No spaces, no newlines (compact serialization)
  // Byte-identical output regardless of key insertion order
}
```

## Signing Pipeline

### 1. Payload Preparation

All response payloads are canonicalized before signing:

```javascript
const payload = {
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  iris_score: 92,
  risk_level: 'low',
  risk_factors: []
};

// Canonical JSON (sorted keys, no whitespace)
const canonical = canonicalJSON(payload);
// Result: {"address":"EPjFWdd5...","iris_score":92,"risk_factors":[],"risk_level":"low"}
```

**Why canonical JSON?**
- Prevents signature ambiguity (key order is normalized)
- Enables offline verification in any language (Python, Rust, JS all produce identical output)
- No whitespace means byte-exact serialization

### 2. Subprocess Invocation

```javascript
async function asyncSign(reportText) {
  // Acquire semaphore (max 8 concurrent)
  await _acquireSemaphore();
  
  return new Promise((resolve, reject) => {
    // Spawn: python3 /root/scanner/sign-report.py
    const proc = spawn('python3', [SIGN_SCRIPT]);
    
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    
    // Send payload via stdin
    proc.stdin.write(reportText);
    proc.stdin.end();
    
    // Wait for subprocess to complete (or timeout)
    proc.on('close', code => {
      _releaseSemaphore();
      if (code === 0) {
        resolve(JSON.parse(stdout));  // Envelope
      } else {
        reject(new Error(`Sign failed: ${stderr.slice(0, 200)}`));
      }
    });
  });
}
```

**Subprocess script:** `/root/scanner/sign-report.py`
- Reads text from stdin (the payload to sign)
- Uses tweetnacl/PyNaCl Ed25519 private key
- Outputs JSON envelope with base64-encoded signature
- Exit code 0 = success, non-zero = failure

### 3. Envelope Structure

All signed responses follow this flat envelope format:

```json
{
  "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "iris_score": 92,
  "risk_level": "low",
  "risk_factors": [],
  "signed_at": "2026-05-06T10:00:00.000Z",
  "signature": "base64-encoded-ed25519-sig",
  "verify_key": "base64-encoded-32-byte-pubkey",
  "key_id": "integrity-molt-primary-2026",
  "signer": "integrity.molt",
  "algorithm": "Ed25519",
  "issuer_metaplex_asset": "2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy",
  "issuer_metaplex_url": "https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy"
}
```

**Fields:**
- **Payload fields** (address, iris_score, risk_level, etc.) — What was signed
- **signed_at** — ISO 8601 timestamp when signature was created
- **signature** — Base64-encoded Ed25519 signature (88 chars for 64-byte sig)
- **verify_key** — Base64-encoded 32-byte Ed25519 public key
- **key_id** — Human-readable key identifier (first 16 chars of verify_key)
- **signer** — Metadata ("integrity.molt")
- **algorithm** — Signature algorithm ("Ed25519")
- **issuer_metaplex_asset** — Metaplex Agent Token core asset address (on-chain identity)
- **issuer_metaplex_url** — Canonical URL on metaplex.com (verifiable on-chain)

## JWKS Publication

The public key is published in standard RFC 8037 (JSON Web Key) format:

```bash
GET https://intmolt.org/.well-known/jwks.json
```

**Response:**
```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "base64-encoded-pubkey",
      "kid": "integrity-molt-primary-2026",
      "alg": "EdDSA",
      "use": "sig"
    }
  ]
}
```

**RFC 8037 compliance:**
- `kty: "OKP"` — Octet string key pairs (EC algorithms)
- `crv: "Ed25519"` — Curve name
- `x` — Base64-encoded public key (32 bytes)
- `kid` — Key ID (matches envelope `key_id` field)
- `alg: "EdDSA"` — EdDSA signature algorithm
- `use: "sig"` — Used for signing

**Key pinning:** Downstream consumers can verify the response signature against the published JWKS. If the public key in the response does not match JWKS, it's a foreign signature (not from integrity.molt).

## Verification Workflows

### Server-Side Verification (Fast)

The `/verify/v1/signed-receipt` endpoint performs key pinning and Ed25519 verification:

```bash
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d '{"envelope": <signed-response>}'
```

**Response:**
```json
{
  "valid": true,
  "key_pinned": true,
  "mathematically_valid": true,
  "reason": "signature_valid",
  "key_id": "integrity-molt-primary-2026",
  "signed_at": "2026-05-06T10:00:00.000Z",
  "issuer": "integrity.molt"
}
```

**Logic:**
```javascript
function verifyReceipt(envelope) {
  const result = {
    valid: false,
    key_pinned: false,
    mathematically_valid: false,
    reason: null
  };

  // 1. Parse envelope
  if (!envelope.signature || !envelope.verify_key) {
    result.reason = 'missing_fields';
    return result;
  }

  // 2. Deserialize signature and key
  const sig = Buffer.from(envelope.signature, 'base64');
  const vk = Buffer.from(envelope.verify_key, 'base64');

  // 3. Compute payload (same canonicalJSON as signing)
  const payload = { ...envelope };
  delete payload.signature;
  delete payload.verify_key;
  delete payload.key_id;
  delete payload.signed_at;
  delete payload.signer;
  delete payload.algorithm;
  const canonical = canonicalJSON(payload);

  // 4. Verify Ed25519 signature
  try {
    nacl.sign.detached.verify(
      Buffer.from(canonical, 'utf-8'),
      sig,
      vk
    );
    result.mathematically_valid = true;
  } catch {
    result.reason = 'invalid_signature';
    return result;
  }

  // 5. Key pinning — compare against JWKS
  const jwks = getPublishedJWKS();
  const pinned = jwks.keys.find(k => 
    k.kid === envelope.key_id && 
    Buffer.from(k.x, 'base64').equals(vk)
  );
  
  if (!pinned) {
    result.valid = false;
    result.mathematically_valid = true;  // Sig is valid, but not from our key
    result.reason = 'key_not_pinned';
    return result;
  }

  result.key_pinned = true;
  result.valid = true;
  result.reason = 'signature_valid';
  return result;
}
```

**Key insight:** `valid` requires BOTH mathematical correctness AND key pinning. A self-signed envelope with a foreign key returns `valid: false, mathematically_valid: true`.

### Offline Verification (Python)

No HTTP call to the server. Uses the public key embedded in the response:

```python
import json
import base64
import nacl.signing

def verify_offline(receipt_path):
    with open(receipt_path, 'r') as f:
        receipt = json.load(f)
    
    # 1. Extract signature and public key
    vk = nacl.signing.VerifyKey(base64.b64decode(receipt['verify_key']))
    sig = base64.b64decode(receipt['signature'])
    
    # 2. Reconstruct canonical payload
    payload = {k: v for k, v in receipt.items()
               if k not in {'signature', 'verify_key', 'key_id',
                            'signed_at', 'signer', 'algorithm', 'report'}}
    canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    
    # 3. Verify signature
    try:
        vk.verify(canonical.encode('utf-8'), sig)
        print("✓ Valid signature")
        return True
    except nacl.exceptions.BadSignatureError:
        print("✗ Invalid signature")
        return False
```

**Key requirement:** The canonical JSON must match byte-for-byte. This works because:
- Receipt has the raw payload fields (address, iris_score, etc.)
- Same `canonicalJSON()` logic (sort keys, no whitespace)
- Same public key from receipt (no key pinning needed offline)

### JavaScript/Node.js Verification

```javascript
const nacl = require('tweetnacl');
const crypto = require('crypto');

function verifyOffline(envelope) {
  // 1. Extract and deserialize
  const sig = Buffer.from(envelope.signature, 'base64');
  const vk = Buffer.from(envelope.verify_key, 'base64');
  
  // 2. Canonical payload
  const payload = Object.keys(envelope)
    .filter(k => !['signature', 'verify_key', 'key_id', 'signed_at', 'signer', 'algorithm'].includes(k))
    .reduce((acc, k) => { acc[k] = envelope[k]; return acc; }, {});
  
  const canonical = canonicalJSON(payload);
  
  // 3. Verify with nacl
  const message = Buffer.from(canonical, 'utf-8');
  const isValid = nacl.sign.detached.verify(message, sig, vk);
  
  return isValid;
}

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return '{' + Object.keys(sorted).map(k =>
    JSON.stringify(k) + ':' + canonicalJSON(sorted[k])
  ).join(',') + '}';
}
```

## Key Rotation & Lifecycle

**Current key (as of May 2026):**
- Key ID: `integrity-molt-primary-2026`
- Created: Early 2026
- Backup location: `/root/.secrets/` (not in git)
- Expiry: No formal expiry; rotated on security incident or per ADR-011

**Future key rotation** (if needed):
1. Generate new Ed25519 keypair
2. Store in `/root/.secrets/new_signing_key.bin`, `/root/.secrets/new_verify_key.bin`
3. Update CLAUDE.md with new key ID
4. Publish new public key to JWKS endpoint
5. Old signatures remain valid (keys don't invalidate historical receipts)
6. Timestamp-based verification can distinguish old vs. new keys

**Never share or rotate without explicit ADR discussion.** See CLAUDE.md section 12 for constraints.

## Signature Validation Best Practices

### 1. Always Canonicalize

Never verify raw JSON — use canonical form:

```javascript
// ✗ Wrong — may fail due to key order
const sig_fails = crypto.verify(null, Buffer.from(JSON.stringify(obj)), ...);

// ✓ Right — canonical JSON
const sig_ok = crypto.verify(null, Buffer.from(canonicalJSON(obj)), ...);
```

### 2. Check Key Pinning

If verifying a response from integrity.molt, always validate the key:

```javascript
const publicJWKS = await fetch('https://intmolt.org/.well-known/jwks.json').then(r => r.json());
const expectedKey = publicJWKS.keys[0].x;  // Base64
const receivedKey = envelope.verify_key;   // Base64

if (expectedKey !== receivedKey) {
  throw new Error('Signature from foreign key — not from integrity.molt');
}
```

### 3. Use RFC 8037 Libraries

Prefer libraries that implement RFC 8037 for Ed25519:

- **Python:** PyNaCl (`nacl.signing.VerifyKey`)
- **Node.js:** tweetnacl-js, libsodium-wrappers
- **Rust:** ed25519-dalek
- **Go:** golang.org/x/crypto/ed25519

### 4. Preserve `signed_at` for Audit Trail

Always log the `signed_at` timestamp:

```javascript
console.log(`Verified receipt from ${envelope.signed_at} by ${envelope.issuer}`);
```

This enables:
- Chronological audit trails
- Detection of replay (same signature seen twice = same `signed_at`)
- Forensic analysis of timing

## Troubleshooting

### "Invalid Signature" Errors

**Cause 1: Whitespace in JSON**

```javascript
// ✗ Wrong
JSON.stringify({a: 1, b: 2})
// {"a":1,"b":2}  (may vary by implementation)

// ✓ Right
canonicalJSON({a: 1, b: 2})
// {"a":1,"b":2}  (guaranteed byte-identical)
```

**Cause 2: Field omission**

Some fields MUST be excluded from the signature:
- `signature` — Can't sign the signature itself
- `verify_key` — Can't include the key in its own signature
- `key_id`, `signed_at`, `signer`, `algorithm` — Metadata, not payload

```python
# Correct payload reconstruction
verified_fields = {k: v for k, v in receipt.items()
                   if k not in {'signature', 'verify_key', 'key_id', 'signed_at', 'signer', 'algorithm'}}
```

**Cause 3: Key mismatch**

Ensure you're using the correct public key:

```javascript
// From JWKS (most reliable)
const jwks = await fetch('https://intmolt.org/.well-known/jwks.json').then(r => r.json());
const key = jwks.keys[0];

// From receipt (embedded, but verify against JWKS)
const embeddedKey = envelope.verify_key;
```

### "Key Not Pinned" on Server Verification

This is expected for self-signed responses (from external sources):

```json
{
  "valid": false,
  "key_pinned": false,
  "mathematically_valid": true,  // ← Sig is correct math
  "reason": "key_not_pinned"      // ← But not from our key
}
```

**This is correct behavior.** A self-signed receipt with a valid Ed25519 signature is mathematically sound, but it's not from integrity.molt.

### "ENOENT: no such file or directory" on Signing

`asyncSign()` spawns `/root/scanner/sign-report.py`. If missing:

```bash
# Check if sign script exists
ls -la /root/scanner/sign-report.py

# If missing, contact ops/Hans for script deployment
# Script uses PyNaCl: python3 -m pip install pynacl
```

## Key Information for Operators

| Item | Value |
|------|-------|
| Algorithm | Ed25519 (RFC 8032) |
| Key size | 32 bytes (256 bits) |
| Signature size | 64 bytes (base64 ≈ 88 chars) |
| Canonical JSON | All objects sorted keys, no whitespace |
| Key ID | `integrity-molt-primary-2026` |
| Key format (storage) | Raw 32-byte binary in `/root/.secrets/` |
| Key format (JWKS) | Base64 in RFC 8037 JWK format |
| Signing subprocess | Python3 `/root/scanner/sign-report.py` |
| Max concurrent signing | 8 (semaphore-bounded) |
| Signing timeout | 10 seconds per call |
| JWKS endpoint | `GET /.well-known/jwks.json` |
| Verification endpoint | `POST /verify/v1/signed-receipt` |

## Integration Checklist

- [ ] Fetch JWKS once and cache locally (`~/.well-known/jwks.json`)
- [ ] Implement `canonicalJSON()` in same language as verification
- [ ] Extract payload fields (exclude signature, verify_key, metadata)
- [ ] Verify Ed25519 signature with extracted key
- [ ] Check key ID against JWKS (key pinning)
- [ ] Log `signed_at` for audit trail
- [ ] Handle "key not pinned" gracefully (expected for non-integrity.molt sources)
- [ ] Retry verification on transient failures (network timeout during JWKS fetch)
