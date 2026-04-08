'use strict';
// scanners/evm-token.js — EVM token risk scanner
// Chains: ethereum, bsc, polygon, arbitrum, base
// Žádné npm závislosti — pouze Node built-ins + fetch (Node 18+)

const fs = require('fs');

// ── API key loaders ───────────────────────────────────────────────────────────
// Primárně z process.env, fallback ze souboru (jen pro Etherscan kvůli zpětné kompatibilitě)

function loadKeyFromFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch { return ''; }
}

function getExplorerKey(envVar) {
  if (process.env[envVar]) return process.env[envVar];
  // Fallback: starý způsob přes soubor (jen ETHERSCAN_API_KEY)
  if (envVar === 'ETHERSCAN_API_KEY') {
    const fromFile = loadKeyFromFile('/root/.secrets/etherscan_api_key');
    if (fromFile) return fromFile;
  }
  return '';
}

// ── Alchemy RPC ───────────────────────────────────────────────────────────────
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || loadKeyFromFile('/root/.secrets/alchemy_api_key');

function alchemyRpc(subdomain) {
  return ALCHEMY_KEY ? `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}` : null;
}

// ── Chain configs ─────────────────────────────────────────────────────────────

// Etherscan migroval na v2 API (v1 deprecated).
// Ethereum, Arbitrum, Base sdílí Etherscan infrastrukturu → ETHERSCAN_API_KEY + chainid param.
// BSC a Polygon mají vlastní nativní API (stále v1 kompatibilní).
const CHAINS = {
  ethereum: {
    rpc:          alchemyRpc('eth-mainnet') || 'https://ethereum.publicnode.com',
    alchRpc:      alchemyRpc('eth-mainnet'),
    explorerBase: 'https://api.etherscan.io/v2/api',
    explorerChainId: '1',
    apiKeyEnv:    'ETHERSCAN_API_KEY',
    label:        'Ethereum'
  },
  bsc: {
    rpc:          'https://bsc-dataseed.binance.org',
    alchRpc:      null,
    explorerBase: 'https://api.bscscan.com/api',
    explorerChainId: null,
    apiKeyEnv:    'BSCSCAN_API_KEY',
    label:        'BSC'
  },
  polygon: {
    rpc:          'https://polygon-rpc.com',
    alchRpc:      alchemyRpc('polygon-mainnet'),
    explorerBase: 'https://api.polygonscan.com/api',
    explorerChainId: null,
    apiKeyEnv:    'POLYGONSCAN_API_KEY',
    label:        'Polygon'
  },
  arbitrum: {
    rpc:          alchemyRpc('arb-mainnet') || 'https://arb1.arbitrum.io/rpc',
    alchRpc:      alchemyRpc('arb-mainnet'),
    explorerBase: 'https://api.etherscan.io/v2/api',
    explorerChainId: '42161',
    apiKeyEnv:    'ARBISCAN_API_KEY',
    label:        'Arbitrum'
  },
  base: {
    rpc:          alchemyRpc('base-mainnet') || 'https://mainnet.base.org',
    alchRpc:      alchemyRpc('base-mainnet'),
    explorerBase: 'https://api.etherscan.io/v2/api',
    explorerChainId: '8453',
    apiKeyEnv:    'BASESCAN_API_KEY',
    label:        'Base'
  }
};

const SUPPORTED_CHAINS = Object.keys(CHAINS);

// ── Rate limiter: max 5 req/s per explorer hostname ───────────────────────────
// Sdílený přes celý proces (singleton Map)
const _rlLastCall = new Map(); // hostname → timestamp (ms)
const RL_INTERVAL_MS = 210;   // 1000ms / 5 = 200ms, +10ms buffer

