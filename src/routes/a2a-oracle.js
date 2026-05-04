'use strict';
/**
 * src/routes/a2a-oracle.js — A2A Oracle MVP endpoints
 *
 * Endpoints:
 *   POST /verify/v1/signed-receipt       — server-side Ed25519 receipt verification (free)
 *   GET  /scan/v1/:address               — IRIS quick scan, signed envelope (free)
 *   POST /monitor/v1/governance-change   — governance detection via Helius (0.15 USDC)
 *   GET  /feed/v1/new-spl-tokens         — pull feed of new SPL mints from events.jsonl (free)
 *
 * Security: no secrets in code; secretes live in .env only.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

const { asyncSign, canonicalJSON } = require('../crypto/sign');
const { isSolanaAddress } = require('../validation/address');
const { calculateIRIS } = require('../features/iris-score');
const { enrichScanResult } = require('../enrichment');
const { lookupScamDb } = require('../scam-db/lookup');
const { evaluateTransaction, parseEnhancedTransaction } = _requireParseEnhancedTx();
const { PRICING } = require('../../config/pricing');

// ── Helius Enhanced Transactions API ─────────────────────────────────────────
const HELIUS_BASE = 'https://api.helius.xyz/v0';

async function fetchHeliusTransactions(programId, limit = 50) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null; // Dev mock mode — signal caller to try Alchemy

  const url = `${HELIUS_BASE}/addresses/${encodeURIComponent(programId)}/transactions?api-key=${apiKey}&limit=${limit}&type=ANY`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Helius API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Alchemy RPC fallback ──────────────────────────────────────────────────────
// Used when Helius API key is missing or Helius returns an error (credits exhausted etc.)
async function fetchAlchemyTransactions(programId, limit = 50) {
  const rpcUrl = process.env.ALCHEMY_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl || rpcUrl.includes('api.mainnet-beta.solana.com')) return null;

  const rpc = async (method, params) => {
    const res = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal:  AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Alchemy RPC HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Alchemy RPC: ${data.error.message}`);
    return data.result;
  };

  const sigInfos = await rpc('getSignaturesForAddress', [programId, { limit }]);
  if (!Array.isArray(sigInfos) || sigInfos.length === 0) return [];

  const sigs = sigInfos.filter(s => !s.err).map(s => s.signature);
  const transactions = [];

  // Batch RPC calls — 5 per request to stay under rate limits
  for (let i = 0; i < sigs.length; i += 5) {
    const batch = sigs.slice(i, i + 5).map((sig, idx) => ({
      jsonrpc: '2.0', id: idx + 1, method: 'getTransaction',
      params:  [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }));
    const res = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(batch),
      signal:  AbortSignal.timeout(20_000),
    });
    if (!res.ok) break;
    const results = await res.json();
    for (const item of (Array.isArray(results) ? results : [results])) {
      if (item.result) transactions.push(_normalizeAlchemyTx(item.result));
    }
  }
  return transactions;
}

function _normalizeAlchemyTx(tx) {
  const sigs = tx.transaction?.signatures || [];
  const msg  = tx.transaction?.message   || {};
  const keys = msg.accountKeys           || [];

  const toKey = k => (typeof k === 'string' ? k : (k?.pubkey || null));

  return {
    signature:         sigs[0]                          || null,
    timestamp:         tx.blockTime                     || 0,
    type:              'UNKNOWN',
    fee:               tx.meta?.fee                     || 0,
    slot:              tx.slot                          || null,
    feePayer:          toKey(keys[0]),
    accountData:       keys.map(k => ({ account: toKey(k) })),
    instructions:      msg.instructions                 || [],
    innerInstructions: tx.meta?.innerInstructions       || [],
    nativeTransfers:   [],
    tokenTransfers:    [],
    events:            {},
    _source:           'alchemy_rpc',
  };
}

// Lazy require to avoid circular dependency with webhook-receiver if loaded before server.js
// parseEnhancedTransaction lives in src/monitor/webhook-receiver.js
function _requireParseEnhancedTx() {
  try {
    return require('../monitor/webhook-receiver');
  } catch {
    // If not available, provide a minimal stand-in
    return {
      evaluateTransaction: () => [],
      parseEnhancedTransaction: (tx) => ({
        signature: tx.signature,
        timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
        type: tx.type || 'UNKNOWN',
        fee: tx.fee || 0,
        slot: tx.slot || null,
        accounts: (tx.accountData || []).map(a => a.account),
        nativeTransfers: tx.nativeTransfers || [],
        tokenTransfers: tx.tokenTransfers || [],
        instructions: tx.instructions || [],
        programs: [],
        _raw: tx,
      }),
    };
  }
}

// ── Per-IP rate limiter factory ───────────────────────────────────────────────
function makeRateLimiter(maxPerMin) {
  const rl = new Map();
  return function rateLimiter(req, res, next) {
    const ip = req.ip || '127.0.0.1';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    const now = Date.now();
    const entry = rl.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart >= 60_000) { entry.count = 0; entry.windowStart = now; }
    entry.count++;
    rl.set(ip, entry);
    if (entry.count > maxPerMin) {
      return res.status(429).json({ error: `Rate limit exceeded (${maxPerMin} req/min)` });
    }
    next();
  };
}

const _scanRL    = makeRateLimiter(10);
const _verifyRL  = makeRateLimiter(20);
const _feedRL    = makeRateLimiter(20);

// ── Solana address validator (middleware) ─────────────────────────────────────
function validateSolanaParam(paramName) {
  return (req, res, next) => {
    const addr = (req.params[paramName] || req.body?.[paramName] || '').trim();
    if (!addr) return res.status(400).json({ error: `Missing ${paramName}` });
    if (!isSolanaAddress(addr)) {
      return res.status(400).json({
        error: 'invalid_solana_address',
        message: 'Must be a valid Solana base58 address (32-44 chars)',
      });
    }
    next();
  };
}

// ── Verify Key loader ─────────────────────────────────────────────────────────
// Loaded lazily so the module can be required without the key being on disk yet.
const VERIFY_KEY_PATH = process.env.VERIFY_KEY_PATH || '/root/.secrets/verify_key.bin';

function getVerifyKeyBytes() {
  return fs.readFileSync(VERIFY_KEY_PATH); // 32 raw bytes
}

// ── POST /verify/v1/signed-receipt ────────────────────────────────────────────
/**
 * Server-side Ed25519 receipt verification.
 * Always returns HTTP 200 with { valid: bool, ... } for machine-parseable results.
 *
 * Input envelope fields:
 *   payload     — object  (wrapped format, optional — see below)
 *   signature   — base64 Ed25519 signature (64 bytes)
 *   verify_key  — base64 Ed25519 public key (32 bytes)
 *   key_id      — string (first 16 chars of verify_key base64)
 *   signed_at   — ISO8601
 *   signer      — string
 *   algorithm   — "ed25519" (case-insensitive)
 *   ...rest     — any additional fields (flat format report data)
 *
 * Two envelope formats are supported:
 *   Wrapped: { payload: {address, iris_score,...}, signature, verify_key, ... }
 *     → canonical bytes = JSON.stringify(envelope.payload)
 *   Flat (as emitted by all oracle endpoints):
 *     { address, iris_score, ..., signature, verify_key, key_id, ... }
 *     → canonical bytes = JSON.stringify( all keys except signing metadata )
 *     Metadata keys stripped: signature, verify_key, key_id, signed_at, signer, algorithm, report
 */
