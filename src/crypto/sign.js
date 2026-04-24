'use strict';
/**
 * src/crypto/sign.js — Async Ed25519 signing utility
 *
 * Shared by server.js and src/delta/signing.js.
 * Wraps the existing Python/PyNaCl sign-report.py pipeline asynchronously.
 * No execSync — does not block the event loop.
 *
 * Usage:
 *   const { asyncSign } = require('./src/crypto/sign');
 *   const envelope = await asyncSign(reportTextOrJSON);
 *   // envelope: { report, signature, verify_key, key_id, signed_at, signer, algorithm }
 */

const { spawn } = require('child_process');

const SIGN_SCRIPT = '/root/scanner/sign-report.py';
const SIGN_TIMEOUT_MS = 10_000;

/**
 * asyncSign — pass reportText via stdin to sign-report.py, return parsed JSON envelope.
 *
 * @param {string} reportText  The text to sign. For JSON payloads, caller must
 *                             JSON.stringify before passing — the signature covers
 *                             the raw UTF-8 bytes of this string.
 * @returns {Promise<object>}  Envelope from sign-report.py:
 *   { report, signature, verify_key, key_id, signed_at, signer, algorithm }
 */
function asyncSign(reportText) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [SIGN_SCRIPT], { timeout: SIGN_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error('sign-report.py invalid JSON: ' + stdout.slice(0, 200)));
        }
      } else {
        reject(new Error('sign-report.py exited ' + code + ': ' + stderr.slice(0, 200)));
      }
    });
    proc.on('error', reject);
    proc.stdin.write(reportText);
    proc.stdin.end();
  });
}

module.exports = { asyncSign, SIGN_SCRIPT };
