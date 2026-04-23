'use strict';
const { PublicKey } = require('@solana/web3.js');

function isEvmAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isSolanaAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (isEvmAddress(addr)) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return false;
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

function detectChain(addr) {
  if (isEvmAddress(addr)) return 'evm';
  if (isSolanaAddress(addr)) return 'solana';
  return 'unknown';
}

module.exports = { isEvmAddress, isSolanaAddress, detectChain };
