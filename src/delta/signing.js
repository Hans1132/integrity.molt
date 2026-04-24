'use strict';
// src/delta/signing.js — Ed25519 signing for Delta Reports
// Uses the shared async signing utility (src/crypto/sign.js) — no execSync.

const { asyncSign, canonicalJSON } = require('../crypto/sign');

/**
 * Sign a delta report object with the integrity.molt Ed25519 key.
 * The signed payload is the canonical JSON string of the report (without the
 * signature field itself), matching the existing sign-report.py convention.
 *
 * NOTE: This function is now async. Callers must await it.
 *
 * @param {object} deltaReport  delta report without signature/verify_key fields
 * @returns {Promise<object>}   deltaReport extended with signature and verify_key fields
 */
async function signDeltaReport(deltaReport) {
  const payload = canonicalJSON(deltaReport);

  let envelope;
  try {
    envelope = await asyncSign(payload);
  } catch (e) {
    console.error('[delta/signing] signing failed:', e.message);
    return deltaReport; // Return unsigned if signing fails (callers must check)
  }

  return {
    ...deltaReport,
    signature:  envelope.signature,
    verify_key: envelope.verify_key,
    key_id:     envelope.key_id,
    signed_at:  envelope.signed_at,
    signer:     envelope.signer,
    algorithm:  envelope.algorithm,
  };
}

module.exports = { signDeltaReport };
