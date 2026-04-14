'use strict';
/**
 * verify-pda.js — Metaplex Asset Signer PDA detection and verification
 *
 * Asset Signer PDA is derived from: [b"asset_signer", agentMint]
 * under the Metaplex Core (mpl-core) program.
 *
 * OpenClaw AI agents and other A2A clients using Metaplex Core NFTs pay from
 * their Asset Signer PDA rather than a normal EOA wallet. This module lets the
 * payment middleware detect and validate that case.
 *
 * Source: https://developers.metaplex.com/core
 */

const { PublicKey } = require('@solana/web3.js');

// Metaplex Core (mpl-core) program ID — Asset Signer PDAs are derived under this program.
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

const PDA_SEED = Buffer.from('asset_signer');

/**
 * Derive the Asset Signer PDA address for a given agent mint.
 * Returns the base58 PDA string, or null if derivation fails (invalid mint).
 *
 * @param {string} agentMintAddress - base58 mint address of the agent NFT
 * @returns {string|null}
 */
function deriveAssetSignerPDA(agentMintAddress) {
  try {
    const mintPubkey = new PublicKey(agentMintAddress);
    const [pda] = PublicKey.findProgramAddressSync(
      [PDA_SEED, mintPubkey.toBuffer()],
      MPL_CORE_PROGRAM_ID
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

/**
 * Check whether a given sender address matches the Asset Signer PDA for a mint.
 *
 * When agentMintAddress is not supplied we cannot verify the derivation — the
 * function returns false so that the caller falls through to normal verification.
 * Full verification requires the mint to be provided (via x-agent-mint header).
 *
 * @param {string} senderAddress    - on-chain sender address from tx
 * @param {string|null} agentMintAddress - agent mint to derive PDA from
 * @returns {boolean}
 */
function isAssetSignerPDA(senderAddress, agentMintAddress = null) {
  if (!senderAddress) return false;
  if (!agentMintAddress) {
    // Without the mint we cannot derive the expected PDA — treat as non-PDA.
    return false;
  }
  const expectedPDA = deriveAssetSignerPDA(agentMintAddress);
  return expectedPDA !== null && expectedPDA === senderAddress;
}

/**
 * Enrich a payment context with PDA metadata.
 * Call this from requirePayment (or wrappers around it) once the tx sender is
 * known to log and gate A2A payments from Metaplex Asset Signer PDAs.
 *
 * Integration note for server.js owner:
 *   const { enrichPaymentContextWithPDA } = require('./src/middleware/payment');
 *   const pdaCtx = enrichPaymentContextWithPDA(txSender, req.headers['x-agent-mint']);
 *   if (pdaCtx.isPDA && !pdaCtx.pdaValid) {
 *     return res.status(402).json({ error: 'PDA mismatch', hint: '...' });
 *   }
 *
 * @param {string} txSender       - fee-payer / sender address extracted from tx
 * @param {string|null} agentMint - value of x-agent-mint request header (may be undefined)
 * @returns {{ isPDA: boolean, agentMint: string|null, pdaValid: boolean }}
 */
function enrichPaymentContextWithPDA(txSender, agentMint = null) {
  if (!agentMint) {
    return { isPDA: false, agentMint: null, pdaValid: false };
  }

  const pdaValid = isAssetSignerPDA(txSender, agentMint);

  // Always log when mint is supplied — helps audit A2A traffic.
  console.log(`[payment/pda] payment_source=pda sender=${txSender} mint=${agentMint} pdaValid=${pdaValid}`);

  return { isPDA: true, agentMint, pdaValid };
}

module.exports = {
  deriveAssetSignerPDA,
  isAssetSignerPDA,
  enrichPaymentContextWithPDA,
  MPL_CORE_PROGRAM_ID: MPL_CORE_PROGRAM_ID.toBase58(),
};
