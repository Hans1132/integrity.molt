'use strict';

const crypto = require('crypto');

// Známé bezpečné programy — nebudou triggrovovat suspicious_cpi
const KNOWN_PROGRAMS = new Set([
  '11111111111111111111111111111111',             // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbequAaJF3VnKPBDJPPNBB1hPPdYMFJnAU', // Token 2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsn', // Associated Token
  'BPFLoaderUpgradeab1e111111111111111111111111111', // BPF Loader Upgradeable
  'BPFLoader2111111111111111111111111111111111111',  // BPF Loader 2
  'ComputeBudget111111111111111111111111111111111',  // Compute Budget
  'Vote111111111111111111111111111111111111111111',  // Vote Program
  'Stake11111111111111111111111111111111111111111',  // Stake Program
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',  // Metaplex Token Metadata
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // Serum DEX
]);

// BPF Loader Upgradeable — program který upgraduje jiné programy
const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e111111111111111111111111111';

// Thresholds pro large_transfer
const LARGE_TRANSFER_SOL_LAMPORTS = 100 * 1e9;       // 100 SOL v lamports
const LARGE_TRANSFER_TOKEN_AMOUNT  = 10_000;           // 10k tokenů (pro USDC = 10k USDC při 6 decimals)
const LARGE_TRANSFER_USDC_DECIMALS = 6;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Detekce authority change — hledá klíčová slova v instruction datech nebo parsed events.
 */
function detectAuthorityChange(parsed, address) {
  const authorityKeywords = [
    'set_authority', 'setAuthority', 'change_authority', 'changeAuthority',
    'transfer_authority', 'transferAuthority', 'update_authority', 'updateAuthority',
  ];

  for (const ix of parsed.instructions) {
    // Helius parsed events
    if (ix._event === 'set_authority') return true;
    if (ix.parsed?.type && authorityKeywords.some(kw => ix.parsed.type.toLowerCase().includes(kw.replace('_', '')))) {
      return true;
    }
    // Base58 data heuristic — hledej v instrukci zda accounts obsahuje sledovanou adresu
    if (ix.accounts && ix.accounts.includes(address)) {
      const dataStr = String(ix.data || '');
      if (authorityKeywords.some(kw => dataStr.toLowerCase().includes(kw))) return true;
    }
  }

  // Helius type
  if (['SET_AUTHORITY', 'UPDATE_AUTHORITY', 'CHANGE_AUTHORITY']
      .includes((parsed.type || '').toUpperCase())) return true;

  return false;
}

/**
 * Detekce program upgrade — BPFLoaderUpgradeable::Upgrade instrukce.
 */
function detectProgramUpgrade(parsed) {
  for (const ix of parsed.instructions) {
    if (ix.program === BPF_LOADER_UPGRADEABLE || ix.programId === BPF_LOADER_UPGRADEABLE) {
      // Helius označí typ UPGRADE_PROGRAM
      if (parsed.type === 'UPGRADE_PROGRAM') return true;
      // Nebo parsed data obsahují upgrade
      if (ix.parsed?.type === 'upgrade') return true;
      return true; // Jakákoliv instrukce BPF Loader Upgradeable je podezřelá
    }
  }
  if (parsed.type === 'UPGRADE_PROGRAM') return true;
  return false;
}

/**
 * Detekce velkého SOL nebo token transferu.
 * Vrací { found, amount, token, from, to } nebo null.
 */
function detectLargeTransfer(parsed, address) {
  // SOL transfery
  for (const t of parsed.nativeTransfers) {
    if (t.amount >= LARGE_TRANSFER_SOL_LAMPORTS &&
        (t.from === address || t.to === address)) {
      return {
        amount: (t.amount / 1e9).toFixed(4),
        token:  'SOL',
        from:   t.from,
        to:     t.to,
      };
    }
  }

  // Token transfery
  for (const t of parsed.tokenTransfers) {
    if (t.from === address || t.to === address) {
      // USDC — 6 decimals, threshold 10k
      if (t.mint === USDC_MINT) {
        const usdcAmount = t.amount / Math.pow(10, LARGE_TRANSFER_USDC_DECIMALS);
        if (usdcAmount >= LARGE_TRANSFER_TOKEN_AMOUNT) {
          return { amount: usdcAmount.toFixed(2), token: 'USDC', from: t.from, to: t.to };
        }
      } else {
        // Ostatní tokeny — raw amount threshold
        if (t.amount >= LARGE_TRANSFER_TOKEN_AMOUNT) {
          return { amount: t.amount, token: `token:${t.mint?.slice(0, 8)}`, from: t.from, to: t.to };
        }
      }
    }
  }
  return null;
}

/**
 * Detekce nového mint (mint_to instrukce na sledovaný mint).
 */
