const express = require('express');
const { spawn }  = require('child_process');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const { PRICING, PRICING_DISPLAY } = require('./config/pricing');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { PublicKey } = require('@solana/web3.js');
const Stripe = require('stripe');
const { scanEVMToken, SUPPORTED_CHAINS: EVM_CHAINS, getExplorerKey: evmGetKey, hasExplorerKey: evmHasKey } = require('./scanners/evm-token');
const { auditToken, getShowcaseReport } = require('./scanners/token-audit');
const { scanAgentToken }               = require('./scanners/agent-token-scanner');
const { generateReport, generatePDFBuffer, generatePNGBuffer } = require('./report-generator');
const authModule = require('./auth');
const { configureSession, setupStrategies, registerAuthRoutes } = authModule;
const { initUsersSchema } = db;
const { runWeeklyDigests, sendWelcomeEmail } = require('./mailer');
const { saveSnapshot, getLatestSnapshot, getSnapshotByTimestamp, getSnapshotHistory } = require('./src/delta/store');
const { isEvmAddress, isSolanaAddress } = require('./src/validation/address');
const { computeDelta } = require('./src/delta/diff');
const { signDeltaReport } = require('./src/delta/signing');
const { runAdversarialSim }  = require('./src/adversarial/runner');
const { getAllPlaybooks }     = require('./src/adversarial/playbooks');
const { verifyWebhookAuth, handleHeliusWebhook, registerRescanCallback } = require('./src/monitor/webhook-receiver');
const { initMonitor }        = require('./src/monitor/init');
const { runWithAdvisor }     = require('./src/llm/anthropic-advisor');
const { SECURITY_ANALYST_SYSTEM } = require('./src/llm/prompts/security-analyst');
const { lookupScamDb }       = require('./src/scam-db/lookup');
const { createQuotaMiddleware, createBlacklistMiddleware, GLOBAL_DAILY_CAP } = require('./src/middleware/free-quota');
// Initialized after db is required at line 7; db.db is the raw better-sqlite3 instance
const _quotaMw = createQuotaMiddleware(db.db);
const { checkFreeQuota, consumeFreeQuota, getQuotaStatus, isInternalCall } = _quotaMw;
const _blacklistMw = createBlacklistMiddleware(db.db);
const { checkBlacklist, logAbuseEvent, addToBlacklist } = _blacklistMw;
const { enrichScanResult, combineScores } = require('./src/enrichment');
const { parseTokenExtensionsFromBuffer }  = require('./src/enrichment/token-extensions');
const { calculateIRIS, formatIrisForLLM } = require('./src/features/iris-score');
const {
  validateReport,
  applyCorrectionsToAuditResult,
  buildLLMReportFromAuditResult,
  buildRawDataFromAuditResult,
  formatValidationStatus,
} = require('./src/validation/report-validator');

const https = require('https');
const nodemailer = require('nodemailer');

// ── Async Ed25519 signer — shared utility (src/crypto/sign.js) ───────────────
// Neblokuje event loop. Použij asyncSign() všude místo execSync sign-report.py.
const { asyncSign } = require('./src/crypto/sign');

