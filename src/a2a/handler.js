'use strict';
const fs = require('fs');
const _VERIFY_KEY_PATH = process.env.VERIFY_KEY_PATH || '/root/.secrets/verify_key.bin';
function _getVerifyKeyBase64() {
  try { return fs.readFileSync(_VERIFY_KEY_PATH).toString('base64'); } catch { return null; }
}
// src/a2a/handler.js — Google A2A (Agent-to-Agent) protocol implementation
// Spec: https://google.github.io/A2A/specification
// Exposes integrity.molt scan capabilities to AI agents via JSON-RPC 2.0.
//
// Supported methods:
//   tasks/send   — start a scan task (returns inline result when fast, else task ID for polling)
//   tasks/get    — poll task status by ID
//   tasks/cancel — cancel a pending task
//
// Payment model: same x402 USDC micropayments as REST API; caller must include
//   x402-payment header OR use a pre-funded subscription API key.
//   For MVP, tasks/send with skill=quick_scan is free (matches REST /scan/quick free tier).
//
// AutoPilot: AI agents identified by x-agent-mint header are subject to co-signing
//   rules (spending limits, allowed skills). canAutoSign() is checked before every
//   paid skill execution; decisions are logged to autopilot_spending SQLite table.

// ── Task store (SQLite-backed) ────────────────────────────────────────────────
const {
  createTask,
  getTask,
  updateTask,
  deleteExpiredTasks,
} = require('./task-store');

// ── AutoPilot + PDA ───────────────────────────────────────────────────────────
const { canAutoSign, logAutoSignDecision, getAgentDailySpending } = require('./autopilot');
const { enrichPaymentContextWithPDA } = require('../payment/verify-pda');

// ── OtterSec + signing (program_verification_status skill) ───────────────────
const { getVerificationStatus }   = require('../lib/ottersec');
const { asyncSign, canonicalJSON } = require('../crypto/sign');

// ── Agent identity (Metaplex registry cross-reference) ───────────────────────
const { METAPLEX_ASSET, METAPLEX_URL, METAPLEX_REGISTRY_BLOCK } = require('../config/agent-identity');

// TTL cleanup job — every 10 minutes
const _cleanupInterval = setInterval(deleteExpiredTasks, 10 * 60 * 1000);
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ── Skill → scan type mapping ─────────────────────────────────────────────────

