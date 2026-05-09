'use strict';

// Bitquery V2 streaming API client.
// Standard plan endpoint: streaming.bitquery.io/graphql
// EAP plan:              streaming.bitquery.io/eap  (set BITQUERY_ENDPOINT)

const BITQUERY_ENDPOINT = process.env.BITQUERY_ENDPOINT || 'https://streaming.bitquery.io/graphql';

// ── Liquidity removal query (hybrid SolRPDS pipeline, V4) ────────────────────
//
// Filters: Quote.ChangeAmount < 0 (quote side leaving = removal signal).
// No TVL filter — full removal coverage across all pool sizes.
// Bitquery server-side optimization keeps cost at ~5 pts/query regardless.
// Ordered descending so cursor advances to most recent event.

const QUERY_LIQUIDITY_REMOVALS = `
  query GetLiquidityRemovals($since: DateTime!) {
    Solana {
      DEXPools(
        limit: { count: 1000 }
        orderBy: { descending: Block_Time }
        where: {
          Block: { Time: { since: $since } }
          Pool: { Quote: { ChangeAmount: { lt: "0" } } }
        }
      ) {
        Block { Time }
        Pool {
          Market {
            MarketAddress
            BaseCurrency { MintAddress Symbol }
            QuoteCurrency { MintAddress Symbol }
          }
          Base { ChangeAmount PostAmount PostAmountInUSD }
          Quote { ChangeAmount PostAmount PostAmountInUSD }
          Dex { ProtocolName ProtocolFamily }
        }
        Transaction { Signature }
      }
    }
  }
`;

async function fetchLiquidityRemovals(sinceIso) {
  const apiKey = process.env.BITQUERY_API_KEY;
  if (!apiKey) throw new Error('BITQUERY_API_KEY not set');

  const response = await fetch(BITQUERY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query: QUERY_LIQUIDITY_REMOVALS, variables: { since: sinceIso } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bitquery API ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  if (data.errors) throw new Error(`Bitquery GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
  return data.data?.Solana?.DEXPools || [];
}

// ── Bulk time-range query (reference / paid-plan use) ────────────────────────

const QUERY_DEX_POOLS = `
  query GetRecentLiquidityChanges($since: DateTime!, $limit: Int!) {
    Solana {
      DEXPools(
        limit: { count: $limit }
        orderBy: { ascending: Block_Time }
        where: { Block: { Time: { since: $since } } }
      ) {
        Block { Time }
        Pool {
          Base { ChangeAmount PostAmount PostAmountInUSD }
          Quote { ChangeAmount PostAmount PostAmountInUSD }
          Dex { ProtocolFamily ProtocolName }
          Market {
            MarketAddress
            BaseCurrency { MintAddress Symbol }
            QuoteCurrency { MintAddress Symbol }
          }
        }
        Transaction { Signature }
      }
    }
  }
`;

async function fetchLiquidityChanges(sinceIso, limit = 500) {
  const apiKey = process.env.BITQUERY_API_KEY;
  if (!apiKey) throw new Error('BITQUERY_API_KEY not set');

  const response = await fetch(BITQUERY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query: QUERY_DEX_POOLS, variables: { since: sinceIso, limit } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bitquery API ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  if (data.errors) throw new Error(`Bitquery GraphQL: ${JSON.stringify(data.errors).slice(0, 500)}`);
  return data.data?.Solana?.DEXPools || [];
}

module.exports = { fetchLiquidityRemovals, fetchLiquidityChanges };