// ── Async scan runner — nahrazuje execSync, neblokuje event loop ──────────────
// Spustí shell skript jako child_process, vrátí Promise<{ stdout, stderr }>.
// Timeout v ms; při překročení proces ukončí a rejectuje.
function runScript(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      reject(new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        reject(new Error(`Script exited with code ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Advisor helper — spustí LLM jen pokud score v šedé zóně (40-70) ──────────
// alwaysRun=true: ignoruje zónu (pro /scan/quick kde LLM nahrazuje celý report)
// Vrátí { text, advisorUsed, provider, signed } nebo null při skip/chybě.
async function runAdvisorIfGreyZone({ score, context, scanType, alwaysRun = false }) {
  const inGrey = typeof score === 'number' && score >= 40 && score <= 70;
  if (!alwaysRun && !inGrey) {
    // Skóre mimo šedou zónu — zaloguj jako not-invoked a skonči
    try { db.logAdvisorUsage(null, scanType, { advisorUsed: false, usage: {} }); } catch {}
    return null;
  }
  try {
    const result = await runWithAdvisor({ systemPrompt: SECURITY_ANALYST_SYSTEM, userMessage: context });
    let signed = null;
    try { signed = await asyncSign(result.text); } catch {}
    db.logAdvisorUsage(null, scanType, result);
    return { text: result.text, advisorUsed: result.advisorUsed, provider: result.provider, signed };
  } catch (e) {
    console.warn(`[advisor/${scanType}] failed (non-fatal):`, e.message);
    return null;
  }
}

// ── In-memory job store pro async bot advisor (TTL 10 min, max 100 jobů) ────────
const _botJobs = new Map(); // jobId → { chat_id, ts, endpoint }
function _botJobCleanup() {
  const now = Date.now();
  for (const [id, j] of _botJobs) {
    if (now - j.ts > 600_000) _botJobs.delete(id);
  }
  // FIFO eviction pokud přesáhne 100 záznamů
  if (_botJobs.size > 100) {
    const oldest = [..._botJobs.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [id] of oldest.slice(0, _botJobs.size - 100)) _botJobs.delete(id);
  }
}

// Načte nejnovější report soubory pro danou adresu (txt + signed.json).
// prefix = '' pro quick/deep, 'token-audit', 'wallet-profile', 'defi-pool', 'swarm'
function loadLatestReport(reportsDir, slug, prefix) {
  let files;
  try { files = fs.readdirSync(reportsDir).sort().reverse(); } catch { return {}; }
  const match = f => (!prefix || f.includes(prefix)) && f.includes(slug);
  const latestTxt    = files.find(f => match(f) && f.endsWith('.txt'));
  const latestSigned = files.find(f => match(f) && f.endsWith('.signed.json'));
  const reportText   = latestTxt    ? fs.readFileSync(path.join(reportsDir, latestTxt),    'utf-8') : null;
  let signedEnvelope = null;
  if (latestSigned) {
    try { signedEnvelope = JSON.parse(fs.readFileSync(path.join(reportsDir, latestSigned), 'utf-8')); } catch {}
  }
  return { reportText, signedEnvelope };
}

const VERIFY_KEY_PATH = '/root/.secrets/verify_key.bin';
const { SOLANA_RPC_URL: SOLANA_RPC } = require('./src/rpc');

// ── Konstanty pro quick-rpc scan ──────────────────────────────────────────────
const USDC_MINT       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT       = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
// Adresy mint/freeze authority pro known stablecoiny (nevlastní riziko)
const KNOWN_SAFE_AUTHORITIES = new Set([
  'BJE5MMbqXjVwjAF7oxwPYXnrXoUCCqyHR3Zmqd7f8eRj', // USDC mint authority (Circle)
  '3CCHpFBNeXRKwbEBnPVQD2PPzHdKNJwBuEBz3HUbkfHe', // USDT freeze authority
]);
// Tokeny s ověřenou legitimitou — přeskočí scam-db penalizaci (high-confidence false positives)
const KNOWN_LEGITIMATE_TOKENS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (Circle)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT (Tether)
  'So11111111111111111111111111111111111111112',      // Wrapped SOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',   // JUP
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',   // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // ETH (Wormhole)
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',  // BTC (Wormhole)
]);

/**
 * Parsuje mintAuthority a freezeAuthority z raw Buffer SPL token mint accountu.
 * SPL Token mint layout (82 bytes):
 *   [0-3]   mintAuthority option (LE u32, 0=None, 1=Some)
 *   [4-35]  mintAuthority pubkey (32 bytes)
 *   [36-43] supply (u64 LE)
 *   [44]    decimals (u8)
 *   [45]    isInitialized (bool)
 *   [46-49] freezeAuthority option (LE u32, 0=None, 1=Some)
 *   [50-81] freezeAuthority pubkey (32 bytes)
 */
function parseMintAuthorities(rawData) {
  if (!rawData || rawData.length < 82) {
    return { mintAuthority: null, freezeAuthority: null };
  }
  try {
    const mintAuthorityOpt   = rawData.readUInt32LE(0);
    const freezeAuthorityOpt = rawData.readUInt32LE(46);
    return {
      mintAuthority:   mintAuthorityOpt   === 1 ? new PublicKey(rawData.slice(4, 36)).toBase58()  : null,
      freezeAuthority: freezeAuthorityOpt === 1 ? new PublicKey(rawData.slice(50, 82)).toBase58() : null,
    };
  } catch {
    return { mintAuthority: null, freezeAuthority: null };
  }
}

// ── Quick RPC-only scan (no LLM, returns in ~1-2s) ────────────────────────────
async function quickScanRpcOnly(address) {
  const t0 = Date.now();

  // Three parallel calls: two RPC + scam-db lookup
  const [accountRes, sigRes, scamDbRes] = await Promise.allSettled([
    rpcPost({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [address, { encoding: 'base64', commitment: 'confirmed' }] }),
    rpcPost({ jsonrpc: '2.0', id: 2, method: 'getSignaturesForAddress',
      params: [address, { limit: 10, commitment: 'confirmed' }] }),
    lookupScamDb(address)
  ]);
  console.log(`[TIMING quick-rpc] parallel RPC: ${Date.now()-t0}ms`);

  const accountData = accountRes.status === 'fulfilled' ? accountRes.value?.result?.value : null;
  const signatures  = sigRes.status   === 'fulfilled' ? (sigRes.value?.result || []) : [];
  const scamDb      = scamDbRes.status === 'fulfilled' ? scamDbRes.value : { known_scam: null, rugcheck: null, db_match: false };

  if (!accountData) {
    const notFoundMsg = "This address doesn't exist on-chain yet. It may be invalid, not yet funded, or previously closed. Insufficient data for risk scoring.";
    return {
      risk_score:   null,
      risk_level:   'UNKNOWN',
      status:       'address_not_found',
      summary:      notFoundMsg,
      message:      notFoundMsg,
      risk_factors: [],
      checks:       {},
      evidence:     [],
      scan_type:    'quick-rpc',
      scan_ms:      Date.now()-t0,
      scam_db:      scamDb
    };
  }

  const lamports   = accountData.lamports || 0;
  const owner      = accountData.owner    || 'unknown';
  const executable = accountData.executable || false;
  const dataB64    = accountData.data?.[0] || '';
  const rawData    = dataB64 ? Buffer.from(dataB64, 'base64') : Buffer.alloc(0);
  const dataLen    = rawData.length;
  const solBalance = lamports / 1e9;

  // Known program IDs
  const TOKEN_PROG      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const STAKE_PROG      = 'Stake11111111111111111111111111111111111111112';
  const VOTE_PROG       = 'Vote111111111111111111111111111111111111111p';
  const SYS_PROG        = '11111111111111111111111111111111';

  const isMintAccount = (owner === TOKEN_PROG && dataLen === 82) || owner === TOKEN_2022_PROG;

  let addressType = 'wallet';
  if (executable) {
    addressType = 'on-chain program';
  } else if (owner === TOKEN_PROG) {
    addressType = dataLen === 82 ? 'SPL token mint' : 'SPL token account';
  } else if (owner === TOKEN_2022_PROG) {
    addressType = 'Token-2022 mint';
  } else if (owner === STAKE_PROG) {
    addressType = 'stake account';
  } else if (owner === VOTE_PROG) {
    addressType = 'validator vote account';
  } else if (owner === SYS_PROG) {
    addressType = 'system account (wallet)';
  }

  // ── Authority check (SPL token & Token-2022 mint accounts) ───────────────
  let mintAuthority   = null;
  let freezeAuthority = null;
  if (isMintAccount) {
    ({ mintAuthority, freezeAuthority } = parseMintAuthorities(rawData));
  }

  // ── Token-2022 extensions (parsujeme z dat, která už máme — bez extra RPC) ─
  const t2022Info = (owner === TOKEN_2022_PROG)
    ? parseTokenExtensionsFromBuffer(rawData)
    : { is_token_2022: false, extensions: [], extension_names: [] };

  // ── Token age: spolehlivý check — earliest tx v naší sadě 10 musí být starý
  // Pouze pro nové/neaktivní tokeny: pokud je celkový počet podpisů < 10
  // (vrácen méně než 10), token je velmi nový nebo neaktivní — age check relevantní.
  const firstBlockTime = signatures.length > 0 ? signatures[signatures.length - 1]?.blockTime : null;
  const isVeryNew = (signatures.length < 5) && firstBlockTime
    ? (Date.now() / 1000 - firstBlockTime) / 3600 < 24
    : false;

  // ── Risk scoring — base 0 ────────────────────────────────────────────────
  let score = 0;
  const riskFactors = [];

  // Known scam DB — nejvyšší priorita
  // Přeskočíme well-known legitimní tokeny (known false positives z datasetu)
  const isKnownLegitimate = KNOWN_LEGITIMATE_TOKENS.has(address);
  if (scamDb.known_scam && !isKnownLegitimate) {
    const conf = scamDb.known_scam.confidence_score || scamDb.known_scam.confidence || 0.5;
    score += 50;
    riskFactors.push(`Known scam database match ⚠️ (source: ${scamDb.known_scam.source}, confidence: ${conf.toFixed ? conf.toFixed(2) : conf})`);
  } else if (scamDb.known_scam && isKnownLegitimate) {
    // DB match ale token je legitimní — jen informativní
    riskFactors.push('No known scam match ✅ (verified legitimate token)');
  }
  if (scamDb.rugcheck?.rugged) {
    score += 35;
    riskFactors.push('RugCheck: token confirmed rugged ⚠️');
  } else if (scamDb.rugcheck?.risk_level === 'danger') {
    score += 20;
    riskFactors.push('RugCheck: danger level ⚠️');
  } else if (scamDb.rugcheck?.risk_level === 'warn') {
    score += 10;
    riskFactors.push('RugCheck: warn level ⚠️');
  }
  if (!scamDb.known_scam && !scamDb.rugcheck?.rugged) {
    riskFactors.push('No known scam match ✅');
  }

  // Authority checks
  if (isMintAccount) {
    const isKnownStablecoin = address === USDC_MINT || address === USDT_MINT;
    if (mintAuthority) {
      if (isKnownStablecoin) {
        riskFactors.push(`Mint authority: active (authorized issuer) ✅`);
      } else if (KNOWN_SAFE_AUTHORITIES.has(mintAuthority)) {
        riskFactors.push(`Mint authority: active (known safe issuer) ✅`);
      } else {
        score += 15;
        riskFactors.push(`Mint authority: active — creator can mint new tokens ⚠️`);
      }
    } else {
      riskFactors.push('Mint authority: revoked ✅');
    }

    if (freezeAuthority) {
      if (isKnownStablecoin) {
        riskFactors.push(`Freeze authority: active (stablecoin compliance feature) ✅`);
      } else {
        score += 5;
        riskFactors.push(`Freeze authority: active — creator can freeze accounts ⚠️`);
      }
    } else {
      riskFactors.push('Freeze authority: revoked ✅');
    }

    // Bonus pokud obě authority aktivní (plná kontrola tvůrce)
    if (mintAuthority && freezeAuthority && !isKnownStablecoin) {
      score += 5;
    }
  }

  // Token-2022 extensions
  if (t2022Info.is_token_2022 && t2022Info.extensions.length > 0) {
    for (const ext of t2022Info.extensions) {
      if (ext.severity === 'critical') {
        score += 30;
        riskFactors.push(`Token-2022: ${ext.name} — ${ext.description} ⚠️`);
      } else if (ext.severity === 'high') {
        score += 15;
        riskFactors.push(`Token-2022: ${ext.name} — ${ext.description} ⚠️`);
      } else if (ext.severity === 'medium') {
        score += 5;
        riskFactors.push(`Token-2022 extension: ${ext.name} ⚠️`);
      }
    }
    if (!t2022Info.has_critical && !t2022Info.has_high) {
      riskFactors.push(`Token-2022: ${t2022Info.extension_names.join(', ') || 'no risky extensions'} ✅`);
    }
  }

  // Token věk — pouze pro tokeny s < 5 podpisy (opravdu nové/neaktivní)
  if (isVeryNew) {
    score += 25;
    riskFactors.push('Token age: very new (< 24h, <5 total transactions) ⚠️');
  }

  // Zero balance
  if (lamports === 0) {
    riskFactors.push('Zero SOL balance — account may be closed or drained ⚠️');
    score += 20;
  }

  const recentTxCount = signatures.length;
  if (recentTxCount === 0 && lamports < 1_000_000) {
    riskFactors.push('No recent activity and minimal balance ⚠️');
    score += 10;
  }

  score = Math.min(score, 100);

  // Owner label
  const OWNER_NAMES = {
    [TOKEN_PROG]:      'Token Program',
    [TOKEN_2022_PROG]: 'Token-2022 Program',
    [STAKE_PROG]:      'Stake Program',
    [VOTE_PROG]:       'Vote Program',
    [SYS_PROG]:        'System Program'
  };
  const ownerLabel = OWNER_NAMES[owner] || (owner.slice(0, 12) + '…');

  const mintAuthLabel = !isMintAccount
    ? 'N/A'
    : mintAuthority ? 'active' : 'revoked';
  const freezeAuthLabel = !isMintAccount
    ? 'N/A'
    : freezeAuthority ? 'active' : 'revoked';

  const checks = {
    account_status:   { status: 'Active on-chain',              risk: 'safe' },
    account_type:     { status: addressType,                    risk: 'safe' },
    sol_balance:      { status: `${solBalance.toFixed(4)} SOL`, risk: lamports === 0 ? 'medium' : 'safe' },
    owner_program:    { status: ownerLabel,                     risk: 'safe' },
    mint_authority:   { status: mintAuthLabel,                  risk: mintAuthority && !['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(address) && isMintAccount ? 'medium' : 'safe' },
    freeze_authority: { status: freezeAuthLabel,                risk: freezeAuthority && isMintAccount && address !== USDC_MINT && address !== USDT_MINT ? 'low' : 'safe' },
    recent_activity:  {
      status: recentTxCount >= 10 ? '10+ recent txs' : `${recentTxCount} recent txs`,
      risk:   recentTxCount === 0 && lamports < 1_000_000 ? 'medium' : 'safe'
    },
    scam_db: {
      status: scamDb.known_scam
        ? `MATCH: ${scamDb.known_scam.source} (${scamDb.known_scam.scam_type || 'rug_pull'})`
        : scamDb.rugcheck ? `RugCheck: ${scamDb.rugcheck.risk_level}` : 'No match',
      risk: scamDb.db_match ? 'critical' : scamDb.rugcheck?.risk_level === 'warn' ? 'medium' : 'safe'
    }
  };

  if (t2022Info.is_token_2022) {
    checks.token_2022 = {
      status: t2022Info.extension_names.length > 0
        ? `Extensions: ${t2022Info.extension_names.join(', ')}`
        : 'Token-2022, no extensions',
      risk: t2022Info.has_critical ? 'critical' : t2022Info.has_high ? 'high' : 'safe'
    };
  }

  const riskLevel = score >= 71 ? 'critical' : score >= 46 ? 'high' : score >= 21 ? 'medium' : 'low';

  let summary;
  if (executable) {
    summary = `On-chain program with ${solBalance.toFixed(4)} SOL balance. ${recentTxCount >= 10 ? 'Actively used' : `${recentTxCount} recent transactions`}.`;
  } else if (isMintAccount) {
    const authSummary = mintAuthority ? 'Mint authority active' : 'Mint authority revoked';
    const freezeSummary = freezeAuthority ? ', freeze authority active' : ', freeze authority revoked';
    summary = `${addressType.charAt(0).toUpperCase() + addressType.slice(1)}. ${authSummary}${freezeSummary}. Owner: ${ownerLabel}.`;
    if (t2022Info.is_token_2022 && t2022Info.extension_names.length > 0) {
      summary += ` Token-2022 extensions: ${t2022Info.extension_names.join(', ')}.`;
    }
  } else {
    summary = `${riskLevel === 'low' ? 'Standard' : 'Flagged'} ${addressType}. Balance: ${solBalance.toFixed(4)} SOL. ${recentTxCount >= 10 ? '10+' : recentTxCount} recent transactions.`;
  }

  const evidence = signatures.slice(0, 5).map(s => ({
    signature: s.signature,
    slot:      s.slot,
    err:       s.err   || null,
    blockTime: s.blockTime || null
  }));

  return {
    risk_score:       score,
    risk_level:       riskLevel,
    summary,
    address_type:     addressType,
    sol_balance:      solBalance,
    owner_program:    owner,
    is_executable:    executable,
    recent_tx_count:  recentTxCount,
    mint_authority:   mintAuthority,
    freeze_authority: freezeAuthority,
    token_2022:       t2022Info.is_token_2022 ? t2022Info : null,
    risk_factors:     riskFactors,
    checks,
    evidence,
    scam_db:          scamDb,
    scan_type: 'quick-rpc',
    scan_ms:   Date.now()-t0
  };
}

function getVerifyKeyBase64() {
  try { return fs.readFileSync(VERIFY_KEY_PATH).toString('base64'); } catch { return null; }
}

// ── RPC rate limiter — token bucket, max 50 req/s, burst 100 ─────────────────
// Alchemy free tier: 660 CU/s (~330 req/s), nastavujeme konzervativně
const _rpcBucket = { tokens: 100, max: 100, refillRate: 50, lastRefill: Date.now() };
function _rpcAcquire() {
  const now = Date.now();
  const elapsed = (now - _rpcBucket.lastRefill) / 1000;
  _rpcBucket.tokens = Math.min(_rpcBucket.max, _rpcBucket.tokens + elapsed * _rpcBucket.refillRate);
  _rpcBucket.lastRefill = now;
  if (_rpcBucket.tokens >= 1) { _rpcBucket.tokens--; return 0; }
  // Čekání do dalšího dostupného tokenu (ms)
  return Math.ceil((1 - _rpcBucket.tokens) / _rpcBucket.refillRate * 1000);
}

function rpcPost(body) {
  return new Promise((resolve, reject) => {
    const wait = _rpcAcquire();
    const doRequest = () => {
      const data = JSON.stringify(body);
      const req = https.request(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(data);
      req.end();
    };
    if (wait <= 0) doRequest();
    else setTimeout(doRequest, wait);
  });
}


async function verifyPayment(xPaymentHeader, requiredMicroUsdc, resource) {
  // Decode the x402 payment header (base64 JSON envelope)
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf-8'));
  } catch {
    return { ok: false, reason: 'invalid x-payment header encoding' };
  }

  const sig = envelope.transaction || envelope.signature || envelope.txSignature || envelope.tx;
  if (!sig || typeof sig !== 'string') {
    return { ok: false, reason: 'no transaction signature in payment header' };
  }

  // Anti-replay: reject a signature that was already verified and used
  if (await db.isAlreadyUsed(sig)) {
    return { ok: false, reason: 'transaction already used' };
  }

  // Fetch transaction from RPC
  let txData;
  try {
    const resp = await rpcPost({
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]
    });
    txData = resp && resp.result;
  } catch (e) {
    return { ok: false, reason: `RPC error: ${e.message}` };
  }

  if (!txData) return { ok: false, reason: 'transaction not found or not yet confirmed' };
  if (txData.meta && txData.meta.err) return { ok: false, reason: 'transaction failed on-chain' };

  // Find net USDC credited to our wallet using pre/post token balances.
  // postTokenBalances entries include `owner` (wallet address) and `mint`, so we
  // do NOT check instruction destination (which is the ATA, not the wallet address).
  const preTokenBalances  = txData.meta?.preTokenBalances  || [];
  const postTokenBalances = txData.meta?.postTokenBalances || [];

  let transferredMicroUsdc = 0;
  for (const post of postTokenBalances) {
    if (post.mint !== USDC_MINT || post.owner !== WALLET) continue;
    const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
    const preAmt  = BigInt(pre?.uiTokenAmount?.amount  || '0');
    const postAmt = BigInt(post.uiTokenAmount?.amount  || '0');
    const delta = postAmt - preAmt;
    if (delta > 0n) transferredMicroUsdc += Number(delta);
  }

  const verified = transferredMicroUsdc >= requiredMicroUsdc;

  // Anti-replay (atomic claim): INSERT immediately after successful on-chain verification
  // and check the return value. The earlier isAlreadyUsed() call is only a fast-path
  // optimization — it is NOT safe against TOCTOU because the RPC round-trip between
  // that read and this insert gives parallel requests a wide window to all pass the
  // pre-check with the same sig. SQLite's INSERT OR IGNORE on a PRIMARY KEY is
  // serialized under a single writer lock, so exactly one caller sees r.changes === 1
  // and all concurrent racers see 0 → must be rejected.
  if (verified) {
    const reserved = db.markSignatureUsed(sig);
    if (!reserved) {
      console.warn('[anti-replay] race-rejected', JSON.stringify({
        sig, resource, action: 'race-rejected'
      }));
      return {
        ok: false,
        reason: 'transaction already used (race)',
        signature: sig,
        microUsdc: transferredMicroUsdc
      };
    }
    console.log('[anti-replay] reserved', JSON.stringify({
      sig, resource, action: 'reserved'
    }));
  }

  return {
    ok: verified,
    reason: verified
      ? 'payment confirmed'
      : `insufficient USDC: got ${transferredMicroUsdc} micro-USDC, need ${requiredMicroUsdc}`,
    signature: sig,
    microUsdc: transferredMicroUsdc
  };
}

const app = express();
app.set('trust proxy', 1); // důvěřuj NGINX reverse proxy — req.ip = skutečná IP klienta
const PORT = process.env.PORT || 3402;
const WALLET = process.env.SOLANA_WALLET_ADDRESS;
if (!WALLET) {
  console.error('FATAL: SOLANA_WALLET_ADDRESS env var is not set');
  process.exit(1);
}

// Derive the ATA (Associated Token Account) for USDC payments to our wallet.
// SPL token transfers must go to the ATA, not directly to the wallet address.
// x402 clients use this as the `payTo` destination for USDC transfers.
const USDC_ATA = (() => {
  try {
    return getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      new PublicKey(WALLET),
      false,             // allowOwnerOffCurve = false (normal wallet)
      TOKEN_PROGRAM_ID
    ).toBase58();
  } catch (e) {
    console.error('[payment] FATAL: cannot derive USDC ATA:', e.message);
    process.exit(1);
  }
})();
console.log(`[payment] USDC ATA for wallet ${WALLET}: ${USDC_ATA}`);

// ── Session + Passport middleware (before routes) ─────────────────────────────
setupStrategies();
configureSession(app);

// HTTP request logging do souboru (Apache combined format)
const LOG_DIR = process.env.LOG_DIR || '/var/log/intmolt';
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const accessLogStream = fs.createWriteStream(path.join(LOG_DIR, 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessLogStream }));

app.use(express.static('/root/x402-server/public', { extensions: ['html'] }));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

// Funnel tracking: loguje scan_started při příchodu requestu a report_viewed při 200 odpovědi.
function trackFunnel(resource) {
  return (req, res, next) => {
    db.logEvent({ name: 'scan_started', resource, ip: req.ip })
      .catch(e => console.error('[db] logEvent error:', e.message));
    res.on('finish', () => {
      if (res.statusCode === 200) {
        db.logEvent({ name: 'report_viewed', resource, ip: req.ip })
          .catch(e => console.error('[db] logEvent error:', e.message));
      }
    });
    next();
  };
}

// Middleware: ověří Bearer im_xxx API klíč; pokud platný, nastaví req.apiKey a pokračuje.
// Pokud klíč chybí nebo je neplatný (a header nezačíná im_), pokračuje k x402 ověření.
async function requireApiKey(req, res, next) {
  const auth = (req.headers['authorization'] || '').trim();
  if (!auth.startsWith('Bearer im_')) return next();
  const rawKey = auth.slice(7);
  try {
    const keyRecord = await db.validateApiKey(rawKey);
    if (!keyRecord) return res.status(401).json({ error: 'Invalid or revoked API key' });
    db.incrementApiKeyUsage(keyRecord.id).catch(() => {});
    req.apiKey = keyRecord;
  } catch (e) {
    console.error('[api-key] validation error:', e.message);
  }
  next();
}

function requirePayment(accepts, requiredMicroUsdc = 0) {
  return async (req, res, next) => {
    // Subscribers s platným API klíčem přeskočí x402 platební bránu
    if (req.apiKey) {
      req.paymentVerified = true;
      return next();
    }

    const resource = accepts[0]?.resource;
    const xPayment = req.headers['x-payment'];
    if (!xPayment) {
      db.logEvent({ name: 'payment_required', resource, ip: req.ip })
        .catch(e => console.error('[db] logEvent error:', e.message));
      return res.status(402).json({ x402Version: 1, error: 'X-PAYMENT header is required', accepts });
    }

    const result = await verifyPayment(xPayment, requiredMicroUsdc, resource);
    db.logPayment({
      tx_sig:              result.signature || `no-sig-${Date.now()}`,
      resource:            resource,
      required_micro_usdc: requiredMicroUsdc,
      micro_usdc:          result.microUsdc || 0,
      verified:            result.ok,
      reason:              result.reason,
      ip:                  req.ip
    }).catch(e => console.error('[db] logPayment error:', e.message));

    if (!result.ok) {
      console.log(`[payment] REJECTED: ${result.reason} sig=${result.signature}`);
      db.logEvent({ name: 'payment_failed', resource, ip: req.ip, meta: { reason: result.reason } })
        .catch(e => console.error('[db] logEvent error:', e.message));
      return res.status(402).json({
        x402Version: 1,
        error: 'Payment verification failed',
        detail: result.reason,
        accepts
      });
    }

    console.log(`[payment] VERIFIED: sig=${result.signature} micro_usdc=${result.microUsdc}`);
    db.logEvent({ name: 'payment_success', resource, ip: req.ip, meta: { micro_usdc: result.microUsdc } })
      .catch(e => console.error('[db] logEvent error:', e.message));
    req.paymentVerified = true;
    next();
  };
}

const quickPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.quick),
  resource: 'https://intmolt.org/api/v2/scan/quick',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Quick on-chain security scan of any Solana address',
  mimeType: 'application/json',
  maxTimeoutSeconds: 60,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v2/scan/quick',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { address: { type: 'string', description: 'Solana address to scan' } } }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { status: { type: 'string' }, report: { type: 'string' }, timestamp: { type: 'string' } } }
    }
  }
}];

const deepPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.deep),
  resource: 'https://intmolt.org/api/v2/scan/deep',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Comprehensive security audit with source code review and vulnerability assessment',
  mimeType: 'application/json',
  maxTimeoutSeconds: 120,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v2/scan/deep',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { address: { type: 'string', description: 'Solana address to audit' } } }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { status: { type: 'string' }, report: { type: 'string' }, timestamp: { type: 'string' } } }
    }
  }
}];

const tokenAuditPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.token),
  resource: 'https://intmolt.org/api/v2/scan/token',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Token launch audit: mint authority, freeze authority, top-10 holder distribution, supply analysis',
  mimeType: 'application/json',
  maxTimeoutSeconds: 90,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v2/scan/token',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { address: { type: 'string', description: 'Token mint address to audit' } } }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { status: { type: 'string' }, report: { type: 'string' }, timestamp: { type: 'string' } } }
    }
  }
}];

const walletProfilePaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.wallet),
  resource: 'https://intmolt.org/api/v2/scan/wallet',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Wallet profiling: age estimate, activity level, DeFi exposure, risk classification',
  mimeType: 'application/json',
  maxTimeoutSeconds: 60,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v2/scan/wallet',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { address: { type: 'string', description: 'Wallet address to profile' } } }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { status: { type: 'string' }, report: { type: 'string' }, timestamp: { type: 'string' } } }
    }
  }
}];

const poolScanPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.pool),
  resource: 'https://intmolt.org/api/v2/scan/pool',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'DeFi pool safety scan: liquidity depth, LP distribution, Raydium/Orca pool analysis',
  mimeType: 'application/json',
  maxTimeoutSeconds: 90,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v2/scan/pool',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { address: { type: 'string', description: 'DEX pool address to scan' } } }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: { status: { type: 'string' }, report: { type: 'string' }, timestamp: { type: 'string' } } }
    }
  }
}];

const evmTokenPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING['evm-token']),
  resource: 'https://intmolt.org/api/v2/scan/evm-token',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'EVM token risk scan — honeypot detection, source code analysis, ownership check',
  mimeType: 'application/json',
  maxTimeoutSeconds: 60,
  extra: {
    name: 'integrity.molt EVM Token Scan',
    chains: ['ethereum', 'bsc', 'polygon', 'arbitrum', 'base']
  }
}];

const evmScanPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING['evm-scan']),
  resource: 'https://intmolt.org/api/v2/scan/evm',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'EVM token risk scan — honeypot detection, source code analysis, ownership check',
  mimeType: 'application/json',
  maxTimeoutSeconds: 60,
  extra: {
    name: 'integrity.molt EVM Scan',
    chains: ['ethereum', 'bsc', 'polygon', 'arbitrum', 'base']
  }
}];

const contractAuditPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.contract),
  resource: 'https://intmolt.org/api/v2/scan/contract',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Contract Audit — static analysis (cargo-audit, clippy, semgrep), LLM-verified findings with CVE mapping and Immunefi impact assessment',
  mimeType: 'application/json',
  maxTimeoutSeconds: 600,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v2/scan/contract',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: {
        github_url:   { type: 'string', description: 'GitHub repository URL (https://github.com/owner/repo)' },
        project_name: { type: 'string', description: 'Optional project name for the report' }
      }, required: ['github_url'] }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'object', properties: {
        status:   { type: 'string' },
        findings: { type: 'array' },
        stats:    { type: 'object' },
        report:   { type: 'object' }
      } }
    }
  }
}];

const tokenSecurityAuditPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING['token-audit']),
  resource: 'https://intmolt.org/api/v1/scan/token-audit',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Token Security Audit — mint/freeze authority, supply distribution, treasury multisig check, Token-2022 extensions, Metaplex metadata, Beggars Allocation risk',
  mimeType: 'application/json',
  maxTimeoutSeconds: 90,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v1/scan/token-audit',
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'object',
        required: ['token_mint'],
        properties: {
          token_mint:  { type: 'string', description: 'Token mint address (base58)' },
          token_name:  { type: 'string', description: 'Optional token name for report labeling' },
          callback_url: { type: 'string', description: 'Optional webhook URL to receive the signed report' }
        }
      }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'object',
        properties: {
          status:      { type: 'string' },
          risk_score:  { type: 'number' },
          category:    { type: 'string', enum: ['SAFE', 'CAUTION', 'DANGER'] },
          summary:     { type: 'string' },
          findings:    { type: 'array' },
          signed:      { type: 'object' },
          timestamp:   { type: 'string' }
        }
      }
    }
  }
}];

// ── Agent Token Scan payment accepts (0.15 USDC = 150000 micro-USDC) ─────────
const agentTokenPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING['agent-token']),
  resource: 'https://intmolt.org/api/v1/scan/agent-token',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: USDC_ATA,
  description: 'Agent Token Security Scan — Metaplex Core NFT backing, treasury PDA, update authority, creator fees, DAO governance, activity analysis',
  mimeType: 'application/json',
  maxTimeoutSeconds: 60,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      url: 'https://intmolt.org/api/v1/scan/agent-token',
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'object',
        required: ['mint'],
        properties: {
          mint: { type: 'string', description: 'Metaplex Core asset address (base58)' }
        }
      }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'object',
        properties: {
          scan_type:      { type: 'string' },
          target:         { type: 'string' },
          score:          { type: 'number' },
          risk_level:     { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          findings:       { type: 'array' },
          agent_metadata: { type: 'object' },
          token_metrics:  { type: 'object' },
          signed:         { type: 'object' },
          timestamp:      { type: 'string' }
        }
      }
    }
  }
}];

// Logo - free
app.get('/logo.svg', (req, res) => { res.sendFile('/root/x402-ecosystem-submission/logo.svg'); });

// OpenAPI spec - runtime generated (single source of truth: config/pricing.js + src/docs/endpoint-spec.js)
const { generateOpenApi }         = require('./src/docs/generate-openapi');
const { generateX402Discovery }   = require('./src/docs/generate-x402-discovery');

app.get('/openapi.json', (req, res) => {
  try {
    res.json(generateOpenApi(USDC_ATA));
  } catch (e) {
    console.error('[openapi] generation failed:', e.message);
    res.status(500).json({ error: 'Failed to generate OpenAPI spec' });
  }
});

// x402 discovery - runtime generated
app.get('/.well-known/x402.json', (req, res) => {
  try {
    res.json(generateX402Discovery(USDC_ATA));
  } catch (e) {
    console.error('[x402-discovery] generation failed:', e.message);
    res.status(500).json({ error: 'Failed to generate x402 discovery document' });
  }
});

// ── A2A (Agent-to-Agent) protocol — Google A2A spec ──────────────────────────

const { handleA2ARequest, handleA2ASubscribe, buildAgentCard } = require('./src/a2a/handler');

// Agent card — machine-readable capability description for A2A discovery
// Three paths: canonical (A2A 0.4+), legacy alias (A2A 0.2), root alias (ElizaOS/MCP discovery)
const _buildAgentCardResponse = (req) => {
  const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return buildAgentCard(baseUrl);
};
app.get('/.well-known/agent.json',      (req, res) => res.json(_buildAgentCardResponse(req)));
app.get('/.well-known/agent-card.json', (req, res) => res.json(_buildAgentCardResponse(req)));
app.get('/agent.json',                  (req, res) => res.json(_buildAgentCardResponse(req)));

// JWKS endpoint — Ed25519 public key in JWK Set format (RFC 8037)
const _b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
app.get('/.well-known/jwks.json', (req, res) => {
  try {
    const keyBytes = fs.readFileSync(VERIFY_KEY_PATH);
    res.set('Content-Type', 'application/jwk-set+json');
    res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
    res.json({
      keys: [{
        kty: 'OKP',
        crv: 'Ed25519',
        use: 'sig',
        alg: 'EdDSA',
        kid: 'integrity-molt-primary-2026',
        x:   _b64url(keyBytes)
      }]
    });
  } catch (e) {
    console.error('[jwks] failed to read verify key:', e.message);
    res.status(500).json({ error: 'JWKS unavailable' });
  }
});

// A2A JSON-RPC 2.0 endpoint — tasks/send, tasks/get, tasks/cancel
const _a2aRL = new Map();
const _a2aRLMiddleware = (req, res, next) => {
  const ip = req.ip || '127.0.0.1';
  // 127.0.0.1 = internal calls from own services — exempt
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  const now = Date.now();
  const entry = _a2aRL.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart >= 60_000) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  _a2aRL.set(ip, entry);
  if (entry.count > 20) return res.status(429).json({ error: 'Rate limit exceeded (20 req/min per IP)' });
  next();
};
app.post('/a2a', express.json({ limit: '64kb' }), _a2aRLMiddleware, handleA2ARequest);

// A2A SSE streaming endpoint — POST /a2a/subscribe
// Body: { skill, address, sessionId?, metadata? }
// Response: text/event-stream with events: task_created, task_working, task_completed, task_failed
app.post('/a2a/subscribe', express.json({ limit: '16kb' }), handleA2ASubscribe);

// ── A2A Oracle MVP endpoints ──────────────────────────────────────────────────
// POST /verify/v1/signed-receipt   — free, Ed25519 receipt verification
// GET  /scan/v1/:address           — free, IRIS signed risk scan
// POST /monitor/v1/governance-change — 0.15 USDC, paid via x402
// GET  /feed/v1/new-spl-tokens     — free, pull feed of new SPL mints
const a2aOracleRouter = require('./src/routes/a2a-oracle');

// Governance endpoint payment accepts (0.15 USDC = 150_000 micro-USDC)
const governancePaymentAccepts = [{
  scheme:            'exact',
  network:           'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING['governance-change'] || 150_000),
  resource:          'https://intmolt.org/monitor/v1/governance-change',
  asset:             'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo:             USDC_ATA,
  description:       'Governance Change Detection — Ed25519-signed program audit over Helius transactions',
  mimeType:          'application/json',
  maxTimeoutSeconds: 60,
}];

// Apply payment middleware ONLY to the paid governance endpoint before mounting the router
app.post(
  '/monitor/v1/governance-change',
  requireApiKey,
  requirePayment(governancePaymentAccepts, PRICING['governance-change'] || 150_000)
);

// Mount oracle router — free routes handled by router's own rate limits
app.use(a2aOracleRouter);

// /.well-known/receipts-schema.json — static JSON Schema for oracle envelope format
app.get('/.well-known/receipts-schema.json', (req, res) => {
  res.set('Content-Type', 'application/schema+json');
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    '$schema': 'http://json-schema.org/draft-07/schema#',
    '$id': 'https://intmolt.org/.well-known/receipts-schema.json',
    title: 'integrity.molt Oracle Envelope (Flat Format)',
    description: [
      'Ed25519-signed oracle report in flat envelope format.',
      'All report fields and signing metadata appear at the top level of the response object.',
      'The signature covers UTF-8 bytes of JSON.stringify(reportData),',
      'where reportData = all response fields EXCEPT: signature, verify_key, key_id, signed_at, signer, algorithm, report.',
      'Verify using POST /verify/v1/signed-receipt — the server supports both flat and wrapped envelope formats.',
    ].join(' '),
    type: 'object',
    required: ['signature', 'verify_key', 'key_id', 'signed_at', 'signer', 'algorithm'],
    properties: {
      // ── Signing metadata (always present) ──────────────────────────────────
      signature: {
        type: 'string',
        description: 'Base64-encoded Ed25519 signature (64 bytes) over UTF-8 bytes of JSON.stringify(report data).'
      },
      verify_key: {
        type: 'string',
        description: 'Base64-encoded Ed25519 public key (32 bytes). Verify against /.well-known/jwks.json kid=integrity-molt-primary-2026.'
      },
      key_id: {
        type: 'string',
        description: 'First 16 characters of the base64-encoded verify_key. Key fingerprint.'
      },
      signed_at: {
        type: 'string',
        format: 'date-time',
        description: 'ISO8601 UTC timestamp when the signature was created.'
      },
      signer: {
        type: 'string',
        description: 'Signer identity string, e.g. "integrity.molt".'
      },
      algorithm: {
        type: 'string',
        enum: ['Ed25519'],
        description: 'Signing algorithm.'
      },
      // ── Typical report fields (endpoint-dependent, all included in signed bytes) ─
      address: {
        type: 'string',
        description: 'Solana or EVM address that was scanned (present on scan endpoints).'
      },
      iris_score: {
        type: 'number',
        description: 'IRIS risk score 0-100 (present on /scan/v1/:address).'
      },
      risk_level: {
        type: 'string',
        description: 'Risk classification: low | medium | high | critical (present on scan endpoints).'
      },
      risk_factors: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of detected risk factors.'
      },
      mints: {
        type: 'array',
        description: 'New SPL token mint events (present on /feed/v1/new-spl-tokens).'
      },
      findings: {
        type: 'array',
        description: 'Governance change findings (present on /monitor/v1/governance-change).'
      },
      verdict: {
        type: 'string',
        description: 'Governance verdict: clean | suspicious | critical.'
      }
    },
    examples: [
      {
        description: 'GET /scan/v1/:address response',
        value: {
          address:      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          iris_score:   12,
          risk_level:   'low',
          risk_factors: [],
          signed_at:    '2026-04-24T12:00:00Z',
          signature:    '<base64_64_bytes>',
          verify_key:   '<base64_32_bytes>',
          key_id:       '<first_16_chars>',
          signer:       'integrity.molt',
          algorithm:    'Ed25519',
        }
      },
      {
        description: 'POST /verify/v1/signed-receipt — flat envelope input',
        value: {
          envelope: {
            address:    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            iris_score: 12,
            risk_level: 'low',
            signature:  '<base64_64_bytes>',
            verify_key: '<base64_32_bytes>',
            key_id:     '<first_16_chars>',
            signed_at:  '2026-04-24T12:00:00Z',
            signer:     'integrity.molt',
            algorithm:  'Ed25519',
          }
        }
      }
    ]
  });
});

// Health check - free
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'integrity.molt security scanner', version: '1.0' });
});

// Service discovery - free
app.get('/services', (req, res) => {
  res.json({
    name: 'integrity.molt',
    description: 'AI-powered Solana security scanner',
    services: [
      {
        endpoint: 'POST /scan/quick',
        price: PRICING_DISPLAY.quick,
        description: 'Quick on-chain scan of a Solana address - account info, balance, basic risk assessment'
      },
      {
        endpoint: 'POST /scan/deep',
        price: PRICING_DISPLAY.deep,
        description: 'Comprehensive security audit - full code review, vulnerability assessment, detailed report'
      },
      {
        endpoint: 'POST /scan/token',
        price: PRICING_DISPLAY.token,
        description: 'Token launch audit - mint authority status, freeze authority status, top-10 holder distribution, supply analysis, rug risk rating'
      },
      {
        endpoint: 'POST /scan/wallet',
        price: PRICING_DISPLAY.wallet,
        description: 'Wallet profiling - age estimate, activity level, DeFi exposure, risk classification (fresh wallet / whale / dormant / normal)'
      },
      {
        endpoint: 'POST /scan/pool',
        price: PRICING_DISPLAY.pool,
        description: 'DeFi pool safety scan - liquidity depth, LP token distribution, Raydium/Orca/Meteora pool analysis, withdrawal risk'
      },
      {
        endpoint: 'POST /scan/contract',
        price: PRICING_DISPLAY.contract,
        description: 'Contract Audit — static analysis (cargo-audit CVEs, clippy, semgrep) + LLM-verified findings with Immunefi impact mapping. Input: GitHub URL of a Solana/Rust project.'
      },
      {
        endpoint: 'POST /scan/agent-token',
        price: PRICING_DISPLAY['agent-token'],
        description: 'Agent Token Security Scan — Metaplex Core NFT backing, treasury PDA, update authority, creator fees, DAO governance, activity (0.15 USDC)'
      },
      {
        endpoint: 'GET /api/v1/delta/:address',
        price: PRICING_DISPLAY.delta,
        description: 'Signed delta report — cryptographically signed diff between two security scans'
      },
      {
        endpoint: 'POST /api/v1/adversarial/simulate',
        price: PRICING_DISPLAY.adversarial,
        description: 'Adversarial simulation — forks on-chain state and probes exploit paths with 7 attack playbooks'
      }
    ],
    subscription: [
      {
        tier: 'pro_trader',
        price: '$15/month',
        description: '20 watchlist addresses, all alerts, Telegram + email notifications, weekly delta report, unlimited scans, signed reports',
        url: 'https://intmolt.org/subscribe/pro_trader'
      },
      {
        tier: 'builder',
        price: '$49/month',
        description: '100 watchlist addresses, all alerts + webhook, daily delta report, 1 adversarial sim/mo, API access (100 req/min), signed JSON reports, priority queue',
        url: 'https://intmolt.org/subscribe/builder'
      },
      {
        tier: 'team',
        price: '$299/month',
        description: '500 watchlist addresses, custom alert rules, unlimited adversarial sim, API (1000 req/min), SLA 99.5%, priority support',
        url: 'https://intmolt.org/subscribe/team'
      }
    ],
    x402: true,
    network: 'solana',
    payTo: USDC_ATA,
    reportSigning: {
      algorithm: 'Ed25519',
      verifyKey: getVerifyKeyBase64(),
      description: 'All scan reports are signed with Ed25519. Verify with /root/scanner/verify-report.py or any NaCl-compatible Ed25519 library.'
    }
  });
});

// Public reputation stats - free
async function buildStatsResponse() {
  const stats = await db.getLiveStats();
  return {
    total_scans:             stats.total_scans,
    scans_today:             stats.scans_today,
    success_rate_pct:        stats.success_rate_pct,
    average_response_time_ms: stats.average_response_time_ms || 0,
    // camelCase aliases pro kompatibilitu
    totalScans:       stats.total_scans,
    scansToday:       stats.scans_today,
    successRate:      stats.success_rate_pct,
    avgResponseTime:  stats.average_response_time_ms || 0,
  };
}

app.get('/stats/advisor', (req, res) => {
  try {
    const days  = Math.min(parseInt(req.query.days) || 30, 365);
    const stats = db.getAdvisorStats(days);
    res.json({ ok: true, days, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /email/capture — soft paywall email lead capture
app.post('/email/capture', express.json(), (req, res) => {
  const { email, source, scan_type } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  // Zaloguj jako event (db.logEvent je non-blocking)
  db.logEvent({ name: 'email_captured', resource: email, ip: req.ip,
    meta: JSON.stringify({ source: source || 'unknown', scan_type: scan_type || '' }) }).catch(() => {});
  res.json({ ok: true });
});

app.get('/stats',              async (req, res) => { try { res.json(await buildStatsResponse()); } catch { res.status(503).json({ error: 'Stats unavailable', total_scans: 0 }); } });
app.get('/api/v1/stats',       async (req, res) => { try { res.json(await buildStatsResponse()); } catch { res.status(503).json({ error: 'Stats unavailable', total_scans: 0 }); } });
app.get('/api/v2/stats',       async (req, res) => { try { res.json(await buildStatsResponse()); } catch { res.status(503).json({ error: 'Stats unavailable', total_scans: 0 }); } });
function handleQuotaRequest(req, res) {
  const ip = req.ip;
  const q  = getQuotaStatus(ip);
  res.json({
    scans_used:      q.used,
    scans_limit:     q.limit,
    scans_remaining: q.remaining,
    resets_at:       q.resets_at,
    global_used:     q.global_used,
    global_limit:    q.global_limit,
  });
}
app.get('/quota',        handleQuotaRequest);  // NGINX strips /api/v2/ prefix
app.get('/api/v1/quota', handleQuotaRequest);  // direct access (bypasses NGINX redirect)
app.get('/api/v1/stats/advisor', (req, res) => {
  try {
    const days  = Math.min(parseInt(req.query.days) || 30, 365);
    const stats = db.getAdvisorStats(days);
    res.json({ ok: true, days, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Abuse monitoring dashboard — requires ADMIN_TOKEN header
app.get('/admin/abuse-stats', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const rawDb = db.db;
  const globalToday = rawDb.prepare(
    'SELECT free_count, paid_count FROM global_scan_stats WHERE stat_date = ?'
  ).get(today) || { free_count: 0, paid_count: 0 };

  res.json({
    timestamp: new Date().toISOString(),
    global_today:        globalToday,
    cap_remaining:       GLOBAL_DAILY_CAP - globalToday.free_count,
    top_ips_today:       rawDb.prepare(
      'SELECT identifier as ip, count FROM free_scan_quota WHERE scan_date = ? ORDER BY count DESC LIMIT 20'
    ).all(today),
    blacklist_active:    rawDb.prepare(
      "SELECT ip, reason, added_at, expires_at, hit_count FROM ip_blacklist WHERE expires_at > datetime('now') ORDER BY added_at DESC"
    ).all(),
    abuse_events_24h:    rawDb.prepare(
      "SELECT event_type, COUNT(*) as count FROM abuse_events WHERE occurred_at > datetime('now', '-24 hours') GROUP BY event_type"
    ).all(),
    abuse_top_ips_24h:   rawDb.prepare(
      "SELECT ip, event_type, COUNT(*) as count FROM abuse_events WHERE occurred_at > datetime('now', '-24 hours') GROUP BY ip, event_type ORDER BY count DESC LIMIT 10"
    ).all(),
  });
});

// Accuracy monitoring — internal, no auth (add auth if exposed externally)
app.get('/api/v1/admin/accuracy', (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 720);
    res.json({ ok: true, ...db.getAccuracyStats(hours) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Helius webhook status — internal monitoring dashboard
app.get('/api/v1/admin/helius', (req, res) => {
  try {
    const fs   = require('fs');
    const path = require('path');

    const configPath  = path.join(__dirname, 'data/monitor/webhook-config.json');
    const backoffPath = path.join(__dirname, 'data/monitor/helius-backoff.json');

    let webhookConfig = {};
    try { webhookConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

    let backoff = null;
    try {
      const b = JSON.parse(fs.readFileSync(backoffPath, 'utf8'));
      backoff = { until: new Date(b.until).toISOString(), active: Date.now() < b.until, set: b.set };
    } catch {}

    // Počet webhook eventů za posledních 24h z DB
    let webhookEvents24h = 0;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      webhookEvents24h = db.db.prepare(
        `SELECT COUNT(*) as n FROM events WHERE name = 'helius_webhook' AND created_at > ?`
      ).get(since)?.n ?? 0;
    } catch {}

    res.json({
      ok:             true,
      webhook:        webhookConfig.webhookId ? {
        id:           webhookConfig.webhookId,
        addresses:    webhookConfig.addressCount || 0,
        updatedAt:    webhookConfig.updatedAt || webhookConfig.createdAt || null,
      } : null,
      circuit_breaker: backoff,
      events_24h:     webhookEvents24h,
      status:         backoff?.active ? 'credit_limit' : webhookConfig.webhookId ? 'active' : 'no_webhook',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// User feedback on scan result accuracy
app.post('/api/v1/feedback', express.json(), (req, res) => {
  const { mint, feedback, note } = req.body || {};
  const allowed = ['correct', 'false_positive', 'false_negative'];
  if (!mint || !allowed.includes(feedback)) {
    return res.status(400).json({ error: 'mint and feedback (correct|false_positive|false_negative) required' });
  }
  try {
    db.logUserFeedback(mint, feedback, note || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// IRIS-only scan — lightweight bot endpoint, rate-limited (10 req/min/IP)
// Calls enrichment + calculateIRIS without shell scripts or LLM — safe for internal bot use.
// 127.0.0.1 is exempt from rate limit (Moltbook heartbeat).
const _freeScanRL = new Map(); // IP → { count, windowStart }
const _legitTokens = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/legit-tokens.json'), 'utf8'));
    return new Set((raw.tokens || []).map(t => t.mint));
  } catch { return new Set(); }
})();
const validateSolanaAddress = (req, res, next) => {
  const address = (req.body?.address || req.body?.mint || req.body?.wallet || req.body?.pool || req.body?.target || req.params?.address || '').trim();
  if (!address) return res.status(400).json({ error: 'Missing address field in request body' });
  if (isEvmAddress(address)) {
    return res.status(400).json({
      error: 'evm_not_supported_on_solana_endpoint',
      message: 'This endpoint supports Solana only. For EVM tokens use POST /scan/evm-token or GET /scan/evm/:address',
      detected_chain: 'evm',
      supported_chains: ['ethereum', 'base', 'bsc', 'polygon', 'arbitrum'],
    });
  }
  if (!isSolanaAddress(address)) {
    return res.status(400).json({
      error: 'invalid_solana_address',
      message: 'Address does not match Solana base58 format (32-44 chars)',
    });
  }
  next();
};

app.post('/scan/iris', express.json(), checkBlacklist, validateSolanaAddress, async (req, res) => {
  const ip = req.ip || '127.0.0.1';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    const now = Date.now();
    const entry = _freeScanRL.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart >= 60_000) { entry.count = 0; entry.windowStart = now; }
    entry.count++;
    _freeScanRL.set(ip, entry);
    if (entry.count > 10) {
      return res.status(429).json({ error: 'Rate limit exceeded (10 req/min)' });
    }
  }

  const address = req.body?.address || req.body?.target;
  const safeAddress = address; // validated by validateSolanaAddress middleware

  if (!isInternalCall(req)) {
    const quota = getQuotaStatus(ip);
    if (quota.remaining <= 0) {
      return res.status(429).json({
        error:       'Daily free scan limit reached',
        message:     `You've used ${quota.used}/${quota.limit} free scans today. Limit resets at midnight UTC.`,
        used:        quota.used,
        limit:       quota.limit,
        remaining:   0,
        resets_at:   'midnight UTC',
        upgrade_url: 'https://intmolt.org/scan',
      });
    }
    consumeFreeQuota(ip);
  }

  try {
    const [enrichment, scamDb, accountRes] = await Promise.all([
      enrichScanResult(safeAddress).catch(() => null),
      lookupScamDb(safeAddress).catch(() => ({ known_scam: null, rugcheck: null, db_match: false })),
      rpcPost({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [safeAddress, { encoding: 'base64', commitment: 'confirmed' }] }).catch(() => null),
    ]);

    const accountData      = accountRes?.result?.value;
    const noEnrichmentData = !enrichment ||
      (!enrichment.external_sources?.rugcheck && !enrichment.external_sources?.solana_tracker);

    if (!accountData && noEnrichmentData) {
      return res.json({
        status:       'address_not_found',
        address:      safeAddress,
        risk_score:   null,
        risk_level:   'UNKNOWN',
        iris:         { score: null, grade: 'UNKNOWN', breakdown: null },
        message:      "This address doesn't exist on-chain yet. It may be invalid, not yet funded, or previously closed. Insufficient data for risk scoring.",
        risk_factors: [],
        timestamp:    new Date().toISOString(),
      });
    }

    const isWhitelisted = _legitTokens.has(safeAddress);
    // Whitelist přepíše false positive known_scam záznamy před scoring
    const scamDbForIris = isWhitelisted
      ? { ...scamDb, known_scam: null }
      : scamDb;
    const iris = calculateIRIS(enrichment, scamDbForIris);
    const scamDbOut = isWhitelisted
      ? { known_scam: false, whitelisted: true, note: 'Verified legitimate token', db_match: false }
      : { known_scam: scamDb.known_scam, rugcheck: scamDb.rugcheck, db_match: scamDb.db_match };

    let riskFactors = Array.isArray(iris.risk_factors) ? iris.risk_factors : [];
    if (isWhitelisted) {
      riskFactors = riskFactors.filter(f =>
        !f.toLowerCase().includes('scam') &&
        !f.toLowerCase().includes('rug') &&
        !f.toLowerCase().includes('suspicious')
      );
    }

    res.json({
      status:       'complete',
      address:      safeAddress,
      iris:         { score: iris.score, grade: iris.grade, breakdown: iris.breakdown },
      scam_db:      scamDbOut,
      risk_factors: riskFactors,
      timestamp:    new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

// Quick Scan - paid endpoint (0.50 USDC = 500000 micro-USDC)
app.post('/scan/quick', trackFunnel('quick'), requireApiKey, express.json(), validateSolanaAddress, requirePayment(quickPaymentAccepts, PRICING.quick), async (req, res) => {
  const address = (req.body.address || req.body.target || '').trim();
  const safeAddress = address; // validated by validateSolanaAddress middleware

  try {
    const _t0 = Date.now();

    // 0. RPC existence check — non-existent → UNKNOWN immediately (no LLM cost)
    const _accountCheck = await rpcPost({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [safeAddress, { encoding: 'base64', commitment: 'confirmed' }]
    }).catch(() => null);
    if (!_accountCheck?.result?.value) {
      const msg = "This address doesn't exist on-chain yet. It may be invalid, not yet funded, or previously closed.";
      return res.json({
        status:       'address_not_found',
        address:      safeAddress,
        risk_score:   null,
        risk_level:   'UNKNOWN',
        iris:         { score: null, grade: 'UNKNOWN', breakdown: null },
        message:      msg,
        risk_factors: [],
        timestamp:    new Date().toISOString()
      });
    }

    // 1. Shell skript + scam-db lookup + enrichment (paralelně)
    const [{ stdout }, scamDb, quickEnrichment] = await Promise.all([
      runScript('/root/scanner/quick-scan.sh', [safeAddress], 60000),
      lookupScamDb(safeAddress).catch(e => {
        console.warn('[scan/quick] scam-db lookup failed (non-fatal):', e.message);
        return { known_scam: null, rugcheck: null, db_match: false };
      }),
      enrichScanResult(safeAddress).catch(e => {
        console.warn('[scan/quick] enrichment failed (non-fatal):', e.message);
        return null;
      })
    ]);
    const scriptMs = Date.now() - _t0;
    const slug = safeAddress.substring(0, 10).toLowerCase();
    const { reportText: shellReport, signedEnvelope: shellSigned } = loadLatestReport('/root/scanner/reports', slug, '');
    const rawReport = shellReport || stdout;

    // IRIS score
    const irisResult = calculateIRIS(quickEnrichment, scamDb);

    // Příprava scam-db sekce pro LLM
    let scamDbSection = '';
    if (scamDb.known_scam) {
      const ks = scamDb.known_scam;
      scamDbSection += `\n⚠️ SCAM DATABASE MATCH:\n  Source: ${ks.source}\n  Type: ${ks.scam_type || 'rug_pull'}\n  Confidence: ${ks.confidence_score || ks.confidence}\n  Label: ${ks.label || 'n/a'}\n  Pattern: ${ks.rug_pattern || 'n/a'}\n`;
    }
    if (scamDb.rugcheck) {
      const rc = scamDb.rugcheck;
      scamDbSection += `\nRugCheck API:\n  Risk level: ${rc.risk_level}\n  Score: ${rc.score ?? 'n/a'}\n  Rugged: ${rc.rugged ? 'YES' : 'no'}\n`;
      if (rc.risks_json?.length) {
        scamDbSection += `  Risks: ${rc.risks_json.map(r => r.name || r).join(', ')}\n`;
      }
    }
    if (!scamDbSection) scamDbSection = '\nScam databases: No match found.\n';

    // IRIS sekce pro LLM
    const irisSection = `\n${formatIrisForLLM(irisResult)}\n`;

    // 2. Sonnet executor + Opus advisor — LLM analýza
    let advisorResult = null;
    let finalReport   = rawReport;
    let signedEnvelope = shellSigned;
    try {
      advisorResult = await runWithAdvisor({
        systemPrompt: SECURITY_ANALYST_SYSTEM,
        userMessage:  `Adresa: ${safeAddress}\n\nOn-chain data:\n${rawReport}${scamDbSection}${irisSection}`,
      });
      finalReport = advisorResult.text || rawReport;
      console.log(`[scan/quick] advisor=${advisorResult.provider} used=${advisorResult.advisorUsed} llmMs=${Date.now()-_t0-scriptMs}ms`);

      // 3. Ed25519 podpis advisor výstupu
      try {
        signedEnvelope = await asyncSign(finalReport);
      } catch (signErr) {
        console.warn('[scan/quick] signing failed (non-fatal):', signErr.message);
      }

      // 4. Logování advisor usage do DB (fire-and-forget)
      db.logAdvisorUsage(null, 'quick-paid', advisorResult);
    } catch (llmErr) {
      console.warn('[scan/quick] advisor failed, fallback na shell report:', llmErr.message);
    }

    console.log(`[scan/quick] address=${safeAddress} script=${scriptMs}ms total=${Date.now()-_t0}ms`);
    db.logScanToHistory({
      email: req.apiKey?.email || null, address: safeAddress, scan_type: 'quick-paid',
      risk_score: null, risk_level: null,
      summary: advisorResult?.text?.slice(0, 500) || null,
      cached: false, result_json: null
    }).catch(() => {});

    res.json({
      status:        'complete',
      address:       safeAddress,
      report:        finalReport,
      advisor_used:  advisorResult?.advisorUsed ?? false,
      provider:      advisorResult?.provider    ?? 'shell-only',
      signed:        signedEnvelope,
      scam_db:       scamDb,
      iris:          { score: irisResult.score, grade: irisResult.grade },
      timestamp:     new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

// Deep Audit - paid endpoint (5.00 USDC = 5000000 micro-USDC)
// Volá multi-agent swarm orchestrator (scanner → analyst → reputation → meta-scorecard)
app.post('/scan/deep', trackFunnel('deep'), requireApiKey, express.json(), validateSolanaAddress, requirePayment(deepPaymentAccepts, PRICING.deep), async (req, res) => {
  const address = (req.body.address || req.body.target || '').trim();
  const safeAddress = address; // validated by validateSolanaAddress middleware

  try {
    const _t0 = Date.now();
    // Swarm orchestrator + enrichment + scam-db in parallel (IRIS post-processing)
    const [swarmOut, deepEnrichment, deepScamDb] = await Promise.allSettled([
      runScript('/root/swarm/orchestrator/orchestrator.sh', [safeAddress], 120000),
      enrichScanResult(safeAddress),
      lookupScamDb(safeAddress)
    ]);
    const scriptMs = Date.now() - _t0;
    console.log(`[scan/deep] address=${safeAddress} script=${scriptMs}ms`);

    const { stdout } = swarmOut.status === 'fulfilled' ? swarmOut.value : { stdout: '' };
    const deepEnrichmentData = deepEnrichment.status === 'fulfilled' ? deepEnrichment.value : null;
    const deepScamDbData = deepScamDb.status === 'fulfilled' ? deepScamDb.value : { known_scam: null, rugcheck: null, db_match: false };

    let swarmResult = null;
    try { swarmResult = JSON.parse(stdout); } catch {}

    let reportText = null;
    let signedEnvelope = null;

    if (swarmResult?.report_file) {
      try { reportText = fs.readFileSync(swarmResult.report_file, 'utf-8'); } catch {}
    }
    if (swarmResult?.signed_file) {
      try { signedEnvelope = JSON.parse(fs.readFileSync(swarmResult.signed_file, 'utf-8')); } catch {}
    }

    // Fallback: nejnovější swarm report pro tuto adresu
    if (!reportText) {
      const slug = safeAddress.substring(0, 10).toLowerCase();
      const { reportText: ft, signedEnvelope: fs2 } = loadLatestReport('/root/scanner/reports', slug, 'swarm');
      reportText     = ft;
      signedEnvelope = signedEnvelope || fs2;
    }

    // IRIS full breakdown + raw enrichment pro deep audit
    const irisResult = calculateIRIS(deepEnrichmentData, deepScamDbData);

    db.logScanToHistory({
      email: req.apiKey?.email || null, address: safeAddress, scan_type: 'deep-audit',
      risk_score: swarmResult?.aggregate_score ?? null,
      risk_level: swarmResult?.decision || null,
      summary: null, cached: false, result_json: null
    }).catch(() => {});
    res.json({
      status: 'complete',
      tier: 'deep-audit',
      pipeline: 'swarm',
      address: safeAddress,
      decision:        swarmResult?.decision        || null,
      aggregate_score: swarmResult?.aggregate_score || null,
      rug_override:    swarmResult?.rug_override    || false,
      agents:          swarmResult?.agents          || null,
      iris:            irisResult,
      enrichment:      deepEnrichmentData || null,
      report:          reportText || stdout,
      signed:          signedEnvelope,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

// Token Audit - paid endpoint (0.75 USDC = 750000 micro-USDC)
app.post('/scan/token', trackFunnel('token'), requireApiKey, express.json(), validateSolanaAddress, requirePayment(tokenAuditPaymentAccepts, PRICING.token), async (req, res) => {
  const address = (req.body.address || req.body.mint || req.body.target || '').trim();
  const safeAddress = address; // validated by validateSolanaAddress middleware

  try {
    const _t0 = Date.now();
    // Run script, RugCheck enrichment, and scam-db lookup in parallel
    const [scriptResult, enrichmentResult, scamDbResult] = await Promise.allSettled([
      runScript('/root/scanner/enhanced-token-scan.sh', [safeAddress], 150000),
      enrichScanResult(safeAddress),
      lookupScamDb(safeAddress)
    ]);
    console.log(`[scan/token] address=${safeAddress} script=${Date.now()-_t0}ms`);
    const { stdout } = scriptResult.status === 'fulfilled' ? scriptResult.value : { stdout: '' };
    const enrichmentData = enrichmentResult.status === 'fulfilled' ? enrichmentResult.value : null;
    const scamDb = scamDbResult.status === 'fulfilled' ? scamDbResult.value : { known_scam: null, rugcheck: null, db_match: false };

    const slug = safeAddress.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope: shellSigned } = loadLatestReport('/root/scanner/reports', slug, 'enhanced-token');

    // Combine enrichment score with script score if both available
    let finalScore = data?.risk_score ?? null;
    if (enrichmentData?.aggregated_risk != null && typeof finalScore === 'number') {
      finalScore = combineScores(finalScore, enrichmentData.aggregated_risk);
    }

    // IRIS full breakdown
    const irisResult = calculateIRIS(enrichmentData, scamDb);

    // IRIS floor: pro staré/rugged tokeny shell vrací 0 ale IRIS zná DB signály.
    // Worst-case wins — bereme vyšší ze dvou skóre.
    if (typeof irisResult.score === 'number' && irisResult.score > (finalScore ?? 0)) {
      finalScore = irisResult.score;
      if (data) data = { ...data, risk_score: finalScore, risk_level: irisResult.grade.toLowerCase() };
    }

    // IRIS sekce pro advisor kontext
    const irisSection = `\n${formatIrisForLLM(irisResult)}\n`;

    // Advisor — šedá zóna 40-70
    const advisorCtx = `Token audit pro adresu ${safeAddress}:\n${JSON.stringify(data || { raw: stdout.slice(0, 2000) }, null, 2)}${irisSection}`;
    const adv = await runAdvisorIfGreyZone({ score: finalScore, context: advisorCtx, scanType: 'token' });

    db.logScanToHistory({
      email: req.apiKey?.email || null, address: safeAddress, scan_type: 'token',
      risk_score: finalScore ?? null, risk_level: data?.risk_level || null,
      summary: adv?.text?.slice(0, 500) || data?.summary || null, cached: false, result_json: null
    }).catch(() => {});

    const signed = adv?.signed || (data?.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : shellSigned);
    res.json({
      status:        'complete',
      type:          'enhanced-token-scan',
      scan_version:  '2.0',
      address:       safeAddress,
      data:          data || null,
      enrichment:    enrichmentData || null,
      risk_score:    finalScore,
      iris:          irisResult,
      report:        (!data && (reportText || stdout)) || null,
      advisor:       adv ? { text: adv.text, advisor_used: adv.advisorUsed, provider: adv.provider } : null,
      signed,
      timestamp:     new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Token scan failed', detail: err.message });
  }
});

// Wallet Deep Scan - paid endpoint (0.75 USDC = 750000 micro-USDC)
app.post('/scan/wallet', trackFunnel('wallet'), requireApiKey, express.json(), validateSolanaAddress, requirePayment(walletProfilePaymentAccepts, PRICING.wallet), async (req, res) => {
  const address = (req.body.address || req.body.wallet || req.body.target || '').trim();
  const safeAddress = address; // validated by validateSolanaAddress middleware

  try {
    const _t0 = Date.now();

    // Parallel: shell script + scamDb + RPC existence check + enrichment
    const [{ stdout }, scamDb, accountRes, enrichmentData] = await Promise.all([
      runScript('/root/scanner/wallet-deep-scan.sh', [safeAddress], 120000),
      lookupScamDb(safeAddress).catch(() => ({ known_scam: null, rugcheck: null, db_match: false })),
      rpcPost({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [safeAddress, { encoding: 'base64', commitment: 'confirmed' }] }).catch(() => null),
      enrichScanResult(safeAddress).catch(() => null),
    ]);
    console.log(`[scan/wallet] address=${safeAddress} script=${Date.now()-_t0}ms`);

    // Non-existent address → UNKNOWN
    const accountData = accountRes?.result?.value;
    if (!accountData) {
      return res.json({
        status: 'address_not_found', address: safeAddress,
        risk_score: null, risk_level: 'UNKNOWN',
        message: "This address doesn't exist on-chain.",
        timestamp: new Date().toISOString()
      });
    }

    const slug = safeAddress.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope: shellSigned } = loadLatestReport('/root/scanner/reports', slug, 'wallet-deep');

    // IRIS scoring with whitelist isolation
    const isWhitelisted   = _legitTokens.has(safeAddress);
    const scamDbForIris   = isWhitelisted ? { ...scamDb, known_scam: null } : scamDb;
    const irisResult      = calculateIRIS(enrichmentData, scamDbForIris);
    let finalScore        = data?.risk_score ?? null;

    if (isWhitelisted) {
      // Whitelisted → IRIS wins as an upper bound (prevents false HIGH from wrong scan type)
      if (typeof irisResult.score === 'number' && (finalScore === null || irisResult.score < finalScore)) {
        finalScore = irisResult.score;
        if (data) data = { ...data, risk_score: finalScore, risk_level: irisResult.grade.toLowerCase() };
      }
    } else if (typeof irisResult.score === 'number' && irisResult.score > (finalScore ?? 0)) {
      // Non-whitelisted → IRIS floor: worst-case wins
      finalScore = irisResult.score;
      if (data) data = { ...data, risk_score: finalScore, risk_level: irisResult.grade.toLowerCase() };
    }

    const advisorCtx = `Wallet profiling pro adresu ${safeAddress}:\n${JSON.stringify(data || { raw: stdout.slice(0, 2000) }, null, 2)}`;
    const adv = await runAdvisorIfGreyZone({ score: finalScore, context: advisorCtx, scanType: 'wallet' });

    const signed = adv?.signed || (data?.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : shellSigned);
    res.json({
      status:       'complete',
      type:         'wallet-deep-scan',
      scan_version: '2.0',
      address:      safeAddress,
      data:         data || null,
      report:       (!data && (reportText || stdout)) || null,
      advisor:      adv ? { text: adv.text, advisor_used: adv.advisorUsed, provider: adv.provider } : null,
      signed,
      timestamp:    new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Wallet scan failed', detail: err.message });
  }
});

// Pool Deep Scan - paid endpoint (0.75 USDC = 750000 micro-USDC)
app.post('/scan/pool', trackFunnel('pool'), requireApiKey, express.json(), validateSolanaAddress, requirePayment(poolScanPaymentAccepts, PRICING.pool), async (req, res) => {
  const address = (req.body.address || req.body.pool || req.body.target || '').trim();
  const safeAddress = address; // validated by validateSolanaAddress middleware

  try {
    const _t0 = Date.now();

    // Parallel: shell script + scamDb + RPC existence check + enrichment
    const [{ stdout }, scamDb, accountRes, enrichmentData] = await Promise.all([
      runScript('/root/scanner/pool-deep-scan.sh', [safeAddress], 120000),
      lookupScamDb(safeAddress).catch(() => ({ known_scam: null, rugcheck: null, db_match: false })),
      rpcPost({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [safeAddress, { encoding: 'base64', commitment: 'confirmed' }] }).catch(() => null),
      enrichScanResult(safeAddress).catch(() => null),
    ]);
    console.log(`[scan/pool] address=${safeAddress} script=${Date.now()-_t0}ms`);

    // Non-existent address → UNKNOWN
    const accountData = accountRes?.result?.value;
    if (!accountData) {
      return res.json({
        status: 'address_not_found', address: safeAddress,
        risk_score: null, risk_level: 'UNKNOWN',
        message: "This address doesn't exist on-chain.",
        timestamp: new Date().toISOString()
      });
    }

    const slug = safeAddress.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope: shellSigned } = loadLatestReport('/root/scanner/reports', slug, 'pool-deep');

    // IRIS scoring with whitelist isolation
    const isWhitelisted   = _legitTokens.has(safeAddress);
    const scamDbForIris   = isWhitelisted ? { ...scamDb, known_scam: null } : scamDb;
    const irisResult      = calculateIRIS(enrichmentData, scamDbForIris);
    let finalScore        = data?.risk_score ?? null;

    if (isWhitelisted) {
      // Whitelisted → IRIS wins as an upper bound (prevents false HIGH from wrong scan type)
      if (typeof irisResult.score === 'number' && (finalScore === null || irisResult.score < finalScore)) {
        finalScore = irisResult.score;
        if (data) data = { ...data, risk_score: finalScore, risk_level: irisResult.grade.toLowerCase() };
      }
    } else if (typeof irisResult.score === 'number' && irisResult.score > (finalScore ?? 0)) {
      // Non-whitelisted → IRIS floor: worst-case wins
      finalScore = irisResult.score;
      if (data) data = { ...data, risk_score: finalScore, risk_level: irisResult.grade.toLowerCase() };
    }

    const advisorCtx = `Pool scan pro adresu ${safeAddress}:\n${JSON.stringify(data || { raw: stdout.slice(0, 2000) }, null, 2)}`;
    const adv = await runAdvisorIfGreyZone({ score: finalScore, context: advisorCtx, scanType: 'pool' });

    const signed = adv?.signed || (data?.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : shellSigned);
    res.json({
      status:       'complete',
      type:         'pool-deep-scan',
      scan_version: '2.0',
      address:      safeAddress,
      data:         data || null,
      report:       (!data && (reportText || stdout)) || null,
      advisor:      adv ? { text: adv.text, advisor_used: adv.advisorUsed, provider: adv.provider } : null,
      signed,
      timestamp:    new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Pool scan failed', detail: err.message });
  }
});

// EVM Token Risk Scan - paid endpoint (0.75 USDC = 750000 micro-USDC)
app.post('/scan/evm-token', trackFunnel('evm-token'), requireApiKey, requirePayment(evmTokenPaymentAccepts, PRICING['evm-token']), express.json(), async (req, res) => {
  const address = (req.body?.address || '').trim();
  const chain   = (req.body?.chain   || 'ethereum').trim().toLowerCase();

  if (!address) return res.status(400).json({ error: 'Missing address field' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid EVM address format (expected 0x + 40 hex chars)' });
  }
  if (!EVM_CHAINS.includes(chain)) {
    return res.status(400).json({ error: `Invalid chain — use ${EVM_CHAINS.join('|')}` });
  }

  let scanResult;
  const _tEvmScan = Date.now();
  try {
    scanResult = await scanEVMToken(address, chain);
    console.log(`[scan/evm-token] address=${address} chain=${chain} scan=${Date.now()-_tEvmScan}ms`);
  } catch (err) {
    return res.status(500).json({ error: 'EVM scan failed', detail: err.message });
  }

  // Build text report for signing
  const reportLines = [
    '=== integrity.molt EVM Token Scan ===',
    `Date:     ${new Date().toISOString()}`,
    `Chain:    ${chain}`,
    `Address:  ${address}`,
    '',
    `Name:     ${scanResult.meta.name    || 'unknown'}`,
    `Symbol:   ${scanResult.meta.symbol  || 'unknown'}`,
    `Decimals: ${scanResult.meta.decimals ?? 'unknown'}`,
    `Supply:   ${scanResult.meta.totalSupply || 'unknown'}`,
    `Owner:    ${scanResult.meta.owner   || 'unknown'}`,
    `Verified: ${scanResult.meta.verified}`,
    `Contract: ${scanResult.meta.contractName || 'N/A'}`,
    `Deployer: ${scanResult.meta.deployer || 'unknown'}`,
    `Age:      ${scanResult.meta.ageDays != null ? scanResult.meta.ageDays + ' days' : 'unknown'}`,
    `Proxy:    ${scanResult.meta.isProxy}`,
    '',
    `Risk Score:     ${scanResult.score} / 100`,
    `Recommendation: ${scanResult.recommendation}`,
    '',
    '--- Findings ---'
  ];
  for (const f of scanResult.findings) {
    reportLines.push(`[${f.severity.toUpperCase()}] [${f.category}] ${f.label}`);
  }
  if (!scanResult.findings.length) reportLines.push('No significant findings.');
  reportLines.push('');
  reportLines.push('---');
  reportLines.push('Report signed with Ed25519. Verify: python3 /root/scanner/verify-report.py <signed.json>');
  reportLines.push('This is an automated static analysis. Not a full security audit.');
  const reportText = reportLines.join('\n');

  // Advisor — šedá zóna 40-70
  const evmCtx = `EVM token scan ${chain}/${address}:\nScore: ${scanResult.score}\nRecommendation: ${scanResult.recommendation}\nFindings:\n${scanResult.findings.map(f=>`[${f.severity}] ${f.label}`).join('\n')}\nMeta: ${JSON.stringify(scanResult.meta)}`;
  const adv = await runAdvisorIfGreyZone({ score: scanResult.score, context: evmCtx, scanType: 'evm-token' });

  // Sign: pokud advisor běžel, podepíše jeho text; jinak původní reportText
  let signedEnvelope = adv?.signed || null;
  if (!signedEnvelope) {
    try { signedEnvelope = await asyncSign(reportText); } catch {}
  }
  console.log(`[scan/evm-token] address=${address} chain=${chain} advisor=${adv?.advisorUsed ?? 'skip'}`);

  res.json({
    status:          'complete',
    type:            'evm-token-scan',
    chain,
    address,
    score:           scanResult.score,
    recommendation:  scanResult.recommendation,
    findings:        scanResult.findings,
    meta:            scanResult.meta,
    report:          adv?.text || reportText,
    advisor:         adv ? { text: adv.text, advisor_used: adv.advisorUsed, provider: adv.provider } : null,
    signed:          signedEnvelope,
    timestamp:       new Date().toISOString()
  });
});

// ── GET /scan/evm/:address — EVM scan (0.75 USDC, x402) ──────────────────────
// Alias pro /api/v2/scan/evm/:address — address v URL, chain v ?chain= query param
// Příklad: GET /api/v2/scan/evm/0xdAC17F958D2ee523a2206206994597C13D831ec7?chain=ethereum
// Etherscan v2 — jeden klíč pro všechny chainy
function evmPreValidate(req, res, next) {
  const address = (req.params.address || '').trim();
  const chain   = (req.query.chain    || 'ethereum').trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.status(400).json({ error: 'Invalid EVM address (expected 0x + 40 hex chars)' });
  if (!EVM_CHAINS.includes(chain))
    return res.status(400).json({ error: `Invalid chain — use ${EVM_CHAINS.join('|')}` });
  if (!evmHasKey(chain))
    return res.status(400).json({ error: `API key not configured for ${chain}`, hint: 'Set ETHERSCAN_API_KEY in server .env' });
  next();
}
app.get('/scan/evm/:address', trackFunnel('evm-scan'), evmPreValidate, requireApiKey, requirePayment(evmScanPaymentAccepts, PRICING['evm-scan']), async (req, res) => {
  const address = (req.params.address || '').trim();
  const chain   = (req.query.chain    || 'ethereum').trim().toLowerCase();

  const _t = Date.now();
  let scanResult;
  try {
    scanResult = await scanEVMToken(address, chain);
    console.log(`[scan/evm] address=${address} chain=${chain} scan=${Date.now()-_t}ms`);
  } catch (err) {
    return res.status(500).json({ error: 'EVM scan failed', detail: err.message });
  }

  // Build report text
  const reportLines = [
    '=== integrity.molt EVM Token Scan ===',
    `Date:     ${new Date().toISOString()}`,
    `Chain:    ${chain} (${scanResult.meta.chainLabel || chain})`,
    `Address:  ${address}`,
    '',
    `Name:     ${scanResult.meta.name     || 'unknown'}`,
    `Symbol:   ${scanResult.meta.symbol   || 'unknown'}`,
    `Decimals: ${scanResult.meta.decimals ?? 'unknown'}`,
    `Supply:   ${scanResult.meta.totalSupply || 'unknown'}`,
    `Owner:    ${scanResult.meta.owner    || 'unknown'}`,
    `Verified: ${scanResult.meta.verified}`,
    `Contract: ${scanResult.meta.contractName || 'N/A'}`,
    `Deployer: ${scanResult.meta.deployer || 'unknown'}`,
    `Age:      ${scanResult.meta.ageDays != null ? scanResult.meta.ageDays + ' days' : 'unknown'}`,
    `Proxy:    ${scanResult.meta.isProxy}`,
    '',
    `Risk Score:     ${scanResult.score} / 100`,
    `Recommendation: ${scanResult.recommendation}`,
    '',
    '--- Findings ---'
  ];
  for (const f of scanResult.findings) {
    reportLines.push(`[${f.severity.toUpperCase()}] [${f.category}] ${f.label}`);
  }
  if (!scanResult.findings.length) reportLines.push('No significant findings.');
  reportLines.push('');
  reportLines.push('---');
  reportLines.push('Report signed with Ed25519. Verify: python3 /root/scanner/verify-report.py <signed.json>');
  reportLines.push('This is an automated static analysis. Not a full security audit.');
  const reportText = reportLines.join('\n');

  // Advisor — šedá zóna
  const evmCtx2 = `EVM token scan ${chain}/${address}:\nScore: ${scanResult.score}\nRecommendation: ${scanResult.recommendation}\nFindings:\n${scanResult.findings.map(f=>`[${f.severity}] ${f.label}`).join('\n')}\nMeta: ${JSON.stringify(scanResult.meta)}`;
  const adv2 = await runAdvisorIfGreyZone({ score: scanResult.score, context: evmCtx2, scanType: 'evm-scan' });

  let signedEnvelope = adv2?.signed || null;
  if (!signedEnvelope) {
    try { signedEnvelope = await asyncSign(reportText); } catch {}
  }
  console.log(`[scan/evm] address=${address} chain=${chain} advisor=${adv2?.advisorUsed ?? 'skip'}`);

  res.json({
    status:          'complete',
    type:            'evm-token-scan',
    chain,
    address,
    score:           scanResult.score,
    recommendation:  scanResult.recommendation,
    findings:        scanResult.findings,
    meta:            scanResult.meta,
    report:          adv2?.text || reportText,
    advisor:         adv2 ? { text: adv2.text, advisor_used: adv2.advisorUsed, provider: adv2.provider } : null,
    signed:          signedEnvelope,
    timestamp:       new Date().toISOString()
  });
});

// Contract Audit - paid endpoint (5.00 USDC = 5000000 micro-USDC)
// POST /scan/contract
// Body: { github_url, project_name? }
// Spouští bounty-hunter/deep-scan.sh: cargo-audit + clippy + semgrep + LLM verification
app.post('/scan/contract', trackFunnel('contract'), requireApiKey, requirePayment(contractAuditPaymentAccepts, PRICING.contract), express.json(), async (req, res) => {
  const rawUrl     = (req.body?.github_url || '').trim();
  const projName   = (req.body?.project_name || '').trim().replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 64) || 'unknown';

  if (!rawUrl) return res.status(400).json({ error: 'Missing github_url field' });

  // Povolíme jen github.com a gitlab.com URL
  if (!/^https?:\/\/(github\.com|gitlab\.com)\/[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+(\.git)?(\/?|\/tree\/[^\s]*)$/.test(rawUrl)) {
    return res.status(400).json({ error: 'Invalid GitHub/GitLab URL. Expected: https://github.com/owner/repo' });
  }

  const DEEP_SCAN = '/root/bounty-hunter/deep-scan.sh';
  const t0 = Date.now();
  console.log(`[scan/contract] starting: ${rawUrl} (${projName})`);

  try {
    const { stdout, stderr } = await runScript('bash', [DEEP_SCAN, rawUrl, projName], 600_000);
    const elapsed = Date.now() - t0;
    console.log(`[scan/contract] done in ${elapsed}ms: ${rawUrl}`);

    // Parsuj výstupní cestu z stdout: "  → Output: /path/to/file.json"
    const outMatch = stdout.match(/→ Output:\s*(\S+\.json)/);
    let report = null;
    let signature = null;

    if (outMatch?.[1]) {
      try {
        report = JSON.parse(fs.readFileSync(outMatch[1], 'utf-8'));
        signature = report.signature || null;
      } catch (e) {
        console.error('[scan/contract] Failed to read output JSON:', e.message);
      }
    }

    if (!report) {
      return res.status(500).json({ error: 'Scan completed but output not found', detail: stderr.slice(0, 300) });
    }

    res.json({
      status:       'complete',
      tier:         'contract-audit',
      github_url:   rawUrl,
      project_name: report.metadata?.project_name || projName,
      language:     report.metadata?.language || null,
      pipeline:     report.metadata?.pipeline || [],
      stats:        report.stats || {},
      findings:     report.findings || [],
      signature:    signature,
      scan_ms:      elapsed,
      timestamp:    new Date().toISOString(),
    });
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.error(`[scan/contract] failed after ${elapsed}ms: ${err.message}`);
    res.status(500).json({ error: 'Contract audit failed', detail: err.message });
  }
});

// ── Token Security Audit — paid endpoint (0.75 USDC = 750000 micro-USDC) ──────
// POST /api/v1/scan/token-audit
// Body: { token_mint, token_name?, callback_url? }
app.post(
  '/api/v1/scan/token-audit',
  trackFunnel('token-security-audit'),
  requireApiKey,
  requirePayment(tokenSecurityAuditPaymentAccepts, PRICING['token-audit']),
  express.json(),
  async (req, res) => {
    const { token_mint, token_name, callback_url } = req.body || {};

    if (!token_mint) return res.status(400).json({ error: 'Missing token_mint field in request body' });

    const safeMint = token_mint.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeMint || safeMint.length < 32 || safeMint.length > 44) {
      return res.status(400).json({ error: 'Invalid Solana address format for token_mint' });
    }

    const safeTokenName = token_name ? String(token_name).slice(0, 64).replace(/[^\w\s.\-]/g, '') : null;

    try {
      const _t0 = Date.now();
      const auditResult = await auditToken(safeMint, safeTokenName);

      // Validation layer — po LLM analýze, před Ed25519 podpisem
      const _llmReport = buildLLMReportFromAuditResult(auditResult);
      const _rawData   = buildRawDataFromAuditResult(auditResult);
      const _validation = validateReport(_llmReport, _rawData);
      const _corrCount  = applyCorrectionsToAuditResult(auditResult, _validation.issues);
      const _validStatus = formatValidationStatus(_validation, _corrCount);
      try {
        db.logValidationIssues({
          mint:             safeMint,
          scanType:         'token-audit',
          valid:            _validation.valid,
          issues:           _validation.issues,
          correctionsCount: _corrCount,
        });
      } catch (vLogErr) {
        console.warn('[scan/token-audit] validation log failed (non-fatal):', vLogErr.message);
      }

      console.log(`[scan/token-audit] mint=${safeMint} scan=${Date.now()-_t0}ms score=${auditResult.risk_score} category=${auditResult.category} validation=${_validStatus}`);

      // Build text report for signing
      const reportLines = [
        '=== integrity.molt Token Security Audit ===',
        `Date:         ${new Date().toISOString()}`,
        `Mint:         ${safeMint}`,
        `Token:        ${auditResult.token_name}`,
        '',
        `Risk Score:   ${auditResult.risk_score} / 100`,
        `Category:     ${auditResult.category}`,
        '',
        `Summary:      ${auditResult.summary}`,
        '',
        `Mint Authority:   ${auditResult.detail?.mint_info?.mint_authority  || 'n/a'}`,
        `Freeze Authority: ${auditResult.detail?.mint_info?.freeze_authority || 'n/a'}`,
        `Supply:           ${auditResult.detail?.mint_info?.supply           || 'n/a'}`,
        `Decimals:         ${auditResult.detail?.mint_info?.decimals         ?? 'n/a'}`,
        `Token-2022:       ${auditResult.detail?.mint_info?.is_token_2022    ?? false}`,
        '',
        '--- Supply Concentration ---',
        `Top 1 holder:  ${auditResult.detail?.concentration?.top1_pct  ?? 'n/a'}%`,
        `Top 3 holders: ${auditResult.detail?.concentration?.top3_pct  ?? 'n/a'}%`,
        `Top 10 holders:${auditResult.detail?.concentration?.top10_pct ?? 'n/a'}%`,
        '',
        '--- Treasury Analysis ---',
        `Treasury wallet:  ${auditResult.detail?.treasury?.identified_treasury?.owner || 'not identified'}`,
        `Is multisig:      ${auditResult.detail?.treasury?.is_multisig ?? 'unknown'}`,
        `Drain risk:       ${auditResult.detail?.treasury?.drain_risk  || 'n/a'}`,
        '',
        '--- Findings ---'
      ];

      for (const f of auditResult.findings) {
        reportLines.push(`[${f.severity.toUpperCase()}] [${f.category}] ${f.label}${f.detail ? ' — ' + f.detail : ''}`);
      }
      if (!auditResult.findings.length) reportLines.push('No findings.');
      reportLines.push('');
      reportLines.push('--- Known Database Matches ---');
      const dbMatches = auditResult.db_matches || [];
      if (dbMatches.length) {
        for (const m of dbMatches) {
          reportLines.push(`[${m.source.toUpperCase()}] ${m.label || m.type}`);
          if (m.risks && m.risks.length) {
            for (const r of m.risks.slice(0, 5)) {
              reportLines.push(`  • [${r.level}] ${r.name}${r.description ? ': ' + r.description : ''}`);
            }
          }
        }
      } else {
        reportLines.push('No matches found in scam databases.');
      }
      reportLines.push('');
      reportLines.push('--- Key Risks ---');
      for (const r of (auditResult.key_risks || [])) reportLines.push(`• ${r}`);
      reportLines.push('');
      reportLines.push('--- Recommendations ---');
      for (const r of (auditResult.recommendations || [])) reportLines.push(`• ${r}`);
      reportLines.push('');
      reportLines.push('---');
      reportLines.push('Report signed with Ed25519. Verify: python3 /root/scanner/verify-report.py <signed.json>');
      reportLines.push('This is an automated static analysis. Not a substitute for a full manual security audit.');

      const reportText = reportLines.join('\n');

      // Sign report with Ed25519 (async — neblokuje event loop)
      const _tSign = Date.now();
      let signedEnvelope = null;
      try {
        signedEnvelope = await asyncSign(reportText);
      } catch (e) {
        console.error('[scan/token-audit] signing failed:', e.message);
      }
      console.log(`[scan/token-audit] mint=${safeMint} signing=${Date.now()-_tSign}ms`);

      // Save snapshot for delta tracking; attach delta if a previous snapshot exists.
      const snapshotData = {
        risk_score:  auditResult.risk_score,
        category:    auditResult.category,
        summary:     auditResult.summary,
        findings:    auditResult.findings,
        detail:      auditResult.detail,
        key_risks:   auditResult.key_risks
      };
      const prevSnap = getLatestSnapshot(safeMint, 'token-audit');
      const snapMeta = saveSnapshot(safeMint, 'token-audit', snapshotData);

      let deltaSection = null;
      if (prevSnap) {
        try {
          const newSnap = { data: snapshotData, address: safeMint, scanType: 'token-audit', timestamp: snapMeta.timestamp, contentHash: snapMeta.contentHash };
          deltaSection  = await buildDeltaReport(prevSnap, newSnap);
        } catch (e) {
          console.error('[scan/token-audit] delta computation failed:', e.message);
        }
      }

      const response = {
        status:          'complete',
        type:            'token-security-audit',
        scan_version:    '1.0',
        mint_address:    safeMint,
        token_name:      auditResult.token_name,
        risk_score:      auditResult.risk_score,
        category:        auditResult.category,
        summary:         auditResult.summary,
        key_risks:       auditResult.key_risks,
        recommendations: auditResult.recommendations,
        findings:        auditResult.findings,
        detail:          auditResult.detail,
        report:          reportText,
        signed:          signedEnvelope,
        delta:           deltaSection,
        verify_instructions: signedEnvelope ? {
          method:  'Ed25519',
          command: 'python3 /root/scanner/verify-report.py <path-to-signed.json>',
          key_id:  signedEnvelope.key_id,
          note:    'verify_key field in the signed envelope is the base64-encoded Ed25519 public key'
        } : null,
        scan_ms:             auditResult.scan_ms,
        timestamp:           new Date().toISOString(),
        validated:           _validation.valid,
        corrections_applied: _corrCount,
      };

      // Optional callback webhook
      if (callback_url) {
        try {
          const cbUrl = new URL(callback_url);
          // Only allow https callbacks
          if (cbUrl.protocol === 'https:') {
            fetch(callback_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': 'integrity.molt/1.0' },
              body: JSON.stringify(response),
              signal: AbortSignal.timeout(15000)
            }).catch(e => console.error('[scan/token-audit] callback failed:', e.message));
          }
        } catch {}
      }

      res.json(response);
    } catch (err) {
      console.error('[scan/token-audit] error:', err.message);
      res.status(500).json({ error: 'Token audit failed', detail: err.message });
    }
  }
);

// GET /api/v1/token-audit/showcase — public demo report (free, no payment required)
app.get('/api/v1/token-audit/showcase', (req, res) => {
  const showcase = getShowcaseReport();
  res.json({
    status:  'showcase',
    message: 'This is a pre-computed example Token Security Audit report. Run a live audit for any Molt.id token via POST /api/v1/scan/token-audit (0.75 USDC via x402).',
    pricing: {
      price:    '0.75 USDC',
      method:   'x402 micropayment or Bearer API key',
      endpoint: 'POST /api/v1/scan/token-audit',
      body:     '{ "token_mint": "<mint_address>", "token_name": "<optional>" }'
    },
    example_report: showcase,
    features: [
      'Mint authority status (renounced = fixed supply)',
      'Freeze authority check (can holders be frozen?)',
      'Top-10 holder supply concentration',
      'Treasury multisig vs single-key risk',
      'Beggars Allocation drain risk analysis',
      'Token-2022 extension audit (transfer fees, permanent delegates)',
      'Metaplex metadata legitimacy check',
      'Ed25519-signed report for tamper-proof verification',
      'LLM-generated risk summary (SAFE / CAUTION / DANGER)'
    ]
  });
});

// ── Agent Token Scan — paid endpoint (0.15 USDC = 150000 micro-USDC) ──────────
// POST /api/v1/scan/agent-token
// Body: { mint }
app.post(
  '/api/v1/scan/agent-token',
  trackFunnel('agent-token'),
  requireApiKey,
  requirePayment(agentTokenPaymentAccepts, PRICING['agent-token']),
  express.json(),
  async (req, res) => {
    const { mint } = req.body || {};

    if (!mint) return res.status(400).json({ error: 'Missing mint field in request body' });

    const safeMint = mint.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeMint || safeMint.length < 32 || safeMint.length > 44) {
      return res.status(400).json({ error: 'Invalid Solana address format for mint' });
    }

    try {
      const _t0   = Date.now();
      const result = await scanAgentToken(safeMint);
      console.log(`[scan/agent-token] mint=${safeMint} scan=${Date.now()-_t0}ms score=${result.score} risk=${result.risk_level}`);

      // Build text report for signing
      const reportLines = [
        '=== integrity.molt Agent Token Security Scan ===',
        `Date:       ${new Date().toISOString()}`,
        `Asset:      ${safeMint}`,
        `Domain:     ${result.domain || 'n/a'}`,
        '',
        `Risk Score: ${result.score} / 100`,
        `Risk Level: ${result.risk_level}`,
        '',
        `Summary:    ${result.summary}`,
        '',
        '--- Agent Metadata ---',
        `Metaplex Core:      ${result.agent_metadata?.is_metaplex_core ?? 'n/a'}`,
        `Update Authority:   ${result.agent_metadata?.update_authority || 'none'}`,
        `Authority Risk:     ${result.agent_metadata?.update_authority_risk || 'n/a'}`,
        `Creator Fees (bps): ${result.agent_metadata?.creator_fees_bps ?? 0}`,
        `Treasury PDA:       ${result.agent_metadata?.treasury_address || 'n/a'}`,
        `Treasury Lamports:  ${result.agent_metadata?.treasury_lamports ?? 0}`,
        `Mutable:            ${result.agent_metadata?.is_mutable ?? 'n/a'}`,
        `Frozen:             ${result.agent_metadata?.is_frozen ?? 'n/a'}`,
        '',
        '--- Findings ---',
        ...result.findings.map(f => `[${f.severity.toUpperCase()}] (${f.category}) ${f.title}: ${f.detail}`),
        '',
        '---',
        'Report signed with Ed25519. Verify: python3 /root/scanner/verify-report.py <signed.json>',
        'This is an automated static analysis. Not a substitute for a full manual security audit.'
      ];
      const reportText = reportLines.join('\n');

      // Sign report with Ed25519
      let signedEnvelope = null;
      try {
        signedEnvelope = await asyncSign(reportText);
      } catch (e) {
        console.error('[scan/agent-token] signing failed:', e.message);
      }

      res.json({
        status:          'complete',
        type:            'agent-token-scan',
        scan_version:    '1.0',
        scan_type:       result.scan_type,
        target:          result.target,
        domain:          result.domain,
        score:           result.score,
        risk_level:      result.risk_level,
        summary:         result.summary,
        findings:        result.findings,
        agent_metadata:  result.agent_metadata,
        token_metrics:   result.token_metrics,
        report:          reportText,
        signed:          signedEnvelope,
        verify_instructions: signedEnvelope ? {
          method:  'Ed25519',
          command: 'python3 /root/scanner/verify-report.py <path-to-signed.json>',
          key_id:  signedEnvelope.key_id,
          note:    'verify_key field in the signed envelope is the base64-encoded Ed25519 public key'
        } : null,
        scan_ms:   result.scan_ms,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error('[scan/agent-token] error:', err.message);
      res.status(500).json({ error: 'Agent token scan failed', detail: err.message });
    }
  }
);

// ── Adversarial Simulation ─────────────────────────────────────────────────────
// GET  /api/v1/adversarial/playbooks          — list all playbooks (free)
// POST /api/v1/adversarial/simulate           — run simulation (paid, 10.00 USDC)

const adversarialPaymentAccepts = [{
  scheme:            'exact',
  network:           'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.adversarial),
  resource:          'https://intmolt.org/api/v1/adversarial/simulate',
  asset:             'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo:             USDC_ATA,
  description:       'AI-powered adversarial simulation — forks on-chain state and systematically probes exploit paths',
  mimeType:          'application/json',
  maxTimeoutSeconds: 360,
  outputSchema: {
    input: {
      type:   'http',
      method: 'POST',
      url:    'https://intmolt.org/api/v1/adversarial/simulate',
      headers: { 'Content-Type': 'application/json' },
      body: {
        type:     'object',
        required: ['program_id'],
        properties: {
          program_id:   { type: 'string', description: 'Solana program address (base58)' },
          playbook_ids: { type: 'array',  items: { type: 'string' }, description: 'Optional: restrict to specific playbook IDs' },
          skip_fork:    { type: 'boolean', description: 'Skip local validator fork (analysis-only, faster)' }
        }
      }
    },
    output: {
      type: 'http',
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'object',
        properties: {
          type:        { type: 'string' },
          program_id:  { type: 'string' },
          summary:     { type: 'object' },
          signature:   { type: 'string' },
          verify_key:  { type: 'string' }
        }
      }
    }
  }
}];

// GET /api/v1/adversarial/playbooks — free, returns all playbook definitions
app.get('/api/v1/adversarial/playbooks', (req, res) => {
  res.json({
    count:     getAllPlaybooks().length,
    playbooks: getAllPlaybooks().map(p => ({
      id:                  p.id,
      name:                p.name,
      description:         p.description,
      severity_if_success: p.severity_if_success,
      cwe:                 p.cwe,
      steps:               p.steps
    }))
  });
});

// POST /api/v1/adversarial/simulate — paid: run adversarial simulation
app.post(
  '/api/v1/adversarial/simulate',
  trackFunnel('adversarial'),
  requireApiKey,
  requirePayment(adversarialPaymentAccepts, PRICING.adversarial),
  express.json(),
  async (req, res) => {
    const { program_id, playbook_ids, skip_fork } = req.body || {};

    if (!program_id) return res.status(400).json({ error: 'Missing program_id field' });

    const safeProgramId = String(program_id).replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeProgramId || safeProgramId.length < 32 || safeProgramId.length > 44) {
      return res.status(400).json({ error: 'Invalid Solana program address format' });
    }

    const safePlaybookIds = Array.isArray(playbook_ids)
      ? playbook_ids.map(id => String(id).replace(/[^\w_-]/g, '')).filter(Boolean)
      : [];

    const _t0 = Date.now();
    console.log(`[adversarial] simulation requested for program=${safeProgramId} skip_fork=${!!skip_fork}`);

    try {
      const report = await runAdversarialSim(safeProgramId, {
        playbookIds: safePlaybookIds,
        skipFork:    !!skip_fork,
        rpcPort:     8899
      });

      db.logEvent({
        name:     'adversarial_simulation_complete',
        resource: safeProgramId,
        ip:       req.ip,
        meta:     { overall_risk: report.summary?.overall_risk, ms: Date.now() - _t0 }
      }).catch(() => {});

      console.log(`[adversarial] done in ${Date.now() - _t0}ms risk=${report.summary?.overall_risk}`);
      res.json({ status: 'complete', ...report });
    } catch (err) {
      console.error('[adversarial] simulation failed:', err.message);
      res.status(500).json({ error: 'Adversarial simulation failed', detail: err.message });
    }
  }
);

// ── Verified Delta Reports ─────────────────────────────────────────────────────
// GET  /api/v1/history/:address        — snapshot list (metadata, free)
// GET  /api/v1/delta/:address          — delta vs. latest snapshot (paid)
// GET  /api/v1/delta/:address/:ts1/:ts2 — delta between two specific snapshots (paid)

const deltaPaymentAccepts = [{
  scheme:           'exact',
  network:          'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: String(PRICING.delta),
  resource:         'https://intmolt.org/api/v1/delta',
  asset:            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo:            USDC_ATA,
  description:      'Verified Delta Report — cryptographically signed diff between two Solana security scans',
  mimeType:         'application/json',
  maxTimeoutSeconds: 120
}];

// Build and sign a delta report from two snapshots.
// Returns the full signed delta report object.
async function buildDeltaReport(oldSnap, newSnap) {
  const changes = await computeDelta(oldSnap, newSnap);

  const critical = changes.filter(c => c.severity === 'critical').length;
  const warnings = changes.filter(c => c.severity === 'warning').length;

  const report = {
    type:        'delta_report',
    version:     1,
    address:     newSnap.address,
    scan_type:   newSnap.scanType,
    baseline:    { timestamp: oldSnap.timestamp, contentHash: oldSnap.contentHash, scanType: oldSnap.scanType },
    current:     { timestamp: newSnap.timestamp, contentHash: newSnap.contentHash, scanType: newSnap.scanType },
    changes,
    summary:     { total_changes: changes.length, critical, warnings, info: changes.length - critical - warnings },
    generated_at: new Date().toISOString()
  };

  return await signDeltaReport(report);
}

// GET /api/v1/history/:address — free, returns snapshot metadata list
app.get('/api/v1/history/:address', async (req, res) => {
  const raw = (req.params.address || '').trim();
  const safeAddress = raw.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana address' });
  }

  const limit   = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const history = getSnapshotHistory(safeAddress, limit);
  res.json({ address: safeAddress, count: history.length, snapshots: history });
});

// GET /api/v1/delta/:address — paid: delta between latest two snapshots for same scanType
app.get(
  '/api/v1/delta/:address',
  requireApiKey,
  requirePayment(deltaPaymentAccepts, PRICING.delta),
  async (req, res) => {
    const raw = (req.params.address || '').trim();
    const safeAddress = raw.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    const scanType = (req.query.type || 'token-audit').trim();

    // Run a fresh scan first so we always compare against live data
    let freshReport;
    try {
      const auditResult = await auditToken(safeAddress);
      freshReport = {
        risk_score: auditResult.risk_score,
        category:   auditResult.category,
        summary:    auditResult.summary,
        findings:   auditResult.findings,
        detail:     auditResult.detail,
        key_risks:  auditResult.key_risks
      };
    } catch (e) {
      console.error('[delta] fresh scan failed:', e.message);
      return res.status(500).json({ error: 'Fresh scan failed', detail: e.message });
    }

    const oldSnap = getLatestSnapshot(safeAddress, scanType);

    // Save the new snapshot regardless
    const newMeta = saveSnapshot(safeAddress, scanType, freshReport);
    const newSnap = { data: freshReport, address: safeAddress, scanType, timestamp: newMeta.timestamp, contentHash: newMeta.contentHash };

    if (!oldSnap) {
      return res.json({
        first_scan:  true,
        address:     safeAddress,
        scan_type:   scanType,
        snapshot:    { timestamp: newMeta.timestamp, contentHash: newMeta.contentHash },
        report:      freshReport,
        message:     'No baseline found. This snapshot is now stored as the baseline for future delta reports.'
      });
    }

    try {
      const deltaReport = await buildDeltaReport(oldSnap, newSnap);
      db.logEvent({ name: 'delta_report_generated', resource: safeAddress, ip: req.ip }).catch(() => {});
      res.json({ status: 'complete', delta: deltaReport, report: freshReport });
    } catch (e) {
      console.error('[delta] buildDeltaReport failed:', e.message);
      res.status(500).json({ error: 'Delta computation failed', detail: e.message });
    }
  }
);

// GET /api/v1/delta/:address/:timestamp1/:timestamp2 — paid: delta between two specific snapshots
app.get(
  '/api/v1/delta/:address/:ts1/:ts2',
  requireApiKey,
  requirePayment(deltaPaymentAccepts, PRICING.delta),
  async (req, res) => {
    const raw = (req.params.address || '').trim();
    const safeAddress = raw.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    const ts1 = decodeURIComponent(req.params.ts1 || '');
    const ts2 = decodeURIComponent(req.params.ts2 || '');

    const snap1 = getSnapshotByTimestamp(safeAddress, ts1);
    const snap2 = getSnapshotByTimestamp(safeAddress, ts2);

    if (!snap1) return res.status(404).json({ error: `Snapshot not found for timestamp: ${ts1}` });
    if (!snap2) return res.status(404).json({ error: `Snapshot not found for timestamp: ${ts2}` });

    // Ensure chronological order (snap1 = older)
    const [oldSnap, newSnap] = snap1.timestamp <= snap2.timestamp
      ? [snap1, snap2]
      : [snap2, snap1];

    try {
      const deltaReport = await buildDeltaReport(oldSnap, newSnap);
      db.logEvent({ name: 'delta_report_generated', resource: safeAddress, ip: req.ip }).catch(() => {});
      res.json({ status: 'complete', delta: deltaReport });
    } catch (e) {
      console.error('[delta] buildDeltaReport failed:', e.message);
      res.status(500).json({ error: 'Delta computation failed', detail: e.message });
    }
  }
);

// ── Watchlist API ──────────────────────────────────────────────────────────────
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Limity watchlistu per tier (počet aktivních adres)
const WATCHLIST_TIER_LIMITS = {
  free:       3,   // bez předplatného — malý buffer pro vyzkoušení
  pro_trader: 20,
  builder:    100,
  team:       500,
};

async function getWatchlistLimit(email, telegram_chat_id) {
  let sub = null;
  if (email)             sub = await db.getActiveSubscription(email).catch(() => null);
  if (!sub && telegram_chat_id) sub = await db.getActiveSubscriptionByChatId(telegram_chat_id).catch(() => null);
  const tier = sub?.tier || 'free';
  return { tier, limit: WATCHLIST_TIER_LIMITS[tier] ?? WATCHLIST_TIER_LIMITS.free };
}

// Systémové/nativní adresy s obrovským objemem transakcí — nesmí být ve watchlistu
// (každá transakce na Solana by generovala webhook → miliony kreditů/den)
const WATCHLIST_BLOCKED_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112',  // Wrapped SOL (wSOL) mint
  '11111111111111111111111111111111',             // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
  'TokenzQdBNbEqufqEJu1B7ayKkXJMPuSHEFPiHsqEuu', // Token-2022 Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bFAE', // Associated Token Program
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',  // Metaplex Token Metadata
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',  // Serum DEX v3
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',   // Serum DEX v4
]);

function isBlockedWatchlistAddress(address) {
  return WATCHLIST_BLOCKED_ADDRESSES.has(address);
}

// POST /watchlist/add — přidat adresu do watchlistu
app.post('/watchlist/add', express.json(), async (req, res) => {
  const { address, label, telegram_chat_id, email } = req.body || {};
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid or missing Solana address' });
  }
  if (isBlockedWatchlistAddress(address)) {
    return res.status(400).json({ error: 'This address cannot be monitored (system/program address with excessive transaction volume)' });
  }
  if (!telegram_chat_id && !email) {
    return res.status(400).json({ error: 'Provide telegram_chat_id or email for notifications' });
  }
  try {
    // Enforce tier limit
    const { tier, limit } = await getWatchlistLimit(email, telegram_chat_id);
    const current = telegram_chat_id
      ? db.countWatchlistForChat(telegram_chat_id)
      : db.countWatchlistForEmail(email);
    if (current >= limit) {
      return res.status(403).json({
        error: `Watchlist limit reached (${current}/${limit} for tier '${tier}'). Upgrade your plan to add more addresses.`,
        tier, limit, current
      });
    }

    const entry = await db.addWatchlistEntry({
      address,
      label,
      notify_telegram_chat: telegram_chat_id || null,
      notify_email: email || null
    });
    db.logEvent({ name: 'watchlist_created', resource: address, ip: req.ip })
      .catch(() => {});
    res.json({ ok: true, id: entry.id, address: entry.address, created_at: entry.created_at });
    // Synchronizuj novou adresu do Helius webhooku (non-blocking)
    const { syncWatchlistToWebhook } = require('./src/monitor/webhook-manager');
    syncWatchlistToWebhook().catch(e => console.error('[monitor] webhook sync after add failed:', e.message));
  } catch (e) {
    res.status(500).json({ error: 'Failed to add watchlist entry', detail: e.message });
  }
});

// DELETE /watchlist/:id — odebrat adresu z watchlistu
app.delete('/watchlist/:id', express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { telegram_chat_id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const removed = await db.removeWatchlistEntry(id, telegram_chat_id);
    res.json({ ok: removed, id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove entry', detail: e.message });
  }
});

// GET /watchlist?telegram_chat_id=XXX — seznam sledovaných adres pro daný chat
app.get('/watchlist', async (req, res) => {
  const chat = req.query.telegram_chat_id;
  if (!chat) return res.status(400).json({ error: 'telegram_chat_id query param required' });
  try {
    const entries = await db.listWatchlistForChat(chat);
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list watchlist', detail: e.message });
  }
});

// ── Stripe Per-Scan Checkout ──────────────────────────────────────────────────

const SCAN_PRICES_USD = {
  quick:       0.50,
  deep:        5.00,
  token:       0.75,
  wallet:      0.75,
  pool:        0.75,
  'evm-token': 0.75,
  contract:    5.00
};

// Dočasná cache výsledků zaplacených scanů (klíč = Stripe session_id, TTL 1h)
const paidScanCache = new Map();

// Cache výsledků free scanů — L1: in-memory (rychlost), L2: DB (persistence po restartu)
const freeScanCache = new Map();
const FREE_SCAN_CACHE_TTL = 3_600_000; // 1h

function freeScanCacheKey(address, type, chain) {
  return `${address.toLowerCase()}:${type}:${chain}`;
}

function setCachedScan(address, type, chain, result) {
  const key = freeScanCacheKey(address, type, chain);
  freeScanCache.set(key, { result, cachedAt: Date.now() });
  setTimeout(() => freeScanCache.delete(key), FREE_SCAN_CACHE_TTL);
}

async function getCachedScan(address, type, chain) {
  // L1: in-memory
  const entry = freeScanCache.get(freeScanCacheKey(address, type, chain));
  if (entry && Date.now() - entry.cachedAt <= FREE_SCAN_CACHE_TTL) return entry.result;
  // L2: DB (po restartu serveru)
  try {
    const dbResult = await db.getCachedScanFromDb(address, type, FREE_SCAN_CACHE_TTL);
    if (dbResult) {
      // Natáhnout zpět do L1 cache
      freeScanCache.set(freeScanCacheKey(address, type, chain), { result: dbResult, cachedAt: Date.now() });
      return dbResult;
    }
  } catch {}
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// POST /scan/checkout — vytvoří Stripe Checkout session (one-time payment) pro jednorázový scan
app.post('/scan/checkout', express.json(), async (req, res) => {
  const safeType = ((req.body?.type || 'quick').trim()).toLowerCase();
  const rawAddr  = (req.body?.address || '').trim();

  if (!SCAN_PRICES_USD[safeType]) {
    return res.status(400).json({ error: 'Invalid scan type' });
  }

  // Contract audit vyžaduje github_url — Stripe checkout zatím nepodporuje, nasměruj na x402
  if (safeType === 'contract') {
    return res.status(400).json({
      error: 'Contract audit does not support Stripe checkout. Use x402 payment or API key.',
      x402: { endpoint: '/scan/contract', accepts: contractAuditPaymentAccepts }
    });
  }

  // Validace adresy — EVM nebo Solana
  let safeAddress;
  if (safeType === 'evm-token') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
      return res.status(400).json({ error: 'Invalid EVM address format' });
    }
    safeAddress = rawAddr.toLowerCase();
  } else {
    safeAddress = rawAddr.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
      // Pokud adresa chybí, vytvoř checkout bez ní (uživatel ji zadá po zaplacení)
      safeAddress = 'unknown';
    }
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured' });

  const stripe   = Stripe(stripeKey);
  const priceUsd = SCAN_PRICES_USD[safeType];
  const APP_URL  = process.env.APP_URL || 'https://intmolt.org';
  const typeName = safeType.charAt(0).toUpperCase() + safeType.slice(1);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name:        `integrity.molt — ${typeName} Scan`,
            description: `One-time security scan for ${safeAddress.substring(0, 8)}...`
          },
          unit_amount: Math.round(priceUsd * 100)
        },
        quantity: 1
      }],
      metadata: { scan_type: safeType, address: safeAddress },
      success_url: `${APP_URL}/scan/paid?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/scan`
    });
    db.logEvent({ name: 'scan_checkout_created', resource: safeType, ip: req.ip }).catch(() => {});
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create checkout session', detail: e.message });
  }
});

// POST /scan/report — vygeneruje PDF nebo PNG infografiku ze scan výsledku
// Body: { format: 'pdf'|'png', type: string, data: object, address: string }
app.post('/scan/report', express.json({ limit: '2mb' }), async (req, res) => {
  const fmt     = (req.body?.format || 'pdf').toLowerCase();
  const address = (req.body?.address || '').trim();
  const type    = (req.body?.type    || 'scan').trim();

  if (!['pdf', 'png'].includes(fmt)) {
    return res.status(400).json({ error: 'format must be pdf or png' });
  }

  // Přijímáme buď `result` (celý scan response) nebo zpětně kompatibilní `data`
  let result;
  if (req.body?.result && typeof req.body.result === 'object') {
    result = { type, address, ...req.body.result };
  } else if (req.body?.data && typeof req.body.data === 'object') {
    result = { type, address, data: req.body.data };
  } else {
    return res.status(400).json({ error: 'Missing result or data object' });
  }

  // Bezpečný název souboru — jen base58/hex znaky z adresy
  const safeAddr = address.replace(/[^1-9A-HJ-NP-Za-km-z0-9x]/g, '').slice(0, 16) || 'report';
  const filename = `intmolt-${type}-${safeAddr}.${fmt}`;

  try {
    let buffer;
    if (fmt === 'pdf') {
      buffer = await generatePDFBuffer(result);
      res.setHeader('Content-Type', 'application/pdf');
    } else {
      buffer = await generatePNGBuffer(result);
      res.setHeader('Content-Type', 'image/png');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    db.logEvent({ name: 'report_downloaded', resource: `${type}.${fmt}`, ip: req.ip }).catch(() => {});
  } catch (e) {
    console.error('[report] generation failed:', e.message);
    res.status(500).json({ error: 'Report generation failed', detail: e.message });
  }
});

// GET /scan/paid — po Stripe redirectu ověří platbu, spustí scan, zobrazí výsledek
app.get('/scan/paid', async (req, res) => {
  const sessionId = req.query.session_id;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!sessionId || !stripeKey) return res.redirect('/scan');

  // Cachovaný výsledek — zabraňuje opakovanému spuštění scanu při refreshi
  if (paidScanCache.has(sessionId)) {
    return res.send(renderPaidScanPage(paidScanCache.get(sessionId)));
  }

  const stripe = Stripe(stripeKey);
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return res.redirect('/scan');
  }

  if (session.payment_status !== 'paid') return res.redirect('/scan');

  const scanType   = session.metadata?.scan_type || 'quick';
  const address    = session.metadata?.address   || '';
  if (!address || !SCAN_PRICES_USD[scanType]) return res.redirect('/scan');

  const scriptMap = {
    quick:  { script: '/root/scanner/quick-scan.sh',                    prefix: '',               timeout: 60000  },
    deep:   { script: '/root/swarm/orchestrator/orchestrator.sh',       prefix: 'swarm',          timeout: 180000 },
    token:  { script: '/root/scanner/enhanced-token-scan.sh',           prefix: 'enhanced-token', timeout: 150000 },
    wallet: { script: '/root/scanner/wallet-deep-scan.sh',              prefix: 'wallet-deep',    timeout: 120000 },
    pool:   { script: '/root/scanner/pool-deep-scan.sh',                prefix: 'pool-deep',      timeout: 120000 }
  };
  const { script, prefix, timeout } = scriptMap[scanType];

  let result;
  try {
    const { stdout } = await runScript(script, [address], timeout);
    const slug = address.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope } = loadLatestReport('/root/scanner/reports', slug, prefix);
    // Prefer signed envelope as data if stdout wasn't structured JSON
    const effectiveData = data || signedEnvelope || null;
    result = { status: 'complete', type: scanType, address, data: effectiveData, report: (!effectiveData && (reportText || stdout)) || null };
    db.logEvent({ name: 'paid_scan_completed', resource: scanType }).catch(() => {});
  } catch (e) {
    result = { status: 'error', type: scanType, address, error: e.message };
  }

  // Generate premium PNG + PDF report (async, non-blocking for the response)
  let reportFiles = null;
  try {
    reportFiles = await generateReport(result, '/root/scanner/reports');
  } catch (genErr) {
    console.error('[report-generator] Failed to generate report:', genErr.message);
  }

  const cacheEntry = { ...result, reportFiles };
  paidScanCache.set(sessionId, cacheEntry);
  setTimeout(() => paidScanCache.delete(sessionId), 3_600_000);
  res.send(renderPaidScanPage(cacheEntry));
});

function renderPaidScanPage(result) {
  const isError  = result.status === 'error';
  const typeName = (result.type || 'scan').charAt(0).toUpperCase() + (result.type || 'scan').slice(1);

  // Build report HTML based on data type
  let reportHtml = '';
  if (isError) {
    reportHtml = `<div style="padding:20px;background:#1a0808;border:1px solid #5a1a1a;border-left:4px solid #f85149;border-radius:8px;margin:20px 0">
      <div style="font-family:monospace;font-size:13px;color:#f85149;margin-bottom:6px">Scan Error</div>
      <div style="font-size:14px;color:#d0d8e8">${escapeHtml(result.error || 'Unknown error')}</div>
    </div>`;
  } else if (result.data && typeof result.data === 'object') {
    const d = result.data;
    const score = d.risk_score ?? d.aggregate_score ?? '?';
    const risk  = (d.risk_level || 'unknown').toLowerCase();
    const RISK_COL = { low: '#3fb950', medium: '#d29922', high: '#f85149', critical: '#ff4444', unknown: '#6a7490' };
    const col = RISK_COL[risk] || '#6a7490';
    const RISK_BG  = { low: '#0d1f18', medium: '#1f180d', high: '#1f0d0d', critical: '#200808', unknown: '#12121e' };
    const bg = RISK_BG[risk] || '#12121e';

    reportHtml += `
      <div style="display:flex;align-items:center;gap:16px;padding:20px;background:${bg};border:1px solid #1e1e2e;border-radius:10px;margin:20px 0;flex-wrap:wrap">
        <div style="width:64px;height:64px;border-radius:50%;background:${bg};border:3px solid ${col};display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:22px;font-weight:700;color:${col};flex-shrink:0">${score}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:monospace;font-size:11px;color:${col};text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${risk.toUpperCase()} RISK</div>
          <div style="font-size:15px;color:#e6edf3">${escapeHtml(d.summary || '')}</div>
          <div style="font-family:monospace;font-size:11px;color:#6a7490;margin-top:4px">${escapeHtml(result.address)}</div>
        </div>
        <div style="font-family:monospace;font-size:11px;padding:4px 10px;background:#0d1f18;border:1px solid #1e3a2f;color:#3fb950;border-radius:4px;flex-shrink:0">✓ Ed25519 Signed</div>
      </div>`;

    if (d.checks && typeof d.checks === 'object') {
      reportHtml += `<div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Security Checks</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-bottom:20px">`;
      for (const [key, val] of Object.entries(d.checks)) {
        const rk = (val?.risk || '').toLowerCase();
        const bcol = rk === 'high' ? '#f85149' : rk === 'medium' ? '#d29922' : '#3fb950';
        const bbg  = rk === 'high' ? '#1f0d0d'  : rk === 'medium' ? '#1f180d'  : '#0d1f18';
        const bbd  = rk === 'high' ? '#5a1a1a'  : rk === 'medium' ? '#3a2e1e'  : '#1e3a2f';
        const label = key.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
        const valueText = val?.status || val?.risk || '—';
        reportHtml += `<div style="background:#0f0f18;border:1px solid #1e1e2e;border-left:3px solid ${bcol};border-radius:8px;padding:14px 16px">
          <div style="font-family:monospace;font-size:11px;color:#6a7490;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">${escapeHtml(label)}</div>
          <div style="font-size:14px;color:#d0d8e8">${escapeHtml(String(valueText))}</div>
        </div>`;
      }
      reportHtml += '</div>';
    }

    if (d.evidence && d.evidence.length) {
      reportHtml += `<div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Evidence — Recent Transactions</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px">`;
      for (const ev of d.evidence) {
        const ts = ev.blockTime ? new Date(ev.blockTime * 1000).toLocaleString() : 'unknown';
        const errBadge = ev.err ? `<span style="color:#f85149;font-size:10px;margin-left:6px">FAILED</span>` : '';
        reportHtml += `<div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:6px;padding:10px 14px;font-family:monospace;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <a href="https://solscan.io/tx/${escapeHtml(ev.signature)}" target="_blank" style="color:#4da6ff;word-break:break-all;flex:1">${escapeHtml(ev.signature?.slice(0,20)+'…')}</a>
          ${errBadge}
          <span style="color:#3a3f54;font-size:11px;white-space:nowrap">${escapeHtml(ts)}</span>
          <a href="https://explorer.solana.com/tx/${escapeHtml(ev.signature)}" target="_blank" style="color:#2a6aaa;font-size:11px;white-space:nowrap">Explorer ↗</a>
        </div>`;
      }
      reportHtml += '</div>';
    }
  } else if (result.data && result.data.pipeline === 'swarm') {
    // ── Deep Audit swarm result (paid Stripe path) ─────────────────────────
    const d  = result.data;
    const agg = d.aggregate_score ?? '?';
    const dec = d.decision ?? 'unknown';
    const agents = d.agents ?? {};
    const sc = d.scorecard?.agents ?? {};
    const rugOverride = d.rug_override === true;
    const DCOL = { safe: '#3fb950', caution: '#d29922', 'high-risk': '#f85149' };
    const DBG  = { safe: '#052e16', caution: '#1f180d', 'high-risk': '#1f0d0d' };
    const rCol = DCOL[dec] || '#d29922';
    const rBg  = DBG[dec]  || '#1f180d';
    const DLBL = { safe: 'SAFE', caution: 'CAUTION', 'high-risk': 'HIGH RISK' };

    function scoreCol(n) { return Number(n)>=80 ? '#3fb950' : Number(n)>=55 ? '#d29922' : '#f85149'; }
    function ageBar(score, pct, contrib, conf) {
      const col = scoreCol(score);
      return `<div style="flex:1;height:6px;border-radius:3px;background:#1e1e2e;overflow:hidden"><div style="height:100%;width:${score}%;background:${col};border-radius:3px"></div></div>`;
    }

    const agRows = [
      { key:'scanner',    label:'Scanner Agent',    model:'gemini-2.5-flash', pct:30 },
      { key:'analyst',    label:'Analyst Agent',    model:'gpt-4o-mini',      pct:50 },
      { key:'reputation', label:'Reputation Agent', model:'heuristics',       pct:20 },
    ].map(({ key, label, model, pct }) => {
      const ag = agents[key] ?? {};
      const sca = sc[key] ?? {};
      const score  = Number(ag.score ?? 0);
      const conf   = ag.confidence ?? 0;
      const contrib = Number(sca.contribution ?? (score * pct / 100)).toFixed(1);
      const col    = scoreCol(score);
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#0f0f18;border:1px solid #1e1e2e;border-radius:8px;margin-bottom:8px">
        <div style="min-width:130px">
          <div style="font-size:13px;color:#d0d8e8;font-weight:500">${escapeHtml(label)}</div>
          <div style="font-family:monospace;font-size:10px;color:#3a3f54;margin-top:2px">${escapeHtml(model)} · weight ${pct}%</div>
        </div>
        <div style="flex:1">
          <div style="height:6px;border-radius:3px;background:#1e1e2e;overflow:hidden"><div style="height:100%;width:${score}%;background:${col};border-radius:3px"></div></div>
          <div style="font-family:monospace;font-size:10px;color:#3a3f54;margin-top:3px">confidence: ${conf}%</div>
        </div>
        <div style="text-align:right;min-width:72px;flex-shrink:0">
          <div style="font-size:18px;font-weight:700;color:${col};line-height:1">${score}<span style="font-size:10px;color:#3a3f54;font-weight:400">/100</span></div>
          <div style="font-family:monospace;font-size:10px;color:#3a3f54;margin-top:2px">+${contrib} pts</div>
        </div>
      </div>`;
    }).join('');

    const scannerData = agents.scanner?.data ?? {};
    const analyst     = agents.analyst ?? {};
    const dims        = analyst.dimensions ?? {};
    const keyRisks    = analyst.key_risks ?? [];
    const repFlags    = agents.reputation?.flags ?? [];

    // Dimensions grid
    const dimMeta = { mint_authority_risk:'Mint Authority', freeze_authority_risk:'Freeze Authority', owner_trust:'Owner Trust', token_legitimacy:'Legitimacy' };
    const dimsHtml = Object.keys(dims).length ? `
      <div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Risk Dimensions</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:20px">
        ${Object.entries(dims).map(([k,v]) => {
          const n = Number(v)||0; const col = scoreCol(n);
          return `<div style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:8px;padding:14px 16px">
            <div style="font-family:monospace;font-size:10px;color:#3a3f54;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">${escapeHtml(dimMeta[k]||k)}</div>
            <div style="font-size:18px;font-weight:700;color:${col};margin-bottom:6px">${n}<span style="font-size:10px;color:#3a3f54;font-weight:400">/100</span></div>
            <div style="height:5px;border-radius:3px;background:#1e1e2e;overflow:hidden"><div style="height:100%;width:${n}%;background:${col};border-radius:3px"></div></div>
          </div>`;
        }).join('')}
      </div>` : '';

    // Key risks
    const risksHtml = keyRisks.length ? `
      <div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Key Risks</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px">
        ${keyRisks.map(r => `<div style="display:flex;gap:9px;align-items:flex-start;padding:8px 12px;background:#0f0f18;border:1px solid #1e1e2e;border-radius:6px">
          <span style="color:#d29922;font-family:monospace;font-size:12px;flex-shrink:0">!</span>
          <span style="font-size:12px;color:#6a7490;line-height:1.5">${escapeHtml(r)}</span>
        </div>`).join('')}
      </div>` : '';

    // Reputation flags
    function rfCls(f) {
      const l = f.toLowerCase();
      return (l.includes('renounced')||l.includes('trusted')) ? '#3fb950' : (l.includes('rug')||l.includes('unlimited')||l.includes('not_found')) ? '#f85149' : '#d29922';
    }
    const flagsHtml = repFlags.length ? `
      <div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Reputation Flags</div>
      <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:20px">
        ${repFlags.map(f => {
          const ci = f.indexOf(':');
          const key = ci>0 ? f.slice(0,ci).replace(/_/g,' ') : f;
          const desc = ci>0 ? f.slice(ci+1).trim() : '';
          const col = rfCls(f);
          return `<div style="display:flex;gap:9px;padding:8px 12px;background:#0f0f18;border:1px solid #1e1e2e;border-radius:6px;font-size:12px">
            <span style="color:${col};font-weight:700;flex-shrink:0">${col==='#3fb950'?'✓':col==='#f85149'?'!':'~'}</span>
            <span><span style="color:#d0d8e8;font-weight:500">${escapeHtml(key)}</span>${desc?`<span style="color:#6a7490"> — ${escapeHtml(desc)}</span>`:''}</span>
          </div>`;
        }).join('')}
      </div>` : '';

    reportHtml = `
      <div style="display:flex;align-items:center;gap:14px;padding:20px;background:${rBg};border:1px solid #1e1e2e;border-top:2px solid ${rCol};border-radius:10px;margin:20px 0;flex-wrap:wrap;position:relative">
        <div style="width:72px;height:72px;border-radius:50%;background:${rBg};border:3px solid ${rCol};display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:24px;font-weight:700;color:${rCol};flex-shrink:0">${agg}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-family:monospace;font-size:12px;font-weight:700;color:${rCol};text-transform:uppercase;letter-spacing:1px">${escapeHtml(DLBL[dec]||dec)}</span>
            <span style="font-family:monospace;font-size:10px;padding:2px 8px;background:rgba(78,166,255,.1);border:1px solid rgba(78,166,255,.2);color:#4da6ff;border-radius:4px">DEEP AUDIT · 3 AI AGENTS</span>
            ${rugOverride ? '<span style="font-family:monospace;font-size:10px;padding:2px 8px;background:#ff4d4d22;color:#ff6b6b;border:1px solid #ff4d4d44;border-radius:4px">⚠ RUG OVERRIDE</span>' : ''}
          </div>
          <div style="font-size:13px;color:#6a7490">gemini-2.5-flash · gpt-4o-mini · reputation · weighted consensus</div>
          <div style="font-family:monospace;font-size:11px;color:#3a3f54;margin-top:4px;word-break:break-all">${escapeHtml(result.address)}</div>
        </div>
        ${d.signed ? '<div style="font-family:monospace;font-size:11px;padding:4px 10px;background:#0d1f18;border:1px solid #1e3a2f;color:#3fb950;border-radius:4px;flex-shrink:0">✓ Ed25519 Signed</div>' : ''}
      </div>
      <div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Multi-Agent Scorecard</div>
      ${agRows}
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#12121e;border:1px solid #1e1e2e;border-radius:8px;margin-top:4px;margin-bottom:20px">
        <span style="font-family:monospace;font-size:11px;color:#6a7490">Weighted Aggregate</span>
        <span style="font-size:20px;font-weight:700;color:${rCol}">${agg}<span style="font-size:11px;color:#3a3f54;font-weight:400"> / 100</span></span>
      </div>
      ${analyst.analysis ? `<div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">AI Analysis</div>
      <div style="background:#0f0f18;border:1px solid #1e1e2e;border-left:3px solid #2a6aaa;border-radius:8px;padding:14px 18px;margin-bottom:16px">
        <div style="font-family:monospace;font-size:10px;color:#3a3f54;margin-bottom:7px">gpt-4o-mini · score ${analyst.score??'?'}/100</div>
        <div style="font-size:13px;color:#6a7490;line-height:1.7">${escapeHtml(analyst.analysis)}</div>
      </div>` : ''}
      ${risksHtml}${dimsHtml}${flagsHtml}`;

    if (d.report || result.report) {
      const rawReport = d.report || result.report;
      reportHtml += `<div style="margin-top:12px"><details><summary style="font-family:monospace;font-size:11px;color:#3a3f54;cursor:pointer;text-transform:uppercase;letter-spacing:1px">Show raw signed report</summary>
        <pre style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:8px;padding:16px;font-family:monospace;font-size:11px;line-height:1.7;color:#6a7490;white-space:pre-wrap;word-break:break-all;margin-top:8px;max-height:400px;overflow-y:auto">${escapeHtml(rawReport)}</pre>
      </details></div>`;
    }

  } else if (result.report) {
    reportHtml = `<div style="font-family:monospace;font-size:11px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px">Report</div>
      <pre style="background:#0f0f18;border:1px solid #1e1e2e;border-radius:8px;padding:20px;font-family:monospace;font-size:12px;line-height:1.7;color:#6a7490;white-space:pre-wrap;word-break:break-all;max-height:600px;overflow-y:auto">${escapeHtml(result.report)}</pre>`;
  }

  return `<!DOCTYPE html><html lang="en"><head>
<title>${escapeHtml(typeName)} Scan Result — integrity.molt</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18061030609"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-WXYD5E5NWE');
  gtag('config', 'AW-18061030609');
</script>
${!isError ? `<!-- Event snippet for Nákup conversion page -->
<script>
  gtag('event', 'conversion', {
    'send_to': 'AW-18061030609/ZnnKCJaJjJUcENHplaRD',
    'transaction_id': ''
  });
</script>` : ''}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#d0d8e8;padding:0;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:#4da6ff;text-decoration:none}a:hover{text-decoration:underline}
.container{max-width:920px;margin:0 auto;padding:0 24px}
.top-bar{border-bottom:1px solid #1e1e2e;padding:18px 0;display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}
.logo{font-family:monospace;font-size:18px;font-weight:600;color:#fff}
.logo span{color:#4da6ff}
.scan-badge{font-family:monospace;font-size:11px;padding:3px 10px;border:1px solid ${isError ? '#5a1a1a' : '#1e3a2f'};color:${isError ? '#f85149' : '#3fb950'};border-radius:4px}
.page-title{font-size:22px;font-weight:700;color:#fff;margin-bottom:6px}
.page-meta{font-size:13px;color:#6a7490;font-family:monospace;margin-bottom:8px;word-break:break-all}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}
.btn{display:inline-block;padding:10px 20px;background:#4da6ff;color:#000;border-radius:6px;font-weight:600;font-size:13px;font-family:monospace;text-decoration:none}
.btn-ghost{background:transparent;border:1px solid #1e1e2e;color:#6a7490}
.btn-ghost:hover{border-color:#4da6ff;color:#4da6ff;text-decoration:none}
.upsell{margin:20px 0;padding:16px 20px;background:#12121e;border:1px solid #2a2a3e;border-radius:8px;font-size:13px;color:#6a7490}
.upsell strong{color:#4da6ff}
footer{border-top:1px solid #1e1e2e;margin-top:60px;padding:24px 0;text-align:center;font-family:monospace;font-size:12px;color:#3a3f54}
</style>
</head><body>
<div class="container">
<div class="top-bar">
  <a href="/" style="text-decoration:none"><div class="logo">integrity<span>.</span>molt</div></a>
  <span class="scan-badge">${isError ? '✕ Error' : '✓ Scan Complete'}</span>
</div>

<div class="page-title">${escapeHtml(typeName)} Scan Result</div>
<div class="page-meta">Address: ${escapeHtml(result.address)}</div>

${reportHtml}

${!isError ? (result.type === 'deep'
  ? `<div class="upsell"><strong>Deep Audit complete.</strong> Subscribe to <a href="/#plans">Builder ($49/mo)</a> for unlimited deep audits, API access, and watchlist monitoring.</div>`
  : `<div class="upsell"><strong>Quick Scan</strong> — This was a basic on-chain check. Upgrade to <strong>Deep Audit ($5.00)</strong> for full AI vulnerability analysis, insider cluster detection, and wash trading signals. Or subscribe to <a href="/#plans">Pro Trader ($15/mo)</a> for unlimited access.</div>`)
: ''}

${result.reportFiles ? `<div style="margin:20px 0;padding:20px 24px;background:#0f0f18;border:1px solid #1e2e40;border-radius:10px">
  <div style="font-family:monospace;font-size:10px;color:#3a3f54;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Download Premium Report</div>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <a href="/report/download?file=${encodeURIComponent(result.reportFiles.pngPath)}&name=integrity-molt-report.png"
       class="btn" style="background:#1e3a2f;color:#3fb950;border:1px solid #2a5040;font-size:12px;padding:8px 16px">
      ↓ report.png
    </a>
    <a href="/report/download?file=${encodeURIComponent(result.reportFiles.pdfPath)}&name=integrity-molt-report.pdf"
       class="btn" style="background:#1a2a3f;color:#4da6ff;border:1px solid #253a55;font-size:12px;padding:8px 16px">
      ↓ report.pdf
    </a>
  </div>
</div>` : ''}

<div class="actions">
  <a href="/scan" class="btn">← New Scan</a>
  <a href="/scan?address=${escapeHtml(result.address)}&type=deep" class="btn-ghost btn">Deep Audit ($5.00)</a>
  <a href="/verify.html" class="btn-ghost btn">Verify Report</a>
</div>

</div>
<footer>integrity.molt — AI-native Solana security scanner · <a href="/">Home</a> · <a href="/docs.html">API</a></footer>
</body></html>`;
}

// ── Report download endpoint ───────────────────────────────────────────────────
// GET /report/download?file=<abs_path>&name=<filename>
// Only serves files within /root/scanner/reports/ ending in .png or .pdf
app.get('/report/download', (req, res) => {
  const filePath = req.query.file || '';
  const fileName = path.basename(req.query.name || path.basename(filePath));
  const allowed = filePath.startsWith('/root/scanner/reports/') &&
    (filePath.endsWith('.png') || filePath.endsWith('.pdf') || filePath.endsWith('.html'));
  if (!allowed || !fs.existsSync(filePath)) {
    return res.status(404).send('Report not found');
  }
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.sendFile(filePath);
});

// ── Stripe Subscription ────────────────────────────────────────────────────────

const STRIPE_PRICE_IDS = {
  pro_trader: process.env.STRIPE_PRICE_PRO_TRADER,
  builder:    process.env.STRIPE_PRICE_BUILDER,
  team:       process.env.STRIPE_PRICE_TEAM
};

// POST /subscribe/:tier — vytvoří Stripe Checkout session a přesměruje
app.post('/subscribe/:tier', express.json(), async (req, res) => {
  const tier = req.params.tier;
  if (!['pro_trader', 'builder', 'team'].includes(tier)) {
    return res.status(400).json({ error: `Unknown tier: ${tier}. Use 'pro_trader', 'builder' or 'team'.` });
  }
  const { email, telegram_chat_id, success_url, cancel_url } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || !STRIPE_PRICE_IDS[tier]) {
    return res.status(503).json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY and STRIPE_PRICE_' + tier.toUpperCase() });
  }
  const stripe = Stripe(stripeKey);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICE_IDS[tier], quantity: 1 }],
      customer_email: email,
      metadata: { tier, telegram_chat_id: telegram_chat_id || '' },
      success_url: success_url || `${process.env.APP_URL || 'https://intmolt.org'}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancel_url  || `${process.env.APP_URL || 'https://intmolt.org'}/#plans`
    });
    db.logEvent({ name: 'subscription_started', resource: tier, ip: req.ip })
      .catch(() => {});
    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create checkout session', detail: e.message });
  }
});

// POST /stripe/webhook — zpracuje události od Stripe (raw body nutný pro ověření podpisu)
app.post('/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripeKey) return res.status(503).send('Stripe not configured');

    const stripe = Stripe(stripeKey);
    let event;
    try {
      event = webhookSecret
        ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret)
        : JSON.parse(req.body.toString());
    } catch (e) {
      console.error('[stripe] webhook signature failed:', e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    const sub = event.data?.object;
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          // Subscription zaplacena — vytvoříme nebo aktualizujeme záznam
          if (sub.mode === 'subscription' && sub.subscription) {
            const fullSub = await stripe.subscriptions.retrieve(sub.subscription);
            await db.upsertSubscription({
              stripe_customer_id: sub.customer,
              stripe_sub_id:      sub.subscription,
              email:              sub.customer_email || sub.customer_details?.email,
              tier:               sub.metadata?.tier || 'builder',
              status:             fullSub.status,
              current_period_end: fullSub.current_period_end,
              telegram_chat_id:   sub.metadata?.telegram_chat_id || null
            });
            db.logEvent({ name: 'subscription_activated', resource: sub.metadata?.tier }).catch(() => {});
            console.log(`[stripe] subscription activated: ${sub.customer_email} tier=${sub.metadata?.tier}`);
            // Odeslat welcome email
            const welEmail = sub.customer_email || sub.customer_details?.email;
            const welTier  = sub.metadata?.tier || 'builder';
            if (welEmail) sendWelcomeEmail({ email: welEmail, tier: welTier }).catch(() => {});
          }
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const customer = await stripe.customers.retrieve(sub.customer);
          await db.upsertSubscription({
            stripe_customer_id: sub.customer,
            stripe_sub_id:      sub.id,
            email:              customer.email,
            tier:               sub.metadata?.tier || 'builder',
            status:             sub.status,
            current_period_end: sub.current_period_end
          });
          console.log(`[stripe] subscription ${event.type}: ${customer.email} status=${sub.status}`);
          break;
        }
      }
    } catch (e) {
      console.error('[stripe] webhook handler error:', e.message);
    }

    res.json({ received: true });
  }
);

// GET /subscribe/success — potvrzovací stránka po zaplacení
app.get('/subscribe/success', async (req, res) => {
  const sessionId = req.query.session_id;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || !sessionId) {
    return res.send('<html><body><h2>Subscription confirmed!</h2><p><a href="/">Back to home</a></p></body></html>');
  }
  try {
    const stripe = Stripe(stripeKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.send(`<!DOCTYPE html><html><head><title>Subscribed — integrity.molt</title>
<meta charset="utf-8">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18061030609"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-WXYD5E5NWE');
  gtag('config', 'AW-18061030609');
</script>
<!-- Event snippet for Nákup conversion page -->
<script>
  gtag('event', 'conversion', {
    'send_to': 'AW-18061030609/ZnnKCJaJjJUcENHplaRD',
    'transaction_id': '${sessionId}'
  });
</script>
<style>
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:48px;border:1px solid #30363d;border-radius:12px;max-width:480px}
h2{color:#4da6ff;margin-bottom:16px}p{color:#8b949e;margin:8px 0}a{color:#4da6ff;text-decoration:none}
</style></head><body><div class="box">
<h2>✓ Subscription active</h2>
<p>Welcome, <strong>${session.customer_email || 'subscriber'}</strong></p>
<p>Tier: <strong>${session.metadata?.tier || 'builder'}</strong></p>
<p style="margin-top:24px"><a href="/">← Back to integrity.molt</a></p>
</div></body></html>`);
  } catch {
    res.send('<html><body><h2>Subscription confirmed!</h2><p><a href="/">Back</a></p></body></html>');
  }
});

// GET /unsubscribe?email=X — odhlásí uživatele z digest emailů (ne subscription)
app.get('/unsubscribe', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send(`<html><body style="font-family:system-ui;background:#0a0a0f;color:#d0d8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
      <div style="text-align:center;padding:40px;border:1px solid #1e1e2e;border-radius:12px;max-width:400px">
        <h2 style="color:#f85149">Neplatný email</h2>
        <p style="color:#6a7490"><a href="/" style="color:#4da6ff">← Zpět</a></p>
      </div></body></html>`);
  }
  try {
    // Nastav příznak digest_unsubscribed na subscriptions záznamu
    try { db.db.prepare('UPDATE subscriptions SET digest_unsubscribed = 1 WHERE lower(email) = ?').run(email.toLowerCase()); } catch (_) {}
    // Zaloguj event
    await db.logEvent({ name: 'digest_unsubscribed', resource: email, ip: req.ip }).catch(() => {});
    console.log(`[mailer] unsubscribe: ${email}`);
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Odhlášení — integrity.molt</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0a0f;color:#d0d8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center;padding:40px;border:1px solid #1e1e2e;border-radius:12px;max-width:420px">
  <div style="font-size:32px;margin-bottom:12px">✓</div>
  <h2 style="color:#fff;margin:0 0 10px">Odhlášení úspěšné</h2>
  <p style="color:#6a7490;font-size:14px">Email <strong style="color:#d0d8e8">${email}</strong> nebude dostávat weekly digest.</p>
  <p style="color:#6a7490;font-size:13px;margin-top:8px">Vaše předplatné zůstává aktivní — odhlásíte se jen z newsletteru.</p>
  <p style="margin-top:24px"><a href="/" style="color:#4da6ff;text-decoration:none">← Zpět na integrity.molt</a></p>
</div></body></html>`);
  } catch (e) {
    res.status(500).send('Chyba — zkuste to prosím znovu.');
  }
});

// GET /subscription/status?email=X — zkontroluje stav subscription
app.get('/subscription/status', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query param required' });
  const sub = await db.getActiveSubscription(email).catch(() => null);
  if (!sub) return res.json({ active: false });
  res.json({
    active: true,
    tier: sub.tier,
    status: sub.status,
    current_period_end: sub.current_period_end
  });
});

// POST /track — privacy-friendly page view beacon (bez cookies, bez externích scriptů)
// Body: { path, referrer } — vše volitelné
app.post('/track', express.json({ limit: '2kb' }), (req, res) => {
  const pagePath = (req.body?.path || '/').substring(0, 200).replace(/[<>"]/g, '');
  const referrer = (req.body?.referrer || '').substring(0, 300).replace(/[<>"]/g, '');
  db.logEvent({
    name:     'page_view',
    resource: null,
    ip:       req.ip,
    meta:     { path: pagePath, referrer: referrer || null }
  }).catch(() => {});
  res.status(204).end();
});

// Stats endpoint — chráněno STATS_TOKEN v env (Bearer token v Authorization hlavičce)
app.get('/stats/funnel', async (req, res) => {
  const token = process.env.STATS_TOKEN;
  if (token) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const [funnel, payments, pageviews] = await Promise.all([
    db.getFunnelStats(days),
    db.getPaymentStats(days),
    db.getPageviewStats(days)
  ]);
  res.json({ days, funnel, payments, pageviews });
});

// ── API Keys management ─────────────────────────────────────────────────────────

// POST /api-keys/generate — vygeneruje nový API klíč (vyžaduje aktivní subscription)
app.post('/api-keys/generate', express.json(), async (req, res) => {
  const { email, label } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  const sub = await db.getActiveSubscription(email).catch(() => null);
  if (!sub) {
    return res.status(403).json({ error: 'Active subscription required', url: 'https://intmolt.org/#plans' });
  }
  try {
    const keyData = await db.createApiKey({ email, tier: sub.tier, label });
    db.logEvent({ name: 'api_key_created', resource: email, ip: req.ip }).catch(() => {});
    res.json({
      ok: true,
      key: keyData.key,
      prefix: keyData.key_prefix,
      tier: keyData.tier,
      id: keyData.id,
      note: 'Save this key — it will not be shown again.'
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate key', detail: e.message });
  }
});

// GET /api-keys?email=X — seznam aktivních klíčů (bez raw hodnot)
app.get('/api-keys', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query param required' });
  const sub = await db.getActiveSubscription(email).catch(() => null);
  if (!sub) return res.status(403).json({ error: 'Active subscription required' });
  const keys = await db.listApiKeys(email).catch(() => []);
  res.json({ keys });
});

// DELETE /api-keys/:id — odvolání API klíče
app.delete('/api-keys/:id', express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { email } = req.body || {};
  if (!id || !email) return res.status(400).json({ error: 'id and email required' });
  const revoked = await db.revokeApiKey(id, email).catch(() => false);
  res.json({ ok: revoked });
});

// GET /dashboard — HTML page (served as static file, see below)
// GET /dashboard/data — JSON data for dashboard (auth: session OR API key OR email param)
app.get('/dashboard/data', requireApiKey, async (req, res) => {
  // Determine email: session → api key → query param
  let email = null;
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email) {
    email = req.user.email;
  } else if (req.apiKey?.email) {
    email = req.apiKey.email;
  } else if (req.query.email) {
    email = req.query.email;
  }
  if (!email) return res.status(401).json({ error: 'Authentication required' });

  const [sub, keys] = await Promise.all([
    db.getActiveSubscription(email).catch(() => null),
    db.listApiKeys(email).catch(() => [])
  ]);
  if (!sub) return res.status(403).json({ error: 'Active subscription required', subscribe_url: 'https://intmolt.org/#plans' });
  res.json({
    email,
    tier:               sub.tier,
    status:             sub.status,
    current_period_end: sub.current_period_end,
    api_keys: keys.map(k => ({
      id:           k.id,
      prefix:       k.key_prefix,
      label:        k.label,
      tier:         k.tier,
      usage_count:  k.usage_count,
      last_used_at: k.last_used_at,
      created_at:   k.created_at
    }))
  });
});

// Legacy: GET /dashboard?email=X (JSON API for backwards compat)
app.get('/dashboard', requireApiKey, async (req, res) => {
  // If email param present → return JSON (API usage)
  if (req.query.email) {
    const email = req.query.email;
    const [sub, keys] = await Promise.all([
      db.getActiveSubscription(email).catch(() => null),
      db.listApiKeys(email).catch(() => [])
    ]);
    if (!sub) return res.status(403).json({ error: 'Active subscription required' });
    return res.json({
      email, tier: sub.tier, status: sub.status,
      current_period_end: sub.current_period_end,
      api_keys: keys.map(k => ({ id: k.id, prefix: k.key_prefix, label: k.label, tier: k.tier, usage_count: k.usage_count, last_used_at: k.last_used_at, created_at: k.created_at }))
    });
  }
  // Otherwise serve dashboard HTML
  res.sendFile('/root/x402-server/public/dashboard.html');
});

// ── /scan page + free-tier endpoints ──────────────────────────────────────────

const FREE_SCAN_LIMIT = 3;

// Serve /watchlist page
app.get('/watchlist', (req, res) => res.sendFile('/root/x402-server/public/watchlist.html'));

// Serve /scan page
app.get('/scan', (req, res) => res.sendFile('/root/x402-server/public/scan.html'));

// GET /scan/cached?address=X&type=Y — vrátí cached výsledek scanu (1h TTL) pro shareable links
app.get('/scan/cached', async (req, res) => {
  const address = (req.query.address || '').trim();
  const type    = (req.query.type    || 'quick').trim().toLowerCase();
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const result = await db.getCachedScanFromDb(address, type, FREE_SCAN_CACHE_TTL);
    if (!result) return res.status(404).json({ cached: false });
    res.json({ cached: true, data: result, type, address });
  } catch (e) {
    res.status(500).json({ error: 'Cache lookup failed', detail: e.message });
  }
});

// GET /scan/captcha-challenge — generuje HMAC-signed matematickou CAPTCHA otázku
const { createHmac, timingSafeEqual } = require('node:crypto');
const CAPTCHA_SECRET = process.env.CAPTCHA_SECRET || 'changeme-local-dev';
const CAPTCHA_TTL_MS = 15 * 60 * 1000; // 15 minut

app.get('/scan/captcha-challenge', (req, res) => {
  const a = Math.floor(Math.random() * 10) + 1;  // 1–10
  const b = Math.floor(Math.random() * 10) + 1;  // 1–10
  const answer = String(a + b);
  const ts = Date.now();
  const token = createHmac('sha256', CAPTCHA_SECRET)
    .update(`${answer}:${ts}`)
    .digest('hex') + ':' + ts;
  res.json({ question: `${a} + ${b}`, token });
});

// GET /scan/quota — vrátí zbývající free scany pro aktuální IP
app.get('/scan/quota', (req, res) => {
  const ip = req.ip;
  const q  = getQuotaStatus(ip);
  res.json({
    scans_used:      q.used,
    scans_limit:     q.limit,
    scans_remaining: q.remaining,
    resets_at:       q.resets_at,
  });
});

// POST /scan/free — bezplatný scan (first 3 per IP/day), pak 402
// Matematická CAPTCHA verifikace (HMAC-signed, TTL 15 minut)
function verifyCaptcha(token, answer) {
  if (!token || !answer) return false;
  const parts = token.split(':');
  if (parts.length !== 2) return false;
  const [hmac, ts] = parts;
  if (Date.now() - Number(ts) > CAPTCHA_TTL_MS) return false;
  const expected = createHmac('sha256', CAPTCHA_SECRET)
    .update(`${answer.trim()}:${ts}`)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false; // malformed hex / length mismatch
  }
}

app.post('/scan/free', express.json(), checkBlacklist, async (req, res) => {
  const address = (req.body?.address || '').trim();
  const type    = (req.body?.type    || 'quick').trim();
  const chain   = (req.body?.chain   || 'base').trim().toLowerCase();
  const captchaToken  = (req.body?.captcha_token  || '').trim();
  const captchaAnswer = (req.body?.captcha_answer || '').trim();

  if (!address) return res.status(400).json({ error: 'Missing address' });

  // Matematická CAPTCHA verifikace (přeskočí se pro interní A2A volání ze stejného serveru)
  const isInternalA2A = req.headers['x-a2a-caller'] === '1' && req.ip === '127.0.0.1';
  const captchaOk = isInternalA2A || verifyCaptcha(captchaToken, captchaAnswer);
  if (!captchaOk) {
    logAbuseEvent(req.ip, 'captcha_failed', { reason: 'invalid_answer' });
    return res.status(403).json({ error: 'CAPTCHA verification failed', captcha_required: true });
  }
  if (!['quick', 'deep', 'token', 'wallet', 'pool', 'evm-token', 'contract'].includes(type)) {
    return res.status(400).json({ error: 'Invalid scan type' });
  }

  // Contract audit je vždy placený
  if (type === 'contract') {
    return res.status(402).json({
      error:           'payment_required',
      message:         'Contract Audit requires payment ($5.00 USDC). Use x402 micropayments or API key.',
      payment_options: {
        contract: { endpoint: '/scan/contract', price_usdc: 5.00, micro_usdc: 5000000, accepts: contractAuditPaymentAccepts }
      },
      subscription: {
        pro_trader: { price: '$15/mo', url: 'https://intmolt.org/subscribe/pro_trader' },
        builder:    { price: '$49/mo', url: 'https://intmolt.org/subscribe/builder' },
        team:       { price: '$299/mo', url: 'https://intmolt.org/subscribe/team'   }
      }
    });
  }

  // Validace adresy podle typu
  const isEvm = type === 'evm-token';
  let safeAddress;
  if (isEvm) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid EVM address format (expected 0x + 40 hex chars)' });
    }
    if (!['base', 'ethereum', 'arbitrum'].includes(chain)) {
      return res.status(400).json({ error: 'Invalid chain — use base|ethereum|arbitrum' });
    }
    safeAddress = address.toLowerCase();
  } else {
    // Detect EVM address passed without 0x prefix (40 hex chars)
    if (/^[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({
        error: 'Invalid address format',
        hint: `This looks like an EVM address. Use type="evm-token" with chain=base|ethereum|arbitrum and prefix the address with "0x": "0x${address.toLowerCase()}"`
      });
    }
    safeAddress = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
      return res.status(400).json({ error: 'Invalid Solana address format' });
    }
  }

  // Deep scan je vždy placený (bez free tier)
  if (type === 'deep') {
    return res.status(402).json({
      error:           'payment_required',
      message:         'Deep Audit requires payment ($5.00 USDC). Use Stripe or x402 micropayments.',
      scans_used:      0,
      scans_limit:     0,
      scans_remaining: 0,
      payment_options: {
        deep: { endpoint: '/scan/deep', price_usdc: PRICING.deep / 1_000_000, micro_usdc: PRICING.deep, accepts: deepPaymentAccepts }
      },
      subscription: {
        pro_trader: { price: '$15/mo', url: 'https://intmolt.org/subscribe/pro_trader' },
        builder:    { price: '$49/mo', url: 'https://intmolt.org/subscribe/builder' },
        team:       { price: '$299/mo', url: 'https://intmolt.org/subscribe/team'   }
      }
    });
  }

  const ip          = req.ip;
  const quotaStatus = getQuotaStatus(ip);
  const used        = quotaStatus.used;

  if (quotaStatus.global_used >= GLOBAL_DAILY_CAP) {
    return res.status(429).json({
      error:        'Daily free scan capacity exhausted',
      message:      'Free tier limit reached globally. Try again tomorrow or upgrade for unlimited scans.',
      global_limit: GLOBAL_DAILY_CAP,
      global_used:  quotaStatus.global_used,
      upgrade_url:  'https://intmolt.org/scan',
    });
  }

  if (used >= FREE_SCAN_LIMIT) {
    // Spusť levný RPC-only scan (bez LLM) pro teaser v paywall UI
    let teaser = null;
    if (!isEvm && safeAddress) {
      try {
        const t = await Promise.race([
          quickScanRpcOnly(safeAddress),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
        teaser = { risk_score: t.risk_score, risk_level: t.risk_level, summary: t.summary, address: safeAddress };
      } catch { /* non-fatal — paywall se zobrazí bez teaseru */ }
    }
    return res.status(429).json({
      error:           'free_quota_exceeded',
      message:         `Daily free scan limit reached. Upgrade at intmolt.org/pricing`,
      scans_used:      used,
      scans_limit:     FREE_SCAN_LIMIT,
      scans_remaining: 0,
      teaser,
      payment_options: {
        quick:     { endpoint: '/scan/quick',     price_usdc: PRICING.quick / 1_000_000,          micro_usdc: PRICING.quick,           accepts: quickPaymentAccepts },
        deep:      { endpoint: '/scan/deep',      price_usdc: PRICING.deep / 1_000_000,           micro_usdc: PRICING.deep,            accepts: deepPaymentAccepts },
        token:     { endpoint: '/scan/token',     price_usdc: PRICING.token / 1_000_000,          micro_usdc: PRICING.token,           accepts: tokenAuditPaymentAccepts },
        wallet:    { endpoint: '/scan/wallet',    price_usdc: PRICING.wallet / 1_000_000,         micro_usdc: PRICING.wallet,          accepts: walletProfilePaymentAccepts },
        pool:      { endpoint: '/scan/pool',      price_usdc: PRICING.pool / 1_000_000,           micro_usdc: PRICING.pool,            accepts: poolScanPaymentAccepts },
        'evm-token': { endpoint: '/scan/evm-token', price_usdc: PRICING['evm-token'] / 1_000_000, micro_usdc: PRICING['evm-token'],   accepts: evmTokenPaymentAccepts },
        contract:  { endpoint: '/scan/contract',  price_usdc: PRICING.contract / 1_000_000,       micro_usdc: PRICING.contract,        accepts: contractAuditPaymentAccepts }
      },
      subscription: {
        pro_trader: { price: '$15/mo', url: 'https://intmolt.org/subscribe/pro_trader' },
        builder:    { price: '$49/mo', url: 'https://intmolt.org/subscribe/builder' },
        team:       { price: '$299/mo', url: 'https://intmolt.org/subscribe/team'   }
      }
    });
  }

  // ── Cache hit — vrátí výsledek okamžitě bez opakování pipeline ──────────────
  const cached = await getCachedScan(safeAddress, type, isEvm ? chain : 'solana');
  if (cached) {
    console.log(`[scan/free] CACHE HIT address=${safeAddress} type=${type} — skipping pipeline`);
    return res.json({
      ...cached,
      scans_used:      used,
      scans_remaining: Math.max(0, FREE_SCAN_LIMIT - used),
      scans_limit:     FREE_SCAN_LIMIT,
      cached:          true
    });
  }

  // Spotřebuj kvótu před spuštěním — zabrání souběžnému zneužití
  consumeFreeQuota(ip);

  const newUsed = used + 1;
  const t0 = Date.now();

  // ── EVM token scan (JS module, bez shell skriptu) ─────────────────────────
  if (isEvm) {
    try {
      const t1 = Date.now();
      const evmResult = await scanEVMToken(safeAddress, chain);
      const scanMs = Date.now() - t1;
      console.log(`[scan/free] EVM address=${safeAddress} chain=${chain} scan=${scanMs}ms total=${Date.now()-t0}ms`);

      // Advisor — šedá zóna
      const evmFreeCtx = `Free EVM token scan ${chain}/${safeAddress}:\nScore: ${evmResult.score}\nRecommendation: ${evmResult.recommendation}\nFindings:\n${evmResult.findings.map(f=>`[${f.severity}] ${f.label}`).join('\n')}`;
      const evmAdv = await runAdvisorIfGreyZone({ score: evmResult.score, context: evmFreeCtx, scanType: 'free-evm' });

      const result = {
        status:          'complete',
        type:            'evm-token',
        chain,
        address:         safeAddress,
        score:           evmResult.score,
        recommendation:  evmResult.recommendation,
        findings:        evmResult.findings,
        meta:            evmResult.meta,
        advisor:         evmAdv ? { text: evmAdv.text, advisor_used: evmAdv.advisorUsed, provider: evmAdv.provider } : null,
        signed:          evmAdv?.signed || null,
        timestamp:       new Date().toISOString()
      };
      setCachedScan(safeAddress, type, chain, result);
      res.json({ ...result, scans_used: newUsed, scans_remaining: Math.max(0, FREE_SCAN_LIMIT - newUsed), scans_limit: FREE_SCAN_LIMIT });
    } catch (err) {
      res.status(500).json({ error: 'EVM scan failed', detail: err.message });
    }
    return;
  }

  // ── Quick scan: pure RPC, no LLM, ~1-2s ──────────────────────────────────
  if (type === 'quick') {
    try {
      const t1 = Date.now();
      const scanData = await quickScanRpcOnly(safeAddress);
      const scanMs   = Date.now()-t1;
      console.log(`[scan/free] QUICK-RPC address=${safeAddress} scan=${scanMs}ms total=${Date.now()-t0}ms`);
      const result = {
        status: 'complete', type: 'quick',
        address: safeAddress, data: scanData,
        timestamp: new Date().toISOString()
      };
      setCachedScan(safeAddress, 'quick', 'solana', result);
      const histEmail = (req.isAuthenticated && req.isAuthenticated() && req.user?.email)
                     || req.apiKey?.email || null;
      db.logScanToHistory({
        email: histEmail || null, address: safeAddress, scan_type: 'quick',
        risk_score: scanData.risk_score, risk_level: scanData.risk_level,
        summary: scanData.summary, cached: false, result_json: scanData
      }).catch(() => {});
      if (scanData?.llm_validation_flags !== undefined) {
        db.logAccuracySignal({
          mint: safeAddress, scanType: 'quick',
          rawScore:      scanData.detail?.raw_score ?? null,
          llmScore:      scanData.detail?.raw_score ?? null,
          finalScore:    scanData.risk_score,
          finalCategory: scanData.category,
          validationFlags: scanData.llm_validation_flags || []
        });
      }
      return res.json({
        ...result,
        scans_used:      newUsed,
        scans_remaining: Math.max(0, FREE_SCAN_LIMIT - newUsed),
        scans_limit:     FREE_SCAN_LIMIT
      });
    } catch (err) {
      console.error(`[scan/free] QUICK-RPC error: ${err.message}`);
      return res.status(500).json({ error: 'Quick scan failed', detail: err.message });
    }
  }

  // ── Solana scans (shell skripty) ──────────────────────────────────────────
  const scriptMap = {
    token:  { script: '/root/scanner/enhanced-token-scan.sh',       prefix: 'enhanced-token', timeout: 150000 },
    wallet: { script: '/root/scanner/wallet-deep-scan.sh',          prefix: 'wallet-deep',    timeout: 120000 },
    pool:   { script: '/root/scanner/pool-deep-scan.sh',            prefix: 'pool-deep',      timeout: 120000 }
  };
  const { script, prefix, timeout } = scriptMap[type];

  try {
    const t1 = Date.now();
    const { stdout } = await runScript(script, [safeAddress], timeout);
    const scriptMs = Date.now() - t1;

    const t2 = Date.now();
    const slug       = safeAddress.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope } = loadLatestReport('/root/scanner/reports', slug, prefix);
    const reportMs = Date.now() - t2;

    const totalMs = Date.now() - t0;
    console.log(`[scan/free] type=${type} address=${safeAddress} script=${scriptMs}ms report_load=${reportMs}ms total=${totalMs}ms`);

    // Shell script returned error JSON (e.g. token not found on Solana)
    if (data?.error) {
      return res.status(404).json({
        error: data.error,
        hint:  data.hint || null,
        address: safeAddress,
        scans_used:      newUsed,
        scans_remaining: Math.max(0, FREE_SCAN_LIMIT - newUsed),
        scans_limit:     FREE_SCAN_LIMIT
      });
    }

    // Advisor — šedá zóna 40-70
    const freeCtx = `${type} scan pro adresu ${safeAddress}:\n${JSON.stringify(data || { raw: stdout.slice(0, 2000) }, null, 2)}`;
    const freeAdv = await runAdvisorIfGreyZone({ score: data?.risk_score, context: freeCtx, scanType: `free-${type}` });

    const freeSigned = freeAdv?.signed
      || (data?.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : signedEnvelope)
      || null;

    const result = {
      status:    'complete',
      type,
      address:   safeAddress,
      data:      data || null,
      report:    (!data && (reportText || stdout)) || null,
      advisor:   freeAdv ? { text: freeAdv.text, advisor_used: freeAdv.advisorUsed, provider: freeAdv.provider } : null,
      signed:    freeSigned,
      timestamp: new Date().toISOString()
    };
    setCachedScan(safeAddress, type, 'solana', result);
    const histEmail2 = (req.isAuthenticated && req.isAuthenticated() && req.user?.email)
                    || req.apiKey?.email || null;
    db.logScanToHistory({
      email: histEmail2 || null, address: safeAddress, scan_type: type,
      risk_score: data?.risk_score ?? null, risk_level: data?.risk_level || null,
      summary: freeAdv?.text?.slice(0, 500) || data?.summary || null, cached: false, result_json: data || null
    }).catch(() => {});
    if (data?.llm_validation_flags !== undefined) {
      db.logAccuracySignal({
        mint: safeAddress, scanType: type,
        rawScore:      data.detail?.raw_score ?? null,
        llmScore:      data.detail?.raw_score ?? null,
        finalScore:    data.risk_score,
        finalCategory: data.category,
        validationFlags: data.llm_validation_flags || []
      });
    }
    res.json({
      ...result,
      scans_used:      newUsed,
      scans_remaining: Math.max(0, FREE_SCAN_LIMIT - newUsed),
      scans_limit:     FREE_SCAN_LIMIT
    });
  } catch (err) {
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

// ── Social login routes ───────────────────────────────────────────────────────
registerAuthRoutes(app);

// Serve /login page
app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');
  res.sendFile('/root/x402-server/public/login.html');
});

// ── Subscribe flow with social login ─────────────────────────────────────────
// GET /subscribe/builder|team — redirects through auth if not logged in, then creates Stripe checkout
app.get('/subscribe/:tier', async (req, res) => {
  const tier = req.params.tier;
  if (!['pro_trader', 'builder', 'team'].includes(tier)) return res.status(400).send('Unknown tier');

  // If not authenticated, redirect to login with next= param
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.redirect(`/login?next=/subscribe/${tier}`);
  }

  const email = req.user?.email;
  if (!email) return res.redirect('/login');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || !STRIPE_PRICE_IDS[tier]) {
    return res.redirect('/#plans');
  }

  const stripe = Stripe(stripeKey);
  const APP_URL = process.env.APP_URL || 'https://intmolt.org';

  try {
    // Get or create Stripe customer for this user
    let customerId = req.user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: req.user?.name || undefined,
        metadata: { user_id: String(req.user?.id || '') }
      });
      customerId = customer.id;
      // Save customer_id to users table
      try { db.db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id); } catch (_) {}
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICE_IDS[tier], quantity: 1 }],
      metadata: { tier, user_id: String(req.user?.id || '') },
      success_url: `${APP_URL}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/#plans`
    });

    db.logEvent({ name: 'subscription_started', resource: tier, ip: req.ip }).catch(() => {});
    res.redirect(session.url);
  } catch (e) {
    console.error('[subscribe] Stripe error:', e.message);
    res.redirect('/#plans');
  }
});

// ── Scan history endpoint ─────────────────────────────────────────────────────
app.get('/scan/history', requireApiKey, async (req, res) => {
  let email = null;
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email) {
    email = req.user.email;
  } else if (req.apiKey?.email) {
    email = req.apiKey.email;
  } else if (req.query.email) {
    email = req.query.email;
  }
  if (!email) return res.status(401).json({ error: 'Authentication required' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = await db.getScanHistory(email, limit).catch(() => []);
  res.json({ history: rows });
});

// Public shareable scan URL — MUST be defined AFTER all specific /scan/xxx routes
// to prevent :address wildcard from swallowing /scan/cached, /scan/quota, etc.
app.get('/scan/:address', async (req, res) => {
  const { address } = req.params;

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return res.status(400).send('Invalid Solana address');
  }

  const shortAddr = address.slice(0, 8) + '…';
  let meta = {
    TITLE:       `Security Scan — ${shortAddr} | integrity.molt`,
    DESCRIPTION: `IRIS security scan for Solana token ${shortAddr}`,
    OG_TITLE:    `Scan: ${shortAddr}`,
    OG_DESCRIPTION: `IRIS-scored on-chain analysis by integrity.molt`,
    ADDRESS:     address,
    IRIS_JSON:   'null'
  };

  try {
    const ctrl    = new AbortController();
    const timer   = setTimeout(() => ctrl.abort(), 8000);
    const irisRes = await fetch('http://127.0.0.1:3402/scan/iris', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address }),
      signal:  ctrl.signal
    });
    clearTimeout(timer);
    const irisData = await irisRes.json();

    const grade = (irisData.iris?.grade || irisData.risk_level || 'UNKNOWN').toUpperCase();
    const isNotFound = irisData.status === 'address_not_found';
    const score = isNotFound ? null :
      (typeof irisData.iris?.score === 'number' ? irisData.iris.score : (irisData.risk_score ?? '?'));

    const riskDescriptor =
      isNotFound                                ? 'could not be found on-chain — address may be invalid, unfunded, or closed' :
      grade === 'LOW'    || grade === 'SAFE'    ? 'verified legitimate with no critical risk factors' :
      grade === 'MEDIUM' || grade === 'CAUTION' ? 'shows moderate risk signals that warrant attention' :
      grade === 'HIGH'                          ? 'contains significant red flags detected by IRIS methodology' :
      grade === 'CRITICAL' || grade === 'DANGER'? 'matches known scam patterns — avoid interaction' :
      'analyzed with IRIS methodology';

    meta.TITLE          = isNotFound
      ? `Address Not Found · Solana Security Scan | integrity.molt`
      : `${grade} Risk (${score}/100) · Solana Token Security Scan | integrity.molt`;
    meta.OG_TITLE       = isNotFound
      ? `UNKNOWN — ${address.slice(0, 8)}... · Not found on-chain`
      : `${grade} Risk — ${score}/100 · ${address.slice(0, 8)}...`;
    meta.DESCRIPTION    = `Solana address ${address.slice(0, 8)}...${address.slice(-4)} ${riskDescriptor}. AI-native security analysis with Ed25519-signed report. Scan yours free at intmolt.org.`;
    meta.OG_DESCRIPTION = meta.DESCRIPTION;
    // Safe JSON injection — guard against </script> in values
    meta.IRIS_JSON      = JSON.stringify(irisData).replace(/<\//g, '<\\/');
  } catch (err) {
    console.warn('[scan/:address] IRIS fetch failed:', err.message);
  }

  const template = fs.readFileSync(path.join(__dirname, 'public', 'scan-view.html'), 'utf8');
  const html = template
    .replace(/\{\{TITLE\}\}/g,          escapeHtml(meta.TITLE))
    .replace(/\{\{DESCRIPTION\}\}/g,    escapeHtml(meta.DESCRIPTION))
    .replace(/\{\{OG_TITLE\}\}/g,       escapeHtml(meta.OG_TITLE))
    .replace(/\{\{OG_DESCRIPTION\}\}/g, escapeHtml(meta.OG_DESCRIPTION))
    .replace(/\{\{ADDRESS\}\}/g,        address)        // validated base58 — safe
    .replace(/\{\{IRIS_JSON\}\}/g,      meta.IRIS_JSON); // pre-escaped above

  res.type('html').send(html);
});

// OG image for /scan/:address — rendered by Puppeteer, cached 5 min in-memory
const { generateOgImage, warmBrowser: ogWarmBrowser } = require('./src/og/generator');

app.get('/og-scan/:file', async (req, res) => {
  const m = /^([1-9A-HJ-NP-Za-km-z]{32,44})\.png$/.exec(req.params.file);
  if (!m) return res.status(400).send('Invalid address');
  const address = m[1];

  try {
    const buffer = await generateOgImage(address);
    res.set({
      'Content-Type':  'image/png',
      'Cache-Control': 'public, max-age=300',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    console.error('[og-scan] Failed:', err.message);
    res.redirect('/og-image.png');
  }
});

// ── User watchlist endpoints (email-based, no telegram required) ──────────────
app.get('/watchlist/user', requireApiKey, async (req, res) => {
  let email = null;
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email) email = req.user.email;
  else if (req.apiKey?.email) email = req.apiKey.email;
  if (!email) return res.status(401).json({ error: 'Authentication required' });

  const entries = await db.getUserWatchlist(email).catch(() => []);
  res.json({ entries });
});

app.post('/watchlist/user/add', express.json(), requireApiKey, async (req, res) => {
  let email = null;
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email) email = req.user.email;
  else if (req.apiKey?.email) email = req.apiKey.email;
  if (!email) return res.status(401).json({ error: 'Authentication required' });

  const { address, label, email_notify } = req.body || {};
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid Solana address' });
  }
  if (isBlockedWatchlistAddress(address)) {
    return res.status(400).json({ error: 'This address cannot be monitored (system/program address with excessive transaction volume)' });
  }
  try {
    // Enforce tier limit
    const { tier, limit } = await getWatchlistLimit(email, null);
    const current = db.countWatchlistForEmail(email);
    if (current >= limit) {
      return res.status(403).json({
        error: `Watchlist limit reached (${current}/${limit} for tier '${tier}'). Upgrade your plan to add more addresses.`,
        tier, limit, current
      });
    }

    const notifyEmail = email_notify === false ? null : email;
    const entry = await db.addUserWatchlistEntry({ email, address, label, notify_email: notifyEmail });
    res.json({ ok: true, id: entry?.id, entry });
    // Synchronizuj novou adresu do Helius webhooku (non-blocking)
    const { syncWatchlistToWebhook } = require('./src/monitor/webhook-manager');
    syncWatchlistToWebhook().catch(e => console.error('[monitor] webhook sync after user add failed:', e.message));
  } catch (e) {
    res.status(500).json({ error: 'Failed to add', detail: e.message });
  }
});

app.delete('/watchlist/user/:id', requireApiKey, async (req, res) => {
  let email = null;
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email) email = req.user.email;
  else if (req.apiKey?.email) email = req.apiKey.email;
  if (!email) return res.status(401).json({ error: 'Authentication required' });

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const ok = await db.removeUserWatchlistEntry({ email, id }).catch(() => false);
  res.json({ ok });
});