router.post('/verify/v1/signed-receipt', express.json({ limit: '128kb' }), _verifyRL, async (req, res) => {
  const { envelope } = req.body || {};

  if (!envelope || typeof envelope !== 'object') {
    return res.json({ valid: false, reason: 'missing_envelope' });
  }

  const { payload, signature, verify_key, key_id, signed_at, signer, algorithm } = envelope;

  // Basic field presence
  if (!signature || !verify_key) {
    return res.json({ valid: false, reason: 'missing_signature_or_verify_key' });
  }

  if (algorithm && algorithm.toLowerCase() !== 'ed25519') {
    return res.json({ valid: false, reason: 'unsupported_algorithm', algorithm });
  }

  // Reconstruct canonical signed text.
  // Wrapped format:  { payload: {...}, signature, verify_key, ... }
  //   → signed bytes = JSON.stringify(envelope.payload)
  // Flat format (actual endpoint responses): all report fields sit alongside signature metadata.
  //   → signed bytes = JSON.stringify(all keys except the signing metadata fields)
  const METADATA = new Set(['signature', 'verify_key', 'key_id', 'signed_at', 'signer', 'algorithm', 'report']);

  let payloadObj;
  if (payload && typeof payload === 'object') {
    // Wrapped format — canonical source is explicit payload field
    payloadObj = payload;
  } else {
    // Flat format — strip metadata fields to recover the original report object
    payloadObj = Object.fromEntries(
      Object.entries(envelope).filter(([k]) => !METADATA.has(k))
    );
    if (Object.keys(payloadObj).length === 0) {
      return res.json({
        valid:    false,
        key_id:   key_id || null,
        signed_at: signed_at || null,
        issuer:   signer || null,
        reason:   'no_verifiable_payload',
        hint:     'envelope contains only metadata fields; cannot reconstruct signed bytes',
      });
    }
  }

  // Reconstruct canonical signed text using sorted-key deterministic JSON.
  // Both sign side (asyncSign callers) and verify side must use canonicalJSON to ensure
  // byte-identical output regardless of key insertion order or consumer language.
  const canonicalText = canonicalJSON(payloadObj);

  // Decode key and signature
  let keyBytes, sigBytes;
  try {
    keyBytes = Buffer.from(verify_key, 'base64');
    sigBytes = Buffer.from(signature, 'base64');
  } catch {
    return res.json({ valid: false, reason: 'invalid_base64_encoding' });
  }

  if (keyBytes.length !== 32) {
    return res.json({ valid: false, reason: 'invalid_verify_key_length', got: keyBytes.length });
  }
  if (sigBytes.length !== 64) {
    return res.json({ valid: false, reason: 'invalid_signature_length', got: sigBytes.length });
  }

  // Optional: verify the key_id matches the provided verify_key
  const expectedKeyId = verify_key.slice(0, 16);
  if (key_id && key_id !== expectedKeyId) {
    return res.json({ valid: false, reason: 'key_id_mismatch', expected: expectedKeyId });
  }

  // Optionally cross-check verify_key against our own server key (trusted key pinning).
  // If verify_key matches our known public key, trust it. If it differs, we still verify
  // the signature mathematically — but flag that the key is not ours.
  let keyPinned = false;
  try {
    const ourKey = getVerifyKeyBytes();
    keyPinned = ourKey.equals(keyBytes);
  } catch {
    // verify_key.bin not available — skip pinning check
  }

  // Verify Ed25519 using node:crypto (Node 18+)
  let valid = false;
  try {
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([
        // SubjectPublicKeyInfo DER header for Ed25519
        Buffer.from('302a300506032b6570032100', 'hex'),
        keyBytes,
      ]),
      format: 'der',
      type:   'spki',
    });
    valid = crypto.verify(null, Buffer.from(canonicalText, 'utf-8'), keyObj, sigBytes);
  } catch (e) {
    return res.json({ valid: false, reason: 'verification_error', detail: e.message.slice(0, 100) });
  }

  // `valid: true` requires both correct Ed25519 math AND the key being ours.
  // A self-signed envelope with a foreign key returns valid:false, reason:'key_not_pinned'.
  // `mathematically_valid` exposes the raw math check for callers who explicitly want it.
  const attested = valid && keyPinned;
  return res.json({
    valid:                attested,
    key_pinned:           keyPinned,
    mathematically_valid: valid,
    key_id:               key_id || expectedKeyId,
    signed_at:            signed_at || null,
    issuer:               signer || null,
    reason:               !valid ? 'invalid_signature'
                          : !keyPinned ? 'key_not_pinned'
                          : 'signature_valid',
  });
});

