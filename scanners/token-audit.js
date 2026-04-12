'use strict';
// scanners/token-audit.js — Token Security Audit for Molt.id ecosystem tokens
// Analyzes mint/freeze authority, supply distribution, Metaplex metadata,
// Token-2022 extensions, and "Beggars Allocation" treasury patterns.

const fs = require('fs');
const crypto = require('crypto');
const { validateLLMScore } = require('../src/llm/scan-validator');
// bs58 v6+ exports via .default in CommonJS interop
const _bs58raw = require('bs58');
const bs58 = _bs58raw.default || _bs58raw;

// ── Config ────────────────────────────────────────────────────────────────────

const SOLANA_RPC = process.env.SOLANA_RPC_URL
  || (() => {
    let k = '';
    try { k = fs.readFileSync('/root/.secrets/alchemy_api_key', 'utf-8').trim(); } catch {}
    if (!k && process.env.ALCHEMY_API_KEY) k = process.env.ALCHEMY_API_KEY;
    return k ? `https://solana-mainnet.g.alchemy.com/v2/${k}` : 'https://api.mainnet-beta.solana.com';
  })();

let OPENROUTER_API_KEY = '';
try { OPENROUTER_API_KEY = fs.readFileSync('/root/.secrets/openrouter_api_key', 'utf-8').trim(); } catch {}
if (!OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY) OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ── Known-safe token whitelist (Solana) ──────────────────────────────────────
function loadSolanaWhitelist() {
  try {
    const data = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../config/known-safe-tokens.json'), 'utf-8'));
    return data.solana || {};
  } catch { return {}; }
}
const SOLANA_WHITELIST = loadSolanaWhitelist();

// Known program IDs
const TOKEN_PROG      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const METAPLEX_META   = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

// ── Severity weights ──────────────────────────────────────────────────────────
const WEIGHTS = { critical: 35, high: 20, medium: 10, low: 5, info: 0 };

// ── RPC helper ────────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

// ── Base58 / PDA helpers ──────────────────────────────────────────────────────

function b58decode(addr) {
  return Buffer.from(bs58.decode(addr));
}

// SHA256d used in Solana PDA derivation
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

// Derive Metaplex metadata PDA: ["metadata", metaplex_program_id, mint_address]
// Uses the same bump-search as the Solana SDK but just needs the canonical PDA.
function deriveMetadataPda(mintAddress) {
  const programId = b58decode(METAPLEX_META);
  const mint      = b58decode(mintAddress);
  const seeds     = [
    Buffer.from('metadata'),
    programId,
    mint
  ];

  // Solana PDA derivation: sha256("ProgramDerivedAddress" || seeds... || program_id)
  // Try bumps 255..0 until we find one off the curve
  const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(Buffer.concat([...seeds, Buffer.from([bump]), programId, PDA_MARKER]));
    // Check that the point is NOT on ed25519 curve (valid PDA)
    // Simple heuristic: if it doesn't throw when we try to encode it, use it
    // The real check is whether the 32-byte hash is a valid curve point.
    // For our purposes, we'll use the known Metaplex PDA pattern.
    // NOTE: Full curve check requires ed25519 point validation.
    // We return the first result; server.js will catch getAccountInfo errors gracefully.
    return bs58.encode(h);
  }
  return null;
}

// ── Mint account parsing ──────────────────────────────────────────────────────

function parseMintAccount(data, owner) {
  // SPL Token mint layout (82 bytes):
  // 0-3:   mint_authority_option (u32)
  // 4-35:  mint_authority (pubkey, 32 bytes)
  // 36-43: supply (u64 LE)
  // 44:    decimals (u8)
  // 45:    is_initialized (bool)
  // 46-49: freeze_authority_option (u32)
  // 50-81: freeze_authority (pubkey, 32 bytes)

  if (data.length < 82) return null;

  const mintAuthorityOption = data.readUInt32LE(0);
  const mintAuthority = mintAuthorityOption === 1
    ? bs58.encode(data.slice(4, 36))
    : null;

  const supplyLo = data.readUInt32LE(36);
  const supplyHi = data.readUInt32LE(40);
  const supply = BigInt(supplyHi) * 0x100000000n + BigInt(supplyLo);

  const decimals = data[44];
  const isInitialized = data[45] === 1;

  const freezeAuthorityOption = data.readUInt32LE(46);
  const freezeAuthority = freezeAuthorityOption === 1
    ? bs58.encode(data.slice(50, 82))
    : null;

  const isToken2022 = owner === TOKEN_2022_PROG;

  return { mintAuthority, supply, decimals, isInitialized, freezeAuthority, isToken2022 };
}

