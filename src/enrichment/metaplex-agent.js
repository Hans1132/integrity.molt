'use strict';

const { createUmi }                    = require('@metaplex-foundation/umi-bundle-defaults');
const { mplAgentIdentity, safeFetchAgentIdentityV1, findAgentIdentityV1Pda } = require('@metaplex-foundation/mpl-agent-registry');
const { findAssetSignerPda }           = require('@metaplex-foundation/mpl-core');
const { publicKey }                    = require('@metaplex-foundation/umi');
const { validateUrl }                  = require('../lib/url-validation');
const db                               = require('../../db');

const RPC_URL              = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HELIUS_API_KEY       = process.env.HELIUS_API_KEY || '';
const CACHE_TTL_S          = 6 * 3600;          // 6 hodin
const FETCH_TIMEOUT_MS     = 5000;
const SERVICE_TIMEOUT_MS   = 3000;
const STALE_DAYS           = 90;

// ── TTL cleanup interval (6h) — smaže expirované záznamy z metaplex_agent_cache ──
const _cleanupInterval = setInterval(() => {
  try { db.cleanMetaplexAgentCache(); } catch {}
}, CACHE_TTL_S * 1000);
if (_cleanupInterval.unref) _cleanupInterval.unref();

// ── Umi singleton (lazy init, injectable pro testy) ───────────────────────────
let _umi = null;

function _getUmi() {
  if (!_umi) _umi = createUmi(RPC_URL).use(mplAgentIdentity());
  return _umi;
}

function _setUmiForTest(instance) { _umi = instance; }

// ── DB cache ──────────────────────────────────────────────────────────────────
function _getCached(address) {
  try { return db.getMetaplexAgentCache(address); } catch { return null; }
}

function _setCached(address, identity, registrationDoc, assetSignerWallet) {
  try {
    db.setMetaplexAgentCache({
      address,
      identity_json:         identity        ? JSON.stringify(identity)        : null,
      registration_doc_json: registrationDoc ? JSON.stringify(registrationDoc) : null,
      asset_signer_wallet:   assetSignerWallet ? JSON.stringify(assetSignerWallet) : null,
    });
  } catch {}
}

// ── detectAgentIdentity ───────────────────────────────────────────────────────
async function detectAgentIdentity(address) {
  const cached = _getCached(address);
  if (cached) {
    const identity = cached.identity_json ? JSON.parse(cached.identity_json) : null;
    return { isAgent: !!identity, identityPda: identity?.identityPda || null, agentIdentity: identity, cached: true };
  }

  try {
    const umi   = _getUmi();
    const asset = publicKey(address);
    const [identityPda] = findAgentIdentityV1Pda(umi, { asset });
    const identity      = await safeFetchAgentIdentityV1(umi, identityPda);

    if (!identity) {
      _setCached(address, null, null, null);
      return { isAgent: false, identityPda: identityPda.toString(), agentIdentity: null };
    }

    const agentIdentity = {
      uri:             identity.uri,
      active:          identity.active,
      supportedTrust:  identity.supportedTrust || [],
      lifecycleChecks: identity.lifecycleChecks || {},
      identityPda:     identityPda.toString(),
    };
    _setCached(address, agentIdentity, null, null);
    return { isAgent: true, identityPda: identityPda.toString(), agentIdentity };
  } catch (e) {
    return { isAgent: false, identityPda: null, agentIdentity: null, error: e.message };
  }
}

