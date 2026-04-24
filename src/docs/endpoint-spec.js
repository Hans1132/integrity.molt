'use strict';
/**
 * src/docs/endpoint-spec.js — Canonical list of all paid API endpoints.
 *
 * This is the single authoritative record that ties together:
 *   - HTTP method + path (as registered in server.js)
 *   - pricing key (must exist in config/pricing.js PRICING map)
 *   - OpenAPI path key (can differ from route path for path params)
 *   - Human metadata for generated docs
 *
 * The drift validator (scripts/validate-openapi-coverage.js) enforces that
 * every entry here has a matching path in the generated OpenAPI spec.
 *
 * Rules:
 *   - pricingKey MUST match a key in PRICING from config/pricing.js
 *   - path is the Express route string (used as OpenAPI path key, {param} notation)
 *   - apiVersion is the path prefix (omitted from the OpenAPI `paths` key here,
 *     already included in `path`)
 */

const ENDPOINT_SPEC = [
  // ── Solana scans (no version prefix — served directly at root) ────────────────
  {
    method:     'POST',
    path:       '/scan/quick',
    pricingKey: 'quick',
    summary:    'Quick on-chain security scan',
    description: 'Scans any Solana address for basic risk assessment — account info, balance, owner program, Ed25519 signed report.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana address to scan' }
      }
    },
    responseDescription: 'Scan report with Ed25519 signed payload',
    tags: ['solana', 'security']
  },
  {
    method:     'POST',
    path:       '/scan/deep',
    pricingKey: 'deep',
    summary:    'Comprehensive security audit',
    description: 'Full security review with multi-agent swarm analysis — scanner, analyst, and reputation agents.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana address or program ID' }
      }
    },
    responseDescription: 'Deep audit report',
    tags: ['solana', 'security', 'audit']
  },
  {
    method:     'POST',
    path:       '/scan/token',
    pricingKey: 'token',
    summary:    'Token launch audit',
    description: 'Analyzes token mint — mint authority, freeze authority, top holder distribution, supply analysis, rug risk rating.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Token mint address' }
      }
    },
    responseDescription: 'Token audit report',
    tags: ['solana', 'token', 'security']
  },
  {
    method:     'POST',
    path:       '/scan/wallet',
    pricingKey: 'wallet',
    summary:    'Wallet profiling',
    description: 'Wallet age estimate, activity level, DeFi exposure, token holdings, risk classification.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Wallet address' }
      }
    },
    responseDescription: 'Wallet profile report',
    tags: ['solana', 'wallet', 'security']
  },
  {
    method:     'POST',
    path:       '/scan/pool',
    pricingKey: 'pool',
    summary:    'DeFi pool safety scan',
    description: 'Liquidity depth, LP token distribution, Raydium/Orca/Meteora analysis, withdrawal risk.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Pool address' }
      }
    },
    responseDescription: 'Pool safety report',
    tags: ['solana', 'defi', 'security']
  },
  {
    method:     'POST',
    path:       '/scan/evm-token',
    pricingKey: 'evm-token',
    summary:    'EVM token risk scan',
    description: 'Scans an EVM token contract on Base, Ethereum, or Arbitrum. Performs honeypot detection, source code analysis, ownership check, and contract age. Returns risk score 0-100 with Ed25519 signed report.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'EVM contract address (0x…)' },
        chain: {
          type: 'string',
          enum: ['base', 'ethereum', 'arbitrum'],
          default: 'base',
          description: 'Target EVM chain'
        }
      }
    },
    responseDescription: 'EVM token scan report',
    tags: ['evm', 'token', 'security']
  },
  {
    method:     'GET',
    path:       '/scan/evm/{address}',
    pricingKey: 'evm-scan',
    summary:    'EVM address scan (GET convenience endpoint)',
    description: 'GET variant of EVM scan. Chain may be passed as query parameter ?chain=base|ethereum|arbitrum. Returns the same risk report as POST /scan/evm-token.',
    requestSchema: null,   // path param, no body
    responseDescription: 'EVM scan report',
    tags: ['evm', 'security'],
    pathParams: [
      { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'EVM contract address (0x…)' }
    ],
    queryParams: [
      { name: 'chain', in: 'query', required: false, schema: { type: 'string', enum: ['base', 'ethereum', 'arbitrum'], default: 'base' }, description: 'Target EVM chain' }
    ]
  },
  {
    method:     'POST',
    path:       '/scan/contract',
    pricingKey: 'contract',
    summary:    'Solana smart contract audit',
    description: 'Deep static + LLM analysis of a Solana program — authority checks, upgrade risk, known vulnerability patterns. Returns signed audit report.',
    requestSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana program address' }
      }
    },
    responseDescription: 'Contract audit report',
    tags: ['solana', 'program', 'security', 'audit']
  },

  // ── v1 prefixed endpoints ─────────────────────────────────────────────────────
  {
    method:     'POST',
    path:       '/api/v1/scan/token-audit',
    pricingKey: 'token-audit',
    summary:    'Token security audit (enhanced)',
    description: 'Enhanced SPL token audit with LLM-verified findings — mint authority, freeze authority, holder concentration, rug risk analysis.',
    requestSchema: {
      type: 'object',
      required: ['token_mint'],
      properties: {
        token_mint:    { type: 'string', description: 'Token mint address (base58)' },
        token_name:    { type: 'string', description: 'Optional token name for report labeling' },
        callback_url:  { type: 'string', description: 'Optional webhook URL for async delivery' }
      }
    },
    responseDescription: 'Token security audit report',
    tags: ['solana', 'token', 'security']
  },
  {
    method:     'POST',
    path:       '/api/v1/scan/agent-token',
    pricingKey: 'agent-token',
    summary:    'Agent Token security scan',
    description: 'Scans a Metaplex Core Agent Token — Core NFT program ownership, treasury PDA, update authority risk (single key vs DAO/multisig), creator royalties, collection governance, and activity age.',
    requestSchema: {
      type: 'object',
      required: ['mint'],
      properties: {
        mint: { type: 'string', description: 'Metaplex Core asset address (base58)' }
      }
    },
    responseDescription: 'Agent token scan report with Ed25519 signed payload',
    tags: ['solana', 'metaplex', 'agent-token', 'security']
  },
  {
    method:     'POST',
    path:       '/api/v1/adversarial/simulate',
    pricingKey: 'adversarial',
    summary:    'Adversarial simulation',
    description: 'Forks on-chain state and probes 7 attack playbooks — authority hijack, flash loan, reentrancy, oracle manipulation, and more. Returns signed risk report.',
    requestSchema: {
      type: 'object',
      required: ['program_id'],
      properties: {
        program_id:   { type: 'string', description: 'Solana program address to simulate against' },
        playbook_ids: { type: 'array', items: { type: 'string' }, description: 'Optional subset of playbook IDs to run' },
        skip_fork:    { type: 'boolean', description: 'Run without forking local validator (faster, less accurate)', default: false }
      }
    },
    responseDescription: 'Adversarial simulation report',
    tags: ['solana', 'program', 'security', 'simulation']
  },
  {
    method:     'GET',
    path:       '/api/v1/delta/{address}',
    pricingKey: 'delta',
    summary:    'Verified delta report',
    description: 'Cryptographically signed diff between current and baseline security scan. Detects authority changes, supply changes, risk escalations.',
    requestSchema: null,  // path param, no body
    responseDescription: 'Signed delta report',
    tags: ['solana', 'delta', 'monitoring'],
    pathParams: [
      { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'Solana address' }
    ],
    queryParams: [
      { name: 'type', in: 'query', required: false, schema: { type: 'string', default: 'token-audit' }, description: 'Scan type to diff (token-audit, quick, etc.)' }
    ]
  },

  // ── A2A Oracle MVP endpoints ──────────────────────────────────────────────────
  {
    method:      'POST',
    path:        '/verify/v1/signed-receipt',
    pricingKey:  null,   // free — no x402 payment required
    free:        true,
    summary:     'Server-side Ed25519 receipt verification',
    description: 'Verifies an Ed25519-signed oracle envelope. Accepts { envelope: { payload, signature, verify_key, ... } }. Always returns HTTP 200 with { valid: bool } for machine-parseable results.',
    requestSchema: {
      type: 'object',
      required: ['envelope'],
      properties: {
        envelope: {
          type: 'object',
          required: ['signature', 'verify_key'],
          properties: {
            payload:    { type: 'object', description: 'The signed payload object (required for verification)' },
            signature:  { type: 'string', description: 'Base64 Ed25519 signature (64 bytes)' },
            verify_key: { type: 'string', description: 'Base64 Ed25519 public key (32 bytes)' },
            key_id:     { type: 'string', description: 'Key fingerprint (first 16 chars of base64 verify_key)' },
            signed_at:  { type: 'string', format: 'date-time' },
            signer:     { type: 'string' },
            algorithm:  { type: 'string', enum: ['ed25519', 'Ed25519'] }
          }
        }
      }
    },
    responseDescription: '{ valid: bool, key_id, signed_at, issuer, reason }',
    tags: ['a2a', 'oracle', 'verification', 'free'],
  },
  {
    method:      'GET',
    path:        '/scan/v1/{address}',
    pricingKey:  null,
    free:        true,
    summary:     'Quick Solana address risk scan (A2A oracle)',
    description: 'Free IRIS risk scan for a Solana address. Returns Ed25519-signed envelope with iris_score, risk_level, and risk_factors. Rate-limited to 10 req/min/IP.',
    requestSchema: null,
    responseDescription: 'Signed IRIS risk report',
    tags: ['a2a', 'oracle', 'solana', 'free'],
    pathParams: [
      { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'Solana address (base58, 32-44 chars)' }
    ]
  },
  {
    method:      'POST',
    path:        '/monitor/v1/governance-change',
    pricingKey:  'governance-change',
    summary:     'Detect governance changes in a Solana program',
    description: 'Fetches recent transactions for a Solana program via Helius and runs authority_change / program_upgrade detection. Returns Ed25519-signed verdict with findings list. Price: 0.15 USDC via x402.',
    requestSchema: {
      type: 'object',
      required: ['program_id'],
      properties: {
        program_id:   { type: 'string', description: 'Solana program address (base58)' },
        window_slots: { type: 'integer', default: 50, minimum: 1, maximum: 200, description: 'Number of recent transactions to inspect' }
      }
    },
    responseDescription: 'Signed governance verdict with findings array',
    tags: ['a2a', 'oracle', 'solana', 'governance', 'monitoring'],
  },
  {
    method:      'GET',
    path:        '/feed/v1/new-spl-tokens',
    pricingKey:  null,
    free:        true,
    summary:     'Pull feed of new SPL token mints',
    description: 'Returns a signed list of new SPL token mint creation events from the Helius webhook event log. Filter by ?since=ISO8601 timestamp (default: last 24h).',
    requestSchema: null,
    responseDescription: 'Signed { mints, since, count }',
    tags: ['a2a', 'oracle', 'solana', 'spl', 'feed', 'free'],
    queryParams: [
      { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'ISO8601 timestamp — return events after this time (default: 24h ago)' }
    ]
  }
];

module.exports = { ENDPOINT_SPEC };
