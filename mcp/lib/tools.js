'use strict';

const { get, post } = require('./client');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function validateAddress(val, fieldName = 'address') {
  if (typeof val !== 'string') throw new Error(`${fieldName} must be a string`);
  const addr = val.trim();
  if (!addr) throw new Error(`${fieldName} is required`);
  if (!BASE58_RE.test(addr)) throw new Error(`${fieldName} must be a valid Solana base58 public key (32–44 chars)`);
  return addr;
}

// Concurrency semaphore — caps in-flight requests to prevent memory exhaustion
// from LLM loops or prompt-injection-driven bursts.
let _inflight = 0;
const MAX_INFLIGHT = 4;

const TOOLS = [
  {
    name: 'scan_solana_address',
    description:
      'IRIS security scan of a Solana token mint or wallet address. ' +
      'Returns iris_score (0–100, higher = riskier), risk_level (low/medium/high/critical), ' +
      'risk_factors array, and an Ed25519-signed receipt for tamper-proof audit. Free, rate-limited. ' +
      '[Network: sends address to https://intmolt.org — informational only, not financial advice.]',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Solana base58 address — token mint or wallet public key',
          minLength: 32,
          maxLength: 44,
          pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'verify_signed_receipt',
    description:
      'Verify an Ed25519-signed oracle receipt from integrity.molt. ' +
      'Confirms the receipt was issued by this oracle and has not been tampered with. ' +
      'Does NOT re-validate the underlying risk assessment, which may be outdated. Free.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        envelope: {
          type: 'object',
          description: 'The signed receipt object returned by scan_solana_address',
          required: ['payload', 'signature', 'kid'],
        },
      },
      required: ['envelope'],
    },
  },
  {
    name: 'get_new_spl_tokens',
    description:
      'Feed of new SPL token mint creation events on Solana (last 24h by default). ' +
      'Useful for monitoring new token launches before they appear on DEXes. ' +
      'Results capped at 500 per call. Free. [Network: queries https://intmolt.org]',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO8601 timestamp — return tokens created after this time',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of tokens to return (1–500, default 100)',
          minimum: 1,
          maximum: 500,
        },
      },
    },
  },
  {
    name: 'quick_scan',
    description:
      'Lightweight IRIS risk scan of a Solana address. ' +
      'Faster than scan_solana_address — no signed receipt. Use for quick risk checks. Free, rate-limited. ' +
      '[Network: sends address to https://intmolt.org — informational only, not financial advice.]',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Solana base58 address',
          minLength: 32,
          maxLength: 44,
          pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'check_program_verification',
    description:
      'Check if a Solana program is verified on OtterSec verify.osec.io — ' +
      'confirms deployed bytecode matches a public source repository. ' +
      'Returns is_verified, repo_url, and last_verified_at. Free, cached 1h. ' +
      'Bytecode match does not imply the program is safe or free of malicious logic.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        program_id: {
          type: 'string',
          description: 'Solana program address',
          minLength: 32,
          maxLength: 44,
          pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
        },
      },
      required: ['program_id'],
    },
  },
];

async function handleTool(name, args) {
  if (_inflight >= MAX_INFLIGHT) {
    return {
      content: [{ type: 'text', text: 'Error: too many concurrent requests, please retry' }],
      isError: true,
    };
  }
  _inflight++;
  try {
    let data;
    switch (name) {
      case 'scan_solana_address': {
        const addr = validateAddress(args.address);
        data = await get(`/scan/v1/${encodeURIComponent(addr)}`);
        break;
      }
      case 'verify_signed_receipt': {
        const env = args.envelope;
        if (!env || typeof env !== 'object' || Array.isArray(env)) {
          throw new Error('envelope must be a plain object');
        }
        const serialized = JSON.stringify(env);
        if (serialized.length > 64 * 1024) throw new Error('envelope too large (max 64KB)');
        data = await post('/verify/v1/signed-receipt', { envelope: env });
        break;
      }
      case 'get_new_spl_tokens': {
        if (args.since !== undefined) {
          if (typeof args.since !== 'string' || Number.isNaN(Date.parse(args.since))) {
            throw new Error('since must be an ISO8601 timestamp string');
          }
        }
        if (args.limit !== undefined) {
          const lim = Number(args.limit);
          if (!Number.isInteger(lim) || lim < 1 || lim > 500) {
            throw new Error('limit must be an integer between 1 and 500');
          }
        }
        const params = new URLSearchParams();
        if (args.since) params.set('since', args.since);
        if (args.limit !== undefined) params.set('limit', String(Math.trunc(Number(args.limit))));
        const qs = params.size ? `?${params.toString()}` : '';
        data = await get(`/feed/v1/new-spl-tokens${qs}`);
        break;
      }
      case 'quick_scan': {
        const addr = validateAddress(args.address);
        data = await post('/scan/iris', { address: addr });
        break;
      }
      case 'check_program_verification': {
        const programId = validateAddress(args.program_id, 'program_id');
        data = await get(`/monitor/v1/program-verification/${encodeURIComponent(programId)}`);
        break;
      }
      default: {
        const safeName = String(name).replace(/[^\w-]/g, '_').slice(0, 64);
        throw new Error(`Unknown tool: ${safeName}`);
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] tool=${name} error=${msg}`);
    return {
      content: [{ type: 'text', text: `Error: ${msg || 'unknown error'}` }],
      isError: true,
    };
  } finally {
    _inflight--;
  }
}

module.exports = { TOOLS, handleTool };