// ── fetchRegistrationDocument ─────────────────────────────────────────────────
function _mutabilityRisk(uri) {
  if (!uri) return 'high';
  if (/^ar:\/\/|arweave\.net\/|ar\.io\//.test(uri)) return 'low';
  if (/^ipfs:\/\/|ipfs\.io\/|cloudflare-ipfs\.com\//.test(uri)) return 'low';
  if (uri.startsWith('https://')) return 'medium';
  return 'high';
}

async function _fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  // Odmítni HTML error pages PŘED JSON.parse (Arweave/IPFS gateway vrací HTML při chybě)
  if (ct && ct.includes('text/html')) throw new Error(`HTML error page from gateway (content-type: ${ct})`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON response (content-type: ${ct})`); }
}

async function fetchRegistrationDocument(uri) {
  const mutabilityRisk = _mutabilityRisk(uri);
  if (!uri) return { doc: null, error: 'No URI', mutabilityRisk: 'high' };

  // Arweave: multi-gateway race (ar.io + arweave.net)
  const arMatch = uri.match(/^ar:\/\/([A-Za-z0-9_-]{43})|arweave\.net\/([A-Za-z0-9_-]{43})|ar\.io\/([A-Za-z0-9_-]{43})/);
  if (arMatch) {
    const txId = arMatch[1] || arMatch[2] || arMatch[3];
    const gateways = [`https://ar.io/${txId}`, `https://arweave.net/${txId}`];
    try {
      const doc = await Promise.any(gateways.map(gw => _fetchJson(gw, FETCH_TIMEOUT_MS)));
      return { doc, error: null, mutabilityRisk };
    } catch {
      return { doc: null, error: 'All Arweave gateways failed or timed out', mutabilityRisk };
    }
  }

  // IPFS: multi-gateway race
  const ipfsMatch = uri.match(/^ipfs:\/\/(.+)/);
  if (ipfsMatch) {
    const cid = ipfsMatch[1];
    const gateways = [`https://ipfs.io/ipfs/${cid}`, `https://cloudflare-ipfs.com/ipfs/${cid}`];
    try {
      const doc = await Promise.any(gateways.map(gw => _fetchJson(gw, FETCH_TIMEOUT_MS)));
      return { doc, error: null, mutabilityRisk };
    } catch {
      return { doc: null, error: 'All IPFS gateways failed or timed out', mutabilityRisk };
    }
  }

  // HTTPS: SSRF check + single fetch
  const ssrfErr = validateUrl(uri);
  if (ssrfErr) return { doc: null, error: `SSRF blocked: ${ssrfErr}`, mutabilityRisk: 'high' };

  try {
    const doc = await _fetchJson(uri, FETCH_TIMEOUT_MS);
    return { doc, error: null, mutabilityRisk };
  } catch (e) {
    return { doc: null, error: e.message, mutabilityRisk };
  }
}

// ── validateErc8004Document ───────────────────────────────────────────────────
const ERC8004_TYPE     = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
const REQUIRED_FIELDS  = ['type', 'name', 'description', 'image'];

function validateErc8004Document(doc) {
  const errors   = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['Document is null or not an object'], warnings };
  }

  for (const f of REQUIRED_FIELDS) {
    if (doc[f] == null || doc[f] === '') errors.push(`Missing required field: ${f}`);
  }

  if (doc.type && doc.type !== ERC8004_TYPE) {
    errors.push(`Invalid type identifier: expected "${ERC8004_TYPE}", got "${doc.type}"`);
  }

  if (doc.services !== undefined) {
    if (!Array.isArray(doc.services)) {
      errors.push('services must be an array');
    } else {
      doc.services.forEach((svc, i) => {
        if (!svc.id)              errors.push(`services[${i}] missing id`);
        if (!svc.type)            errors.push(`services[${i}] missing type`);
        if (!svc.serviceEndpoint) warnings.push(`services[${i}] missing serviceEndpoint`);
      });
    }
  }

  if (doc.registrations !== undefined) {
    if (!Array.isArray(doc.registrations)) {
      warnings.push('registrations should be an array');
    } else {
      const hasSolana = doc.registrations.some(r => r.agentRegistry === 'solana:101:metaplex');
      if (!hasSolana) warnings.push('No solana:101:metaplex registration entry found');
    }
  }

  if (doc.active === false) warnings.push('Agent declared as inactive in registration document');

  return { valid: errors.length === 0, errors, warnings };
}