// ── Watchlist monitoring ───────────────────────────────────────────────────────
const WATCHLIST_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hodin (real-time via webhook, polling jen jako sanity check)
const WATCHLIST_BATCH_DELAY = 2000;                // 2s mezi scany (rate limiting)

async function sendTelegramAlert(chatId, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN
    || (() => { try { return require('fs').readFileSync('/root/.secrets/telegram_bot_token', 'utf8').trim(); } catch { return null; } })();
  if (!token || !chatId) return;
  try {
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  } catch (e) {
    console.error('[watchlist] telegram alert failed:', e.message);
  }
}

// Lazy email transporter — vytvoří se jen pokud je SMTP nakonfigurováno
let _emailTransporter = null;
function getEmailTransporter() {
  if (_emailTransporter) return _emailTransporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  _emailTransporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user, pass }
  });
  return _emailTransporter;
}

async function sendEmail(to, subject, html) {
  const transporter = getEmailTransporter();
  if (!transporter) return; // SMTP není nakonfigurováno — tiché selhání
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transporter.sendMail({ from, to, subject, html });
  } catch (e) {
    console.error('[watchlist] email alert failed:', e.message);
  }
}

async function runWatchlistMonitor() {
  let entries;
  try { entries = await db.getActiveWatchlist(); } catch (e) {
    console.error('[watchlist-monitor] getActiveWatchlist failed:', e.message); return;
  }
  if (!entries.length) return;
  console.log(`[watchlist-monitor] checking ${entries.length} addresses`);

  for (const entry of entries) {
    try {
      const data = await quickScanRpcOnly(entry.address);
      const newLevel = data.risk_level || 'unknown';
      const newScore = data.risk_score ?? null;
      const prevLevel = entry.last_risk_level || null;

      await db.updateWatchlistRisk(entry.id, {
        risk_level: newLevel, risk_score: newScore, risk_summary: data.summary || null
      });

      // Notifikace jen při změně risk levelu
      if (prevLevel && prevLevel !== newLevel) {
        const label = entry.label ? ` (${entry.label})` : '';
        const msg = `⚠️ <b>Risk change detected</b>${label}\n`
          + `Address: <code>${entry.address}</code>\n`
          + `${prevLevel.toUpperCase()} → <b>${newLevel.toUpperCase()}</b> (score: ${newScore ?? '?'})\n`
          + `${data.summary || ''}\n`
          + `🔍 <a href="https://intmolt.org/scan?address=${entry.address}&type=quick">View full scan</a>`;

        if (entry.notify_telegram_chat) {
          await sendTelegramAlert(entry.notify_telegram_chat, msg);
        }
        if (entry.notify_email) {
          const shortAddr = entry.address.slice(0, 8) + '…';
          const emailHtml = `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f0f18;color:#d0d8e8;border:1px solid #1e1e2e;border-radius:10px;padding:28px">
              <h2 style="margin:0 0 16px;color:#fff;font-size:18px">⚠️ Risk change detected</h2>
              ${entry.label ? `<p style="margin:0 0 8px;color:#6a7490">Watchlist: <strong style="color:#d0d8e8">${entry.label}</strong></p>` : ''}
              <p style="margin:0 0 6px;font-family:monospace;font-size:13px;background:#12121e;padding:8px 12px;border-radius:5px;word-break:break-all">${entry.address}</p>
              <p style="margin:12px 0;font-size:16px">
                <span style="color:#6a7490;text-transform:uppercase">${prevLevel}</span>
                &nbsp;→&nbsp;
                <strong style="color:${newLevel === 'high' || newLevel === 'critical' ? '#f85149' : newLevel === 'medium' ? '#d29922' : '#3fb950'};text-transform:uppercase">${newLevel}</strong>
                <span style="color:#6a7490;font-size:13px"> (score: ${newScore ?? '?'})</span>
              </p>
              ${data.summary ? `<p style="margin:0 0 16px;color:#8b95b0;font-size:14px">${data.summary}</p>` : ''}
              <a href="https://intmolt.org/scan?address=${entry.address}&type=quick"
                 style="display:inline-block;padding:10px 20px;background:#4da6ff;color:#000;font-weight:700;border-radius:6px;text-decoration:none;font-size:14px">
                View Full Scan →
              </a>
              <p style="margin:20px 0 0;font-size:11px;color:#3a3f54">integrity.molt — AI-native Solana security · <a href="https://intmolt.org" style="color:#4da6ff">intmolt.org</a></p>
            </div>`;
          await sendEmail(
            entry.notify_email,
            `[integrity.molt] Risk change: ${shortAddr} ${prevLevel.toUpperCase()} → ${newLevel.toUpperCase()}`,
            emailHtml
          );
        }
        console.log(`[watchlist-monitor] risk change ${entry.address}: ${prevLevel} → ${newLevel}`);
      }
    } catch (e) {
      console.error(`[watchlist-monitor] scan failed for ${entry.address}:`, e.message);
    }
    // Rate limiting — nepřetěžovat RPC
    await new Promise(r => setTimeout(r, WATCHLIST_BATCH_DELAY));
  }
  console.log(`[watchlist-monitor] done, next run in ${WATCHLIST_INTERVAL_MS / 3600000}h`);
}

