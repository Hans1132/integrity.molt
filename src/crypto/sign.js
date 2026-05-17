'use strict';
/**
 * src/crypto/sign.js — Async Ed25519 signing utility
 *
 * Wraps the existing Python/PyNaCl sign-report.py pipeline asynchronously.
 * No execSync — does not block the event loop.
 *
 * Usage:
 *   const { asyncSign, SignPipelineError } = require('./src/crypto/sign');
 *   try { envelope = await asyncSign(reportText); }
 *   catch (e) { if (e instanceof SignPipelineError) return res.status(503)... }
 */

const { spawn } = require('child_process');

const SIGN_SCRIPT = '/root/scanner/sign-report.py';
const SIGN_TIMEOUT_MS = 10_000;
const SIGN_CONCURRENCY = 8;

// ── Typed error ───────────────────────────────────────────────────────────────
class SignPipelineError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SignPipelineError';
  }
}

// ── Semaphore ─────────────────────────────────────────────────────────────────
let _active = 0;
const _queue = [];
function _acquireSemaphore() {
  if (_active < SIGN_CONCURRENCY) { _active++; return Promise.resolve(); }
  return new Promise(resolve => _queue.push(resolve));
}
function _releaseSemaphore() {
  _active--;
  if (_queue.length > 0) { _active++; _queue.shift()(); }
}

// ── Failure tracking for Telegram alert ──────────────────────────────────────
let _failCount = 0;
let _failWindowStart = 0;
const FAIL_ALERT_THRESHOLD = 1; // alert on first failure in window
const FAIL_WINDOW_MS = 3_600_000; // 1 hour

function _recordFailure(errMsg) {
  const now = Date.now();
  if (now - _failWindowStart > FAIL_WINDOW_MS) {
    _failCount = 0;
    _failWindowStart = now;
  }
  _failCount++;
  if (_failCount === FAIL_ALERT_THRESHOLD && process.env.NODE_ENV !== 'test') {
    const adminChatId = process.env.ADMIN_CHAT_ID
      || (() => { try { return require('fs').readFileSync('/root/.secrets/admin_chat_id', 'utf8').trim(); } catch { return null; } })();
    if (adminChatId) {
      const { sendAlert } = require('../monitor/notifications');
      sendAlert({
        severity:     'critical',
        rule:         'sign_pipeline_failure',
        message:      `sign-report.py SPOF: ${errMsg.slice(0, 200)} — paid receipts unavailable until resolved`,
        address:      'system',
        tx_signature: null,
        timestamp:    Date.now(),
        id:           `sign_fail_${Date.now()}`,
      }, [{ type: 'telegram', chatId: adminChatId }]).catch(() => {});
    }
  }
}

/**
 * asyncSign — pass reportText via stdin to sign-report.py, return parsed JSON envelope.
 * Throws SignPipelineError on any failure (spawn error, timeout, bad JSON, non-zero exit).
 *
 * @param {string} reportText   UTF-8 bytes to sign.
 * @param {string} [scriptPath] Override path to sign-report.py (test use only).
 */
async function asyncSign(reportText, scriptPath) {
  await _acquireSemaphore();
  return new Promise((resolve, reject) => {
    const script = scriptPath || SIGN_SCRIPT;
    const fail = (msg) => {
      _releaseSemaphore();
      _recordFailure(msg);
      reject(new SignPipelineError(msg));
    };
    const proc = spawn('python3', [script], { timeout: SIGN_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) {
        try {
          _releaseSemaphore();
          resolve(JSON.parse(stdout.trim()));
        } catch {
          fail('sign-report.py invalid JSON: ' + stdout.slice(0, 200));
        }
      } else {
        fail('sign-report.py exited ' + code + ': ' + stderr.slice(0, 200));
      }
    });
    proc.on('error', e => fail(e.message));
    proc.stdin.on('error', e => fail('stdin EPIPE: ' + e.message));
    proc.stdin.write(reportText);
    proc.stdin.end();
  });
}

/**
 * canonicalJSON — deterministic JSON serialization with sorted keys.
 */
function canonicalJSON(obj, depth = 0) {
  if (depth > 32) throw new Error('envelope structure too deep (max 32)');
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(v => canonicalJSON(v, depth + 1)).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k], depth + 1)).join(',') + '}';
}

/**
 * buildMetaplexAgentPayload — sestaví kanonický payload pro Ed25519 signing
 * z výsledku token_audit metaplex_agent flow. Pure funkce, žádné I/O.
 */
function buildMetaplexAgentPayload(auditData) {
  const audit = auditData?.metaplex_agent_audit;
  return {
    subject_type:           'metaplex_agent',
    subject_metaplex_asset: auditData?.address ?? null,
    subject_metaplex_uri:   audit?.registration_uri || null,
    subject_metaplex_risk:  audit?.risk_level || null,
    subject_metaplex_score: audit?.overall_score ?? null,
    issuer:                 'integrity.molt',
    issuer_kid:             'integrity-molt-primary-2026',
  };
}

module.exports = { asyncSign, canonicalJSON, SignPipelineError, SIGN_SCRIPT, buildMetaplexAgentPayload };
