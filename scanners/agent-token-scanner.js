'use strict';
// scanners/agent-token-scanner.js — Metaplex Agent Token Security Scanner
// Analyzes Metaplex Core assets: Core NFT backing, treasury PDA, update authority,
// creator fees, DAO/governance, activity, and mint security.
//
// Metaplex Core program: CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
// Asset Signer PDA seeds: ["asset_signer", asset_pubkey_bytes]
//
// Price: 0.15 USDC (150_000 micro-units)

const fs     = require('fs');
const crypto = require('crypto');
const { enrichScanResult, combineScores } = require('../src/enrichment');

const _bs58raw = require('bs58');
const bs58     = _bs58raw.default || _bs58raw;

// ── Config ────────────────────────────────────────────────────────────────────

const { SOLANA_RPC_URL: SOLANA_RPC } = require('../src/rpc');

// Helius DAS endpoint (for getAsset). Falls back to null if not configured.
const HELIUS_RPC = (() => {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
  let k = '';
  try { k = fs.readFileSync('/root/.secrets/helius_api_key', 'utf-8').trim(); } catch {}
  if (!k && process.env.HELIUS_API_KEY) k = process.env.HELIUS_API_KEY;
  return k ? `https://mainnet.helius-rpc.com/?api-key=${k}` : null;
})();

// ── Constants ─────────────────────────────────────────────────────────────────

const MPL_CORE_PROGRAM  = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TOKEN_PROG        = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROG   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Common DAO / multisig programs
const KNOWN_GOVERNANCE_PROGRAMS = new Set([
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPiCXLf', // SPL Governance
  'GovaE4iu227srtG2s3tZkT4zgFpkNFZMqEkPDs85DkVs', // Governance v3
  '5oazHZAEBaMVnTFGNnUhEMxjp8gDkm5UtPKM3Bni6JgD', // Squads multisig v3
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',   // Squads v4
]);

// ── Severity weights ──────────────────────────────────────────────────────────

const WEIGHTS = { critical: 35, high: 20, medium: 10, low: 5, info: 0 };

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function rpc(endpoint, method, params) {
  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function rpcMain(method, params) {
  return rpc(SOLANA_RPC, method, params);
}

async function dasGetAsset(assetId) {
  if (!HELIUS_RPC) return null;
  try {
    const res = await fetch(HELIUS_RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: assetId } }),
      signal:  AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.result || null;
  } catch {
    return null;
  }
}

