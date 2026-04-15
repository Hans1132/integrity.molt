'use strict';
/**
 * src/enrichment/token-extensions.js
 *
 * Token-2022 extension checker — parsuje on-chain mint account dat
 * a klasifikuje rizika každé extension.
 *
 * PermanentDelegate → CRITICAL (může transferovat/burnovat bez souhlasu)
 * TransferHook      → HIGH     (custom logika při každém transferu)
 * TransferFeeConfig → MEDIUM   (skryté poplatky)
 * DefaultAccountState → MEDIUM (nové účty zmrazeny by default)
 * ConfidentialTransfer → LOW   (privacy feature, legitimní)
 * NonTransferable   → INFO     (soulbound token)
 *
 * Cache: in-memory, TTL 30 minut (extensions se mění zřídka)
 */

const fs = require('fs');
const { SOLANA_RPC_URL: SOLANA_RPC } = require('../rpc');

// ── Config ────────────────────────────────────────────────────────────────────

const TOKEN_2022_PROG  = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TIMEOUT_MS       = 10_000;
const MEM_TTL_MS       = 30 * 60_000; // 30 minut

// ── In-memory cache ───────────────────────────────────────────────────────────

/** @type {Map<string, {data: object, ts: number}>} */
const _memCache = new Map();

function memGet(mint) {
  const hit = _memCache.get(mint);
  if (!hit) return null;
  if (Date.now() - hit.ts > MEM_TTL_MS) { _memCache.delete(mint); return null; }
  return hit.data;
}

function memSet(mint, data) {
  _memCache.set(mint, { data, ts: Date.now() });
}

// ── RPC helper ────────────────────────────────────────────────────────────────