// Prices must stay in sync with config/pricing.js (single source of truth).
const SKILLS = {
  'quick_scan': {
    name:        'Quick Scan',
    description: 'Fast on-chain scan of a Solana address — account info, balance, basic risk assessment. Free tier, rate-limited.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   0,        // free — config/pricing.js: quick = 500_000 (paid REST), A2A uses /scan/free
    tags:        ['solana', 'security', 'free'],
  },
  'token_audit': {
    name:        'Token Audit',
    description: 'SPL token launch audit — mint authority, freeze authority, holder distribution, rug risk.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   0.75,     // config/pricing.js: token = 750_000
    tags:        ['solana', 'token', 'security'],
  },
  'agent_token_scan': {
    name:        'Agent Token Scan',
    description: 'Metaplex Agent Token security scan — Core NFT backing, treasury PDA, update authority risk, creator royalties, DAO governance, activity analysis. Launched 2026-04-13.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   0.15,     // config/pricing.js: agent-token = 150_000
    tags:        ['solana', 'metaplex', 'agent-token', 'nft', 'security'],
  },
  'wallet_profile': {
    name:        'Wallet Profile',
    description: 'Wallet profiling — age, activity, DeFi exposure, risk classification.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   0.75,     // config/pricing.js: wallet = 750_000 (was incorrectly 0.50)
    tags:        ['solana', 'wallet', 'security'],
  },
  'deep_audit': {
    name:        'Deep Audit',
    description: 'Comprehensive Solana program security audit — static analysis, LLM-verified findings, Ed25519-signed report.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   5.00,     // config/pricing.js: deep = 5_000_000
    tags:        ['solana', 'program', 'security', 'audit'],
  },
  'adversarial_sim': {
    name:        'Adversarial Simulation',
    description: 'Full adversarial simulation — forks on-chain state, probes 7 attack playbooks, returns signed risk report.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:    4.00,    // config/pricing.js: adversarial = 4_000_000 (under AutoPilot 5 USDC limit)
    tags:        ['solana', 'program', 'security', 'simulation'],
  },

  // ── A2A Oracle MVP skills ──────────────────────────────────────────────────
  'verify_receipt': {
    name:        'Verify Signed Receipt',
    description: 'Verify Ed25519 signed oracle receipt. Accepts { envelope: { payload, signature, verify_key, ... } }. Free.',
    inputModes:  ['application/json'],
    outputModes: ['application/json'],
    priceUSDC:   0,
    tags:        ['oracle', 'verification', 'free'],
  },
  'scan_address': {
    name:        'Scan Address (Oracle)',
    description: 'Quick Solana address risk scan via IRIS scoring engine. Returns signed { iris_score, risk_level, risk_factors }. Free, rate-limited.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   0,
    tags:        ['solana', 'oracle', 'security', 'free'],
  },
  'governance_change': {
    name:        'Governance Change Detection',
    description: 'Detect governance changes (authority_change, program_upgrade) in a Solana program using Helius enhanced transactions. Returns signed verdict.',
    inputModes:  ['application/json'],
    outputModes: ['application/json'],
    priceUSDC:   0.15,     // config/pricing.js: governance-change = 150_000
    tags:        ['solana', 'oracle', 'governance', 'monitoring'],
  },
  'new_spl_feed': {
    name:        'New SPL Token Feed',
    description: 'Pull feed of new SPL token mint creation events. Filter by ?since=ISO8601. Free.',
    inputModes:  ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC:   0,
    tags:        ['solana', 'oracle', 'spl', 'feed', 'free'],
  },
  'program_verification_status': {
    name:        'Program Verification Status',
    description: 'Cross-references OtterSec verify.osec.io for Solana program build attestation. Returns whether deployed bytecode matches a verified source repository. Free, cached 1h.',
    inputModes:  ['text/plain', 'application/json'],
    outputModes: ['application/json'],
    priceUSDC:   0,
    tags:        ['solana', 'verification', 'ottersec', 'free', 'oracle'],
  },
};

// ── Artifact helper — flatten scan result for A2A callers ────────────────────
// Internal scan endpoints return { status, type, address, data: { risk_level, ... } }.
// A2A callers expect risk_level at parts[0].data.risk_level (not parts[0].data.data.risk_level).
// This merges the inner .data fields into the top level while preserving outer metadata.
function flattenScanResult(scanResult) {
  if (scanResult && typeof scanResult === 'object' && scanResult.data && typeof scanResult.data === 'object') {
    const { data, ...outer } = scanResult;
    return { ...outer, ...data };
  }
  return scanResult;
}

// ── Skill executor — calls internal loopback REST endpoints ──────────────────
// This avoids circular requires (scan logic lives in server.js) and ensures all
// existing middleware (rate limits, logging, metrics) runs normally.
// Payment is forwarded from the original A2A request headers.

const PORT          = process.env.PORT || 3402;
const INTERNAL_BASE = `http://127.0.0.1:${PORT}`;

