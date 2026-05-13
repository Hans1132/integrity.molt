'use strict';

const crypto = require('crypto');

// Pinned Ed25519 public key — kid: integrity-molt-primary-2026
// Source: https://intmolt.org/.well-known/jwks.json
const PINNED_KID = 'integrity-molt-primary-2026';
const PINNED_KEY_B64URL = 'qzppeeRmbyQ4hE4BYOW-4VbQ5muyplTP4GP4uxIhVwY';

// SubjectPublicKeyInfo DER header for Ed25519 (OID 1.3.101.112) — matches backend line 307
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Metadata keys stripped before signing — must match backend METADATA set exactly
const METADATA = new Set(['signature', 'verify_key', 'key_id', 'signed_at', 'signer', 'algorithm', 'report']);

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

function getPinnedKeyBytes() {
  // INTEGRITY_MOLT_TEST_VERIFY_KEY allows test suites to inject a known keypair.
  // Never set in production — read at call time so tests can override per-test.
  const testKey = process.env.INTEGRITY_MOLT_TEST_VERIFY_KEY;
  if (testKey) return Buffer.from(testKey, 'base64url');
  return Buffer.from(PINNED_KEY_B64URL, 'base64url');
}

/**
 * Verify an integrity.molt oracle receipt locally using the pinned Ed25519 key.
 *
 * Supports both receipt formats emitted by backend endpoints:
 *   Wrapped: { payload: {...}, signature, verify_key, ... }
 *     → signed bytes = canonicalJSON(payload)
 *   Flat: { address, iris_score, ..., signature, verify_key, ... }
 *     → signed bytes = canonicalJSON(all keys except METADATA)
 *
 * Returns the same shape as POST /verify/v1/signed-receipt, plus:
 *   verified_locally: true
 *   local_verify_kid: kid of the pinned key used
 */
function verifyLocally(envelope) {
  const { payload, signature, verify_key, key_id, signed_at, signer, algorithm } = envelope;

  if (!signature || !verify_key) {
    return { valid: false, verified_locally: true, reason: 'missing_signature_or_verify_key' };
  }

  if (algorithm && algorithm.toLowerCase() !== 'ed25519') {
    return { valid: false, verified_locally: true, reason: 'unsupported_algorithm', algorithm };
  }

  // Node.js Buffer.from('base64') never throws on bad input — check alphabet explicitly
  const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!BASE64_RE.test(verify_key) || !BASE64_RE.test(signature)) {
    return { valid: false, verified_locally: true, reason: 'invalid_base64_encoding' };
  }

  // Reconstruct canonical signed payload (mirrors backend verification logic)
  let payloadObj;
  if (payload && typeof payload === 'object') {
    payloadObj = payload;
  } else {
    payloadObj = Object.fromEntries(
      Object.entries(envelope).filter(([k]) => !METADATA.has(k))
    );
    if (Object.keys(payloadObj).length === 0) {
      return { valid: false, verified_locally: true, reason: 'no_verifiable_payload' };
    }
  }

  const canonicalText = canonicalJSON(payloadObj);

  let keyBytes, sigBytes;
  try {
    keyBytes = Buffer.from(verify_key, 'base64');
    sigBytes = Buffer.from(signature, 'base64');
  } catch {
    return { valid: false, verified_locally: true, reason: 'invalid_base64_encoding' };
  }

  if (keyBytes.length !== 32) {
    return { valid: false, verified_locally: true, reason: 'invalid_verify_key_length', got: keyBytes.length };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, verified_locally: true, reason: 'invalid_signature_length', got: sigBytes.length };
  }

  const keyPinned = getPinnedKeyBytes().equals(keyBytes);

  let mathematicallyValid = false;
  try {
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: 'der',
      type: 'spki',
    });
    mathematicallyValid = crypto.verify(
      null,
      Buffer.from(canonicalText, 'utf-8'),
      keyObj,
      sigBytes,
    );
  } catch (e) {
    return { valid: false, verified_locally: true, reason: 'verification_error', detail: e.message.slice(0, 100) };
  }

  const attested = mathematicallyValid && keyPinned;
  const expectedKeyId = verify_key.slice(0, 16);

  return {
    valid:                attested,
    key_pinned:           keyPinned,
    mathematically_valid: mathematicallyValid,
    key_id:               key_id || expectedKeyId,
    signed_at:            signed_at || null,
    issuer:               signer || null,
    verified_locally:     true,
    local_verify_kid:     PINNED_KID,
    ...(attested ? {} : { reason: mathematicallyValid ? 'key_not_pinned' : 'invalid_signature' }),
  };
}

/**
 * Returns true when local verification is opted in via INTEGRITY_MOLT_LOCAL_VERIFY=1.
 * Read at call time so tests can override per-test.
 */
function isLocalVerifyEnabled() {
  return process.env.INTEGRITY_MOLT_LOCAL_VERIFY === '1';
}

module.exports = { verifyLocally, isLocalVerifyEnabled, canonicalJSON, PINNED_KID };