// ── Fetch s rate limiting a 429 retry ─────────────────────────────────────────
async function explorerFetch(url, timeoutMs = 12000) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { hostname = 'unknown'; }

  // Rate limit: počkej pokud jsme volali tento host před méně než RL_INTERVAL_MS
  const now = Date.now();
  const lastCall = _rlLastCall.get(hostname) || 0;
  const wait = RL_INTERVAL_MS - (now - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _rlLastCall.set(hostname, Date.now());

  // Retry smyčka pro 429
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) {
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`[evm-scanner] 429 from ${hostname}, retry in ${backoff}ms (attempt ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, backoff));
      _rlLastCall.set(hostname, Date.now() + backoff);
      continue;
    }
    return res;
  }
  throw new Error(`Rate limit exceeded on ${hostname} after 3 retries`);
}

// ── Severity weights ──────────────────────────────────────────────────────────
const WEIGHTS = { critical: 30, high: 20, medium: 10, low: 5, info: 0 };

// ── ABI 4-byte call selectors ─────────────────────────────────────────────────
const SEL = {
  name:        '0x06fdde03',
  symbol:      '0x95d89b41',
  totalSupply: '0x18160ddd',
  decimals:    '0x313ce567',
  owner:       '0x8da5cb5b'
};

// ── Dangerous bytecode 4-byte selectors ──────────────────────────────────────
const DANGEROUS_SELECTORS = [
  { hex: 'c9567bf9', label: 'openTrading() selector in bytecode',   severity: 'critical', category: 'trading-control' },
  { hex: '40c10f19', label: 'mint(address,uint256) in bytecode',    severity: 'high',     category: 'supply'          },
  { hex: '8456cb59', label: 'pause() selector in bytecode',         severity: 'high',     category: 'access-control' },
  { hex: '044df020', label: 'blacklist(address) in bytecode',       severity: 'critical', category: 'access-control' }
];

// ── Impersonation keywords ────────────────────────────────────────────────────
const IMPERSONATION_KEYWORDS = [
  'uniswap', 'pancake', 'sushi', 'weth', 'usdc', 'usdt', 'wbtc',
  'ethereum', 'bitcoin', 'binance', 'safemoon', 'shiba', 'pepe'
];

// ── Source code risk patterns ─────────────────────────────────────────────────
const PATTERNS = [
  { re: /\bselfdestruct\s*\(/i,                                      label: 'selfdestruct present',                             severity: 'critical', category: 'contract-kill'    },
  { re: /tradingEnabled\s*=\s*false|openTrading\s*\(/i,             label: 'trading toggle (can disable trading)',              severity: 'critical', category: 'trading-control'  },
  { re: /\bblacklist\b|\bblacklisted\b/i,                           label: 'blacklist function',                               severity: 'high',     category: 'access-control'   },
  { re: /\bwhitelist\b|\bwhitelisted\b/i,                           label: 'whitelist function',                               severity: 'high',     category: 'access-control'   },
  { re: /setBuyFee|setSellFee|setTax|updateFee|setFee/i,            label: 'adjustable fee functions',                         severity: 'high',     category: 'fees'             },
  { re: /function\s+mint\s*\(|_mint\s*\(/i,                        label: 'mint function present',                            severity: 'high',     category: 'supply'           },
  { re: /function\s+pause\s*\(|_pause\s*\(/i,                      label: 'pause function present',                           severity: 'high',     category: 'access-control'   },
  { re: /delegatecall\s*\(/i,                                       label: 'delegatecall (upgradeable proxy)',                  severity: 'high',     category: 'proxy'            },
  { re: /maxTransaction|maxTxAmount|_maxTxAmount/i,                 label: 'maxTransaction limit',                             severity: 'medium',   category: 'limits'           },
  { re: /maxWallet|_maxWalletSize|maxWalletAmount/i,                label: 'maxWallet limit',                                  severity: 'medium',   category: 'limits'           },
  { re: /cooldown|lastTransaction|antiBot/i,                        label: 'cooldown / anti-bot mechanism',                    severity: 'medium',   category: 'limits'           },
  { re: /swapAndLiquify|swapBack|autoLiquidity/i,                   label: 'auto-swap liquidity function',                     severity: 'medium',   category: 'tokenomics'       }
];

// ── ABI decoders ──────────────────────────────────────────────────────────────

function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (raw.length < 128) return null;
    const len = parseInt(raw.slice(64, 128), 16);
    if (!len || len > 256) return null;
    return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf-8').replace(/\0/g, '');
  } catch { return null; }
}

function decodeUint256(hex) {
  if (!hex || hex === '0x') return null;
  try { return BigInt('0x' + (hex.startsWith('0x') ? hex.slice(2) : hex)); } catch { return null; }
}

function decodeUint8(hex) {
  if (!hex || hex === '0x') return null;
  try { return parseInt((hex.startsWith('0x') ? hex.slice(2) : hex).slice(-2), 16); } catch { return null; }
}

function decodeAddress(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (raw.length < 40) return null;
    return '0x' + raw.slice(-40);
  } catch { return null; }
}

// ── Fee detector ──────────────────────────────────────────────────────────────
function detectFees(source) {
  const patterns = [
    /(?:tax|fee|_fee|_tax|buyFee|sellFee|liquidityFee|marketingFee)\s*[=:]\s*(\d+)/gi,
    /(?:uint\d*)\s+(?:tax|fee|_fee|_tax)\s*=\s*(\d+)/gi
  ];
  const hits = [];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(source)) !== null) {
      const val = parseInt(m[1], 10);
      if (val > 0 && val <= 100) hits.push(val);
    }
  }
  return hits.length ? Math.max(...hits) : 0;
}

// ── Source analysis ───────────────────────────────────────────────────────────
function analyzeSource(source) {
  const findings = [];
  for (const p of PATTERNS) {
    if (p.re.test(source)) findings.push({ label: p.label, severity: p.severity, category: p.category });
  }
  if (/Ownable/i.test(source) && !/renounceOwnership/i.test(source)) {
    findings.push({ label: 'Ownable without renounceOwnership (ownership cannot be renounced)', severity: 'high', category: 'ownership' });
  }
  const maxFee = detectFees(source);
  if (maxFee > 10)     findings.push({ label: `Fee value > 10% detected (${maxFee}%)`, severity: 'critical', category: 'fees' });
  else if (maxFee > 5) findings.push({ label: `Fee value > 5% detected (${maxFee}%)`,  severity: 'high',     category: 'fees' });
  return findings;
}

// ── Transfer pattern analysis (Alchemy) ──────────────────────────────────────
function analyzeTransfers(transfers) {
  const findings = [];
  if (!transfers || !transfers.length) return findings;
  const now     = Date.now();
  const oneDay  = 86400000;
  const oneHour = 3600000;
  const senders   = new Set(transfers.map(t => t.from).filter(Boolean));
  const receivers = new Set(transfers.map(t => t.to).filter(Boolean));
  const last1h = transfers.filter(t => {
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : 0;
    return ts > now - oneHour;
  });
  if (last1h.length >= 50)
    findings.push({ label: `High transfer velocity: ${last1h.length} transfers in last hour`, severity: 'high', category: 'activity' });
  if (transfers.length >= 10 && senders.size <= 2)
    findings.push({ label: `Transfer concentration: only ${senders.size} unique sender(s) out of ${transfers.length} transfers`, severity: 'critical', category: 'concentration' });
  if (transfers.length >= 20 && senders.size === 1 && receivers.size >= 10)
    findings.push({ label: 'Single-source distribution pattern (potential airdrop dump)', severity: 'high', category: 'distribution' });
  return findings;
}

// ── Honeypot simulation ───────────────────────────────────────────────────────
async function simulateTransfer(rpcUrl, contractAddress) {
  const data = '0xa9059cbb' +
    '000000000000000000000000000000000000000000000000000000000000dead' +
    '0000000000000000000000000000000000000000000000000000000000000000';
  try {
    const result = await rpcCall(rpcUrl, 'eth_call', [
      { from: '0x0000000000000000000000000000000000000001', to: contractAddress, data },
      'latest'
    ]);
    if (result === '0x' + '0'.repeat(64))
      return { honeypot: true, reason: 'transfer() returned false (honeypot pattern)' };
    return { honeypot: false };
  } catch (e) {
    if (/blacklist|not enabled|trading|transfer/i.test(e.message || ''))
      return { honeypot: true, reason: e.message };
    return { honeypot: false, error: e.message };
  }
}

// ── JSON-RPC call ─────────────────────────────────────────────────────────────
async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(10000)
  });
  const json = await res.json();
  return json.result;
}

// ── Alchemy helpers ───────────────────────────────────────────────────────────
async function alchemyGetTokenMetadata(alchRpc, address) {
  if (!alchRpc) return null;
  try {
    const result = await rpcCall(alchRpc, 'alchemy_getTokenMetadata', [address]);
    return (result && (result.name || result.symbol)) ? result : null;
  } catch { return null; }
}

async function alchemyGetAssetTransfers(alchRpc, address, maxCount = 100) {
  if (!alchRpc) return null;
  try {
    return await rpcCall(alchRpc, 'alchemy_getAssetTransfers', [{
      contractAddresses: [address],
      category:          ['erc20'],
      withMetadata:      true,
      excludeZeroValue:  true,
      maxCount:          '0x' + maxCount.toString(16),
      order:             'desc'
    }]);
  } catch { return null; }
}

// ── Explorer API calls ────────────────────────────────────────────────────────

function buildExplorerUrl(explorerBase, chainId, params) {
  const chainParam = chainId ? `&chainid=${chainId}` : '';
  const qstr = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${explorerBase}?${qstr}${chainParam}`;
}