async function internalPost(path, body, paymentHeader, timeoutMs = 60_000) {
  const headers = { 'Content-Type': 'application/json', 'X-A2A-Caller': '1' };
  if (paymentHeader) headers['x402-payment'] = paymentHeader;
  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    const err  = new Error(msg);
    err.status  = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function executeSkill(skillId, address, options = {}, paymentHeader = null) {
  switch (skillId) {
    case 'quick_scan':
      // IRIS-only endpoint — enrichment + calculateIRIS, no CAPTCHA, 127.0.0.1 rate-limit exempt.
      return internalPost('/scan/iris', { address }, null, 30_000);

    case 'token_audit':
      return internalPost('/scan/token', { address }, paymentHeader, 60_000);

    case 'agent_token_scan':
      // Metaplex Agent Token scan — 0.15 USDC, POST /api/v1/scan/agent-token
      // Body field is "mint" (not "address") per agent-token-scanner.js API.
      return internalPost('/api/v1/scan/agent-token', { mint: address }, paymentHeader, 60_000);

    case 'wallet_profile':
      return internalPost('/scan/wallet', { address }, paymentHeader, 60_000);

    case 'deep_audit':
      return internalPost('/scan/deep', { address }, paymentHeader, 120_000);

    case 'adversarial_sim':
      return internalPost('/api/v1/adversarial/simulate', {
        programId: address,
        skipFork:  options.skipFork !== false,  // analysis-only via A2A by default
        ...options,
      }, paymentHeader, 300_000);

    case 'program_verification_status': {
      const osec = await getVerificationStatus(address);
      const payload = {
        skill:      'program_verification_status',
        target:     address,
        is_verified:      osec.is_verified,
        on_chain_hash:    osec.on_chain_hash,
        executable_hash:  osec.executable_hash,
        repo_url:         osec.repo_url,
        last_verified_at: osec.last_verified_at,
        source:           osec.source,
        cache_age_s:      osec.cache_age_s,
        issuer:                'integrity.molt',
        issuer_kid:            'integrity-molt-primary-2026',
        issuer_metaplex_asset: METAPLEX_ASSET,
        issuer_metaplex_url:   METAPLEX_URL,
      };
      let envelope = {};
      try {
        envelope = await asyncSign(canonicalJSON(payload));
      } catch (e) {
        console.error('[a2a] program_verification_status asyncSign failed:', e.message);
      }
      return {
        ...payload,
        signed_at:  envelope.signed_at  || new Date().toISOString(),
        signature:  envelope.signature  || null,
        verify_key: envelope.verify_key || null,
        key_id:     envelope.key_id     || null,
        signer:     envelope.signer     || 'integrity.molt',
        algorithm:  envelope.algorithm  || 'Ed25519',
      };
    }

    default:
      throw new Error(`Unknown skill: ${skillId}`);
  }
}

// ── Webhook callback helper ───────────────────────────────────────────────────

/**
 * postCallback — POST result to callbackUrl with timeout + one retry.
 * Logs result into task history via updateTask.
 */
async function postCallback(taskId, callbackUrl, result) {
  if (!callbackUrl) return;

  const payload = JSON.stringify(result);
  const headers = { 'Content-Type': 'application/json', 'X-A2A-Task': taskId };

  let attempt = 0;
  let lastErr  = null;

  while (attempt < 2) {
    attempt++;
    try {
      const res = await fetch(callbackUrl, {
        method:  'POST',
        headers,
        body:    payload,
        signal:  AbortSignal.timeout(10_000),
      });
      const cbStatus = res.status;
      console.log(`[a2a] callback task=${taskId} url=${callbackUrl} status=${cbStatus} attempt=${attempt}`);
      // Log into task history
      updateTask(taskId, {
        status: { state: 'callback_sent', callbackUrl, callbackStatus: cbStatus, attempt }
      });
      return; // success
    } catch (e) {
      lastErr = e;
      console.warn(`[a2a] callback task=${taskId} attempt=${attempt} failed: ${e.message}`);
      if (attempt < 2) {
        // Brief delay before retry — explicit await, not sleep loop
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // Both attempts failed — log failure
  updateTask(taskId, {
    status: { state: 'callback_failed', callbackUrl, error: lastErr?.message }
  });
}

// Extract address from A2A message parts (text/plain or data part with address field)
function extractAddressFromMessage(message) {
  if (!message?.parts?.length) return null;

  for (const part of message.parts) {
    // text/plain: look for base58 address pattern (32-44 chars)
    if (part.type === 'text' || !part.type) {
      const text = part.text || part.content || '';
      const match = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (match) return match[0];
    }
    // data part with explicit address field
    if (part.type === 'data' && part.data?.address) {
      return part.data.address;
    }
  }
  return null;
}

function extractSkillFromMessage(message) {
  if (!message?.parts?.length) return null;
  for (const part of message.parts) {
    if (part.type === 'data' && part.data?.skill) return part.data.skill;
    if (part.metadata?.skill) return part.metadata.skill;
  }
  return null;
}

// ── JSON-RPC 2.0 error codes ──────────────────────────────────────────────────

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// ── Method handlers ───────────────────────────────────────────────────────────

/**
 * tasks/send — Start a new scan task.
 *
 * params:
 *   id?          optional client-generated task ID (UUIDv4) — ignored, server generates ID
 *   sessionId?   optional session grouping
 *   message      A2A Message object:
 *     parts: [{ type: "text", text: "<address>" }, { type: "data", data: { skill: "quick_scan" } }]
 *   metadata?    { skill: "quick_scan", address?: "...", options: {}, callbackUrl?: "..." }
 *   callbackUrl? top-level optional webhook URL (alternative to metadata.callbackUrl)
 *
 * reqHeaders: forwarded from the original HTTP request (for x402-payment passthrough)
 */
async function handleTasksSend(rpcId, params, reqHeaders = {}) {
  const { message, metadata, sessionId, callbackUrl: topCallbackUrl } = params || {};
  if (!message) return rpcError(rpcId, -32602, 'Missing required param: message');

  // Resolve skill
  const skillId = metadata?.skill
    || extractSkillFromMessage(message)
    || 'quick_scan';  // default to free quick scan

  if (!SKILLS[skillId]) {
    return rpcError(rpcId, -32602, `Unknown skill: ${skillId}`, { available: Object.keys(SKILLS) });
  }

  // Resolve target address
  const address = metadata?.address || extractAddressFromMessage(message);
  if (!address) {
    return rpcError(rpcId, -32602, 'Cannot extract Solana address from message parts');
  }

  // Webhook callback URL (metadata takes precedence over top-level)
  const callbackUrl = metadata?.callbackUrl || topCallbackUrl || null;

  // Validate callbackUrl is a valid HTTP(S) URL if provided
  if (callbackUrl) {
    try {
      const u = new URL(callbackUrl);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('non-http');
    } catch {
      return rpcError(rpcId, -32602, 'Invalid callbackUrl — must be http(s):// URL');
    }
  }

  // Forward x402 payment header if present (for paid skills)
  const paymentHeader = reqHeaders['x402-payment'] || reqHeaders['authorization'] || null;

  // Agent identity — Metaplex Agent Token mint (optional, enables AutoPilot checks)
  const agentMint = reqHeaders['x-agent-mint'] || null;

  const skill = SKILLS[skillId];

  // ── AutoPilot check (paid skills only, AI agents only) ───────────────────────
  if (skill.priceUSDC > 0 && agentMint) {
    // Log PDA context for audit
    enrichPaymentContextWithPDA(null, agentMint);

    const autopilotDecision = canAutoSign(agentMint, skillId, skill.priceUSDC);
    if (!autopilotDecision.approved) {
      logAutoSignDecision(agentMint, skillId, skill.priceUSDC, 'rejected', null, autopilotDecision.reason);
      return rpcError(rpcId, -32000, 'AutoPilot rejected: ' + autopilotDecision.reason, {
        skillId,
        priceUSDC:   skill.priceUSDC,
        agentMint,
        reason:      autopilotDecision.reason,
        dailyBudget: getAgentDailySpending(agentMint),
      });
    }
  }

  // Check if paid skill has no payment header — warn but still try (internal call will return 402)
  if (skill.priceUSDC > 0 && !paymentHeader) {
    console.log(`[a2a] tasks/send: skill=${skillId} requires payment but no x402-payment header provided`);
  }

  // Create task (persisted to SQLite)
  const task = createTask(skillId, { address, options: metadata?.options || {}, callbackUrl }, sessionId || null);

  // Run the skill async — update task state when done
  setImmediate(async () => {
    updateTask(task.id, { status: { state: 'working' } });
    try {
      const scanResult = await executeSkill(skillId, address, metadata?.options || {}, paymentHeader);
      const artifactData = flattenScanResult(scanResult);
      updateTask(task.id, {
        status:    { state: 'completed' },
        artifacts: [{
          name:     `${skillId}_result`,
          mimeType: 'application/json',
          parts:    [{ type: 'data', data: artifactData }]
        }]
      });
      // Log approved AutoPilot spend
      if (agentMint && skill.priceUSDC > 0) {
        logAutoSignDecision(agentMint, skillId, skill.priceUSDC, 'approved', null);
      }
      // Fire webhook callback if provided
      await postCallback(task.id, callbackUrl, {
        taskId:    task.id,
        skillId,
        address,
        status:    { state: 'completed' },
        artifacts: [{
          name:     `${skillId}_result`,
          mimeType: 'application/json',
          parts:    [{ type: 'data', data: artifactData }]
        }]
      });
    } catch (e) {
      console.error(`[a2a] task ${task.id} (${skillId}) failed:`, e.message);
      // Preserve payment-required error details for the caller
      const statusUpdate = { state: 'failed', message: e.message.slice(0, 300) };
      if (e.status === 402) {
        statusUpdate.paymentRequired = {
          priceUSDC: SKILLS[skillId]?.priceUSDC,
          currency:  'USDC',
          protocol:  'x402',
          hint:      'Include x402-payment header in the tasks/send request',
        };
      }
      updateTask(task.id, { status: statusUpdate });
      // Fire webhook callback for failure too
      await postCallback(task.id, callbackUrl, {
        taskId:  task.id,
        skillId,
        address,
        status:  statusUpdate,
      });
    }
  });

  // Return task with initial state immediately (caller polls with tasks/get)
  return rpcResult(rpcId, {
    id:        task.id,
    status:    task.status,
    createdAt: new Date(task.createdAt).toISOString(),
    skillId,
    address,
    pricing:   skill.priceUSDC === 0
      ? { type: 'free' }
      : { type: 'per_call', amount: skill.priceUSDC, currency: 'USDC', protocol: 'x402' },
    ...(agentMint   ? { agentMint }   : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
  });
}

/**
 * tasks/get — Poll task status and retrieve result.
 * params: { id: "<task-uuid>" }
 */
function handleTasksGet(rpcId, params) {
  const { id } = params || {};
  if (!id) return rpcError(rpcId, -32602, 'Missing required param: id');

  const task = getTask(id);
  if (!task) return rpcError(rpcId, -32001, `Task not found: ${id}`);

  return rpcResult(rpcId, {
    id:        task.id,
    skillId:   task.skillId,
    status:    task.status,
    artifacts: task.artifacts,
    history:   task.history,
    createdAt: new Date(task.createdAt).toISOString(),
  });
}

/**
 * tasks/cancel — Cancel a pending or working task.
 * params: { id: "<task-uuid>" }
 */
function handleTasksCancel(rpcId, params) {
  const { id } = params || {};
  if (!id) return rpcError(rpcId, -32602, 'Missing required param: id');

  const task = getTask(id);
  if (!task) return rpcError(rpcId, -32001, `Task not found: ${id}`);

  if (['completed', 'failed', 'canceled'].includes(task.status.state)) {
    return rpcError(rpcId, -32002, `Task ${id} is already in terminal state: ${task.status.state}`);
  }

  updateTask(id, { status: { state: 'canceled' } });
  return rpcResult(rpcId, { id, status: { state: 'canceled' } });
}

/**
 * tasks/sendSubscribe — A2A 0.4.1 JSON-RPC SSE streaming.
 * POST /a2a s method="tasks/sendSubscribe" → SSE stream.
 * Events: task_created → task_working (keepalive) → task_completed | task_failed
 */
async function handleTasksSendSubscribe(rpcId, params, req, res) {
  const { message, metadata, sessionId, callbackUrl: topCallbackUrl } = params || {};

  function sseError(code, message) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    sseWrite(res, 'task_failed', rpcError(rpcId, code, message));
    res.end();
  }

  if (!message) return sseError(-32602, 'Missing required param: message');

  const skillId = metadata?.skill || extractSkillFromMessage(message) || 'quick_scan';
  if (!SKILLS[skillId]) return sseError(-32602, `Unknown skill: ${skillId}`);

  const address = metadata?.address || extractAddressFromMessage(message);
  if (!address) return sseError(-32602, 'Cannot extract Solana address from message parts');

  const callbackUrl   = metadata?.callbackUrl || topCallbackUrl || null;
  const paymentHeader = req.headers['x402-payment'] || req.headers['authorization'] || null;
  const skill         = SKILLS[skillId];

  const task = createTask(skillId, { address, options: metadata?.options || {}, callbackUrl }, sessionId || null);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const startMs = Date.now();

  sseWrite(res, 'task_created', rpcResult(rpcId, {
    id:        task.id,
    skillId,
    address,
    status:    { state: 'submitted' },
    createdAt: new Date(task.createdAt).toISOString(),
    pricing:   skill.priceUSDC === 0
      ? { type: 'free' }
      : { type: 'per_call', amount: skill.priceUSDC, currency: 'USDC', protocol: 'x402' },
  }));

  updateTask(task.id, { status: { state: 'working' } });

  const keepalive = setInterval(() => {
    sseWrite(res, 'task_working', rpcResult(rpcId, {
      id:         task.id,
      status:     { state: 'working' },
      elapsed_ms: Date.now() - startMs,
    }));
  }, 5000);

  req.on('close', () => clearInterval(keepalive));

  try {
    const scanResult   = await executeSkill(skillId, address, metadata?.options || {}, paymentHeader);
    const artifactData = flattenScanResult(scanResult);

    clearInterval(keepalive);

    const completedArtifacts = [{ name: `${skillId}_result`, mimeType: 'application/json', parts: [{ type: 'data', data: artifactData }] }];
    updateTask(task.id, { status: { state: 'completed' }, artifacts: completedArtifacts });

    sseWrite(res, 'task_completed', rpcResult(rpcId, {
      id:        task.id,
      status:    { state: 'completed' },
      artifacts: completedArtifacts,
    }));
    res.end();

    await postCallback(task.id, callbackUrl, { taskId: task.id, skillId, address, status: { state: 'completed' }, artifacts: completedArtifacts });

  } catch (e) {
    clearInterval(keepalive);
    console.error(`[a2a/sendSubscribe] task ${task.id} (${skillId}) failed:`, e.message);
    const errStatus = { state: 'failed', message: e.message.slice(0, 300) };
    if (e.status === 402) {
      errStatus.paymentRequired = { priceUSDC: skill.priceUSDC, currency: 'USDC', protocol: 'x402', hint: 'Include x402-payment header' };
    }
    updateTask(task.id, { status: errStatus });
    sseWrite(res, 'task_failed', rpcError(rpcId, -32000, errStatus.message, errStatus));
    res.end();
    await postCallback(task.id, callbackUrl, { taskId: task.id, skillId, address, status: errStatus });
  }
}

// ── SSE streaming handler — handleA2ASubscribe ────────────────────────────────
// Exported and mounted in server.js as: POST /a2a/subscribe
//
// Body: { skill, address, sessionId?, metadata? }
// Sends SSE events: task_created → task_working (keepalive) → task_completed | task_failed
//
// SSE format per spec:
//   event: <name>\n
//   data: <json>\n
//   \n

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleA2ASubscribe(req, res) {
  const { skill, address, sessionId, metadata } = req.body || {};

  // Validate inputs
  if (!address) {
    return res.status(400).json({ error: 'Missing required field: address' });
  }

  const skillId = skill || 'quick_scan';
  if (!SKILLS[skillId]) {
    return res.status(400).json({ error: `Unknown skill: ${skillId}`, available: Object.keys(SKILLS) });
  }

  // Validate address looks like base58 (32–44 chars)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  // Payment header passthrough
  const paymentHeader = req.headers['x402-payment'] || req.headers['authorization'] || null;
  const skillDef      = SKILLS[skillId];

  if (skillDef.priceUSDC > 0 && !paymentHeader) {
    console.log(`[a2a/sse] subscribe: skill=${skillId} requires payment but no x402-payment header`);
  }

  // Create task
  const task = createTask(skillId, { address, options: metadata?.options || {} }, sessionId || null);

  // Set SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const startMs = Date.now();

  // Send initial event
  sseWrite(res, 'task_created', { taskId: task.id, skillId, address });

  // Keepalive interval — every 5 seconds
  const keepalive = setInterval(() => {
    sseWrite(res, 'task_working', { taskId: task.id, elapsed_ms: Date.now() - startMs });
  }, 5000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
  });

  // Execute skill
  updateTask(task.id, { status: { state: 'working' } });

  try {
    const scanResult = await executeSkill(skillId, address, metadata?.options || {}, paymentHeader);
    const artifactData = flattenScanResult(scanResult);

    clearInterval(keepalive);

    updateTask(task.id, {
      status:    { state: 'completed' },
      artifacts: [{
        name:     `${skillId}_result`,
        mimeType: 'application/json',
        parts:    [{ type: 'data', data: artifactData }]
      }]
    });

    sseWrite(res, 'task_completed', { taskId: task.id, result: artifactData });
    res.end();

  } catch (e) {
    clearInterval(keepalive);

    console.error(`[a2a/sse] task ${task.id} (${skillId}) failed:`, e.message);
    const failStatus = { state: 'failed', message: e.message.slice(0, 300) };
    if (e.status === 402) {
      failStatus.paymentRequired = {
        priceUSDC: skillDef.priceUSDC,
        currency:  'USDC',
        protocol:  'x402',
        hint:      'Include x402-payment header in the /a2a/subscribe request',
      };
    }
    updateTask(task.id, { status: failStatus });
    sseWrite(res, 'task_failed', { taskId: task.id, error: failStatus });
    res.end();
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Express handler for POST /a2a.
 * Dispatches JSON-RPC 2.0 requests to the appropriate method.
 */
async function handleA2ARequest(req, res) {
  const body = req.body;

  // Validate JSON-RPC envelope
  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return res.status(400).json(rpcError(body?.id ?? null, -32600, 'Invalid Request — expected JSON-RPC 2.0'));
  }

  const { id: rpcId, method, params } = body;

  // tasks/sendSubscribe — SSE streaming, nelze použít res.json()
  if (method === 'tasks/sendSubscribe') {
    return handleTasksSendSubscribe(rpcId, params, req, res);
  }

  try {
    let response;
    switch (method) {
      case 'tasks/send':
        response = await handleTasksSend(rpcId, params, req.headers);
        break;
      case 'tasks/get':
        response = handleTasksGet(rpcId, params);
        break;
      case 'tasks/cancel':
        response = handleTasksCancel(rpcId, params);
        break;
      default:
        response = rpcError(rpcId, -32601, `Method not found: ${method}`, {
          available: ['tasks/send', 'tasks/get', 'tasks/cancel', 'tasks/sendSubscribe']
        });
    }
    return res.json(response);
  } catch (e) {
    console.error('[a2a] unhandled error:', e.message);
    return res.status(500).json(rpcError(rpcId, -32603, 'Internal error', e.message.slice(0, 200)));
  }
}

// ── Agent card ────────────────────────────────────────────────────────────────

function buildAgentCard(baseUrl) {
  const base = baseUrl || 'https://intmolt.org';
  return {
    name:        'integrity.molt — Solana Security Scanner',
    description: 'AI-powered Solana security scanner and adversarial simulator. Provides on-chain program analysis, token audits, wallet profiling, adversarial attack simulation, and A2A oracle endpoints via the x402 payment protocol.',
    url:         base,
    iconUrl:     `${base}/favicon.ico`,
    version:     '0.5.1-ottersec',
    documentationUrl: 'https://intmolt.org',
    provider: {
      organization: 'integrity.molt',
      url:          'https://intmolt.org',
    },
    capabilities: {
      streaming:              true,
      pushNotifications:      true,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['x402', 'none'],
      description: 'Free skills (verify_receipt, scan_address, new_spl_feed, quick_scan) require no payment. Paid skills require x402 USDC micropayment in x402-payment header.',
    },
    defaultInputModes:  ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: Object.entries(SKILLS).map(([id, s]) => ({
      id,
      name:        s.name,
      description: s.description,
      tags:        s.tags,
      inputModes:  s.inputModes,
      outputModes: s.outputModes,
      pricing:     s.priceUSDC === 0
        ? { type: 'free' }
        : { type: 'per_call', amount: s.priceUSDC, currency: 'USDC', protocol: 'x402' },
      examples: [
        {
          description: `${s.name} of a Solana address`,
          input: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: 'Scan address 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }]
            },
            metadata: { skill: id }
          }
        }
      ]
    })),
    // Canonical endpoint list for A2A oracle callers
    endpoints: [
      { path: '/verify/v1/signed-receipt',     method: 'POST', auth: 'none',  description: 'Server-side Ed25519 receipt verification' },
      { path: '/scan/v1/:address',             method: 'GET',  auth: 'none',  description: 'Quick Solana address IRIS risk scan (free)' },
      { path: '/monitor/v1/governance-change', method: 'POST', auth: 'x402',  description: 'Detect governance changes in Solana program (0.15 USDC)' },
      { path: '/feed/v1/new-spl-tokens',       method: 'GET',  auth: 'none',  description: 'Pull feed of new SPL token mints (free)' },
      { path: '/a2a',                          method: 'POST', auth: 'x402',  description: 'A2A JSON-RPC 2.0 — tasks/send, tasks/get, tasks/cancel' },
      { path: '/a2a/subscribe',                method: 'POST', auth: 'x402',  description: 'A2A SSE streaming subscription' },
    ],
    // Pricing tiers for discovery
    pricing_tiers: {
      discovery: {
        price: 'free',
        endpoints: ['/scan/v1/:address', '/feed/v1/new-spl-tokens', '/.well-known/*'],
      },
      attestation: {
        price: '0.10-0.25 USDC',
        endpoints: ['/monitor/v1/governance-change'],
      },
      forensic: {
        price: 'existing deep scan prices',
        endpoints: ['/api/v1/scan/deep', '/api/v1/adversarial/simulate'],
      },
    },
    // Live usage example
    examples: [
      {
        description: 'Scan known SPL Token program',
        input: { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        endpoint: 'GET /scan/v1/:address',
      }
    ],
    metaplex_registry: METAPLEX_REGISTRY_BLOCK,
    verifyKey: _getVerifyKeyBase64(),
    reportSigning: {
      algorithm:   'Ed25519',
      description: 'All scan reports are signed. Verify receipts via POST /verify/v1/signed-receipt or with any NaCl Ed25519 library using the verifyKey above.',
      receiptsSchema: `${base}/.well-known/receipts-schema.json`,
      jwks:           `${base}/.well-known/jwks.json`,
    }
  };
}

module.exports = { handleA2ARequest, handleA2ASubscribe, handleTasksSendSubscribe, buildAgentCard, SKILLS, getTask, createTask };
