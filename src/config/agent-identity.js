'use strict';

const METAPLEX_ASSET    = '2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy';
const METAPLEX_URL      = 'https://www.metaplex.com/agents/2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy';
const METAPLEX_REGISTRY = 'metaplex_agent_registry';
const METAPLEX_STANDARD = 'EIP-8004';
const METAPLEX_OWNER    = 'HNhZiuihyLWbjH2Nm2WsEZiPGybjnRjQCptasW76Z7DY';

const METAPLEX_REGISTRY_BLOCK = {
  asset:    METAPLEX_ASSET,
  registry: METAPLEX_REGISTRY,
  standard: METAPLEX_STANDARD,
  url:      METAPLEX_URL,
  owner:    METAPLEX_OWNER,
  active:   true,
  x402_support: true,
};

module.exports = {
  METAPLEX_ASSET,
  METAPLEX_URL,
  METAPLEX_REGISTRY,
  METAPLEX_STANDARD,
  METAPLEX_OWNER,
  METAPLEX_REGISTRY_BLOCK,
};