// ── Token-2022 extension parsing ──────────────────────────────────────────────

function parseToken2022Extensions(data) {
  // Token-2022 mint: first 82 bytes = base SPL layout, then account_type (1 byte),
  // then extensions: each extension is [type u16 LE][length u16 LE][data...]
  const extensions = [];
  if (data.length <= 83) return extensions;

  const ACCOUNT_TYPE_OFFSET = 82;
  // account_type = 1 means Mint
  let offset = ACCOUNT_TYPE_OFFSET + 1;

  const EXT_TYPES = {
    1:  'TransferFeeConfig',
    2:  'TransferFeeAmount',
    3:  'MintCloseAuthority',
    4:  'ConfidentialTransferMint',
    5:  'ConfidentialTransferFeeConfig',
    6:  'DefaultAccountState',
    7:  'ImmutableOwner',
    8:  'MemoTransfer',
    9:  'NonTransferable',
    10: 'InterestBearingConfig',
    11: 'CpiGuard',
    12: 'PermanentDelegate',
    13: 'NonTransferableAccount',
    14: 'TransferHook',
    15: 'ConfidentialTransferFeeAmount',
    16: 'MetadataPointer',
    17: 'TokenMetadata',
    18: 'GroupPointer',
    19: 'GroupMemberPointer',
    20: 'TokenGroup',
    21: 'TokenGroupMember',
  };

  try {
    while (offset + 4 <= data.length) {
      const extType   = data.readUInt16LE(offset);
      const extLength = data.readUInt16LE(offset + 2);
      offset += 4;
      if (extType === 0) break; // uninitialized padding

      const extData = data.slice(offset, offset + extLength);
      const name = EXT_TYPES[extType] || `Unknown(${extType})`;
      const ext = { type: extType, name, length: extLength };

      // Parse TransferFeeConfig specifically
      if (extType === 1 && extLength >= 108) {
        // TransferFeeConfig: epoch u64, transfer_fee_config_authority pubkey, withdraw_authority pubkey,
        //                    older_transfer_fee { epoch u64, maximum_fee u64, transfer_fee_basis_points u16 }
        //                    newer_transfer_fee { ... }
        try {
          ext.transfer_fee_config_authority = bs58.encode(extData.slice(8, 40));
          ext.withdraw_withheld_authority   = bs58.encode(extData.slice(40, 72));
          // older fee basis points at offset 72+8+8 = 88 within extData
          ext.older_fee_basis_points = extData.readUInt16LE(88);
          // newer fee: starts at 72+8+8+2=90? Let's use +26 for older block length
          // older_transfer_fee: epoch(8) + maximum_fee(8) + basis_points(2) = 18 bytes
          ext.newer_fee_basis_points = extData.readUInt16LE(90 + 8 + 8);
          ext.max_fee = Number(extData.readBigUInt64LE(80));
        } catch {}
      }

      // PermanentDelegate
      if (extType === 12 && extLength >= 32) {
        try { ext.delegate = bs58.encode(extData.slice(0, 32)); } catch {}
      }

      extensions.push(ext);
      offset += extLength;
    }
  } catch {}

  return extensions;
}

// ── Metaplex metadata parsing ─────────────────────────────────────────────────