// ── Weekly digest scheduler ────────────────────────────────────────────────────

function scheduleWeeklyDigest() {
  function msUntilNextSunday8UTC() {
    const now = new Date();
    const next = new Date(now);
    const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7; // 0=Sunday → 7
    next.setUTCDate(now.getUTCDate() + daysUntilSunday);
    next.setUTCHours(8, 0, 0, 0);
    return Math.max(next - now, 0);
  }

  function loop() {
    const delay = msUntilNextSunday8UTC();
    console.log(`[mailer] weekly digest naplánován za ${Math.round(delay / 3600000)} hodin`);
    setTimeout(async () => {
      await runWeeklyDigests().catch(e => console.error('[mailer] weekly digest failed:', e.message));
      loop(); // naplánuj další týden
    }, delay);
  }

  loop();
}

// ── Admin endpoint pro manuální spuštění digestu ───────────────────────────────
const STATS_TOKEN = process.env.STATS_TOKEN;
app.get('/admin/digest/run', async (req, res) => {
  if (!STATS_TOKEN || req.headers['authorization'] !== `Bearer ${STATS_TOKEN}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await runWeeklyDigests();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Ads ────────────────────────────────────────────────────────────────────────

// GET /ads/serve?placement=scan_result — vrátí aktivní reklamu (veřejné, bez auth)
app.get('/ads/serve', async (req, res) => {
  const placement = req.query.placement || 'scan_result';
  try {
    const ad = await db.getAdForPlacement(placement);
    if (!ad) return res.json({ ad: null });
    // Tracker impression (CPM: $cpm / 1000)
    db.trackAdImpression(ad.id, parseFloat(ad.cpm_usd || 0) / 1000).catch(() => {});
    db.logEvent({ name: 'ad_impression', resource: String(ad.id), ip: req.ip }).catch(() => {});
    res.json({ ad });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ads/click/:id — redirect na cta_url a tracky klik
app.get('/ads/click/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/');
  try {
    db.logEvent({ name: 'ad_click', resource: String(id), ip: req.ip }).catch(() => {});
    const url = await db.trackAdClick(id);
    res.redirect(url || '/');
  } catch {
    res.redirect('/');
  }
});

// ── Admin: správa reklam (STATS_TOKEN) ────────────────────────────────────────

function requireStatsToken(req, res, next) {
  if (!STATS_TOKEN || req.headers['authorization'] !== `Bearer ${STATS_TOKEN}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

app.get('/admin/ads', requireStatsToken, async (req, res) => {
  const ads = await db.listAds().catch(e => { res.status(500).json({ error: e.message }); return null; });
  if (ads) res.json({ ads });
});

app.post('/admin/ads', requireStatsToken, express.json(), async (req, res) => {
  const { advertiser, headline, tagline, cta_text, cta_url, image_url, placement, budget_usd, cpm_usd, expires_at } = req.body || {};
  if (!advertiser || !headline || !cta_url) {
    return res.status(400).json({ error: 'advertiser, headline a cta_url jsou povinné' });
  }
  try {
    const ad = await db.createAd({ advertiser, headline, tagline, cta_text, cta_url, image_url, placement, budget_usd, cpm_usd, expires_at });
    res.json({ ok: true, ad });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/ads/:id', requireStatsToken, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const ad = await db.updateAd(id, req.body || {});
    res.json({ ok: !!ad, ad });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe Live Payments — /api/v1 ────────────────────────────────────────────

const PLAN_PRICES = {
  pro_trader: { amount: 1500, name: 'integrity.molt Pro Trader' },
  builder:    { amount: 4900, name: 'integrity.molt Builder' },
  team:       { amount: 29900, name: 'integrity.molt Team' }
};

// POST /api/v1/create-checkout-session
app.post('/api/v1/create-checkout-session', express.json(), async (req, res) => {
  const { plan } = req.body || {};
  if (!PLAN_PRICES[plan]) {
    return res.status(400).json({ error: `Unknown plan: ${plan}. Use pro_trader, builder, or team.` });
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured' });

  const stripe = Stripe(stripeKey);
  const APP = process.env.APP_URL || 'https://intmolt.org';
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          recurring: { interval: 'month' },
          unit_amount: PLAN_PRICES[plan].amount,
          product_data: { name: PLAN_PRICES[plan].name }
        }
      }],
      metadata: { plan },
      success_url: `${APP}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP}/#pricing`
    });
    db.logEvent({ name: 'checkout_session_created', resource: plan, ip: req.ip }).catch(() => {});
    res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe] create-checkout-session error:', e.message);
    res.status(500).json({ error: 'Failed to create checkout session', detail: e.message });
  }
});