// ── GET /scan/v1/:address — free IRIS signed scan ─────────────────────────────
router.get('/scan/v1/:address', _scanRL, validateSolanaParam('address'), async (req, res) => {
  const address = req.params.address.trim();

  try {
    const [enrichment, scamDb] = await Promise.all([
      enrichScanResult(address).catch(() => null),
      lookupScamDb(address).catch(() => ({ known_scam: null, rugcheck: null, db_match: false })),
    ]);

    const iris = calculateIRIS(enrichment, scamDb);

    // Normalise risk_level to lowercase for A2A consumers
    let riskLevel = (iris.grade || 'unknown').toLowerCase();
    let irisScore = iris.score;
    let irisBreakdown = iris.breakdown || null;
    let riskFactors = iris.risk_factors || [];

    // Whitelist override — top SPL tokens skip scam_db penalty
    // and return baseline low-risk score consistent with IRIS semantics
    // (lower score = lower risk).
    if (scamDb && scamDb.whitelisted) {
      irisScore = 0;
      riskLevel = 'low';
      riskFactors = [];
      irisBreakdown = {
        inflows:   { score: 0, max: 25, details: ['whitelisted_legit_token'] },
        rights:    { score: 0, max: 25, details: ['whitelisted_legit_token'] },
        imbalance: { score: 0, max: 25, details: ['whitelisted_legit_token'] },
        speed:     { score: 0, max: 25, details: ['whitelisted_legit_token'] },
        whitelist_meta: scamDb.whitelist_meta || null,
      };
    }

    const reportPayload = {
      address,
      iris_score:  irisScore,
      risk_level:  riskLevel,
      risk_factors: riskFactors,
      iris_breakdown: irisBreakdown,
    };

    // Sign the report payload (canonical JSON string)
    let envelope;
    try {
      envelope = await asyncSign(canonicalJSON(reportPayload));
    } catch (e) {
      console.error('[a2a-oracle] asyncSign failed for scan:', e.message);
      envelope = {};
    }

    return res.json({
      ...reportPayload,
      signed_at:  envelope.signed_at  || new Date().toISOString(),
      signature:  envelope.signature  || null,
      verify_key: envelope.verify_key || null,
      key_id:     envelope.key_id     || null,
      signer:     envelope.signer     || 'integrity.molt',
      algorithm:  envelope.algorithm  || 'Ed25519',
    });
  } catch (err) {
    console.error('[a2a-oracle] /scan/v1 error:', err.message);
    return res.status(500).json({ error: 'scan_failed', detail: err.message.slice(0, 200) });
  }
});

