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
  wallet:              500_000,   // 0.50 USDC
  pool:                500_000,   // 0.50 USDC
  'evm-token':         750_000,   // 0.75 USDC
  'evm-scan':          750_000,   // 0.75 USDC
  contract:          5_000_000,   // 5.00 USDC
  'token-audit':       500_000,   // 0.50 USDC
  delta:             1_000_000,   // 1.00 USDC
  adversarial:      10_000_000,   // 10.00 USDC
};

// Human-readable USDC prices (for /info and documentation).
const PRICING_DISPLAY = {
  quick:           '0.50 USDC',
  deep:            '5.00 USDC',
  token:           '0.75 USDC',
  wallet:          '0.50 USDC',
  pool:            '0.50 USDC',
  'evm-token':     '0.75 USDC',
  'evm-scan':      '0.75 USDC',
  contract:        '5.00 USDC',
  'token-audit':   '0.50 USDC',
  delta:           '1.00 USDC',
  adversarial:    '10.00 USDC',
};

module.exports = { PRICING, PRICING_DISPLAY };