// POST /api/v1/stripe-webhook — ověření podpisu + logování do JSON souboru
const STRIPE_EVENTS_FILE = path.join(__dirname, 'data', 'stripe_events.json');
app.post('/api/v1/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const stripeKey     = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripeKey) return res.status(503).send('Stripe not configured');

    const stripe = Stripe(stripeKey);
    let event;
    try {
      event = webhookSecret
        ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret)
        : JSON.parse(req.body.toString());
    } catch (e) {
      console.error('[stripe/v1] webhook signature failed:', e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    // Append event to JSON log file
    try {
      let events = [];
      try { events = JSON.parse(fs.readFileSync(STRIPE_EVENTS_FILE, 'utf-8')); } catch {}
      events.push({ ts: new Date().toISOString(), type: event.type, id: event.id, data: event.data?.object });
      fs.writeFileSync(STRIPE_EVENTS_FILE, JSON.stringify(events, null, 2));
    } catch (e) {
      console.error('[stripe/v1] event log write error:', e.message);
    }

    const obj = event.data?.object;
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          if (obj.mode === 'subscription' && obj.subscription) {
            const fullSub = await stripe.subscriptions.retrieve(obj.subscription);
            await db.upsertSubscription({
              stripe_customer_id: obj.customer,
              stripe_sub_id:      obj.subscription,
              email:              obj.customer_email || obj.customer_details?.email,
              tier:               obj.metadata?.plan || 'builder',
              status:             fullSub.status,
              current_period_end: fullSub.current_period_end,
              telegram_chat_id:   obj.metadata?.telegram_chat_id || null
            });
            db.logEvent({ name: 'subscription_activated', resource: obj.metadata?.plan }).catch(() => {});
            console.log(`[stripe/v1] subscription activated: ${obj.customer_email} plan=${obj.metadata?.plan}`);
            const welEmail = obj.customer_email || obj.customer_details?.email;
            if (welEmail) sendWelcomeEmail({ email: welEmail, tier: obj.metadata?.plan || 'builder' }).catch(() => {});
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const customer = await stripe.customers.retrieve(obj.customer);
          await db.upsertSubscription({
            stripe_customer_id: obj.customer,
            stripe_sub_id:      obj.id,
            email:              customer.email,
            tier:               obj.metadata?.plan || 'builder',
            status:             obj.status,
            current_period_end: obj.current_period_end
          });
          console.log(`[stripe/v1] subscription deleted: ${customer.email}`);
          break;
        }
      }
    } catch (e) {
      console.error('[stripe/v1] webhook handler error:', e.message);
    }

    res.json({ received: true });
  }
);

