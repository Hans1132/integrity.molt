'use strict';

// Bitquery V2 streaming API client for Solana DEXPools queries.
// Endpoint: streaming.bitquery.io/graphql (standard plan)
// EAP users: set BITQUERY_ENDPOINT=https://streaming.bitquery.io/eap

const BITQUERY_ENDPOINT = process.env.BITQUERY_ENDPOINT || 'https://streaming.bitquery.io/graphql';

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
  if (!apiKey) {
    throw new Error('BITQUERY_API_KEY environment variable not set');
  }

  const response = await fetch(BITQUERY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: QUERY_DEX_POOLS,
      variables: { since: sinceIso, limit },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bitquery API ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  if (data.errors) {
    throw new Error(`Bitquery GraphQL errors: ${JSON.stringify(data.errors).slice(0, 500)}`);
  }

  return data.data?.Solana?.DEXPools || [];
}

module.exports = { fetchLiquidityChanges };