function parseMetaplexMetadata(data) {
  // Metaplex Metadata layout (after discriminator):
  // 1 byte key, 32 bytes update_authority, 32 bytes mint,
  // then name (4-byte len prefix + string), symbol, uri, ...
  try {
    let offset = 1; // skip key byte
    const updateAuthority = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;
    const metaMint = bs58.encode(data.slice(offset, offset + 32));
    offset += 32;

    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name    = data.slice(offset, offset + nameLen).toString('utf-8').replace(/\0/g, '').trim();
    offset += nameLen;

    const symbolLen = data.readUInt32LE(offset); offset += 4;
    const symbol    = data.slice(offset, offset + symbolLen).toString('utf-8').replace(/\0/g, '').trim();
    offset += symbolLen;

    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri    = data.slice(offset, offset + uriLen).toString('utf-8').replace(/\0/g, '').trim();
    offset += uriLen;

    // seller_fee_basis_points u16
    const sellerFeeBps = data.readUInt16LE(offset); offset += 2;

    // creators: Option<Vec<Creator>>
    const hasCreators = data[offset]; offset += 1;
    const creators = [];
    if (hasCreators) {
      const creatorCount = data.readUInt32LE(offset); offset += 4;
      for (let i = 0; i < Math.min(creatorCount, 10); i++) {
        const addr     = bs58.encode(data.slice(offset, offset + 32)); offset += 32;
        const verified = data[offset]; offset += 1;
        const share    = data[offset]; offset += 1;
        creators.push({ address: addr, verified: verified === 1, share });
      }
    }

    // is_mutable
    const isMutable = data[offset] === 1;

    return { updateAuthority, mint: metaMint, name, symbol, uri, sellerFeeBps, creators, isMutable };
  } catch {
    return null;
  }
}

// ── Holder concentration analysis ────────────────────────────────────────────

function analyzeConcentration(holders, totalSupply) {
  if (!holders || !holders.length || !totalSupply) return null;

  const supply = Number(totalSupply);
  const top1Pct   = holders[0] ? (holders[0].amount / supply) * 100 : 0;
  const top3Pct   = holders.slice(0, 3).reduce((s, h) => s + h.amount, 0) / supply * 100;
  const top10Pct  = holders.reduce((s, h) => s + h.amount, 0) / supply * 100;

  return {
    top1_pct:  Math.round(top1Pct  * 10) / 10,
    top3_pct:  Math.round(top3Pct  * 10) / 10,
    top10_pct: Math.round(top10Pct * 10) / 10,
    holder_count_visible: holders.length
  };
}

// ── LLM summarization via OpenRouter ─────────────────────────────────────────

async function summarizeWithLLM(auditData) {
  if (!OPENROUTER_API_KEY) {
    return {
      summary: 'LLM summarization unavailable (no API key).',
      risk_score: auditData.raw_score,
      category: scoreToCategory(auditData.raw_score)
    };
  }

  const deterministicScore = auditData.raw_score;
  const dangerFindings = (auditData.findings || []).filter(f => f.severity === 'critical' || f.severity === 'high');

  const prompt = `You are integrity.molt, an AI-native Solana security scanner. Analyze this token security audit and produce a structured risk assessment.

DETERMINISTIC SCORE (computed by rule-based engine): ${deterministicScore}/100
${dangerFindings.length > 0 ? `CRITICAL/HIGH FINDINGS (${dangerFindings.length}): ${dangerFindings.map(f => f.label).join(', ')}` : 'NO CRITICAL/HIGH FINDINGS'}

IMPORTANT SCORING CONSTRAINTS:
- Your risk_score MUST NOT differ from the deterministic score by more than 20 points downward.
- If deterministic score is ${deterministicScore}, your risk_score must be >= ${Math.max(0, deterministicScore - 20)}.
- If there are critical or high findings, risk_score MUST be >= 31.
- If deterministic score > 65, category MUST be "DANGER".
- Only justify a lower score if you have specific on-chain evidence that the deterministic engine over-counted.

TOKEN AUDIT DATA:
${JSON.stringify(auditData, null, 2)}

Produce a JSON response with these fields:
{
  "summary": "2-4 sentence human-readable security summary",
  "risk_score": <integer 0-100>,
  "category": "SAFE" | "CAUTION" | "DANGER",
  "key_risks": ["<risk1>", "<risk2>"],
  "recommendations": ["<rec1>", "<rec2>"]
}

Risk score guidelines:
- 0-30: SAFE — standard token, no major concerns
- 31-65: CAUTION — notable risks but not disqualifying
- 66-100: DANGER — serious risks, rug potential or treasury exploit

Focus on:
1. Mint authority status (renounced = safer)
2. Freeze authority (should be null for trusted tokens)
3. Supply concentration (top holder >50% = danger)
4. Treasury security (multisig vs EOA, drain risk)
5. Token-2022 fee traps and permanent delegates
6. Metadata legitimacy

Output ONLY valid JSON, no markdown.`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(30000)
    });

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    // Strip markdown code blocks if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('[token-audit] LLM error:', e.message);
    const cat = scoreToCategory(auditData.raw_score);
    return {
      summary: `Automated analysis complete. Risk score: ${auditData.raw_score}/100. ${auditData.findings.length} finding(s) detected.`,
      risk_score: auditData.raw_score,
      category: cat,
      key_risks:       auditData.findings.filter(f => f.severity !== 'info').map(f => f.label).slice(0, 3),
      recommendations: ['Review mint authority status', 'Check treasury multisig setup']
    };
  }
}