// ── getAssetSignerWallet ──────────────────────────────────────────────────────
async function getAssetSignerWallet(assetAddress) {
  try {
    const umi   = _getUmi();
    const asset = publicKey(assetAddress);
    const [signerPda]  = findAssetSignerPda(umi, { asset });
    const walletAddress = signerPda.toString();

    let balance = null;
    try {
      const rpcRes = await fetch(RPC_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddress, { commitment: 'confirmed' }] }),
        signal:  AbortSignal.timeout(5000),
      });
      const rpcData = await rpcRes.json();
      balance = rpcData?.result?.value ?? null;
    } catch {}

    let recentActivity = [];
    if (HELIUS_API_KEY) {
      try {
        const url    = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
        const txRes  = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (txRes.ok) {
          const txs = await txRes.json();
          recentActivity = Array.isArray(txs)
            ? txs.slice(0, 100).map(tx => ({ signature: tx.signature, timestamp: tx.timestamp, type: tx.type, fee: tx.fee }))
            : [];
        }
      } catch {}
    }

    let scamHit = null;
    try { scamHit = db.lookupKnownScam(walletAddress) || null; } catch {}

    return {
      address:          walletAddress,
      balance_lamports: balance,
      recent_activity:  recentActivity,
      scam_hit:         scamHit,
      last_tx_at:       recentActivity.length > 0 ? recentActivity[0].timestamp : null,
    };
  } catch (e) {
    return { address: null, balance_lamports: null, recent_activity: [], scam_hit: null, error: e.message };
  }
}

// ── assessClaimVsReality ──────────────────────────────────────────────────────
function assessClaimVsReality(doc, walletRecentActivity, services) {
  const findings = [];
  let activeAligned    = true;
  let servicesReachable = null;
  let trustValidated   = true;

  if (!doc) {
    return { activeAligned: false, servicesReachable: null, trustValidated: false, findings: ['registration_doc_missing'] };
  }

  // active claim vs wallet tx recency
  if (doc.active === true && Array.isArray(walletRecentActivity)) {
    if (walletRecentActivity.length === 0) {
      findings.push('stale_active_claim');
      activeAligned = false;
    } else {
      const lastTs = walletRecentActivity[0]?.timestamp;
      if (lastTs != null) {
        const lastDate  = typeof lastTs === 'number' ? new Date(lastTs * 1000) : new Date(lastTs);
        const daysSince = (Date.now() - lastDate.getTime()) / 86_400_000;
        if (daysSince > STALE_DAYS) { findings.push('stale_active_claim'); activeAligned = false; }
      }
    }
  }

  // services declared but empty
  if (Array.isArray(services) && services.length === 0) {
    findings.push('no_services_declared');
    servicesReachable = null;
  }

  // TEE attestation claim without verifiable proof
  const trustClaims = doc.supportedTrust || [];
  if (trustClaims.includes('tee-attestation')) {
    findings.push('tee_attestation_unverified');
    trustValidated = false;
  }

  return { activeAligned, servicesReachable, trustValidated, findings };
}

// ── checkServiceEndpoint ──────────────────────────────────────────────────────
async function checkServiceEndpoint(endpoint) {
  const ssrfErr = validateUrl(endpoint);
  if (ssrfErr) return { reachable: false, statusCode: null, error: ssrfErr, ssrf_blocked: true };

  try {
    const res       = await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS) });
    const reachable = [200, 401, 403].includes(res.status);
    return { reachable, statusCode: res.status, error: null };
  } catch (e) {
    return { reachable: false, statusCode: null, error: e.message };
  }
}

// ── computeAgentScore / scoreToRisk ───────────────────────────────────────────
function computeAgentScore(validation, wallet, claimReality, mutabilityRisk) {
  let score = 0;

  // Registration doc missing entirely
  if (!validation) return 80;

  // Validation errors (max 45)
  score += Math.min(45, (validation.errors || []).length * 15);

  // URI mutability
  if (mutabilityRisk === 'high')   score += 25;
  else if (mutabilityRisk === 'medium') score += 10;

  // Asset Signer wallet scam DB hit — hard signal
  if (wallet?.scam_hit) score += 50;

  // Claim vs reality findings
  if (claimReality?.findings?.includes('stale_active_claim'))        score += 20;
  if (claimReality?.findings?.includes('tee_attestation_unverified')) score += 10;
  if (claimReality?.findings?.includes('no_services_declared'))       score += 5;
  if (claimReality?.findings?.includes('registration_doc_missing'))   score += 30;

  return Math.min(100, score);
}

function scoreToRisk(score) {
  if (score >= 70) return 'danger';
  if (score >= 40) return 'caution';
  return 'safe';
}

module.exports = {
  detectAgentIdentity,
  fetchRegistrationDocument,
  validateErc8004Document,
  getAssetSignerWallet,
  assessClaimVsReality,
  checkServiceEndpoint,
  computeAgentScore,
  scoreToRisk,
  _setUmiForTest,
};
