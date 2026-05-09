'use strict';

// Transforms a Bitquery DEXPools event into typed liquidity events.
//
// Sign-correlation rule (methodology fidelity - SolRPDS paper §4.2):
//   swap:   opposite signs on Base/Quote (one side in, other out)
//   add:    both sides positive (both tokens deposited)
//   remove: both sides negative (both tokens withdrawn)
//
// This distinction is critical: without it, swaps inflate
// total_added/removed_liquidity and corrupt add_to_remove_ratio.

function transformPoolEventToLiquidityEvents(poolEvent) {
  const events = [];
  const blockTimeMs = new Date(poolEvent.Block.Time).getTime();
  const market = poolEvent.Pool.Market.MarketAddress;
  const baseMint = poolEvent.Pool.Market.BaseCurrency.MintAddress;
  const quoteMint = poolEvent.Pool.Market.QuoteCurrency.MintAddress;
  const signature = poolEvent.Transaction.Signature;

  const baseChange = parseFloat(poolEvent.Pool.Base.ChangeAmount) || 0;
  const quoteChange = parseFloat(poolEvent.Pool.Quote.ChangeAmount) || 0;

  if (baseChange === 0 && quoteChange === 0) return events;

  const isSwap = (baseChange > 0 && quoteChange < 0) || (baseChange < 0 && quoteChange > 0);
  const isAdd  = baseChange > 0 && quoteChange > 0;
  const isRemove = baseChange < 0 && quoteChange < 0;

  if (isSwap) {
    events.push({ eventType: 'SWAP', poolAddress: market, mint: baseMint,  amount: 0, timestamp: blockTimeMs, txHash: signature });
    events.push({ eventType: 'SWAP', poolAddress: market, mint: quoteMint, amount: 0, timestamp: blockTimeMs, txHash: signature });
  } else if (isAdd) {
    events.push({ eventType: 'ADD_LIQUIDITY', poolAddress: market, mint: baseMint,  amount: Math.abs(baseChange),  timestamp: blockTimeMs, txHash: signature });
    events.push({ eventType: 'ADD_LIQUIDITY', poolAddress: market, mint: quoteMint, amount: Math.abs(quoteChange), timestamp: blockTimeMs, txHash: signature });
  } else if (isRemove) {
    events.push({ eventType: 'REMOVE_LIQUIDITY', poolAddress: market, mint: baseMint,  amount: Math.abs(baseChange),  timestamp: blockTimeMs, txHash: signature });
    events.push({ eventType: 'REMOVE_LIQUIDITY', poolAddress: market, mint: quoteMint, amount: Math.abs(quoteChange), timestamp: blockTimeMs, txHash: signature });
  }
  // Mixed-sign single-sided events (e.g. one side zero, other non-zero): drop —
  // they indicate fee collection or rounding artifacts, not methodology-relevant events.

  return events;
}

module.exports = { transformPoolEventToLiquidityEvents };
