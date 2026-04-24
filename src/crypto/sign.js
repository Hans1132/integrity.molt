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
const SIGN_CONCURRENCY = 8; // max concurrent python3 processes

// Simple counting semaphore to bound concurrent subprocesses.
let _active = 0;
const _queue = [];
function _acquireSemaphore() {
  if (_active < SIGN_CONCURRENCY) {
    _active++;
    return Promise.resolve();
  }
  return new Promise(resolve => _queue.push(resolve));
}
function _releaseSemaphore() {
  _active--;
  if (_queue.length > 0) {
    _active++;
    _queue.shift()();
  }
}

/**
 * asyncSign — pass reportText via stdin to sign-report.py, return parsed JSON envelope.
 *
 * @param {string} reportText  The text to sign. For JSON payloads, caller must
 *                             JSON.stringify before passing — the signature covers
 *                             the raw UTF-8 bytes of this string.
 * @returns {Promise<object>}  Envelope from sign-report.py:
 *   { report, signature, verify_key, key_id, signed_at, signer, algorithm }
 */
async function asyncSign(reportText) {
  await _acquireSemaphore();
  return new Promise((resolve, reject) => {
    const done = (fn, val) => { _releaseSemaphore(); fn(val); };
    const proc = spawn('python3', [SIGN_SCRIPT], { timeout: SIGN_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) {
        try {
          done(resolve, JSON.parse(stdout.trim()));
        } catch (e) {
          done(reject, new Error('sign-report.py invalid JSON: ' + stdout.slice(0, 200)));
        }
      } else {
        done(reject, new Error('sign-report.py exited ' + code + ': ' + stderr.slice(0, 200)));
      }
    });
    proc.on('error', e => done(reject, e));
    proc.stdin.on('error', e => done(reject, e)); // EPIPE if sign-report.py dies before reading stdin
    proc.stdin.write(reportText);
    proc.stdin.end();
  });
}

/**
 * canonicalJSON — deterministic JSON serialization with sorted keys.
 * Both sign and verify sides must use this to ensure byte-identical output
 * regardless of key insertion order or consumer language.
 *
 * @param {*} obj  Any JSON-serializable value
 * @returns {string}
 */
function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  // Recurse into values (shallow sort is enough for 1-level report payloads,
  // but full recursion prevents future footguns from nested objects)
  return '{' + Object.keys(sorted).map(k =>
    JSON.stringify(k) + ':' + canonicalJSON(sorted[k])
  ).join(',') + '}';
}

module.exports = { asyncSign, canonicalJSON, SIGN_SCRIPT };
