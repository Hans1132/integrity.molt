'use strict';
/**
 * src/docs/generate-x402-discovery.js — Runtime x402 discovery document generator.
 *
 * Preserves the full structure of the existing x402-discovery.json (agent metadata,
 * skills, subscriptions, freeTier, etc.) while making the services[] array and
 * payTo fields fully dynamic — derived from endpoint-spec.js and config/pricing.js.
 *
 * Static sections that do NOT drift (agent identity, subscription tiers, reputation
 * config) are kept inline here. Only prices and service paths are generated.
 *
 * Usage:
 *   const { generateX402Discovery } = require('./src/docs/generate-x402-discovery');
 *   res.json(generateX402Discovery(USDC_ATA));
 */

const fs   = require('fs');
const { PRICING, PRICING_DISPLAY } = require('../../config/pricing');
const { ENDPOINT_SPEC }            = require('./endpoint-spec');

const VERIFY_KEY_PATH = process.env.VERIFY_KEY_PATH || '/root/.secrets/verify_key.bin';
function _getVerifyKeyBase64() {
  try { return fs.readFileSync(VERIFY_KEY_PATH).toString('base64'); } catch { return null; }
}

/**
 * Build the services[] array from endpoint-spec.
 * Each entry mirrors the shape used in the original x402-discovery.json services array.
 */
function buildServices(usdcAta) {
  return ENDPOINT_SPEC.map(spec => {
    const amount = PRICING[spec.pricingKey];
    const price  = (amount / 1_000_000).toFixed(2);

    // Convert OpenAPI {param} notation back to Express :param for the display path
    const displayPath = spec.path.replace(/\{(\w+)\}/g, ':$1');

    // Derive input schema description from requestSchema properties
    let inputSchema = {};
    if (spec.requestSchema && spec.requestSchema.properties) {
      for (const [k, v] of Object.entries(spec.requestSchema.properties)) {
        inputSchema[k] = v.description || v.type || 'string';
      }
    } else if (spec.pathParams) {
      for (const p of spec.pathParams) {
        inputSchema[p.name] = p.description || 'string (path param)';
      }
    }

    return {
      path:        `/api/v1${displayPath}`.replace('/api/v1/api/', '/api/'),  // avoid double prefix for already-prefixed paths
      method:      spec.method,
      description: spec.description,
      price,
      currency:    'USDC',
      micro_usdc:  amount,
      network:     'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      payTo:       usdcAta,
      input:       { type: 'application/json', schema: inputSchema },
      output:      { type: 'application/json' },
      tags:        spec.tags
    };
  });
}

/**
 * Generate the full x402 discovery document.
 *
 * @param {string} usdcAta  Runtime USDC Associated Token Account address.
 * @returns {object}        Plain JS object.
 */