async function explorerGetSourceCode(cfg, address, apiKey) {
  const params = { module: 'contract', action: 'getsourcecode', address };
  if (apiKey) params.apikey = apiKey;
  const url = buildExplorerUrl(cfg.explorerBase, cfg.explorerChainId, params);
  const res  = await explorerFetch(url);
  const json = await res.json();
  // Etherscan v2 vrací NOTOK s popisem pokud je chyba
  if (json?.status === '0' && typeof json?.result === 'string') {
    throw new Error(`Explorer error: ${json.result}`);
  }
  return json?.result?.[0] || null;
}

async function explorerGetContractCreation(cfg, address, apiKey) {
  const params = { module: 'contract', action: 'getcontractcreation', contractaddresses: address };
  if (apiKey) params.apikey = apiKey;
  const url = buildExplorerUrl(cfg.explorerBase, cfg.explorerChainId, params);
  const res  = await explorerFetch(url);
  const json = await res.json();
  if (json?.status === '0' && typeof json?.result === 'string') return null;
  return json?.result?.[0] || null;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

async function scanEVMToken(contractAddress, chain = 'ethereum') {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}. Supported: ${SUPPORTED_CHAINS.join('|')}`);

  const apiKey = getExplorerKey(cfg.apiKeyEnv);

  const findings = [];
  const meta = {
    name: null, symbol: null, totalSupply: null, decimals: null,
    owner: null, verified: false, contractName: null,
    deployer: null, ageDays: null, isProxy: false,
    chain, chainLabel: cfg.label
  };

  // ── (a) Bytecode check ────────────────────────────────────────────────────
  const code = await rpcCall(cfg.rpc, 'eth_getCode', [contractAddress, 'latest']);
  if (!code || code === '0x' || code === '0x0') {
    findings.push({ label: 'No bytecode at address (not a contract)', severity: 'critical', category: 'existence' });
    return { findings, meta, score: 100, recommendation: 'AVOID — address has no contract bytecode' };
  }

  // ── (b) Token metadata — Alchemy preferred, eth_call fallback ───────────
  const [alchMeta, onChainResults] = await Promise.all([
    alchemyGetTokenMetadata(cfg.alchRpc, contractAddress),
    Promise.allSettled([
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.totalSupply }, 'latest']),
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.decimals    }, 'latest']),
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.owner       }, 'latest'])
    ])
  ]);

  if (alchMeta) {
    meta.name     = alchMeta.name    || null;
    meta.symbol   = alchMeta.symbol  || null;
    meta.decimals = alchMeta.decimals != null ? alchMeta.decimals : null;
    meta.logo     = alchMeta.logo    || null;
  } else {
    const [nameR, symR] = await Promise.allSettled([
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.name   }, 'latest']),
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.symbol }, 'latest'])
    ]);
    meta.name   = nameR.status === 'fulfilled' ? decodeString(nameR.value)  : null;
    meta.symbol = symR.status  === 'fulfilled' ? decodeString(symR.value)   : null;
  }

  const supply = onChainResults[0].status === 'fulfilled' ? decodeUint256(onChainResults[0].value) : null;
  if (meta.decimals == null)
    meta.decimals = onChainResults[1].status === 'fulfilled' ? decodeUint8(onChainResults[1].value) : null;
  meta.owner = onChainResults[2].status === 'fulfilled' ? decodeAddress(onChainResults[2].value) : null;

  if (supply !== null && meta.decimals !== null) {
    const supplyTokens = Number(supply) / Math.pow(10, meta.decimals);
    meta.totalSupply = supplyTokens.toFixed(2);
    if (supply === 0n || supplyTokens < 1)
      findings.push({ label: `Zero or negligible total supply (${meta.totalSupply} tokens)`, severity: 'high', category: 'supply' });
  }

  if (meta.owner === '0x0000000000000000000000000000000000000000') {
    findings.push({ label: 'Ownership renounced (owner = 0x0)', severity: 'info', category: 'ownership' });
    meta.owner = 'renounced';
  }

  // ── (c) Source code from explorer ────────────────────────────────────────
  let sourceCode = null;
  if (!apiKey) {
    findings.push({
      label:    `Explorer API key not configured (${cfg.apiKeyEnv} not set) — source code analysis skipped`,
      severity: 'medium',
      category: 'transparency'
    });
  } else {
    try {
      const result = await explorerGetSourceCode(cfg, contractAddress, apiKey);
      if (result && result.ABI && result.ABI !== 'Contract source code not verified') {
        meta.verified     = true;
        meta.contractName = result.ContractName || null;
        sourceCode        = result.SourceCode   || '';
        if (/proxy|implementation|upgradeable/i.test(result.ContractName || '') ||
            /ERC1967|TransparentUpgradeable|UUPS/i.test(sourceCode)) {
          meta.isProxy = true;
          findings.push({ label: 'Upgradeable proxy detected', severity: 'high', category: 'proxy' });
        }
      } else {
        findings.push({ label: 'Source code not verified on explorer', severity: 'critical', category: 'transparency' });
      }
    } catch (e) {
      findings.push({ label: `Explorer API unavailable — source analysis skipped (${e.message.slice(0, 80)})`, severity: 'medium', category: 'transparency' });
    }
  }

  // ── (d) Bytecode selector scan ────────────────────────────────────────────
  {
    const bytecode = code.toLowerCase().slice(2);
    for (const sel of DANGEROUS_SELECTORS) {
      if (bytecode.includes(sel.hex))
        findings.push({ label: sel.label, severity: sel.severity, category: sel.category });
    }
    if (bytecode.includes('ff'))
      findings.push({ label: 'SELFDESTRUCT opcode (0xff) in bytecode', severity: 'critical', category: 'contract-kill' });
    if (!meta.isProxy && bytecode.includes('f4'))
      findings.push({ label: 'DELEGATECALL opcode (0xf4) in non-proxy bytecode', severity: 'high', category: 'proxy' });
  }

  // ── (e) Impersonation check ───────────────────────────────────────────────
  if (!meta.verified) {
    const nameSymbol = `${meta.name || ''} ${meta.symbol || ''}`.toLowerCase();
    if (IMPERSONATION_KEYWORDS.some(kw => nameSymbol.includes(kw)))
      findings.push({
        label:    `Impersonation: unverified token uses known brand name/symbol ("${meta.name || meta.symbol}")`,
        severity: 'critical',
        category: 'impersonation'
      });
  }

  // ── (f) Source code pattern analysis ────────────────────────────────────
  if (sourceCode) findings.push(...analyzeSource(sourceCode));

  // ── (g) Contract creation — deployer + age ────────────────────────────────
  let createTxHash = null;
  if (apiKey) {
    try {
      const creation = await explorerGetContractCreation(cfg, contractAddress, apiKey);
      if (creation) {
        meta.deployer  = creation.contractCreator || null;
        createTxHash   = creation.txHash          || null;
      }
    } catch { /* non-fatal */ }
  }

  // ── (h) Block timestamp → contract age ───────────────────────────────────
  if (createTxHash) {
    try {
      const tx = await rpcCall(cfg.rpc, 'eth_getTransactionByHash', [createTxHash]);
      if (tx?.blockNumber) {
        const block = await rpcCall(cfg.rpc, 'eth_getBlockByNumber', [tx.blockNumber, false]);
        if (block?.timestamp) {
          meta.ageDays = Math.floor((Date.now() - parseInt(block.timestamp, 16) * 1000) / 86400000);
          if (meta.ageDays < 7)
            findings.push({ label: `Very new contract (${meta.ageDays} days old)`, severity: 'high',   category: 'age' });
          else if (meta.ageDays < 30)
            findings.push({ label: `New contract (${meta.ageDays} days old)`,      severity: 'medium', category: 'age' });
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── (i) Honeypot simulation ───────────────────────────────────────────────
  const sim = await simulateTransfer(cfg.rpc, contractAddress);
  if (sim.honeypot)
    findings.push({ label: `Honeypot suspected — transfer reverted: ${sim.reason || 'unknown reason'}`, severity: 'critical', category: 'honeypot' });

  // ── (j) Alchemy transfer pattern analysis ────────────────────────────────
  if (cfg.alchRpc) {
    const transferData = await alchemyGetAssetTransfers(cfg.alchRpc, contractAddress);
    if (transferData?.transfers?.length) {
      meta.transferCount = transferData.transfers.length;
      findings.push(...analyzeTransfers(transferData.transfers));
    }
  }

  // ── Risk score + recommendation ───────────────────────────────────────────
  const score = Math.min(100, findings.reduce((acc, f) => acc + (WEIGHTS[f.severity] || 0), 0));

  let recommendation;
  if      (score >= 60) recommendation = 'HIGH RISK — multiple critical/high findings, proceed with extreme caution';
  else if (score >= 30) recommendation = 'MEDIUM RISK — notable findings detected, review before investing';
  else if (score >= 10) recommendation = 'LOW RISK — minor issues present, standard due diligence advised';
  else                  recommendation = 'APPEARS SAFE — no significant risk patterns detected';

  return { findings, meta, score, recommendation };
}

function hasExplorerKey(chain) {
  const cfg = CHAINS[chain];
  if (!cfg) return false;
  return !!getExplorerKey(cfg.apiKeyEnv);
}

module.exports = { scanEVMToken, SUPPORTED_CHAINS, getExplorerKey, hasExplorerKey };