function detectNewMint(parsed, address) {
  for (const ix of parsed.instructions) {
    if (ix.parsed?.type === 'mintTo' || ix.parsed?.type === 'mintToChecked') {
      const mintAddr = ix.parsed?.info?.mint;
      if (mintAddr === address) {
        return {
          mint:   mintAddr,
          amount: ix.parsed?.info?.amount || ix.parsed?.info?.tokenAmount?.uiAmount || 0,
        };
      }
    }
  }
  // Token transfer s nulovou from = mint_to
  for (const t of parsed.tokenTransfers) {
    if (t.mint === address && !t.from) {
      return { mint: t.mint, amount: t.amount };
    }
  }
  return null;
}

/**
 * Detekce zavření account.
 */
function detectAccountClose(parsed, address) {
  for (const ix of parsed.instructions) {
    if (['closeAccount', 'close_account', 'close'].includes(ix.parsed?.type)) {
      const accs = ix.parsed?.info || {};
      if (accs.account === address || ix.accounts?.includes(address)) return true;
    }
  }
  if (parsed.type === 'CLOSE_ACCOUNT') return true;
  return false;
}

/**
 * Detekce CPI do neznámého programu z monitorovaného programu.
 * Pokud monitorovaná adresa je program a volá neznámý program přes CPI.
 */
function detectSuspiciousCPI(parsed, address) {
  // Sledovaná adresa je volající program
  const isCallerProgram = parsed.programs.includes(address);
  if (!isCallerProgram) return null;

  // Najdi programy volané spolu s monitorenou adresou
  const unknown = parsed.programs.filter(p => p !== address && !KNOWN_PROGRAMS.has(p));
  if (unknown.length > 0) {
    return { unknownPrograms: unknown };
  }
  return null;
}

/**
 * Generuje unikátní ID alertu.
 */
function generateAlertId(txSig, rule, address) {
  return crypto
    .createHash('sha256')
    .update(`${txSig}:${rule}:${address}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Vyhodnotí transakci vůči pravidlům pro danou adresu.
 * @param {object} parsed — výstup z parseEnhancedTransaction()
 * @param {string} address — sledovaná adresa
 * @returns {Array<object>} pole alertů
 */
function evaluateTransaction(parsed, address) {
  const alerts = [];
  const sig    = parsed.signature;
  const ts     = parsed.timestamp || Date.now();

  function makeAlert(rule, severity, message, details = {}) {
    alerts.push({
      id:           generateAlertId(sig, rule, address),
      timestamp:    ts,
      severity,
      rule,
      address,
      tx_signature: sig,
      message,
      details,
    });
  }

  // 1. Authority change
  if (detectAuthorityChange(parsed, address)) {
    const short = address.slice(0, 12) + '…';
    makeAlert(
      'authority_change',
      'critical',
      `Authority change detected on ${short}`,
      { address, programs: parsed.programs }
    );
  }

  // 2. Program upgrade
  if (detectProgramUpgrade(parsed)) {
    // Upozorni jen pokud je sledovaná adresa program v tx
    if (parsed.accounts.includes(address) || parsed.programs.includes(address)) {
      makeAlert(
        'program_upgrade',
        'critical',
        `Program upgrade detected for ${address.slice(0, 12)}…`,
        { programId: address, programs: parsed.programs }
      );
    }
  }

  // 3. Large transfer
  const largeTransfer = detectLargeTransfer(parsed, address);
  if (largeTransfer) {
    makeAlert(
      'large_transfer',
      'warning',
      `Large transfer: ${largeTransfer.amount} ${largeTransfer.token} from ${largeTransfer.from?.slice(0, 8)}…`,
      largeTransfer
    );
  }

  // 4. New mint
  const mintEvent = detectNewMint(parsed, address);
  if (mintEvent) {
    makeAlert(
      'new_mint',
      'warning',
      `New tokens minted: ${mintEvent.amount} on ${mintEvent.mint?.slice(0, 8)}…`,
      mintEvent
    );
  }

  // 5. Account close
  if (detectAccountClose(parsed, address)) {
    makeAlert(
      'account_close',
      'high',
      `Account closed: ${address.slice(0, 12)}…`,
      { address }
    );
  }

  // 6. Suspicious CPI
  const cpiResult = detectSuspiciousCPI(parsed, address);
  if (cpiResult) {
    for (const targetProgram of cpiResult.unknownPrograms) {
      makeAlert(
        'suspicious_cpi',
        'warning',
        `Unknown CPI target ${targetProgram.slice(0, 8)}… from ${address.slice(0, 8)}…`,
        { targetProgram, sourceProgram: address }
      );
    }
  }

  return alerts;
}

module.exports = {
  evaluateTransaction,
  // Export pro testování
  detectAuthorityChange,
  detectProgramUpgrade,
  detectLargeTransfer,
  detectNewMint,
  detectAccountClose,
  detectSuspiciousCPI,
  LARGE_TRANSFER_SOL_LAMPORTS,
  LARGE_TRANSFER_TOKEN_AMOUNT,
};
