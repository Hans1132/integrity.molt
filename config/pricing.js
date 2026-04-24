'use strict';
/**
 * config/pricing.js — Single source of truth for scan pricing.
 *
 * SOL:  1 SOL  = 1_000_000_000 lamports
 * USDC: 1 USDC = 1_000_000 micro-units (6 decimals)
 *
 * NEVER mix SOL lamports and USDC micro-units in one variable.
 */

// USDC prices in micro-units (6 decimals). 1 USDC = 1_000_000.
const PRICING = {
  quick:               500_000,   // 0.50 USDC
  deep:              5_000_000,   // 5.00 USDC
  token:               750_000,   // 0.75 USDC
  wallet:              750_000,   // 0.75 USDC
  pool:                750_000,   // 0.75 USDC
  'evm-token':         750_000,   // 0.75 USDC
  'evm-scan':          750_000,   // 0.75 USDC
  contract:          5_000_000,   // 5.00 USDC
  'token-audit':       750_000,   // 0.75 USDC
  'agent-token':       150_000,   // 0.15 USDC
  delta:             1_000_000,   // 1.00 USDC
  adversarial:       4_000_000,   //  4.00 USDC (under AutoPilot 5 USDC per-tx limit)
  'governance-change': 150_000,   //  0.15 USDC — A2A oracle governance detection
};

// ── Pricing tiers — A2A oracle discovery layers ───────────────────────────────
const PRICING_TIERS = {
  discovery: {
    price: 0,
    description: 'Free discovery layer — rate-limited, no payment required',
    endpoints: ['/scan/v1/:address', '/feed/v1/new-spl-tokens', '/.well-known/*'],
  },
  attestation: {
    min: 0.10,
    max: 0.25,
    unit: 'USDC',
    description: 'Signed attestations via x402 micropayment',
    endpoints: ['/monitor/v1/governance-change'],
  },
  forensic: {
    description: 'Deep analysis — existing scan prices apply',
    endpoints: ['/api/v1/scan/deep', '/api/v1/adversarial/simulate', '/api/v1/scan/token-audit'],
  },
};

// Human-readable USDC prices — derived from PRICING to prevent manual sync drift.
// Each value is `(micro_units / 1_000_000).toFixed(2) + ' USDC'`.
const PRICING_DISPLAY = Object.fromEntries(
  Object.entries(PRICING).map(([k, micro]) => [k, `${(micro / 1_000_000).toFixed(2)} USDC`])
);

module.exports = { PRICING, PRICING_DISPLAY, PRICING_TIERS };