// ── POST /monitor/v1/governance-change — paid (0.15 USDC) ────────────────────
/**
 * Detects governance changes in a Solana program over the last `window_slots`.
 * Uses the Helius Enhanced Transactions API for recent transactions and runs
 * the existing evaluateTransaction() detection engine from src/monitor/alerts.js.
 *
 * Falls back to a deterministic mock verdict if HELIUS_API_KEY is not set.
 */
router.post('/monitor/v1/governance-change', express.json({ limit: '8kb' }), async (req, res) => {
  // Defense-in-depth: requirePayment in server.js sets req.paymentVerified before mounting
  // this router. Assert it here so any future mount-order refactor fails loudly, not silently.
  if (!req.paymentVerified) {
    return res.status(402).json({ error: 'payment_required', message: 'x402 payment required' });
  }
  const { program_id, window_slots } = req.body || {};

  if (!program_id || typeof program_id !== 'string') {
    return res.status(400).json({ error: 'missing_program_id' });
  }
  if (!isSolanaAddress(program_id.trim())) {
    return res.status(400).json({
      error: 'invalid_solana_address',
      message: 'program_id must be a valid Solana base58 address',
    });
  }

  const safeProgram = program_id.trim();
  const txLimit = Math.max(1, Math.min(parseInt(window_slots, 10) || 50, 200));

  let findings   = [];
  let dataSource = 'helius';
  let txList     = null;

  // Primary: Helius Enhanced Transactions API
  try {
    txList = await fetchHeliusTransactions(safeProgram, txLimit);
    // null means no HELIUS_API_KEY — fall through to Alchemy below
  } catch (heliusErr) {
    console.warn('[a2a-oracle] Helius fetch failed, trying Alchemy fallback:', heliusErr.message);
  }

  // Fallback: Alchemy RPC (Helius key missing or credits exhausted)
  if (txList === null) {
    dataSource = 'alchemy_rpc';
    try {
      txList = await fetchAlchemyTransactions(safeProgram, txLimit);
      if (txList === null) dataSource = 'mock_error_fallback'; // no usable RPC available
    } catch (alchemyErr) {
      console.error('[a2a-oracle] Alchemy fallback failed:', alchemyErr.message);
      dataSource = 'mock_error_fallback';
    }
  }

  // Process transactions (works for both Helius and Alchemy-normalized format)
  if (Array.isArray(txList)) {
    for (const rawTx of txList) {
      try {
        const parsed = parseEnhancedTransaction(rawTx);
        const alerts = evaluateTransaction(parsed, safeProgram);
        for (const alert of alerts) {
          findings.push({
            rule:     alert.rule,
            severity: alert.severity,
            tx_sig:   alert.tx_signature || parsed.signature,
            ts:       alert.timestamp
              ? new Date(alert.timestamp).toISOString()
              : new Date().toISOString(),
            message:  alert.message,
          });
        }
      } catch (innerErr) {
        console.warn('[a2a-oracle] governance tx parse error:', innerErr.message);
      }
    }
  }

  // Determine verdict
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasHigh     = findings.some(f => f.severity === 'high');
  const verdict = hasCritical ? 'critical' : hasHigh ? 'suspicious' : 'clean';

  const reportPayload = {
    program_id:   safeProgram,
    window_slots: txLimit,
    findings,
    verdict,
    data_source:  dataSource,
  };

  let envelope;
  try {
    envelope = await asyncSign(JSON.stringify(reportPayload));
  } catch (e) {
    console.error('[a2a-oracle] asyncSign failed for governance:', e.message);
    envelope = {};
  }

  return res.json({
    ...reportPayload,
    signed_at:  envelope.signed_at  || new Date().toISOString(),
    signature:  envelope.signature  || null,
    verify_key: envelope.verify_key || null,
    key_id:     envelope.key_id     || null,
    signer:     envelope.signer     || 'integrity.molt',
    algorithm:  envelope.algorithm  || 'Ed25519',
  });
});

