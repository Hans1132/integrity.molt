'use strict';
// src/delta/signing.js — Ed25519 signing for Delta Reports
// Uses the same Python/PyNaCl pipeline as the existing scan signing.

const { execSync } = require('child_process');

/**
 * Sign a delta report object with the integrity.molt Ed25519 key.
 * The signed payload is the canonical JSON string of the report (without the
 * signature field itself), matching the existing sign-report.py convention.
 *
 * @param {object} deltaReport  delta report without signature/verify_key fields
 * @returns {object}  deltaReport extended with signature and verify_key fields
 */
function signDeltaReport(deltaReport) {
  // Canonical payload = JSON of the report without the signature fields
  const payload = JSON.stringify(deltaReport, null, 2);

  let envelope;
  try {
    const raw = execSync(
      `echo ${JSON.stringify(payload)} | python3 /root/scanner/sign-report.py`,
      { timeout: 10000 }
    );
    envelope = JSON.parse(raw.toString());
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
    algorithm:  envelope.algorithm
  };
}

module.exports = { signDeltaReport };
