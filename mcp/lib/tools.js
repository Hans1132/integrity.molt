'use strict';

const { get, post } = require('./client');

const TOOLS = [
  {
    name: 'scan_solana_address',
    description:
      'IRIS security scan of a Solana token mint or wallet address. ' +
      'Returns iris_score (0–100, higher = riskier), risk_level (low/medium/high/critical), ' +
      'risk_factors array, and an Ed25519-signed receipt for tamper-proof audit. Free, rate-limited.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Solana base58 address — token mint or wallet public key',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'verify_signed_receipt',
    description:
      'Verify an Ed25519-signed oracle receipt from integrity.molt. ' +
      'Confirms the receipt was issued by this oracle and has not been tampered with. Free.',
    inputSchema: {
      type: 'object',
      properties: {
        envelope: {
          type: 'object',
          description: 'The signed receipt object returned by scan_solana_address',
        },
      },
      required: ['envelope'],
    },
  },
  {
    name: 'get_new_spl_tokens',
    description:
      'Feed of new SPL token mint creation events on Solana (last 24h by default). ' +
      'Useful for monitoring new token launches before they appear on DEXes. Free.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO8601 timestamp — return tokens created after this time',
        },
      },
    },
  },
  {
    name: 'quick_scan',
    description:
      'Lightweight IRIS risk scan of a Solana address. ' +
      'Faster than scan_solana_address — no signed receipt. Use for quick risk checks. Free, rate-limited.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Solana base58 address',
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
      'Returns is_verified, repo_url, and last_verified_at. Free, cached 1h.',
    inputSchema: {
      type: 'object',
      properties: {
        program_id: {
          type: 'string',
          description: 'Solana program address',
        },
      },
      required: ['program_id'],
    },
  },
];

async function handleTool(name, args) {
  try {
    let data;
    switch (name) {
      case 'scan_solana_address': {
        const addr = (args.address || '').trim();
        if (!addr) throw new Error('address is required');
        data = await get(`/scan/v1/${encodeURIComponent(addr)}`);
        break;
      }
      case 'verify_signed_receipt': {
        if (!args.envelope || typeof args.envelope !== 'object') {
          throw new Error('envelope must be an object');
        }
        data = await post('/verify/v1/signed-receipt', { envelope: args.envelope });
        break;
      }
      case 'get_new_spl_tokens': {
        const qs = args.since ? `?since=${encodeURIComponent(args.since)}` : '';
        data = await get(`/feed/v1/new-spl-tokens${qs}`);
        break;
      }
      case 'quick_scan': {
        const addr = (args.address || '').trim();
        if (!addr) throw new Error('address is required');
        data = await post('/scan/iris', { address: addr });
        break;
      }
      case 'check_program_verification': {
        const programId = (args.program_id || '').trim();
        if (!programId) throw new Error('program_id is required');
        data = await get(`/monitor/v1/program-verification/${encodeURIComponent(programId)}`);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

module.exports = { TOOLS, handleTool };