// ── Live Runtime Monitoring — Helius Webhook ──────────────────────────────────
// POST /webhook/helius — přijímá Helius enhanced transaction data
// NGINX: /api/v2/webhook/helius → proxy_pass http://127.0.0.1:3402/ stripuje prefix
// Helius webhook URL: https://intmolt.org/api/v2/webhook/helius

// Global rate limit: max 300 req/min od Helius (5/s průměr).
// Chrání před kreditu-burning při sledování extrémně aktivních adres.
const _webhookRateWindow = { count: 0, resetAt: Date.now() + 60_000 };
const WEBHOOK_GLOBAL_RATE_MAX = 300; // req/minuta

function webhookGlobalRateLimit(req, res, next) {
  const now = Date.now();
  if (now > _webhookRateWindow.resetAt) {
    _webhookRateWindow.count   = 0;
    _webhookRateWindow.resetAt = now + 60_000;
  }
  _webhookRateWindow.count++;
  if (_webhookRateWindow.count > WEBHOOK_GLOBAL_RATE_MAX) {
    console.warn(`[monitor] Global webhook rate limit hit (${_webhookRateWindow.count} req/min) — dropping request`);
    return res.status(200).json({ ok: false, error: 'rate_limit' }); // 200 aby Helius neretryoval
  }
  next();
}