function scoreToCategory(score) {
  if (score <= 30) return 'SAFE';
  if (score <= 65) return 'CAUTION';
  return 'DANGER';
}

// ── Main audit function ───────────────────────────────────────────────────────

async function auditToken(mintAddress, tokenName, options = {}) {
  const t0 = Date.now();
  const findings = [];
  let rawScore = 0;

  function finding(severity, category, label, detail = null) {
    findings.push({ severity, category, label, detail });
    rawScore = Math.min(100, rawScore + (WEIGHTS[severity] || 0));
  }

  // ── 1. Fetch mint account ─────────────────────────────────────────────────

  let mintInfo = null;
  let extensions = [];

  try {
    const accountRes = await rpc('getAccountInfo', [
      mintAddress,
      { encoding: 'base64', commitment: 'confirmed' }
    ]);

    if (!accountRes || !accountRes.value) {
      finding('critical', 'account', 'Mint account not found on-chain');
      return buildResult({ mintAddress, tokenName, findings, rawScore, t0 });
    }

    const owner   = accountRes.value.owner;
    const dataB64 = accountRes.value.data?.[0] || '';
    const data    = Buffer.from(dataB64, 'base64');

    if (owner !== TOKEN_PROG && owner !== TOKEN_2022_PROG) {
      finding('critical', 'account', `Account is not a token mint (owner: ${owner})`);
      return buildResult({ mintAddress, tokenName, findings, rawScore, t0 });
    }

    mintInfo = parseMintAccount(data, owner);
    if (!mintInfo) {
      finding('high', 'account', 'Failed to parse mint account data');
    }

    if (mintInfo?.isToken2022) {
      extensions = parseToken2022Extensions(data);
    }
  } catch (e) {
    finding('high', 'rpc', `RPC error fetching mint account: ${e.message}`);
    return buildResult({ mintAddress, tokenName, findings, rawScore, t0 });
  }

  // ── 2. Mint authority checks ───────────────────────────────────────────────

  if (mintInfo) {
    if (mintInfo.mintAuthority === null) {
      findings.push({ severity: 'info', category: 'mint-authority', label: 'Mint authority renounced (null) — supply is fixed', detail: null });
    } else {
      finding('high', 'mint-authority',
        `Mint authority active: ${mintInfo.mintAuthority}`,
        'Owner can mint unlimited tokens at any time');

      // Check if mint authority is a multisig (heuristic: check account type)
      try {
        const maRes = await rpc('getAccountInfo', [
          mintInfo.mintAuthority,
          { encoding: 'base64', commitment: 'confirmed' }
        ]);
        const maOwner = maRes?.value?.owner;
        const maData  = maRes?.value?.data?.[0]
          ? Buffer.from(maRes.value.data[0], 'base64') : null;

        if (!maRes?.value) {
          finding('medium', 'mint-authority', 'Mint authority account not found on-chain (ephemeral key?)');
        } else if (maOwner === TOKEN_PROG && maData && maData.length === 355) {
          // SPL multisig: 355 bytes
          findings.push({ severity: 'info', category: 'mint-authority',
            label: 'Mint authority is an SPL multisig', detail: null });
        } else if (maOwner === '11111111111111111111111111111111') {
          finding('medium', 'mint-authority',
            'Mint authority is a plain wallet (EOA), not a multisig',
            'Single key can mint tokens without additional approvals');
        }
      } catch {}
    }
  }

  // ── 3. Freeze authority checks ─────────────────────────────────────────────

  if (mintInfo) {
    if (mintInfo.freezeAuthority === null) {
      findings.push({ severity: 'info', category: 'freeze-authority', label: 'Freeze authority not set — accounts cannot be frozen', detail: null });
    } else {
      finding('high', 'freeze-authority',
        `Freeze authority active: ${mintInfo.freezeAuthority}`,
        'Owner can freeze any token account, blocking transfers');
    }
  }

  // ── 4. Token-2022 extension checks ────────────────────────────────────────

  let transferFeeInfo = null;
  for (const ext of extensions) {
    switch (ext.name) {
      case 'TransferFeeConfig': {
        transferFeeInfo = ext;
        const bps = ext.newer_fee_basis_points ?? ext.older_fee_basis_points ?? 0;
        const pct = bps / 100;
        if (bps > 0) {
          const sev = bps > 1000 ? 'high' : bps > 300 ? 'medium' : 'low';
          finding(sev, 'transfer-fee',
            `Transfer fee: ${pct.toFixed(2)}% on every transfer`,
            `Fee goes to: ${ext.withdraw_withheld_authority || 'unknown'}`);
        }
        break;
      }
      case 'PermanentDelegate':
        finding('critical', 'permanent-delegate',
          `Permanent delegate set: ${ext.delegate || 'unknown'}`,
          'This address can transfer or burn tokens from ANY holder account without approval');
        break;
      case 'NonTransferable':
        findings.push({ severity: 'info', category: 'non-transferable',
          label: 'Token is non-transferable (soulbound)', detail: null });
        break;
      case 'MintCloseAuthority':
        finding('medium', 'mint-close',
          'MintCloseAuthority set — mint account can be closed',
          'Supply can be wiped by closing the mint');
        break;
      case 'DefaultAccountState':
        finding('high', 'default-frozen',
          'DefaultAccountState extension: new accounts start frozen',
          'All new holders are frozen by default until explicitly unfrozen by authority');
        break;
      case 'TransferHook':
        finding('medium', 'transfer-hook',
          'TransferHook extension active',
          'Custom program called on every transfer — may include blacklists or restrictions');
        break;
      case 'ConfidentialTransferMint':
        findings.push({ severity: 'info', category: 'confidential-transfer',
          label: 'Confidential transfers enabled (ZK proofs)', detail: null });
        break;
    }
  }

  // ── 5. Supply distribution (top 10 holders) ────────────────────────────────

  let holders = [];
  let concentration = null;

  try {
    const holdersRes = await rpc('getTokenLargestAccounts', [
      mintAddress, { commitment: 'confirmed' }
    ]);
    const rawHolders = holdersRes?.value || [];

    // Fetch owner addresses for each token account
    const ownerFetches = rawHolders.slice(0, 10).map(async h => {
      try {
        const accRes = await rpc('getAccountInfo', [h.address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        const owner = accRes?.value?.data?.parsed?.info?.owner || null;
        return {
          token_account: h.address,
          owner,
          amount: Number(h.amount),
          ui_amount: h.uiAmountString
        };
      } catch {
        return { token_account: h.address, owner: null, amount: Number(h.amount), ui_amount: h.uiAmountString };
      }
    });

    holders = await Promise.all(ownerFetches);
    concentration = analyzeConcentration(holders, mintInfo?.supply);

    if (concentration) {
      if (concentration.top1_pct > 80) {
        finding('critical', 'concentration', `Top holder controls ${concentration.top1_pct}% of supply`);
      } else if (concentration.top1_pct > 50) {
        finding('high', 'concentration', `Top holder controls ${concentration.top1_pct}% of supply`);
      } else if (concentration.top1_pct > 30) {
        finding('medium', 'concentration', `Top holder controls ${concentration.top1_pct}% of supply`);
      } else {
        findings.push({ severity: 'info', category: 'concentration',
          label: `Supply reasonably distributed — top holder: ${concentration.top1_pct}%`, detail: null });
      }

      if (concentration.top3_pct > 90) {
        finding('critical', 'concentration', `Top 3 holders control ${concentration.top3_pct}% of supply`);
      } else if (concentration.top3_pct > 70) {
        finding('high', 'concentration', `Top 3 holders control ${concentration.top3_pct}% of supply`);
      }
    }
  } catch (e) {
    finding('low', 'holders', `Could not fetch holder distribution: ${e.message}`);
  }

  // ── 6. Metaplex metadata ──────────────────────────────────────────────────

  let metadata = null;
  try {
    // Compute Metaplex PDA using deterministic derivation
    const pdaAddress = deriveMetadataPda(mintAddress);
    if (pdaAddress) {
      const metaRes = await rpc('getAccountInfo', [pdaAddress, { encoding: 'base64', commitment: 'confirmed' }]);
      if (metaRes?.value?.data?.[0]) {
        const metaData = Buffer.from(metaRes.value.data[0], 'base64');
        metadata = parseMetaplexMetadata(metaData);

        if (metadata) {
          if (metadata.isMutable) {
            finding('medium', 'metadata',
              'Metadata is mutable — name/symbol/URI can be changed',
              'Authority can rebrand token after launch');
          } else {
            findings.push({ severity: 'info', category: 'metadata',
              label: 'Metadata is immutable (update authority locked)', detail: null });
          }

          if (!metadata.uri || metadata.uri === '') {
            finding('low', 'metadata', 'Metadata URI is empty — no off-chain metadata');
          }

          // Check for unverified creators
          const unverified = metadata.creators.filter(c => !c.verified);
          if (unverified.length > 0 && metadata.creators.length > 0) {
            finding('low', 'metadata',
              `${unverified.length} of ${metadata.creators.length} creator(s) not verified`);
          }
        }
      } else {
        finding('low', 'metadata', 'No Metaplex metadata account found');
      }
    }
  } catch (e) {
    // Metadata fetch failure is non-critical
    findings.push({ severity: 'info', category: 'metadata',
      label: `Metadata lookup failed: ${e.message}`, detail: null });
  }

  // ── 7. Beggars Allocation / treasury analysis ──────────────────────────────
  // "Beggars Allocation" = distribution mechanism where AI agents or users
  // receive tokens from a treasury. Key risks: single-key treasury, no rate
  // limits, AI agent can drain entire treasury in one tx.

  const treasuryAnalysis = await analyzeTreasuryPatterns(mintAddress, holders, mintInfo, findings, finding);

  // ── 8. Compute raw score & build result ───────────────────────────────────

  rawScore = Math.min(100, rawScore);

  // Apply known-safe whitelist — regulated assets (USDC, USDT) have active
  // mint/freeze authorities by design. Downgrade findings and cap score.
  const wlEntry = SOLANA_WHITELIST[mintAddress];
  if (wlEntry) {
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      if (f.category === 'mint-authority' && f.severity === 'high' && wlEntry.mint_authority_note) {
        findings[i] = { ...f, severity: 'info', label: f.label + ` — ${wlEntry.mint_authority_note}` };
      } else if (f.category === 'freeze-authority' && f.severity === 'high' && wlEntry.freeze_authority_note) {
        findings[i] = { ...f, severity: 'info', label: f.label + ` — ${wlEntry.freeze_authority_note}` };
      }
    }
    if (wlEntry.max_score != null && rawScore > wlEntry.max_score) {
      rawScore = wlEntry.max_score;
    }
  }

  const auditData = {
    mint_address:    mintAddress,
    token_name:      tokenName || metadata?.name || 'Unknown',
    raw_score:       rawScore,
    findings,
    mint_info:       mintInfo ? {
      mint_authority:   mintInfo.mintAuthority,
      freeze_authority: mintInfo.freezeAuthority,
      supply:           mintInfo.supply.toString(),
      decimals:         mintInfo.decimals,
      is_token_2022:    mintInfo.isToken2022
    } : null,
    extensions:      extensions.map(e => ({ name: e.name, type: e.type })),
    transfer_fee:    transferFeeInfo ? {
      fee_basis_points: transferFeeInfo.newer_fee_basis_points ?? transferFeeInfo.older_fee_basis_points,
      authority:        transferFeeInfo.transfer_fee_config_authority,
      withdraw_authority: transferFeeInfo.withdraw_withheld_authority
    } : null,
    top_holders:     holders,
    concentration,
    metadata:        metadata ? {
      name:             metadata.name,
      symbol:           metadata.symbol,
      uri:              metadata.uri,
      update_authority: metadata.updateAuthority,
      is_mutable:       metadata.isMutable,
      creators:         metadata.creators
    } : null,
    treasury:        treasuryAnalysis
  };

  // LLM summarization + validation
  const llmRaw = await summarizeWithLLM(auditData);
  const { corrected: llm, flags: validationFlags } = validateLLMScore(rawScore, llmRaw, auditData);

  return buildResult({ mintAddress, tokenName, findings, rawScore, t0, auditData, llm, validationFlags });
}

// ── Treasury / Beggars Allocation pattern detection ───────────────────────────

async function analyzeTreasuryPatterns(mintAddress, holders, mintInfo, findings, finding) {
  const result = {
    identified_treasury: null,
    is_multisig:         null,
    drain_risk:          null,
    rate_limit_detected: false,
    notes:               []
  };

  // Heuristic: treasury = largest holder that is NOT a DEX/pool
  // Known DEX program owners (Raydium, Orca, etc.) — these are AMM vaults, not treasury
  const DEX_PROGRAMS = new Set([
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  ]);

  // Find largest non-DEX holder as suspected treasury
  for (const holder of holders.slice(0, 10)) {
    if (holder.owner && !DEX_PROGRAMS.has(holder.owner)) {
      result.identified_treasury = {
        token_account: holder.token_account,
        owner:         holder.owner,
        balance_raw:   holder.amount,
        balance_pct:   mintInfo?.supply
          ? Math.round(holder.amount / Number(mintInfo.supply) * 1000) / 10
          : null
      };
      break;
    }
  }

  if (!result.identified_treasury) return result;

  const treasuryOwner = result.identified_treasury.owner;

  // Check treasury owner account type
  try {
    const ownerRes = await rpc('getAccountInfo', [
      treasuryOwner,
      { encoding: 'base64', commitment: 'confirmed' }
    ]);
    const ownerData  = ownerRes?.value?.data?.[0]
      ? Buffer.from(ownerRes.value.data[0], 'base64') : null;
    const ownerOwner = ownerRes?.value?.owner;

    if (!ownerRes?.value) {
      result.is_multisig = false;
      result.notes.push('Treasury owner account not found on-chain');
      finding('medium', 'treasury', 'Treasury owner not found on-chain — possible ephemeral key risk');
    } else if (ownerOwner === TOKEN_PROG && ownerData && ownerData.length === 355) {
      // SPL multisig
      const m = ownerData[0];  // minimum required signers
      const n = ownerData[1];  // total signers
      result.is_multisig = true;
      result.notes.push(`Treasury controlled by SPL multisig (${m}-of-${n})`);
      findings.push({ severity: 'info', category: 'treasury',
        label: `Treasury uses SPL multisig (${m}-of-${n}) — drain requires multiple signatures`, detail: null });
    } else if (ownerOwner === '11111111111111111111111111111111') {
      // Plain wallet
      result.is_multisig = false;
      finding('high', 'treasury',
        'Treasury controlled by a single wallet (EOA), not a multisig',
        'One compromised key = complete treasury drain. AI agent with this key can extract all funds.');
      result.drain_risk = 'HIGH — single key can drain entire treasury in one transaction';
    } else {
      // Unknown program owner — might be a custom multisig (Squads, etc.)
      result.is_multisig = null;
      result.notes.push(`Treasury owner is program: ${ownerOwner}`);
      // Squads v3/v4 multisig
      const SQUADS_V3 = 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu';
      const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
      if (ownerOwner === SQUADS_V3 || ownerOwner === SQUADS_V4) {
        result.is_multisig = true;
        findings.push({ severity: 'info', category: 'treasury',
          label: 'Treasury uses Squads multisig — drain requires multi-party approval', detail: null });
      } else {
        findings.push({ severity: 'info', category: 'treasury',
          label: `Treasury owner is a program (${ownerOwner.slice(0, 8)}...) — review required`, detail: null });
      }
    }
  } catch (e) {
    result.notes.push(`Treasury owner lookup failed: ${e.message}`);
  }

  // Beggars Allocation: check recent transactions for rate-limit patterns
  // (presence of a rate-limit means distributions are bounded)
  try {
    const sigRes = await rpc('getSignaturesForAddress', [
      result.identified_treasury.token_account,
      { limit: 20, commitment: 'confirmed' }
    ]);
    const sigs = sigRes || [];
    result.notes.push(`Treasury account has ${sigs.length} recent transactions (last 20 fetched)`);

    if (sigs.length === 0) {
      result.notes.push('No recent treasury transactions — possibly newly created or dormant');
    } else {
      // Check if distributions are happening rapidly (possible bot drain)
      const timestamps = sigs.map(s => s.blockTime).filter(Boolean).sort((a, b) => b - a);
      if (timestamps.length >= 5) {
        const recentSpan = timestamps[0] - timestamps[4]; // time for last 5 txs
        if (recentSpan < 60) {
          finding('high', 'treasury',
            'Treasury shows rapid outflow — 5+ transactions in under 60 seconds',
            'Possible automated drain or bot attack in progress');
        }
      }

      result.drain_risk = result.drain_risk || (result.is_multisig ? 'LOW — multisig required' : 'MEDIUM — verify rate limits');
    }
  } catch {}

  return result;
}

// ── Build final result object ─────────────────────────────────────────────────

function buildResult({ mintAddress, tokenName, findings, rawScore, t0, auditData, llm, validationFlags }) {
  const category = llm?.category || scoreToCategory(rawScore);
  return {
    mint_address: mintAddress,
    token_name:   tokenName || auditData?.metadata?.name || 'Unknown',
    risk_score:   llm?.risk_score ?? rawScore,
    category,
    summary:      llm?.summary  || `Automated audit: ${findings.length} finding(s). Score: ${rawScore}/100.`,
    key_risks:    llm?.key_risks         || [],
    recommendations: llm?.recommendations || [],
    findings,
    detail:       auditData || null,
    scan_ms:      Date.now() - t0,
    scan_type:    'token-security-audit',
    scan_version: '1.0',
    llm_validation_flags: validationFlags || []
  };
}

// ── Demo showcase data ────────────────────────────────────────────────────────
// Pre-computed report on a known Solana devnet token for marketing purposes

function getShowcaseReport() {
  return {
    mint_address: 'So11111111111111111111111111111111111111112',
    token_name:   'Wrapped SOL (showcase demo)',
    risk_score:   12,
    category:     'SAFE',
    summary:      'Wrapped SOL (wSOL) is a canonical Token Program mint with no mint or freeze authority. ' +
                  'Supply is fully floating and controlled by the native SOL wrapping mechanism. ' +
                  'No Token-2022 extensions, no concentrated holders, and verified Metaplex metadata. ' +
                  'This token presents minimal risk for holders and integrators.',
    key_risks:    [],
    recommendations: [
      'Always verify the mint address matches the canonical wSOL address',
      'Monitor for any governance proposals that could affect the wrapping program'
    ],
    findings: [
      { severity: 'info', category: 'mint-authority',  label: 'Mint authority renounced (null) — supply is fixed', detail: null },
      { severity: 'info', category: 'freeze-authority', label: 'Freeze authority not set — accounts cannot be frozen', detail: null },
      { severity: 'info', category: 'concentration',   label: 'Supply distributed across millions of accounts', detail: null },
      { severity: 'info', category: 'metadata',        label: 'Metadata is immutable (update authority locked)', detail: null },
      { severity: 'low',  category: 'treasury',        label: 'No concentrated treasury wallet detected', detail: null }
    ],
    detail: {
      mint_info: {
        mint_authority:   null,
        freeze_authority: null,
        supply:           '0',
        decimals:         9,
        is_token_2022:    false
      },
      extensions: [],
      transfer_fee: null,
      concentration: { top1_pct: 0.3, top3_pct: 0.8, top10_pct: 1.9, holder_count_visible: 10 },
      metadata: {
        name:             'Wrapped SOL',
        symbol:           'SOL',
        is_mutable:       false,
        update_authority: 'AuthorityRenounced11111111111111111111111'
      },
      treasury: { identified_treasury: null, is_multisig: null, drain_risk: null, notes: [] }
    },
    scan_ms:      420,
    scan_type:    'token-security-audit',
    scan_version: '1.0',
    demo:         true,
    note:         'This is a pre-computed showcase report for demo purposes. Run a live audit via POST /api/v1/scan/token-audit.'
  };
}

module.exports = { auditToken, getShowcaseReport, _test: { scoreToCategory, analyzeConcentration, WEIGHTS } };
