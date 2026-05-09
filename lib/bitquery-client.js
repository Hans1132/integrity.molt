'use strict';

// Bitquery V2 streaming API client.
// Standard plan endpoint: streaming.bitquery.io/graphql
// EAP plan:              streaming.bitquery.io/eap  (set BITQUERY_ENDPOINT)

const BITQUERY_ENDPOINT = process.env.BITQUERY_ENDPOINT || 'https://streaming.bitquery.io/graphql';

// ── Liquidity removal query (hybrid SolRPDS pipeline, V4) ────────────────────
//
// Filters: Base AND Quote both < 0 (sign-correlation rule, §4.2 — excludes SWAPs
// where only Quote < 0). Ordered ascending so cursor always points past processed
// events; saturation (==1000 results) is logged as a warning.

const QUERY_LIQUIDITY_REMOVALS = `
  query GetLiquidityRemovals($since: DateTime!) {
    Solana {
      DEXPools(
        limit: { count: 1000 }
        orderBy: { ascending: Block_Time }
        where: {
          Block: { Time: { since: $since } }
          Pool: {
            Base:  { ChangeAmount: { lt: "0" } }
            Quote: { ChangeAmount: { lt: "0" } }
          }
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
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bitquery API ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  if (data.errors) throw new Error(`Bitquery GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
  const results = data.data?.Solana?.DEXPools || [];
  if (results.length === 1000) {
    console.warn('[bitquery-client] fetchLiquidityRemovals saturated at 1000 results — some events may be missed; consider narrowing the since window');
  }
  return results;
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
    signal: AbortSignal.timeout(30000),
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
