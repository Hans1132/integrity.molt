'use strict';
/**
 * src/scam-db/whitelist.js
 *
 * Whitelist legit Solana tokenů — applied PŘED scam_db match
 * jako defense in depth proti false positives v importovaných datasetech.
 *
 * Source: data/legit-tokens.json (50 manually curated tokens)
 */

const fs = require('fs');
const path = require('path');

const WHITELIST_PATH = path.join(__dirname, '..', '..', 'data', 'legit-tokens.json');

let _whitelist = null;
let _whitelistLoadedAt = null;

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    
    if (!Array.isArray(parsed.tokens)) {
      console.warn('[whitelist] legit-tokens.json missing tokens array');
      return new Map();
    }
    
    const map = new Map();
    for (const token of parsed.tokens) {
      if (token.mint && typeof token.mint === 'string') {
        map.set(token.mint, {
          symbol: token.symbol || null,
          name: token.name || null,
          category: token.category || null
        });
      }
    }
    
    _whitelistLoadedAt = Date.now();
    console.log(`[whitelist] loaded ${map.size} legit tokens from legit-tokens.json`);
    return map;
  } catch (err) {
    console.error('[whitelist] failed to load legit-tokens.json:', err.message);
    return new Map();
  }
}

function getWhitelist() {
  if (!_whitelist) {
    _whitelist = loadWhitelist();
  }
  return _whitelist;
}

function isWhitelisted(mint) {
  if (!mint || typeof mint !== 'string') return null;
  const wl = getWhitelist();
  return wl.get(mint) || null;
}

function whitelistSize() {
  return getWhitelist().size;
}

module.exports = { isWhitelisted, whitelistSize };
