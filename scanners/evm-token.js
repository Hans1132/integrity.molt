'use strict';
// scanners/evm-token.js — EVM token risk scanner (Base / Ethereum / Arbitrum)
// Žádné npm závislosti — pouze Node built-ins + fetch (Node 18+)

const fs = require('fs');

// Load API keys
let ETHERSCAN_API_KEY = '';
try { ETHERSCAN_API_KEY = fs.readFileSync('/root/.secrets/etherscan_api_key', 'utf-8').trim(); } catch {}

let ALCHEMY_API_KEY = '';
try { ALCHEMY_API_KEY = fs.readFileSync('/root/.secrets/alchemy_api_key', 'utf-8').trim(); } catch {}
if (!ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY) ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

// Build Alchemy RPC URL for given chain subdomain (null if no key)
function alchemyUrl(subdomain) {
  return ALCHEMY_API_KEY ? `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null;
}

const CHAINS = {
  base: {
    rpc:      alchemyUrl('base-mainnet') || 'https://mainnet.base.org',
    alchRpc:  alchemyUrl('base-mainnet'),
    explorer: 'https://api.etherscan.io/v2/api',
    chainId:  8453
  },
  ethereum: {
    rpc:      alchemyUrl('eth-mainnet') || 'https://ethereum.publicnode.com',
    alchRpc:  alchemyUrl('eth-mainnet'),
    explorer: 'https://api.etherscan.io/v2/api',
    chainId:  1
  },
  arbitrum: {
    rpc:      alchemyUrl('arb-mainnet') || 'https://arb1.arbitrum.io/rpc',
    alchRpc:  alchemyUrl('arb-mainnet'),
    explorer: 'https://api.etherscan.io/v2/api',
    chainId:  42161
  }
};

// ── Severity weights for risk score ──────────────────────────────────────────
const WEIGHTS = { critical: 30, high: 20, medium: 10, low: 5, info: 0 };

// ── ABI 4-byte selectors ──────────────────────────────────────────────────────
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
  { hex: '40c10f19', label: 'mint(address,uint256) in bytecode',     severity: 'high',     category: 'supply' },
  { hex: '8456cb59', label: 'pause() selector in bytecode',          severity: 'high',     category: 'access-control' },
  { hex: '044df020', label: 'blacklist(address) in bytecode',        severity: 'critical', category: 'access-control' }
];

// ── Token impersonation keywords ──────────────────────────────────────────────
const IMPERSONATION_KEYWORDS = [
  'uniswap', 'pancake', 'sushi', 'weth', 'usdc', 'usdt', 'wbtc',
  'ethereum', 'bitcoin', 'binance', 'safemoon', 'shiba', 'pepe'
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000)
  });
  const json = await res.json();
  return json.result;
}

// ── Alchemy Enhanced API helpers ─────────────────────────────────────────────

// alchemy_getTokenMetadata — name, symbol, decimals, logo (1 call místo 4× eth_call)
async function alchemyGetTokenMetadata(alchRpc, contractAddress) {
  if (!alchRpc) return null;
  try {
    const result = await rpcCall(alchRpc, 'alchemy_getTokenMetadata', [contractAddress]);
    if (!result || (!result.name && !result.symbol)) return null;
    return result; // { name, symbol, decimals, logo }
  } catch { return null; }
}

// alchemy_getAssetTransfers — posledních N ERC-20 transferů pro detekci pump/dump
async function alchemyGetAssetTransfers(alchRpc, contractAddress, maxCount = 100) {
  if (!alchRpc) return null;
  try {
    const result = await rpcCall(alchRpc, 'alchemy_getAssetTransfers', [{
      contractAddresses: [contractAddress],
      category:          ['erc20'],
      withMetadata:      true,
      excludeZeroValue:  true,
      maxCount:          '0x' + maxCount.toString(16),
      order:             'desc'
    }]);
    return result; // { transfers: [...], pageKey }
  } catch { return null; }
}

// Analyzuje transfer vzory — vrací findings pro pump/dump, koncentraci
function analyzeTransfers(transfers, meta) {
  const findings = [];
  if (!transfers || !transfers.length) return findings;

  const now = Date.now();
  const oneDay = 86400000;
  const oneHour = 3600000;

  // Unikátní příjemci a odesílatelé
  const senders   = new Set(transfers.map(t => t.from).filter(Boolean));
  const receivers  = new Set(transfers.map(t => t.to).filter(Boolean));

  // Transfery za posledních 24h a 1h
  const last24h = transfers.filter(t => {
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : 0;
    return ts > now - oneDay;
  });
  const last1h = last24h.filter(t => {
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : 0;
    return ts > now - oneHour;
  });

  // Pump detekce: > 50 transferů za hodinu
  if (last1h.length >= 50) {
    findings.push({
      label:    `High transfer velocity: ${last1h.length} transfers in last hour`,
      severity: 'high',
      category: 'activity'
    });
  }

  // Koncentrace odesílatelů: 1-2 wallets = 80 %+ transferů
  if (transfers.length >= 10 && senders.size <= 2) {
    findings.push({
      label:    `Transfer concentration: only ${senders.size} unique sender(s) out of ${transfers.length} transfers`,
      severity: 'critical',
      category: 'concentration'
    });
  }

  // Dump signál: > 70 % transferů jsou výprodeje (heuristika: 1 sender → many receivers)
  if (transfers.length >= 20 && senders.size === 1 && receivers.size >= 10) {
    findings.push({
      label:    'Single-source distribution pattern (potential airdrop dump)',
      severity: 'high',
      category: 'distribution'
    });
  }

  return findings;
}

// Decode ABI-encoded string (dynamic) returned by eth_call
function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    // offset (32 bytes) + length (32 bytes) + data
    if (raw.length < 128) return null;
    const lenHex = raw.slice(64, 128);
    const len = parseInt(lenHex, 16);
    if (!len || len > 256) return null;
    const strHex = raw.slice(128, 128 + len * 2);
    return Buffer.from(strHex, 'hex').toString('utf-8').replace(/\0/g, '');
  } catch { return null; }
}

// Decode ABI-encoded uint256
function decodeUint256(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    return BigInt('0x' + raw);
  } catch { return null; }
}

// Decode ABI-encoded uint8
function decodeUint8(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    return parseInt(raw.slice(-2), 16);
  } catch { return null; }
}

// Decode ABI-encoded address (last 20 bytes of 32-byte slot)
function decodeAddress(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (raw.length < 40) return null;
    return '0x' + raw.slice(-40);
  } catch { return null; }
}

// Detect fee percentages in source code (returns max found)
function detectFees(source) {
  const hits = [];
  // Patterns: taxFee = 15, _tax = 10, fee = 5 (% or number)
  const patterns = [
    /(?:tax|fee|_fee|_tax|buyFee|sellFee|liquidityFee|marketingFee)\s*[=:]\s*(\d+)/gi,
    /(?:uint\d*)\s+(?:tax|fee|_fee|_tax)\s*=\s*(\d+)/gi
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(source)) !== null) {
      const val = parseInt(m[1], 10);
      if (val > 0 && val <= 100) hits.push(val);
    }
  }
  return hits.length ? Math.max(...hits) : 0;
}

// ── Source code risk patterns ─────────────────────────────────────────────────

const PATTERNS = [
  // CRITICAL
  { re: /\bselfdestruct\s*\(/i,              label: 'selfdestruct present',               severity: 'critical', category: 'contract-kill' },
  { re: /tradingEnabled\s*=\s*false|openTrading\s*\(/i, label: 'trading toggle (can disable trading)', severity: 'critical', category: 'trading-control' },
  // HIGH
  { re: /\bblacklist\b|\bblacklisted\b/i,   label: 'blacklist function',                 severity: 'high',     category: 'access-control' },
  { re: /\bwhitelist\b|\bwhitelisted\b/i,   label: 'whitelist function',                 severity: 'high',     category: 'access-control' },
  { re: /setBuyFee|setSellFee|setTax|updateFee|setFee/i, label: 'adjustable fee functions',  severity: 'high', category: 'fees' },
  { re: /function\s+mint\s*\(|_mint\s*\(/i, label: 'mint function present',              severity: 'high',     category: 'supply' },
  { re: /function\s+pause\s*\(|_pause\s*\(/i, label: 'pause function present',           severity: 'high',     category: 'access-control' },
  { re: /delegatecall\s*\(/i,               label: 'delegatecall (upgradeable proxy)',    severity: 'high',     category: 'proxy' },
  // HIGH: Ownable without renounceOwnership
  // (handled separately in analyzeSource)
  // MEDIUM
  { re: /maxTransaction|maxTxAmount|_maxTxAmount/i, label: 'maxTransaction limit',        severity: 'medium',   category: 'limits' },
  { re: /maxWallet|_maxWalletSize|maxWalletAmount/i, label: 'maxWallet limit',            severity: 'medium',   category: 'limits' },
  { re: /cooldown|lastTransaction|antiBot/i, label: 'cooldown / anti-bot mechanism',      severity: 'medium',   category: 'limits' },
  { re: /swapAndLiquify|swapBack|autoLiquidity/i, label: 'auto-swap liquidity function',  severity: 'medium',   category: 'tokenomics' }
];

function analyzeSource(source) {
  const findings = [];

  for (const p of PATTERNS) {
    if (p.re.test(source)) {
      findings.push({ label: p.label, severity: p.severity, category: p.category });
    }
  }

  // Ownable without renounceOwnership
  if (/Ownable/i.test(source) && !/renounceOwnership/i.test(source)) {
    findings.push({ label: 'Ownable without renounceOwnership (ownership cannot be renounced)', severity: 'high', category: 'ownership' });
  }

  // Fee values
  const maxFee = detectFees(source);
  if (maxFee > 10) {
    findings.push({ label: `Fee value > 10% detected (${maxFee}%)`, severity: 'critical', category: 'fees' });
  } else if (maxFee > 5) {
    findings.push({ label: `Fee value > 5% detected (${maxFee}%)`, severity: 'high', category: 'fees' });
  }

  return findings;
}

// ── Transfer honeypot simulation ──────────────────────────────────────────────

async function simulateTransfer(rpcUrl, contractAddress) {
  // Encode transfer(address(0xdead), 0)
  // selector: a9059cbb
  // address:  000000000000000000000000000000000000000000000000000000000000dead
  // amount:   0000000000000000000000000000000000000000000000000000000000000000
  const data = '0xa9059cbb' +
    '000000000000000000000000000000000000000000000000000000000000dead' +
    '0000000000000000000000000000000000000000000000000000000000000000';

  try {
    const result = await rpcCall(rpcUrl, 'eth_call', [
      { from: '0x0000000000000000000000000000000000000001', to: contractAddress, data },
      'latest'
    ]);
    // false return value = honeypot (transfer returns false instead of reverting)
    const FALSE_RETURN = '0x' + '0'.repeat(64);
    if (result === FALSE_RETURN) {
      return { honeypot: true, reason: 'transfer() returned false (honeypot pattern)' };
    }
    return { honeypot: false, rawResult: result };
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (/blacklist|not enabled|trading|transfer/i.test(msg)) {
      return { honeypot: true, reason: e.message };
    }
    return { honeypot: false, error: e.message };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

async function scanEVMToken(contractAddress, chain = 'base') {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}. Use base|ethereum|arbitrum`);

  const findings = [];
  const meta = {
    name: null, symbol: null, totalSupply: null, decimals: null,
    owner: null, verified: false, contractName: null,
    deployer: null, ageDays: null, isProxy: false
  };

  // ── (a) Check bytecode ────────────────────────────────────────────────────
  const code = await rpcCall(cfg.rpc, 'eth_getCode', [contractAddress, 'latest']);
  if (!code || code === '0x' || code === '0x0') {
    findings.push({ label: 'No bytecode at address (not a contract)', severity: 'critical', category: 'existence' });
    return { findings, meta, score: 100, recommendation: 'AVOID — address has no contract bytecode' };
  }

  // ── (b) Token metadata — Alchemy preferred, eth_call fallback ───────────────
  const [alchMeta, callResults] = await Promise.all([
    alchemyGetTokenMetadata(cfg.alchRpc, contractAddress),
    Promise.allSettled([
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.totalSupply }, 'latest']),
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.decimals    }, 'latest']),
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.owner       }, 'latest'])
    ])
  ]);

  if (alchMeta) {
    // Alchemy vrátí name/symbol/decimals rychle v jednom volání
    meta.name     = alchMeta.name    || null;
    meta.symbol   = alchMeta.symbol  || null;
    meta.decimals = alchMeta.decimals != null ? alchMeta.decimals : null;
    meta.logo     = alchMeta.logo    || null;
  } else {
    // Fallback: dekóduj z eth_call (name/symbol nejsou v callResults — přidej je)
    const [nameR, symR] = await Promise.allSettled([
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.name   }, 'latest']),
      rpcCall(cfg.rpc, 'eth_call', [{ to: contractAddress, data: SEL.symbol }, 'latest'])
    ]);
    meta.name   = nameR.status === 'fulfilled' ? decodeString(nameR.value)  : null;
    meta.symbol = symR.status  === 'fulfilled' ? decodeString(symR.value)   : null;
  }

  const supply   = callResults[0].status === 'fulfilled' ? decodeUint256(callResults[0].value) : null;
  if (meta.decimals == null)
    meta.decimals = callResults[1].status === 'fulfilled' ? decodeUint8(callResults[1].value)  : null;
  meta.owner     = callResults[2].status === 'fulfilled' ? decodeAddress(callResults[2].value) : null;

  if (supply !== null && meta.decimals !== null) {
    meta.totalSupply = (Number(supply) / Math.pow(10, meta.decimals)).toFixed(2);
    const supplyTokens = Number(supply) / Math.pow(10, meta.decimals);
    if (supply === 0n || supplyTokens < 1) {
      findings.push({ label: `Zero or negligible total supply (${meta.totalSupply} tokens)`, severity: 'high', category: 'supply' });
    }
  }

  // Zero address owner = ownership renounced → info
  if (meta.owner && meta.owner === '0x0000000000000000000000000000000000000000') {
    findings.push({ label: 'Ownership renounced (owner = 0x0)', severity: 'info', category: 'ownership' });
    meta.owner = 'renounced';
  } else if (!meta.owner) {
    // No owner() function — not necessarily bad
  }

  // ── (c) Fetch source from explorer ───────────────────────────────────────
  let sourceCode = null;
  try {
    const apiKey = ETHERSCAN_API_KEY ? `&apikey=${ETHERSCAN_API_KEY}` : '';
    const chainParam = cfg.chainId ? `&chainid=${cfg.chainId}` : '';
    const explorerUrl = `${cfg.explorer}?module=contract&action=getsourcecode&address=${contractAddress}${chainParam}${apiKey}`;
    const explorerRes = await fetch(explorerUrl, { signal: AbortSignal.timeout(12000) });
    const explorerJson = await explorerRes.json();
    const result = explorerJson?.result?.[0];
    if (result && result.ABI && result.ABI !== 'Contract source code not verified') {
      meta.verified = true;
      meta.contractName = result.ContractName || null;
      sourceCode = result.SourceCode || '';
      // Detect proxy
      if (/proxy|implementation|upgradeable/i.test(result.ContractName || '') ||
          /ERC1967|TransparentUpgradeable|UUPS/i.test(sourceCode)) {
        meta.isProxy = true;
        findings.push({ label: 'Upgradeable proxy detected', severity: 'high', category: 'proxy' });
      }
    } else {
      // Unverified source is CRITICAL — no transparency into contract behavior
      findings.push({ label: 'Source code not verified on explorer', severity: 'critical', category: 'transparency' });
    }
  } catch (e) {
    findings.push({ label: 'Explorer API unavailable — could not fetch source', severity: 'medium', category: 'transparency' });
  }

  // ── (d) Bytecode selector scan (works without source code) ───────────────
  {
    const bytecode = code.toLowerCase().slice(2); // strip 0x
    for (const sel of DANGEROUS_SELECTORS) {
      if (bytecode.includes(sel.hex)) {
        findings.push({ label: sel.label, severity: sel.severity, category: sel.category });
      }
    }
    // SELFDESTRUCT opcode (0xff)
    if (bytecode.includes('ff')) {
      findings.push({ label: 'SELFDESTRUCT opcode (0xff) in bytecode', severity: 'critical', category: 'contract-kill' });
    }
    // DELEGATECALL opcode (0xf4) in non-proxy contracts
    if (!meta.isProxy && bytecode.includes('f4')) {
      findings.push({ label: 'DELEGATECALL opcode (0xf4) in non-proxy bytecode', severity: 'high', category: 'proxy' });
    }
  }

  // ── (d2) Impersonation check ──────────────────────────────────────────────
  if (!meta.verified) {
    const nameSymbol = `${meta.name || ''} ${meta.symbol || ''}`.toLowerCase();
    const impersonates = IMPERSONATION_KEYWORDS.some(kw => nameSymbol.includes(kw));
    if (impersonates) {
      findings.push({
        label: `Impersonation: unverified token uses known brand name/symbol ("${meta.name || meta.symbol}")`,
        severity: 'critical',
        category: 'impersonation'
      });
    }
  }

  // ── (d3) Regex analysis of source ────────────────────────────────────────
  if (sourceCode) {
    const sourceFindings = analyzeSource(sourceCode);
    findings.push(...sourceFindings);
  }

  // ── (e) Contract creation — deployer + age ────────────────────────────────
  let createTxHash = null;
  try {
    const apiKey = ETHERSCAN_API_KEY ? `&apikey=${ETHERSCAN_API_KEY}` : '';
    const chainParam = cfg.chainId ? `&chainid=${cfg.chainId}` : '';
    const creationUrl = `${cfg.explorer}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}${chainParam}${apiKey}`;
    const creationRes = await fetch(creationUrl, { signal: AbortSignal.timeout(10000) });
    const creationJson = await creationRes.json();
    const creationResult = creationJson?.result?.[0];
    if (creationResult) {
      meta.deployer  = creationResult.contractCreator || null;
      createTxHash   = creationResult.txHash || null;
    }
  } catch {}

  // ── (f) Block timestamp → age in days ────────────────────────────────────
  if (createTxHash) {
    try {
      const tx = await rpcCall(cfg.rpc, 'eth_getTransactionByHash', [createTxHash]);
      if (tx?.blockNumber) {
        const block = await rpcCall(cfg.rpc, 'eth_getBlockByNumber', [tx.blockNumber, false]);
        if (block?.timestamp) {
          const deployTs = parseInt(block.timestamp, 16) * 1000;
          meta.ageDays = Math.floor((Date.now() - deployTs) / 86400000);
          if (meta.ageDays < 7) {
            findings.push({ label: `Very new contract (${meta.ageDays} days old)`, severity: 'high', category: 'age' });
          } else if (meta.ageDays < 30) {
            findings.push({ label: `New contract (${meta.ageDays} days old)`, severity: 'medium', category: 'age' });
          }
        }
      }
    } catch {}
  }

  // ── (g) Transfer simulation (honeypot check) ──────────────────────────────
  const sim = await simulateTransfer(cfg.rpc, contractAddress);
  if (sim.honeypot) {
    findings.push({ label: `Honeypot suspected — transfer reverted: ${sim.reason || 'unknown reason'}`, severity: 'critical', category: 'honeypot' });
  }

  // ── (h) Alchemy transfer pattern analysis ────────────────────────────────
  if (cfg.alchRpc) {
    const transferData = await alchemyGetAssetTransfers(cfg.alchRpc, contractAddress);
    if (transferData?.transfers?.length) {
      meta.transferCount = transferData.transfers.length;
      const transferFindings = analyzeTransfers(transferData.transfers, meta);
      findings.push(...transferFindings);
    }
  }

  // ── Risk score ────────────────────────────────────────────────────────────
  let score = findings.reduce((acc, f) => acc + (WEIGHTS[f.severity] || 0), 0);
  score = Math.min(100, score);

  // ── Recommendation ────────────────────────────────────────────────────────
  let recommendation;
  if (score >= 60)      recommendation = 'HIGH RISK — multiple critical/high findings, proceed with extreme caution';
  else if (score >= 30) recommendation = 'MEDIUM RISK — notable findings detected, review before investing';
  else if (score >= 10) recommendation = 'LOW RISK — minor issues present, standard due diligence advised';
  else                  recommendation = 'APPEARS SAFE — no significant risk patterns detected';

  return { findings, meta, score, recommendation };
}

module.exports = { scanEVMToken };
