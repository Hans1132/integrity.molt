#!/usr/bin/env node
'use strict';
/**
 * scripts/update-legit-tokens.js
 *
 * Stáhne top 200 Solana-ecosystem tokenů z CoinGecko a přidá nové do
 * data/legit-tokens.json (zachová stávající, nepřepisuje).
 *
 * Strategie:
 *   1. GET /coins/markets?...category=solana-ecosystem&per_page=200  → IDs + metadata
 *   2. GET /coins/list?include_platform=true                          → CG ID → Solana mint
 *   3. Merge s existujícím JSON, skip duplicity podle mint adresy
 *
 * Použití:
 *   node scripts/update-legit-tokens.js
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const LEGIT_PATH = path.join(__dirname, '..', 'data', 'legit-tokens.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'integrity-molt/1.0'
      }
    }, res => {
      if (res.statusCode === 429) {
        reject(new Error(`Rate limited (429) — čekej a zkus znovu`));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} pro ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// CoinGecko kategorie → naše kategorie
function mapCategory(cgCategories, symbol) {
  const sym = (symbol || '').toLowerCase();
  const cats = (cgCategories || []).map(c => (c || '').toLowerCase());

  if (cats.some(c => c.includes('stablecoin'))) return 'stablecoin';
  if (cats.some(c => c.includes('wrapped')))    return 'wrapped';
  if (cats.some(c => c.includes('meme')))       return 'memecoin';
  if (cats.some(c => c.includes('dex') || c.includes('amm') || c.includes('decentralized exchange'))) return 'dex';
  if (cats.some(c => c.includes('staking') || c.includes('liquid stake'))) return 'staking';
  if (cats.some(c => c.includes('defi')))       return 'defi';
  if (cats.some(c => c.includes('gaming') || c.includes('gamefi'))) return 'gamefi';
  if (cats.some(c => c.includes('nft')))        return 'nft';
  if (cats.some(c => c.includes('oracle')))     return 'oracle';
  if (cats.some(c => c.includes('bridge') || c.includes('wormhole') || c.includes('cross-chain'))) return 'bridged';
  if (cats.some(c => c.includes('depin') || c.includes('decentralized physical'))) return 'depin';
  if (cats.some(c => c.includes('launchpad') || c.includes('ido'))) return 'launchpad';
  if (cats.some(c => c.includes('perp') || c.includes('derivatives'))) return 'perps';
  if (cats.some(c => c.includes('infrastructure'))) return 'infrastructure';
  if (cats.some(c => c.includes('storage')))    return 'storage';
  if (cats.some(c => c.includes('social')))     return 'social';
  if (cats.some(c => c.includes('payment')))    return 'payments';

  // fallback na token symbol hints
  if (['sol','wsol'].includes(sym))             return 'wrapped';
  if (['usdc','usdt','dai','frax','usd'].some(s => sym.includes(s))) return 'stablecoin';

  return 'defi';
}

async function main() {
  // ── 1. Načti existující data ────────────────────────────────────────────────
  const existing = JSON.parse(fs.readFileSync(LEGIT_PATH, 'utf-8'));
  const existingMints = new Set(existing.tokens.map(t => t.mint));
  console.log(`[update-legit] Existující tokeny: ${existingMints.size}`);

  // ── 2. CoinGecko markets — top 200 Solana ecosystem ────────────────────────
  const MARKETS_URL =
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd&category=solana-ecosystem&order=market_cap_desc&per_page=200&page=1' +
    '&sparkline=false&price_change_percentage=24h';

  console.log('[update-legit] Stahuji markets list z CoinGecko...');
  let markets;
  try {
    markets = await httpGet(MARKETS_URL);
  } catch (e) {
    console.error('[update-legit] CHYBA při stahování markets:', e.message);
    process.exit(1);
  }
  console.log(`[update-legit] Markets: ${markets.length} tokenů`);
  await sleep(1500); // respektuj rate limit

  // ── 3. CoinGecko coins/list s platformami — mapování ID → Solana mint ──────
  const COINS_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
  console.log('[update-legit] Stahuji coins/list s platformami (může trvat ~10s)...');
  let coinsList;
  try {
    coinsList = await httpGet(COINS_LIST_URL);
  } catch (e) {
    console.error('[update-legit] CHYBA při stahování coins/list:', e.message);
    process.exit(1);
  }
  console.log(`[update-legit] coins/list: ${coinsList.length} tokenů celkem`);

  // Vytvoř mapu CoinGecko ID → Solana mint
  const cgIdToSolana = new Map();
  for (const coin of coinsList) {
    const solanaMint = coin.platforms?.solana;
    if (solanaMint && typeof solanaMint === 'string' && solanaMint.length > 30) {
      cgIdToSolana.set(coin.id, {
        mint:   solanaMint,
        symbol: coin.symbol?.toUpperCase() || '',
        name:   coin.name || ''
      });
    }
  }
  console.log(`[update-legit] Solana-mapovatelné tokeny: ${cgIdToSolana.size}`);

  // ── 4. Merge ────────────────────────────────────────────────────────────────
  const newTokens = [];
  let skipped = 0;

  for (const market of markets) {
    const mapped = cgIdToSolana.get(market.id);
    if (!mapped) { skipped++; continue; }
    if (existingMints.has(mapped.mint)) { skipped++; continue; }

    // CoinGecko /markets neposkytuje categories — použijeme symbol hint
    const category = mapCategory([], market.symbol);
    newTokens.push({
      mint:     mapped.mint,
      symbol:   mapped.symbol || market.symbol?.toUpperCase() || '',
      name:     market.name   || mapped.name,
      category
    });
    existingMints.add(mapped.mint); // dedup v rámci nových
  }

  console.log(`[update-legit] Nových tokenů k přidání: ${newTokens.length} (přeskočeno: ${skipped})`);

  if (newTokens.length === 0) {
    console.log('[update-legit] Žádné nové tokeny — legit-tokens.json beze změny.');
    return;
  }

  // ── 5. Zapis ────────────────────────────────────────────────────────────────
  existing._comment_2  = `+${newTokens.length} tokenů z CoinGecko top-200 Solana ecosystem`;
  existing._updated    = new Date().toISOString().slice(0, 10);
  existing.tokens      = [...existing.tokens, ...newTokens];

  fs.writeFileSync(LEGIT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[update-legit] legit-tokens.json aktualizován — celkem ${existing.tokens.length} tokenů`);

  // Výpis nových tokenů
  console.log('\nNové tokeny:');
  for (const t of newTokens.slice(0, 20)) {
    console.log(`  ${t.symbol.padEnd(12)} ${t.mint.slice(0,8)}...  [${t.category}]`);
  }
  if (newTokens.length > 20) {
    console.log(`  ... a dalších ${newTokens.length - 20}`);
  }
}

main().catch(e => {
  console.error('[update-legit] FATAL:', e.message);
  process.exit(1);
});