app.post('/webhook/helius', express.json({ limit: '1mb' }), verifyWebhookAuth, webhookGlobalRateLimit, handleHeliusWebhook);

// ── Bot-internal endpoints (bez x402, jen ADMIN_API_KEY + localhost) ──────────

function requireBotKey(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return res.status(503).json({ error: 'ADMIN_API_KEY not configured' });
  if (req.headers['x-admin-key'] !== key) return res.status(401).json({ error: 'Unauthorized' });
  // Pouze z localhostu
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1') && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden: internal only' });
  }
  next();
}

// POST /internal/bot/quick — Solana quick scan pro Telegram bot (bez platby)
// Body: { address }
// Pipeline: quickScanRpcOnly → shell quick-scan → runWithAdvisor → asyncSign
app.post('/internal/bot/quick', requireBotKey, express.json(), async (req, res) => {
  const raw = (req.body?.address || '').trim();
  const safeAddress = raw.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').slice(0, 44);
  if (!safeAddress || safeAddress.length < 32)
    return res.status(400).json({ error: 'Invalid Solana address' });

  try {
    const t0 = Date.now();

    // 1. RPC data (rychlé on-chain info)
    const rpcData = await quickScanRpcOnly(safeAddress);

    // 2. Shell quick-scan (detailnější report, non-fatal fallback)
    let shellReport = '';
    try {
      const { stdout } = await runScript('/root/scanner/quick-scan.sh', [safeAddress], 60000);
      shellReport = stdout;
    } catch (shellErr) {
      console.warn('[bot/quick] shell scan failed (non-fatal):', shellErr.message);
    }

    // 3. Sonnet executor + Opus advisor
    const userMessage = `Adresa: ${safeAddress}

On-chain RPC data:
${JSON.stringify(rpcData, null, 2)}

${shellReport ? `Shell scan report:\n${shellReport}` : '(shell scan unavailable)'}`;

    const advisorResult = await runWithAdvisor({
      systemPrompt: SECURITY_ANALYST_SYSTEM,
      userMessage,
    });

    // 4. Ed25519 podpis výstupu
    let signed = null;
    try { signed = await asyncSign(advisorResult.text); } catch (e) {
      console.warn('[bot/quick] signing failed (non-fatal):', e.message);
    }

    // 5. Logování do DB
    db.logAdvisorUsage(null, 'bot-quick', advisorResult);
    db.logEvent({ name: 'bot_quick_scan', resource: safeAddress, ip: req.ip }).catch(() => {});

    console.log(`[bot/quick] address=${safeAddress} provider=${advisorResult.provider} advisor=${advisorResult.advisorUsed} ms=${Date.now()-t0}`);
    res.json({
      status:       'complete',
      address:      safeAddress,
      report:       advisorResult.text,
      advisor_used: advisorResult.advisorUsed,
      provider:     advisorResult.provider,
      risk_score:   rpcData.risk_score   ?? null,
      risk_level:   rpcData.risk_level   ?? null,
      signed,
    });
  } catch (e) {
    console.error('[bot/quick] error:', e.message);
    res.status(500).json({ error: 'Quick scan failed', detail: e.message });
  }
});