// ── GET /feed/v1/new-spl-tokens — public pull feed ────────────────────────────
// Reads from spl_mints table populated by spl-mint-poller.js (Alchemy Token Program poll).
// Falls back gracefully when the table is empty or DB unavailable.

router.get('/feed/v1/new-spl-tokens', _feedRL, async (req, res) => {
  let sinceTs;
  if (req.query.since) {
    sinceTs = Date.parse(req.query.since);
    if (isNaN(sinceTs)) {
      return res.status(400).json({ error: 'invalid_since_param', message: 'Use ISO8601 format, e.g. 2026-04-23T00:00:00Z' });
    }
  } else {
    sinceTs = Date.now() - 24 * 60 * 60 * 1000;
  }

  const sinceISO = new Date(sinceTs).toISOString();
  let mints = [];
  let dataSource = 'spl_mints_db';

  try {
    const db = require('../../db');
    const rawDb = db.db || db;
    const rows = rawDb.prepare(
      `SELECT mint, tx_sig, slot, block_time
       FROM spl_mints
       WHERE block_time >= ?
       ORDER BY block_time DESC, mint ASC
       LIMIT 500`
    ).all(sinceTs);

    mints = rows.map(r => ({
      mint:       r.mint,
      created_at: new Date(r.block_time).toISOString(),
      slot:       r.slot  || null,
      tx_sig:     r.tx_sig || null,
    }));
  } catch (dbErr) {
    console.error('[a2a-oracle] feed DB read error:', dbErr.message);
    dataSource = 'error_fallback';
  }

  const reportPayload = {
    mints,
    since:       sinceISO,
    count:       mints.length,
    data_source: dataSource,
  };

  let envelope;
  try {
    envelope = await asyncSign(JSON.stringify(reportPayload));
  } catch (e) {
    console.error('[a2a-oracle] asyncSign failed for feed:', e.message);
    envelope = {};
  }

  return res.json({
    ...reportPayload,
    signed_at:  envelope.signed_at  || new Date().toISOString(),
    signature:  envelope.signature  || null,
    verify_key: envelope.verify_key || null,
    key_id:     envelope.key_id     || null,
    signer:     envelope.signer     || 'integrity.molt',
    algorithm:  envelope.algorithm  || 'Ed25519',
  });
});

module.exports = router;