async function getRecentTransactions(address, limit = 10) {
  try {
    const result = await rpcMain('getSignaturesForAddress', [
      address,
      { limit, commitment: 'confirmed' }
    ]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

// ── Base58 / PDA helpers ──────────────────────────────────────────────────────

function b58decode(addr) {
  return Buffer.from(bs58.decode(addr));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

// Derive Asset Signer PDA for Metaplex Core
// Seeds: ["asset_signer", asset_pubkey_bytes]
// Program: CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
function deriveAssetSignerPda(assetAddress) {
  try {
    const programId = b58decode(MPL_CORE_PROGRAM);
    const assetKey  = b58decode(assetAddress);
    const seeds     = [
      Buffer.from('asset_signer'),
      assetKey
    ];
    const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
    for (let bump = 255; bump >= 0; bump--) {
      const h = sha256(Buffer.concat([...seeds, Buffer.from([bump]), programId, PDA_MARKER]));
      return bs58.encode(h);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Main scan function ────────────────────────────────────────────────────────

async function scanAgentToken(mintAddress) {
  const t0       = Date.now();
  const findings = [];

  // ── 1. Fetch account info ─────────────────────────────────────────────────

  let accountInfo = null;
  try {
    accountInfo = await rpcMain('getAccountInfo', [
      mintAddress,
      { encoding: 'base64', commitment: 'confirmed' }
    ]);
  } catch (e) {
    findings.push({
      severity: 'critical',
      category: 'Token Security',
      title:    'Address unreachable',
      detail:   `Could not fetch on-chain data: ${e.message}`
    });
    return buildResult(mintAddress, findings, null, null, null, t0);
  }

  if (!accountInfo || !accountInfo.value) {
    findings.push({
      severity: 'critical',
      category: 'Token Security',
      title:    'Account does not exist',
      detail:   'No on-chain account found at this address. This is not a valid Agent Token.'
    });
    return buildResult(mintAddress, findings, null, null, null, t0);
  }

  const { owner, lamports, data: accountData, executable } = accountInfo.value;

  // ── 2. DAS API — try to get full metadata via Helius ─────────────────────

  const dasAsset = await dasGetAsset(mintAddress);

  // ── 3. Determine if this is a Metaplex Core asset ─────────────────────────

  const isMetaplexCore  = owner === MPL_CORE_PROGRAM;
  const isSplToken      = owner === TOKEN_PROG || owner === TOKEN_2022_PROG;

  // Extract metadata from DAS or account data
  let assetName         = dasAsset?.content?.metadata?.name  || null;
  let assetSymbol       = dasAsset?.content?.metadata?.symbol || null;
  let isMutable         = dasAsset ? (dasAsset.mutable !== false) : true;
  let updateAuthority   = null;
  let creatorFeesBps    = 0;
  let creators          = [];
  let currentOwner      = null;
  let isFrozen          = false;

  if (dasAsset) {
    // Parse DAS response
    updateAuthority = dasAsset.authorities?.[0]?.address || null;
    creatorFeesBps  = dasAsset.royalty?.basis_points || 0;
    creators        = dasAsset.creators || [];
    currentOwner    = dasAsset.ownership?.owner || null;
    isFrozen        = dasAsset.ownership?.frozen || false;

    // For fungible tokens, DAS may return different structure
    if (!updateAuthority && dasAsset.token_info) {
      updateAuthority = dasAsset.token_info?.mint_authority || null;
    }
  }

  // ── 4. Token Security category ────────────────────────────────────────────

  if (!isMetaplexCore && !isSplToken) {
    findings.push({
      severity: 'high',
      category: 'Token Security',
      title:    'Not a recognized token program',
      detail:   `Account owner is ${owner}, expected Metaplex Core or SPL Token program.`
    });
  }

  if (isMetaplexCore) {
    findings.push({
      severity: 'info',
      category: 'Token Security',
      title:    'Metaplex Core asset confirmed',
      detail:   `Account is owned by MPL Core program (${MPL_CORE_PROGRAM}).`
    });
  }

  if (isMutable) {
    findings.push({
      severity: 'medium',
      category: 'Token Security',
      title:    'Metadata is mutable',
      detail:   'The asset metadata can be changed by the update authority. Immutable metadata is safer for investors.'
    });
  } else {
    findings.push({
      severity: 'info',
      category: 'Token Security',
      title:    'Metadata is immutable',
      detail:   'Metadata has been locked. Cannot be changed by any authority.'
    });
  }

  if (isFrozen) {
    findings.push({
      severity: 'high',
      category: 'Token Security',
      title:    'Asset is frozen',
      detail:   'This asset is currently frozen, which restricts transfers.'
    });
  }

  if (lamports === 0) {
    findings.push({
      severity: 'critical',
      category: 'Token Security',
      title:    'Zero-lamport account',
      detail:   'Account has no rent balance. It may be eligible for garbage collection.'
    });
  }

  // ── 5. Agent-Specific Security category ──────────────────────────────────

  // 5a. Update authority risk
  let updateAuthorityRisk = 'unknown';
  if (!updateAuthority) {
    findings.push({
      severity: 'info',
      category: 'Agent-Specific Security',
      title:    'No update authority detected',
      detail:   'Update authority appears renounced or not detectable via DAS API.'
    });
    updateAuthorityRisk = 'renounced';
  } else {
    // Check if update authority is a known governance/multisig
    let isGovernance = false;
    let uaAccountOwner = null;
    try {
      const uaInfo = await rpcMain('getAccountInfo', [
        updateAuthority,
        { encoding: 'base64', commitment: 'confirmed' }
      ]);
      uaAccountOwner = uaInfo?.value?.owner || null;
      if (uaAccountOwner && KNOWN_GOVERNANCE_PROGRAMS.has(uaAccountOwner)) {
        isGovernance = true;
      }
    } catch {}

    if (isGovernance) {
      findings.push({
        severity: 'info',
        category: 'Agent-Specific Security',
        title:    'Update authority is a governance/multisig program',
        detail:   `Update authority ${updateAuthority} is controlled by a DAO or multisig (${uaAccountOwner}).`
      });
      updateAuthorityRisk = 'governance';
    } else {
      findings.push({
        severity: 'medium',
        category: 'Agent-Specific Security',
        title:    'Update authority is a single wallet',
        detail:   `Update authority ${updateAuthority} appears to be an externally-owned account. Single key control is a risk.`
      });
      updateAuthorityRisk = 'single_key';
    }
  }

  // 5b. Creator fees
  if (creatorFeesBps > 1000) {
    findings.push({
      severity: 'high',
      category: 'Agent-Specific Security',
      title:    `Excessive creator royalties: ${creatorFeesBps / 100}%`,
      detail:   `Creator fees of ${creatorFeesBps / 100}% (${creatorFeesBps} bps) are above the typical 10% maximum. This is predatory for secondary market buyers.`
    });
  } else if (creatorFeesBps > 500) {
    findings.push({
      severity: 'medium',
      category: 'Agent-Specific Security',
      title:    `High creator royalties: ${creatorFeesBps / 100}%`,
      detail:   `Creator fees of ${creatorFeesBps / 100}% (${creatorFeesBps} bps) are on the higher end.`
    });
  } else {
    findings.push({
      severity: 'info',
      category: 'Agent-Specific Security',
      title:    `Creator royalties: ${creatorFeesBps / 100}%`,
      detail:   `Creator fees of ${creatorFeesBps / 100}% (${creatorFeesBps} bps) are within normal range.`
    });
  }

  // 5c. Asset Signer PDA — derive and check
  const assetSignerPda = deriveAssetSignerPda(mintAddress);
  let treasuryAddress  = assetSignerPda;
  let treasuryLamports = 0;

  if (assetSignerPda) {
    try {
      const pdaInfo = await rpcMain('getAccountInfo', [
        assetSignerPda,
        { encoding: 'base64', commitment: 'confirmed' }
      ]);
      if (pdaInfo?.value) {
        treasuryLamports = pdaInfo.value.lamports || 0;
        if (treasuryLamports > 0) {
          findings.push({
            severity: 'info',
            category: 'Agent-Specific Security',
            title:    'Asset Signer PDA has funds',
            detail:   `Treasury PDA (${assetSignerPda}) holds ${(treasuryLamports / 1e9).toFixed(4)} SOL.`
          });
        }
      } else {
        findings.push({
          severity: 'low',
          category: 'Agent-Specific Security',
          title:    'Asset Signer PDA not initialized',
          detail:   `Derived PDA (${assetSignerPda}) does not exist on-chain. Treasury functionality not active.`
        });
      }
    } catch {}
  }

  // 5d. Unverified creators
  const unverifiedCreators = creators.filter(c => !c.verified);
  if (unverifiedCreators.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'Agent-Specific Security',
      title:    `${unverifiedCreators.length} unverified creator(s)`,
      detail:   `Creators: ${unverifiedCreators.map(c => c.address).join(', ')} have not signed to verify their identity on this asset.`
    });
  }

  // ── 6. DAO & Governance category ─────────────────────────────────────────

  // Check if grouping (collection) is set — indicates token belongs to a collection
  const collectionAddress = dasAsset?.grouping?.find(g => g.group_key === 'collection')?.group_value || null;

  if (collectionAddress) {
    // Check if collection authority is governance
    let collectionOwnerProgram = null;
    try {
      const collInfo = await rpcMain('getAccountInfo', [
        collectionAddress,
        { encoding: 'base64', commitment: 'confirmed' }
      ]);
      collectionOwnerProgram = collInfo?.value?.owner || null;
    } catch {}

    if (collectionOwnerProgram && KNOWN_GOVERNANCE_PROGRAMS.has(collectionOwnerProgram)) {
      findings.push({
        severity: 'info',
        category: 'DAO & Governance',
        title:    'Collection governed by DAO/multisig',
        detail:   `Collection (${collectionAddress}) is controlled by a governance program (${collectionOwnerProgram}).`
      });
    } else {
      findings.push({
        severity: 'low',
        category: 'DAO & Governance',
        title:    'Collection exists but governance unclear',
        detail:   `This token belongs to collection ${collectionAddress}. Collection governance program: ${collectionOwnerProgram || 'unknown'}.`
      });
    }
  } else {
    findings.push({
      severity: 'low',
      category: 'DAO & Governance',
      title:    'No collection set',
      detail:   'This Agent Token is not part of a verified collection. Collections provide additional trust and governance context.'
    });
  }

  // ── 7. Activity & Reputation category ─────────────────────────────────────

  const recentTxs     = await getRecentTransactions(mintAddress, 20);
  const txCount       = recentTxs.length;
  const hasActivity   = txCount > 0;
  const firstTx       = recentTxs.length > 0 ? recentTxs[recentTxs.length - 1] : null;
  const lastTx        = recentTxs.length > 0 ? recentTxs[0] : null;

  const blockTimeFirst = firstTx?.blockTime || null;
  const blockTimeLast  = lastTx?.blockTime  || null;

  const ageSeconds = blockTimeFirst
    ? (Math.floor(Date.now() / 1000) - blockTimeFirst)
    : null;
  const ageHours   = ageSeconds !== null ? (ageSeconds / 3600) : null;

  if (!hasActivity) {
    findings.push({
      severity: 'medium',
      category: 'Activity & Reputation',
      title:    'No recent transaction history',
      detail:   'No recent transactions found for this address. The asset may be very new or inactive.'
    });
  } else {
    if (ageHours !== null && ageHours < 24) {
      findings.push({
        severity: 'medium',
        category: 'Activity & Reputation',
        title:    'Very new asset (< 24 hours old)',
        detail:   `First activity detected ~${ageHours.toFixed(1)} hours ago. New assets carry higher risk.`
      });
    } else if (ageHours !== null && ageHours < 168) {
      findings.push({
        severity: 'low',
        category: 'Activity & Reputation',
        title:    'New asset (< 7 days old)',
        detail:   `First activity detected ~${(ageHours / 24).toFixed(1)} days ago.`
      });
    } else {
      findings.push({
        severity: 'info',
        category: 'Activity & Reputation',
        title:    `Asset age: ${ageHours !== null ? (ageHours / 24).toFixed(0) + ' days' : 'unknown'}`,
        detail:   `Last activity: ${blockTimeLast ? new Date(blockTimeLast * 1000).toISOString() : 'unknown'}.`
      });
    }

    // Check for suspicious activity patterns: many txs in very short time
    if (txCount >= 10 && ageHours !== null && ageHours < 1) {
      findings.push({
        severity: 'high',
        category: 'Activity & Reputation',
        title:    'Burst activity detected',
        detail:   `${txCount} transactions in under 1 hour. May indicate wash activity or airdrop botting.`
      });
    }
  }

  // ── 8. Compute score ──────────────────────────────────────────────────────

  // ── 8. Enrichment z externích zdrojů (paralelně, non-blocking) ──────────────
  // Enrichment nemůže zablokovat scan — pokud selže, pokračujeme s vlastními daty.
  let enrichment = null;
  try {
    enrichment = await enrichScanResult(mintAddress);
  } catch (e) {
    console.warn('[scan/agent-token] enrichment failed (non-fatal):', e.message);
  }

  return buildResult(mintAddress, findings, {
    is_metaplex_core:      isMetaplexCore,
    treasury_address:      treasuryAddress,
    treasury_lamports:     treasuryLamports,
    update_authority:      updateAuthority,
    update_authority_risk: updateAuthorityRisk,
    creator_fees_bps:      creatorFeesBps,
    creators:              creators.map(c => ({ address: c.address, verified: c.verified, share: c.share })),
    collection:            collectionAddress,
    is_mutable:            isMutable,
    is_frozen:             isFrozen,
    asset_name:            assetName,
    asset_symbol:          assetSymbol,
  }, {
    mint_authority_disabled:   !isMetaplexCore,  // Core assets have no mint authority concept
    freeze_authority_disabled: !isFrozen,
    owner_program:             owner,
    lamports,
    tx_count_sampled:          txCount,
    age_hours:                 ageHours !== null ? Math.round(ageHours) : null,
    first_activity:            blockTimeFirst ? new Date(blockTimeFirst * 1000).toISOString() : null,
    last_activity:             blockTimeLast  ? new Date(blockTimeLast  * 1000).toISOString() : null,
  }, enrichment, t0);
}

function buildResult(mintAddress, findings, agentMetadata, tokenMetrics, enrichment, t0) {
  // Vlastní deterministic score z findings
  let ownScore = 0;
  for (const f of findings) {
    ownScore += WEIGHTS[f.severity] || 0;
  }
  ownScore = Math.min(100, ownScore);

  // Kombinuj s enrichment (60% vlastní, 40% enrichment) pokud dostupný
  const finalScore = enrichment?.aggregated_risk
    ? combineScores(ownScore, enrichment.aggregated_risk)
    : ownScore;

  let risk_level;
  if      (finalScore >= 70) risk_level = 'CRITICAL';
  else if (finalScore >= 45) risk_level = 'HIGH';
  else if (finalScore >= 20) risk_level = 'MEDIUM';
  else                       risk_level = 'LOW';

  // Summary — prioritizuj enrichment signály (rugged, permanent_delegate)
  const enrichFlags     = enrichment?.aggregated_risk?.flags || [];
  const criticalFindings = findings.filter(f => f.severity === 'critical').map(f => f.title);
  const highFindings     = findings.filter(f => f.severity === 'high').map(f => f.title);
  let summary;

  if (enrichFlags.includes('rugged') || enrichFlags.includes('tracker_rugged')) {
    summary = 'CRITICAL: Token flagged as RUGGED by external databases.';
  } else if (enrichFlags.includes('permanent_delegate_active')) {
    summary = 'CRITICAL: Token has active PermanentDelegate — creator can move your tokens without consent.';
  } else if (criticalFindings.length > 0) {
    summary = `CRITICAL risks: ${criticalFindings.slice(0, 2).join('; ')}.`;
  } else if (highFindings.length > 0) {
    summary = `HIGH risks detected: ${highFindings.slice(0, 2).join('; ')}.`;
  } else if (finalScore < 20) {
    summary = 'No critical issues found. Standard due diligence advised.';
  } else {
    summary = `Medium risk profile. Score: ${finalScore}/100. Review all findings before investing.`;
  }

  return {
    scan_type:      'agent-token',
    target:         mintAddress,
    domain:         null,
    score:          finalScore,
    own_score:      ownScore,
    risk_level,
    summary,
    findings,
    agent_metadata: agentMetadata,
    token_metrics:  tokenMetrics,
    enrichment:     enrichment || null,
    scan_ms:        Date.now() - t0
  };
}

module.exports = { scanAgentToken };
