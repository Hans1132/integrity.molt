'use strict';
/**
 * src/middleware/payment.js — PDA-aware payment context enrichment
 *
 * This module extends the x402 payment middleware (defined in server.js) with
 * Metaplex Asset Signer PDA support for A2A (agent-to-agent) clients.
 *
 * How to wire into requirePayment (server.js):
 *
 *   const { enrichPaymentContextWithPDA, validatePDAOrReject } = require('./src/middleware/payment');
 *
 *   Inside requirePayment, after verifyPayment returns ok:true, extract the
 *   tx fee-payer and call:
 *
 *     const agentMint = req.headers['x-agent-mint'] || null;
 *     const pdaCheck  = validatePDAOrReject(txSender, agentMint, res, accepts);
 *     if (!pdaCheck.passed) return; // response already sent
 *
 * This keeps PDA logic isolated from the core USDC transfer validation.
 */

const { enrichPaymentContextWithPDA, isAssetSignerPDA } = require('../payment/verify-pda');

/**
 * Validate PDA sender when x-agent-mint header is present.
 *
 * Returns { passed: true } when:
 *   - No x-agent-mint header (non-A2A request — pass through unchanged).
 *   - x-agent-mint is present AND the tx sender matches the derived PDA.
 *
 * Returns { passed: false } and sends a 402 response when:
 *   - x-agent-mint is present BUT the tx sender does NOT match the derived PDA.
 *
 * @param {string}              txSender  - fee-payer address from on-chain tx
 * @param {string|null}         agentMint - value of x-agent-mint header
 * @param {import('express').Response} res
 * @param {Array}               accepts   - x402 accepts array (for error body)
 * @returns {{ passed: boolean }}
 */
function validatePDAOrReject(txSender, agentMint, res, accepts) {
  if (!agentMint) {
    // Not an A2A payment — skip PDA check.
    return { passed: true };
  }

  const ctx = enrichPaymentContextWithPDA(txSender, agentMint);

  if (!ctx.pdaValid) {
    res.status(402).json({
      x402Version: 1,
      error: 'PDA mismatch',
      hint: 'x-agent-mint header does not match tx sender PDA',
      detail: `Expected Asset Signer PDA derived from mint ${agentMint}, got sender ${txSender}`,
      accepts,
    });
    return { passed: false };
  }

  return { passed: true };
}

module.exports = {
  enrichPaymentContextWithPDA,
  validatePDAOrReject,
};