async function getAccountInfo(mint) {
  const res = await fetch(SOLANA_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'getAccountInfo',
      params:  [mint, { encoding: 'base64', commitment: 'confirmed' }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC: ${json.error.message}`);
  return json.result?.value || null;
}

// ── Extension type catalog ────────────────────────────────────────────────────

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

/** Klasifikace severity per extension typ */
const EXT_SEVERITY = {
  PermanentDelegate:       'critical',
  TransferHook:            'high',
  TransferFeeConfig:       'medium',
  DefaultAccountState:     'medium',
  ConfidentialTransferMint:     'low',
  ConfidentialTransferFeeConfig:'low',
  NonTransferable:         'info',
  ImmutableOwner:          'info',
  MemoTransfer:            'info',
  MetadataPointer:         'info',
  TokenMetadata:           'info',
  InterestBearingConfig:   'low',
  MintCloseAuthority:      'medium',
  GroupPointer:            'info',
  GroupMemberPointer:      'info',
  TokenGroup:              'info',
  TokenGroupMember:        'info',
  CpiGuard:                'info',
};

const EXT_DESCRIPTIONS = {
  PermanentDelegate:        'Token creator can transfer or burn your tokens at any time without your permission. CRITICAL risk.',
  TransferHook:             'Custom program logic executes on every transfer. Can block transfers, extract fees, or implement arbitrary restrictions.',
  TransferFeeConfig:        'Token has built-in transfer fees that are deducted on every transaction. Check fee basis points.',
  DefaultAccountState:      'New token accounts start in a frozen state. Creator must unfreeze before you can use them.',
  ConfidentialTransferMint: 'Confidential (private) transfer enabled. Balances are hidden on-chain — legitimate privacy feature.',
  ConfidentialTransferFeeConfig: 'Confidential transfer fee configuration. Related to privacy layer.',
  NonTransferable:          'Token cannot be transferred (soulbound). Intentional for identity/achievement tokens.',
  ImmutableOwner:           'Token account owner cannot be reassigned. Standard security feature.',
  MemoTransfer:             'All transfers must include a memo. Informational.',
  MetadataPointer:          'Metadata stored on-chain via Token-2022 extension.',
  InterestBearingConfig:    'Token accrues interest over time. Verify rate and authority.',
  MintCloseAuthority:       'Mint account can be closed by the authority. Tokens could be made unusable.',
  CpiGuard:                 'Restricts cross-program invocations on this account.',
};

// ── Parser ────────────────────────────────────────────────────────────────────

const _bs58raw = require('bs58');
const bs58     = _bs58raw.default || _bs58raw;

function parseExtensions(data) {
  const extensions = [];
  // Token-2022 mint: 82 bytes base layout + 1 byte account_type + extension array
  const BASE_SIZE = 82;
  if (data.length <= BASE_SIZE + 1) return extensions;

  let offset = BASE_SIZE + 1; // skip account_type byte

  try {
    while (offset + 4 <= data.length) {
      const extType   = data.readUInt16LE(offset);
      const extLength = data.readUInt16LE(offset + 2);
      offset += 4;

      if (extType === 0) break; // uninitialized padding

      const extData = data.slice(offset, offset + extLength);
      const name    = EXT_TYPES[extType] || `Unknown(${extType})`;

      const ext = {
        type:     extType,
        name,
        length:   extLength,
        severity: EXT_SEVERITY[name] || 'info',
        description: EXT_DESCRIPTIONS[name] || `Token-2022 extension type ${extType}.`,
        detected: true
      };

      // Parsuj specifická pole pro klíčové extensions
      if (extType === 12 && extLength >= 32) {
        // PermanentDelegate — 32 bytů = pubkey delegáta
        try { ext.delegate_address = bs58.encode(extData.slice(0, 32)); } catch {}
        // Pokud je delegát SystemProgram (samé nuly), není aktivní
        if (ext.delegate_address === '11111111111111111111111111111111') {
          ext.delegate_address = null;
          ext.severity         = 'info';
          ext.description      = 'PermanentDelegate extension present but delegate is null/unset.';
        }
      }

      if (extType === 14 && extLength >= 64) {
        // TransferHook — authority (32B) + program_id (32B)
        try {
          ext.hook_authority  = bs58.encode(extData.slice(0, 32));
          ext.hook_program_id = bs58.encode(extData.slice(32, 64));
          // Pokud program_id je SystemProgram, hook není aktivní
          if (ext.hook_program_id === '11111111111111111111111111111111') {
            ext.hook_program_id = null;
            ext.severity        = 'info';
            ext.description     = 'TransferHook extension present but no hook program set.';
          }
        } catch {}
      }

      if (extType === 1 && extLength >= 108) {
        // TransferFeeConfig
        try {
          ext.fee_config_authority     = bs58.encode(extData.slice(8, 40));
          ext.withdraw_withheld_auth   = bs58.encode(extData.slice(40, 72));
          ext.older_fee_basis_points   = extData.readUInt16LE(88);
          ext.newer_fee_basis_points   = extData.readUInt16LE(106); // 72+16+8+8 = 104, bps at +2
          ext.max_fee_lamports         = Number(extData.readBigUInt64LE(80));
        } catch {}
      }

      if (extType === 3 && extLength >= 32) {
        // MintCloseAuthority
        try { ext.close_authority = bs58.encode(extData.slice(0, 32)); } catch {}
      }

      if (extType === 6 && extLength >= 1) {
        // DefaultAccountState — 0=initialized, 1=frozen
        ext.default_state = extData[0] === 1 ? 'frozen' : 'initialized';
      }

      extensions.push(ext);
      offset += extLength;
    }
  } catch (e) {
    console.warn('[enrichment/token-extensions] parse error:', e.message);
  }

  return extensions;
}

// ── Hlavní export ─────────────────────────────────────────────────────────────

/**
 * Zkontroluje Token-2022 extensions pro daný mint.
 * Pokud není Token-2022, vrátí { is_token_2022: false, extensions: [] }.
 *
 * @param {string} mint
 * @returns {Promise<object>}
 */
async function checkTokenExtensions(mint) {
  const cached = memGet(mint);
  if (cached) return cached;

  const t0 = Date.now();
  try {
    const info = await getAccountInfo(mint);

    if (!info) {
      const result = { is_token_2022: false, extensions: [], note: 'account not found' };
      memSet(mint, result);
      return result;
    }

    const isToken2022 = info.owner === TOKEN_2022_PROG;

    if (!isToken2022) {
      const result = { is_token_2022: false, owner_program: info.owner, extensions: [] };
      memSet(mint, result);
      return result;
    }

    // Dekóduj base64 data
    const rawData  = Buffer.from(info.data[0], 'base64');
    const exts     = parseExtensions(rawData);
    const ms       = Date.now() - t0;

    const hasCritical = exts.some(e => e.severity === 'critical');
    const hasHigh     = exts.some(e => e.severity === 'high');

    const result = {
      is_token_2022:   true,
      owner_program:   TOKEN_2022_PROG,
      extensions:      exts,
      has_critical:    hasCritical,
      has_high:        hasHigh,
      extension_names: exts.map(e => e.name),
      scan_ms:         ms,
      fetched_at:      new Date().toISOString()
    };

    console.log(`[enrichment/token-extensions] mint=${mint.slice(0, 8)} token2022=true exts=${exts.map(e => e.name).join(',') || 'none'} ms=${ms}`);
    memSet(mint, result);
    return result;

  } catch (e) {
    console.warn(`[enrichment/token-extensions] failed for ${mint.slice(0, 8)}: ${e.message}`);
    const result = { is_token_2022: false, extensions: [], error: e.message };
    memSet(mint, result);
    return result;
  }
}

/**
 * Parsuje Token-2022 extensions z raw Buffer dat mint accountu.
 * Lze použít pokud data již máme (bez extra RPC volání).
 *
 * @param {Buffer} rawData — dekódovaný Buffer z base64 accountData
 * @returns {object}  — { is_token_2022: bool, extensions: [], ... }
 */
function parseTokenExtensionsFromBuffer(rawData) {
  const isToken2022 = rawData.length > 82; // Token-2022 mint má > 82 bytů (base + extensions)
  if (!isToken2022) {
    return { is_token_2022: false, extensions: [], extension_names: [] };
  }

  const exts           = parseExtensions(rawData);
  const hasCritical    = exts.some(e => e.severity === 'critical');
  const hasHigh        = exts.some(e => e.severity === 'high');
  const extensionNames = exts.map(e => e.name);

  return {
    is_token_2022:   true,
    owner_program:   TOKEN_2022_PROG,
    extensions:      exts,
    has_critical:    hasCritical,
    has_high:        hasHigh,
    extension_names: extensionNames,
  };
}

module.exports = { checkTokenExtensions, parseTokenExtensionsFromBuffer };