// POST /internal/bot/token — SPL token audit pro Telegram bot (bez platby)
// Body: { address, chat_id? }
// Pokud chat_id přítomno: 2-fázový response (preliminary < 5s + async advisor → Telegram zpráva)
// Pokud chat_id chybí: sync mode jako dřív (advisor s max 55s timeoutem)
app.post('/internal/bot/token', requireBotKey, express.json(), async (req, res) => {
  const raw = (req.body?.address || '').trim();
  const safeAddress = raw.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').slice(0, 44);
  const chatId = req.body?.chat_id || null;
  if (!safeAddress || safeAddress.length < 32)
    return res.status(400).json({ error: 'Invalid Solana address' });

  try {
    const result = await auditToken(safeAddress);
    db.logEvent({ name: 'bot_token_audit', resource: safeAddress, ip: req.ip }).catch(() => {});

    // Validation layer
    const _botLLM       = buildLLMReportFromAuditResult(result);
    const _botRaw       = buildRawDataFromAuditResult(result);
    const _botValidation = validateReport(_botLLM, _botRaw);
    const _botCorrCount  = applyCorrectionsToAuditResult(result, _botValidation.issues);
    const _botValidStatus = formatValidationStatus(_botValidation, _botCorrCount);
    try {
      db.logValidationIssues({
        mint:             safeAddress,
        scanType:         'bot-token',
        valid:            _botValidation.valid,
        issues:           _botValidation.issues,
        correctionsCount: _botCorrCount,
      });
    } catch (vLogErr) {
      console.warn('[bot/token] validation log failed (non-fatal):', vLogErr.message);
    }

    const inGrey = typeof result.risk_score === 'number' && result.risk_score >= 40 && result.risk_score <= 70;

    if (chatId && inGrey) {
      // Fáze A: okamžitá preliminary odpověď
      _botJobCleanup();
      const jobId = `token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      _botJobs.set(jobId, { chat_id: chatId, ts: Date.now(), endpoint: 'bot-token' });

      res.json({
        status:            'preliminary',
        address:           safeAddress,
        risk_score:        result.risk_score,
        category:          result.category,
        summary:           result.summary,
        advisor_used:      false,
        findings:          result.findings || [],
        job_id:            jobId,
        validation_status: _botValidStatus,
      });

      // Fáze B: async advisor → Telegram push
      setImmediate(async () => {
        try {
          const advisorResult = await runWithAdvisor({
            systemPrompt: SECURITY_ANALYST_SYSTEM,
            userMessage:  `Token audit data:\n${JSON.stringify(result, null, 2)}`,
            maxAdvisorUses: 2,
          });
          db.logAdvisorUsage(null, 'bot-token', advisorResult);
          const advText = advisorResult?.text || '';
          if (advText) {
            const escapedValidStatus = _botValidStatus.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const msg = `<b>Token advisor update</b> (${safeAddress.slice(0, 8)}...) ${escapedValidStatus}\n\n${advText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 3800)}`;
            await sendTelegramAlert(chatId, msg).catch(tgErr =>
              console.warn('[bot/token] telegram push failed:', tgErr.message)
            );
          }
        } catch (advErr) {
          console.warn('[bot/token] advisor failed (non-fatal):', advErr.message);
        } finally {
          _botJobs.delete(jobId);
        }
      });

    } else if (inGrey) {
      // Sync mode (bez chat_id) — advisor s 55s timeoutem
      let advisorResult = null;
      try {
        advisorResult = await Promise.race([
          runWithAdvisor({
            systemPrompt: SECURITY_ANALYST_SYSTEM,
            userMessage:  `Token audit data:\n${JSON.stringify(result, null, 2)}`,
            maxAdvisorUses: 2,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('advisor timeout 55s')), 55_000)),
        ]);
        db.logAdvisorUsage(null, 'bot-token', advisorResult);
      } catch (advErr) {
        console.warn('[bot/token] advisor failed (non-fatal):', advErr.message);
      }

      res.json({
        status:            'complete',
        address:           safeAddress,
        risk_score:        result.risk_score,
        category:          result.category,
        summary:           advisorResult?.text || result.summary,
        advisor_used:      advisorResult?.advisorUsed ?? false,
        findings:          result.findings || [],
        validation_status: _botValidStatus,
      });

    } else {
      // Skóre mimo šedou zónu — žádný advisor
      res.json({
        status:            'complete',
        address:           safeAddress,
        risk_score:        result.risk_score,
        category:          result.category,
        summary:           result.summary,
        advisor_used:      false,
        findings:          result.findings || [],
        validation_status: _botValidStatus,
      });
    }
  } catch (e) {
    console.error('[bot/token] error:', e.message);
    res.status(500).json({ error: 'Token audit failed', detail: e.message });
  }
});

// POST /internal/bot/evm — EVM token scan pro Telegram bot (bez platby)
// Body: { address, chain?, chat_id? }
// Pokud chat_id přítomno: 2-fázový response (preliminary < 5s + async advisor → Telegram zpráva)
// Pokud chat_id chybí: sync mode jako dřív (runAdvisorIfGreyZone blokuje max 55s)
app.post('/internal/bot/evm', requireBotKey, express.json(), async (req, res) => {
  const address = (req.body?.address || '').trim();
  const chain   = (req.body?.chain   || 'ethereum').trim().toLowerCase();
  const chatId  = req.body?.chat_id || null;

  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.status(400).json({ error: 'Invalid EVM address (expected 0x + 40 hex chars)' });
  if (!EVM_CHAINS.includes(chain))
    return res.status(400).json({ error: `Invalid chain. Use: ${EVM_CHAINS.join('|')}` });

  try {
    const evmRes = await scanEVMToken(address, chain);
    db.logEvent({ name: 'bot_evm_scan', resource: chain, ip: req.ip }).catch(() => {});

    const evmBotCtx = `EVM token scan ${chain}/${address}:\nScore: ${evmRes.score}\nRecommendation: ${evmRes.recommendation}\nFindings:\n${evmRes.findings.map(f=>`[${f.severity}] ${f.label}`).join('\n')}`;
    const inGrey = typeof evmRes.score === 'number' && evmRes.score >= 40 && evmRes.score <= 70;

    if (chatId && inGrey) {
      // Fáze A: okamžitá preliminary odpověď
      _botJobCleanup();
      const jobId = `evm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      _botJobs.set(jobId, { chat_id: chatId, ts: Date.now(), endpoint: 'bot-evm' });

      res.json({
        status:         'preliminary',
        chain,
        address,
        score:          evmRes.score,
        risk_level:     evmRes.risk_level || null,
        recommendation: evmRes.recommendation,
        findings:       evmRes.findings,
        meta:           evmRes.meta,
        advisor:        null,
        signed:         null,
        job_id:         jobId,
      });

      // Fáze B: async advisor → Telegram push
      setImmediate(async () => {
        try {
          const adv = await runAdvisorIfGreyZone({ score: evmRes.score, context: evmBotCtx, scanType: 'bot-evm' });
          if (adv?.text) {
            const msg = `<b>EVM advisor update</b> (${chain}/${address.slice(0, 8)}...)\n\n${adv.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 3800)}`;
            await sendTelegramAlert(chatId, msg).catch(tgErr =>
              console.warn('[bot/evm] telegram push failed:', tgErr.message)
            );
          }
        } catch (advErr) {
          console.warn('[bot/evm] advisor failed (non-fatal):', advErr.message);
        } finally {
          _botJobs.delete(jobId);
        }
      });

    } else {
      // Sync mode (bez chat_id nebo mimo šedou zónu) — původní chování s 55s timeoutem na advisor
      let adv = null;
      if (inGrey) {
        try {
          adv = await Promise.race([
            runAdvisorIfGreyZone({ score: evmRes.score, context: evmBotCtx, scanType: 'bot-evm' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('advisor timeout 55s')), 55_000)),
          ]);
        } catch (advErr) {
          console.warn('[bot/evm] advisor failed (non-fatal):', advErr.message);
        }
      }

      res.json({
        status:         'complete',
        chain,
        address,
        score:          evmRes.score,
        risk_level:     evmRes.risk_level || null,
        recommendation: evmRes.recommendation,
        findings:       evmRes.findings,
        meta:           evmRes.meta,
        advisor:        adv ? { text: adv.text, advisor_used: adv.advisorUsed, provider: adv.provider } : null,
        signed:         adv?.signed || null,
      });
    }
  } catch (e) {
    console.error('[bot/evm] scan error:', e.message);
    res.status(500).json({ error: 'EVM scan failed', detail: e.message });
  }
});

// POST /internal/bot/contract — smart contract audit pro Telegram bot (bez platby)
// Body: { github_url, project_name? }
app.post('/internal/bot/contract', requireBotKey, express.json(), async (req, res) => {
  const rawUrl   = (req.body?.github_url || '').trim();
  const projName = (req.body?.project_name || '').trim().replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 64) || 'unknown';

  if (!rawUrl) return res.status(400).json({ error: 'Missing github_url' });
  if (!/^https?:\/\/(github\.com|gitlab\.com)\/[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+(\.git)?(\/?|\/tree\/[^\s]*)$/.test(rawUrl))
    return res.status(400).json({ error: 'Invalid GitHub/GitLab URL. Expected: https://github.com/owner/repo' });

  const DEEP_SCAN = '/root/bounty-hunter/deep-scan.sh';
  db.logEvent({ name: 'bot_contract_audit', resource: rawUrl.slice(0, 100), ip: req.ip }).catch(() => {});
  try {
    const { stdout, stderr } = await runScript('bash', [DEEP_SCAN, rawUrl, projName], 600_000);
    const outMatch = stdout.match(/→ Output:\s*(\S+\.json)/);
    if (!outMatch?.[1]) return res.status(500).json({ error: 'Scan completed but output not found', detail: stderr.slice(0, 300) });

    const report = JSON.parse(fs.readFileSync(outMatch[1], 'utf-8'));
    res.json({ status: 'complete', github_url: rawUrl, project_name: report.metadata?.project_name || projName, language: report.metadata?.language, pipeline: report.metadata?.pipeline || [], stats: report.stats || {}, findings: report.findings || [] });
  } catch (e) {
    console.error('[bot/contract] audit error:', e.message);
    res.status(500).json({ error: 'Contract audit failed', detail: e.message });
  }
});

// ── Admin Monitor Status ───────────────────────────────────────────────────────
// GET /api/v2/monitor/status — souhrnný stav monitoringu (vyžaduje X-Admin-Key)
// NGINX: /api/v2/monitor/status → proxy_pass http://127.0.0.1:3402/monitor/status
const { requireAdminKey, handleMonitorStatus } = require('./src/monitor/status');
app.get('/monitor/status', requireAdminKey, handleMonitorStatus);

// ── Error monitoring ───────────────────────────────────────────────────────────
const ADMIN_TELEGRAM_CHAT = process.env.ADMIN_TELEGRAM_CHAT || null;

async function notifyAdminError(type, err) {
  console.error(`[${type}]`, err);
  if (!ADMIN_TELEGRAM_CHAT) return;
  const msg = `🚨 <b>integrity.molt server error</b>\nType: ${type}\n<code>${String(err).slice(0, 400)}</code>`;
  await sendTelegramAlert(ADMIN_TELEGRAM_CHAT, msg).catch(() => {});
}

process.on('uncaughtException',  err => notifyAdminError('uncaughtException', err));
process.on('unhandledRejection', err => notifyAdminError('unhandledRejection', err));

// ── Startup ───────────────────────────────────────────────────────────────────
db.initSchema()
  .then(() => initUsersSchema())
  .then(() => db.initAdsSchema())
  .then(() => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`integrity.molt x402 server running on port ${PORT}`);
      // Watchlist monitor — první běh po 1 minutě, pak každých 6h
      setTimeout(() => {
        runWatchlistMonitor().catch(e => console.error('[watchlist-monitor] init run failed:', e.message));
        setInterval(() => runWatchlistMonitor().catch(e => console.error('[watchlist-monitor] interval failed:', e.message)), WATCHLIST_INTERVAL_MS);
      }, 60_000);

      // Pre-warm Puppeteer browser — avoids cold-start on first OG request
      setTimeout(() => ogWarmBrowser(), 5000);

      // Weekly digest — každou neděli v 8:00 UTC
      scheduleWeeklyDigest();

      // Live Runtime Monitoring — inicializace Helius webhooku po startu DB
      setTimeout(() => {
        initMonitor().catch(e => console.error('[monitor] Init error:', e.message));
      }, 5_000);

      // Webhook-triggered re-scan: suspektní transakce spustí okamžitý risk re-scan
      registerRescanCallback(async (address, entry) => {
        const data = await quickScanRpcOnly(address);
        const newLevel = data.risk_level || 'unknown';
        const newScore = data.risk_score ?? null;
        await db.updateWatchlistRisk(entry.id, {
          risk_level: newLevel, risk_score: newScore, risk_summary: data.summary || null
        });
        console.log(`[watchlist-monitor] webhook-triggered re-scan ${address}: ${newLevel} (score: ${newScore})`);
      });
    });

    // ── Graceful shutdown — umožní dokončit in-flight requesty ─────────────
    function gracefulShutdown(signal) {
      const { shutdown: ogShutdown } = require('./src/og/generator');
      console.log(`[shutdown] ${signal} received — closing HTTP server...`);
      server.close(async () => {
        await ogShutdown().catch(e => console.error('[shutdown] og:', e.message));
        console.log('[shutdown] All connections closed, exiting cleanly');
        process.exit(0);
      });
      // Nucené ukončení po 15s pokud server.close() nestačí
      setTimeout(() => {
        console.error('[shutdown] Forced shutdown after 15s timeout');
        process.exit(1);
      }, 15000).unref();
    }
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT',  gracefulShutdown);
  })
  .catch(e => {
    console.error('FATAL: DB schema init failed:', e.message);
    process.exit(1);
  });