function generateX402Discovery(usdcAta) {
  if (!usdcAta) {
    throw new Error('[generate-x402-discovery] usdcAta is required');
  }

  return {
    x402:         true,
    x402_version: '2.0',
    version:      '2.0',
    agent: {
      name:                'integrity.molt',
      agent_id:            '2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy',
      domain:              'intmolt.org',
      wallet:              process.env.SOLANA_WALLET_ADDRESS || '',
      authority:           'EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf',
      owner:               'HNhZiuihyLWbjH2Nm2WsEZiPGybjnRjQCptasW76Z7DY',
      description:         'AI-powered Solana security scanner and adversarial simulator',
      version:             '0.4.1',
      registration_status: 'registered',
      registry:            'solana:101:metaplex',
      irys_doc:            'https://gateway.irys.xyz/3p4zvdZg4ALoFbf55uO0VxS4cMVYcp8qnCdcOk7Ru4o',
      image:               'https://molt.mypinata.cloud/ipfs/QmbbWfSR3LK9ZiLzBvMLDR4hZKnC1xjTAUejGAHXifacPe',
      x402Support:         true,
      active:              true
    },
    endpoints: {
      a2a:              'https://intmolt.org/a2a',
      a2a_proxy:        'https://multiclaw.moltid.workers.dev/c/integrity/a2a',
      a2a_subscribe:    'https://intmolt.org/a2a/subscribe',
      agent_card:       'https://intmolt.org/.well-known/agent.json',
      x402_discovery:   'https://intmolt.org/.well-known/x402.json',
      web:              'https://intmolt.org'
    },
    skills: [
      {
        id:          'quick_scan',
        name:        'Quick Scan',
        description: 'Fast on-chain scan of a Solana address — account info, balance, basic risk assessment. Free tier, rate-limited.',
        pricing:     { type: 'free' },
        tags:        ['solana', 'security', 'free']
      },
      {
        id:          'token_audit',
        name:        'Token Audit',
        description: 'SPL token launch audit — mint authority, freeze authority, holder distribution, rug risk.',
        pricing:     { type: 'per_call', amount: PRICING.token / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'token', 'security']
      },
      {
        id:          'agent_token_scan',
        name:        'Agent Token Scan',
        description: 'Metaplex Agent Token security scan — Core NFT backing, treasury PDA, update authority risk, creator royalties, DAO governance, activity analysis.',
        pricing:     { type: 'per_call', amount: PRICING['agent-token'] / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'metaplex', 'agent-token', 'nft', 'security']
      },
      {
        id:          'wallet_profile',
        name:        'Wallet Profile',
        description: 'Wallet profiling — age, activity, DeFi exposure, risk classification.',
        pricing:     { type: 'per_call', amount: PRICING.wallet / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'wallet', 'security']
      },
      {
        id:          'deep_audit',
        name:        'Deep Audit',
        description: 'Comprehensive Solana program security audit — static analysis, LLM-verified findings, Ed25519-signed report.',
        pricing:     { type: 'per_call', amount: PRICING.deep / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'program', 'security', 'audit']
      },
      {
        id:          'adversarial_sim',
        name:        'Adversarial Simulation',
        description: 'Full adversarial simulation — forks on-chain state, probes 7 attack playbooks, returns signed risk report.',
        pricing:     { type: 'per_call', amount: PRICING.adversarial / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'program', 'security', 'simulation']
      },
      {
        id:          'contract_audit',
        name:        'Contract Audit',
        description: 'Deep static + LLM analysis of a Solana program — authority checks, upgrade risk, known vulnerability patterns.',
        pricing:     { type: 'per_call', amount: PRICING.contract / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'program', 'security', 'audit']
      },
      {
        id:          'delta_report',
        name:        'Delta Report',
        description: 'Cryptographically signed diff between current and baseline security scan. Detects authority changes, supply changes, risk escalations.',
        pricing:     { type: 'per_call', amount: PRICING.delta / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['solana', 'delta', 'monitoring']
      },
      {
        id:          'evm_scan',
        name:        'EVM Token Scan',
        description: 'EVM token risk scan for Base, Ethereum, Arbitrum. Honeypot detection, source code analysis, contract age, deployer info.',
        pricing:     { type: 'per_call', amount: PRICING['evm-token'] / 1_000_000, currency: 'USDC', protocol: 'x402' },
        tags:        ['evm', 'token', 'security']
      }
    ],
    provider: {
      name:        'integrity.molt',
      description: 'Real-time Solana risk monitoring for traders, bots, and protocol teams',
      url:         'https://intmolt.org',
      contact:     'https://t.me/intmolt_bot'
    },
    verifyKey:    _getVerifyKeyBase64(),
    reputation: {
      stats_endpoint: 'https://intmolt.org/api/v2/stats',
      description:    'Live scan count, success rate, and average response time. Updated after every scan.'
    },
    reportSigning: {
      algorithm:   'Ed25519',
      description: 'All scan reports are signed. Verify with any NaCl Ed25519 library using the verifyKey above.'
    },
    freeTier: {
      scans_per_day:           3,
      scan_types:              ['quick', 'token', 'wallet', 'pool', 'evm-token'],
      rate_limit:              'IP-based, resets at midnight UTC',
      quota_exceeded_status:   429,
      quota_exceeded_message:  'Daily free scan limit reached. Upgrade at intmolt.org/pricing'
    },
    subscriptions: [
      {
        tier:                  'pro_trader',
        price_usd_monthly:     15,
        price_micro_usdc:      15_000_000,
        watchlist_addresses:   20,
        features:              ['All alerts (critical+high+warning)', 'Telegram + email notifications', 'Weekly delta report', 'Unlimited scans', 'Signed reports'],
        subscribe_url:         'https://intmolt.org/subscribe/pro_trader'
      },
      {
        tier:                  'builder',
        price_usd_monthly:     49,
        price_micro_usdc:      49_000_000,
        watchlist_addresses:   100,
        features:              ['All alerts + webhook callback', 'Daily delta report', '1 adversarial sim/month', 'API access (100 req/min)', 'Signed JSON reports', 'Priority scan queue'],
        subscribe_url:         'https://intmolt.org/subscribe/builder'
      },
      {
        tier:                  'team',
        price_usd_monthly:     299,
        price_micro_usdc:      299_000_000,
        watchlist_addresses:   500,
        features:              ['All alerts + custom alert rules', 'Daily delta + on-demand', 'Unlimited adversarial sim', 'API access (1000 req/min)', 'SLA 99.5% uptime', 'Priority email support'],
        subscribe_url:         'https://intmolt.org/subscribe/team'
      }
    ],
    services: buildServices(usdcAta)
  };
}

module.exports = { generateX402Discovery };
