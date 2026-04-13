'use strict';
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

const { randomUUID } = require('crypto');

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
    priceUSDC:   10.00,    // config/pricing.js: adversarial = 10_000_000
    tags:        ['solana', 'program', 'security', 'simulation'],
  },
};

// ── Task store (in-memory, TTL 1 hour) ───────────────────────────────────────

const _tasks = new Map(); // taskId → Task
const TASK_TTL_MS = 3600_000;

function createTask(skillId, params) {
  const id = randomUUID();
  const task = {
    id,
    skillId,
    params,
    status:    { state: 'submitted' },
    createdAt: Date.now(),
    artifacts: [],
    history:   [{ state: 'submitted', timestamp: new Date().toISOString() }],
  };
  _tasks.set(id, task);
  // TTL cleanup
  setTimeout(() => _tasks.delete(id), TASK_TTL_MS);
  return task;
}

function getTask(id) {
  return _tasks.get(id) || null;
}

function updateTask(id, update) {
  const t = _tasks.get(id);
  if (!t) return;
  Object.assign(t, update);
  if (update.status) {
    t.history.push({ ...update.status, timestamp: new Date().toISOString() });
  }
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
      // Free tier — /scan/free (CAPTCHA-gated, rate-limited by IP).
      // /scan/quick is the paid REST variant (0.50 USDC); A2A exposes the free tier.
      return internalPost('/scan/free', { address, chain: 'solana' }, null, 30_000);

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

    default:
      throw new Error(`Unknown skill: ${skillId}`);
  }
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
 *   id?        optional client-generated task ID (UUIDv4)
 *   sessionId? optional session grouping
 *   message    A2A Message object:
 *     parts: [{ type: "text", text: "<address>" }, { type: "data", data: { skill: "quick_scan" } }]
 *   metadata?  { skill: "quick_scan", address?: "...", options: {} }
 *
 * reqHeaders: forwarded from the original HTTP request (for x402-payment passthrough)
 */
async function handleTasksSend(rpcId, params, reqHeaders = {}) {
  const { message, metadata } = params || {};
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

  // Forward x402 payment header if present (for paid skills)
  const paymentHeader = reqHeaders['x402-payment'] || reqHeaders['authorization'] || null;

  // Check if paid skill has no payment header — warn but still try (internal call will return 402)
  const skill = SKILLS[skillId];
  if (skill.priceUSDC > 0 && !paymentHeader) {
    console.log(`[a2a] tasks/send: skill=${skillId} requires payment but no x402-payment header provided`);
  }

  // Create task
  const task = createTask(skillId, { address, options: metadata?.options || {} });

  // Run the skill async — update task state when done
  setImmediate(async () => {
    updateTask(task.id, { status: { state: 'working' } });
    try {
      const scanResult = await executeSkill(skillId, address, metadata?.options || {}, paymentHeader);
      updateTask(task.id, {
        status:    { state: 'completed' },
        artifacts: [{
          name:     `${skillId}_result`,
          mimeType: 'application/json',
          parts:    [{ type: 'data', data: scanResult }]
        }]
      });
    } catch (e) {
      console.error(`[a2a] task ${task.id} (${skillId}) failed:`, e.message);
      // Preserve payment-required error details for the caller
      const statusUpdate = { state: 'failed', message: e.message.slice(0, 300) };
      if (e.status === 402 || e.status === 402) {
        statusUpdate.paymentRequired = {
          priceUSDC: SKILLS[skillId]?.priceUSDC,
          currency:  'USDC',
          protocol:  'x402',
          hint:      'Include x402-payment header in the tasks/send request',
        };
      }
      updateTask(task.id, { status: statusUpdate });
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
          available: ['tasks/send', 'tasks/get', 'tasks/cancel']
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
  return {
    name:        'integrity.molt — Solana Security Scanner',
    description: 'AI-powered Solana security scanner and adversarial simulator. Provides on-chain program analysis, token audits, wallet profiling, and adversarial attack simulation via the x402 payment protocol.',
    url:         baseUrl || 'https://intmolt.org',
    iconUrl:     `${baseUrl || 'https://intmolt.org'}/favicon.ico`,
    version:     '0.4.0',
    documentationUrl: 'https://intmolt.org',
    provider: {
      organization: 'integrity.molt',
      url:          'https://intmolt.org',
    },
    capabilities: {
      streaming:             false,
      pushNotifications:     false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['x402'],
      description: 'Paid skills require x402 USDC micropayment. Include payment in x402-payment header. quick_scan is free.',
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
    }))
  };
}

module.exports = { handleA2ARequest, buildAgentCard, SKILLS, getTask, createTask };
