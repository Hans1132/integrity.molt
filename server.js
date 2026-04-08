const express = require('express');
const { spawn }  = require('child_process');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const Stripe = require('stripe');
const { scanEVMToken, SUPPORTED_CHAINS: EVM_CHAINS, getExplorerKey: evmGetKey, hasExplorerKey: evmHasKey } = require('./scanners/evm-token');
const { auditToken, getShowcaseReport } = require('./scanners/token-audit');
const { generateReport, generatePDFBuffer, generatePNGBuffer } = require('./report-generator');
const authModule = require('./auth');
const { configureSession, setupStrategies, registerAuthRoutes, initUsersSchema } = authModule;
const { runWeeklyDigests, sendWelcomeEmail } = require('./mailer');
const { saveSnapshot, getLatestSnapshot, getSnapshotByTimestamp, getSnapshotHistory } = require('./src/delta/store');
const { computeDelta } = require('./src/delta/diff');
const { signDeltaReport } = require('./src/delta/signing');
const { runAdversarialSim }  = require('./src/adversarial/runner');
const { getAllPlaybooks }     = require('./src/adversarial/playbooks');
const { verifyWebhookAuth, handleHeliusWebhook } = require('./src/monitor/webhook-receiver');
const { initMonitor }        = require('./src/monitor/init');

const https = require('https');
const nodemailer = require('nodemailer');

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
const _ALCHEMY_KEY    = process.env.ALCHEMY_API_KEY || '';
const _ALCHEMY_SOL    = _ALCHEMY_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${_ALCHEMY_KEY}` : null;
const SOLANA_RPC      = process.env.SOLANA_RPC_URL
                     || _ALCHEMY_SOL
                     || 'https://api.mainnet-beta.solana.com';

// ── Quick RPC-only scan (no LLM, returns in ~1-2s) ────────────────────────────
async function quickScanRpcOnly(address) {
  const t0 = Date.now();

  // Two parallel RPC calls
  const [accountRes, sigRes] = await Promise.allSettled([
    rpcPost({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [address, { encoding: 'base64', commitment: 'confirmed' }] }),
    rpcPost({ jsonrpc: '2.0', id: 2, method: 'getSignaturesForAddress',
      params: [address, { limit: 10, commitment: 'confirmed' }] })
  ]);
  console.log(`[TIMING quick-rpc] parallel RPC: ${Date.now()-t0}ms`);

  const accountData = accountRes.status === 'fulfilled' ? accountRes.value?.result?.value : null;
  const signatures  = sigRes.status   === 'fulfilled' ? (sigRes.value?.result || []) : [];

  if (!accountData) {
    return {
      risk_score: 80, risk_level: 'high',
      summary: 'Address not found on-chain — possibly invalid, unfunded, or closed.',
      checks: { account_status: { status: 'Not found on-chain', risk: 'high' } },
      evidence: [], scan_type: 'quick-rpc', scan_ms: Date.now()-t0
    };
  }

  const lamports   = accountData.lamports || 0;
  const owner      = accountData.owner    || 'unknown';
  const executable = accountData.executable || false;
  const dataB64    = accountData.data?.[0] || '';
  const dataLen    = dataB64 ? Buffer.from(dataB64, 'base64').length : 0;
  const solBalance = lamports / 1e9;

  // Known program IDs
  const TOKEN_PROG      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const STAKE_PROG      = 'Stake11111111111111111111111111111111111111112';
  const VOTE_PROG       = 'Vote111111111111111111111111111111111111111p';
  const SYS_PROG        = '11111111111111111111111111111111';

  let addressType = 'wallet';
  if (executable) {
    addressType = 'on-chain program';
  } else if (owner === TOKEN_PROG) {
    // data length 82 = mint account, 165 = token account
    addressType = dataLen === 82 ? 'SPL token mint' : dataLen === 165 ? 'SPL token account' : 'SPL token account';
  } else if (owner === TOKEN_2022_PROG) {
    addressType = 'Token-2022 mint';
  } else if (owner === STAKE_PROG) {
    addressType = 'stake account';
  } else if (owner === VOTE_PROG) {
    addressType = 'validator vote account';
  } else if (owner === SYS_PROG) {
    addressType = 'system account (wallet)';
  }

  let score = 10;
  const riskFactors = [];

  if (lamports === 0) {
    riskFactors.push('Zero SOL balance — account may be closed or drained');
    score += 20;
  }
  const recentTxCount = signatures.length;
  if (recentTxCount === 0 && lamports < 1_000_000) {
    riskFactors.push('No recent activity and minimal balance');
    score += 10;
  }

  // Owner label
  const OWNER_NAMES = {
    [TOKEN_PROG]:      'Token Program',
    [TOKEN_2022_PROG]: 'Token-2022 Program',
    [STAKE_PROG]:      'Stake Program',
    [VOTE_PROG]:       'Vote Program',
    [SYS_PROG]:        'System Program'
  };
  const ownerLabel = OWNER_NAMES[owner] || (owner.slice(0, 12) + '…');

  const checks = {
    account_status:  { status: 'Active on-chain',             risk: 'safe' },
    account_type:    { status: addressType,                   risk: 'safe' },
    sol_balance:     { status: `${solBalance.toFixed(4)} SOL`, risk: lamports === 0 ? 'medium' : 'safe' },
    owner_program:   { status: ownerLabel,                    risk: 'safe' },
    recent_activity: {
      status: recentTxCount >= 10 ? '10+ recent txs' : `${recentTxCount} recent txs`,
      risk:   recentTxCount === 0 && lamports < 1_000_000 ? 'medium' : 'safe'
    }
  };

  const riskLevel = score >= 71 ? 'critical' : score >= 46 ? 'high' : score >= 21 ? 'medium' : 'low';

  let summary;
  if (executable) {
    summary = `On-chain program with ${solBalance.toFixed(4)} SOL balance. ${recentTxCount >= 10 ? 'Actively used' : `${recentTxCount} recent transactions`}.`;
  } else if (addressType.includes('token')) {
    summary = `${addressType.charAt(0).toUpperCase() + addressType.slice(1)}. Owned by ${ownerLabel}. Balance: ${solBalance.toFixed(4)} SOL.`;
  } else {
    summary = `${riskLevel === 'low' ? 'Standard' : 'Flagged'} ${addressType}. Balance: ${solBalance.toFixed(4)} SOL. ${recentTxCount >= 10 ? '10+' : recentTxCount} recent transactions.`;
  }
  if (riskFactors.length) summary += ' Risk: ' + riskFactors.join('; ') + '.';

  const evidence = signatures.slice(0, 5).map(s => ({
    signature: s.signature,
    slot:      s.slot,
    err:       s.err   || null,
    blockTime: s.blockTime || null
  }));

  return {
    risk_score:      score,
    risk_level:      riskLevel,
    summary,
    address_type:    addressType,
    sol_balance:     solBalance,
    owner_program:   owner,
    is_executable:   executable,
    recent_tx_count: recentTxCount,
    checks,
    evidence,
    scan_type: 'quick-rpc',
    scan_ms:   Date.now()-t0
  };
}
const USDC_MINT       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function getVerifyKeyBase64() {
  try { return fs.readFileSync(VERIFY_KEY_PATH).toString('base64'); } catch { return null; }
}

function rpcPost(body) {
  return new Promise((resolve, reject) => {
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
    if (req.apiKey) return next();

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
    next();
  };
}

const quickPaymentAccepts = [{
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: '1000000',
  resource: 'https://intmolt.org/api/v2/scan/quick',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '2000000',
  resource: 'https://intmolt.org/api/v2/scan/deep',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '1000000',
  resource: 'https://intmolt.org/api/v2/scan/token',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '1000000',
  resource: 'https://intmolt.org/api/v2/scan/wallet',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '1000000',
  resource: 'https://intmolt.org/api/v2/scan/pool',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '1000000',
  resource: 'https://intmolt.org/api/v2/scan/evm-token',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '150000',
  resource: 'https://intmolt.org/api/v2/scan/evm',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '5000000',
  resource: 'https://intmolt.org/api/v2/scan/contract',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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
  maxAmountRequired: '150000',
  resource: 'https://intmolt.org/api/v1/scan/token-audit',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: WALLET,
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

// Logo - free
app.get('/logo.svg', (req, res) => { res.sendFile('/root/x402-ecosystem-submission/logo.svg'); });

// OpenAPI spec - free
app.get('/openapi.json', (req, res) => { res.sendFile('/root/x402-server/openapi.json'); });

// x402 discovery - free
app.get('/.well-known/x402.json', (req, res) => {
  const discovery = require('./x402-discovery.json');
  res.json(discovery);
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
        price: '0.10 USDC',
        description: 'Quick on-chain scan of a Solana address - account info, balance, basic risk assessment'
      },
      {
        endpoint: 'POST /scan/deep',
        price: '2.00 USDC',
        description: 'Comprehensive security audit - full code review, vulnerability assessment, detailed report'
      },
      {
        endpoint: 'POST /scan/token',
        price: '0.25 USDC',
        description: 'Token launch audit - mint authority status, freeze authority status, top-10 holder distribution, supply analysis, rug risk rating'
      },
      {
        endpoint: 'POST /scan/wallet',
        price: '0.15 USDC',
        description: 'Wallet profiling - age estimate, activity level, DeFi exposure, risk classification (fresh wallet / whale / dormant / normal)'
      },
      {
        endpoint: 'POST /scan/pool',
        price: '0.25 USDC',
        description: 'DeFi pool safety scan - liquidity depth, LP token distribution, Raydium/Orca/Meteora pool analysis, withdrawal risk'
      },
      {
        endpoint: 'POST /scan/contract',
        price: '5.00 USDC',
        description: 'Contract Audit — static analysis (cargo-audit CVEs, clippy, semgrep) + LLM-verified findings with Immunefi impact mapping. Input: GitHub URL of a Solana/Rust project.'
      }
    ],
    subscription: [
      {
        tier: 'builder',
        price: '$79/month',
        description: 'Unlimited quick scans, 20 deep audits/month, API access, CI/CD integration, watchlist 10 addresses',
        url: 'https://intmolt.org/subscribe/builder'
      },
      {
        tier: 'team',
        price: '$299/month',
        description: 'Unlimited all scan types, priority queue, Slack/Discord/Telegram alerts, watchlist 100 addresses, dashboard',
        url: 'https://intmolt.org/subscribe/team'
      }
    ],
    x402: true,
    network: 'solana',
    payTo: WALLET,
    reportSigning: {
      algorithm: 'Ed25519',
      verifyKey: getVerifyKeyBase64(),
      description: 'All scan reports are signed with Ed25519. Verify with /root/scanner/verify-report.py or any NaCl-compatible Ed25519 library.'
    }
  });
});

// Public reputation stats - free
app.get('/stats', (req, res) => {
  const reputationFile = '/root/scanner/reputation.json';
  try {
    const raw = JSON.parse(fs.readFileSync(reputationFile, 'utf-8'));
    const total   = raw.total_scans || 0;
    const success = raw.successful_scans || 0;
    const today   = new Date().toISOString().slice(0, 10);
    const todayData = (raw.scans_by_day || {})[today] || {};
    const fb      = raw.feedback || {};
    const fbTotal = Object.values(fb).reduce((a, b) => a + b, 0);

    res.json({
      total_scans: total,
      scans_today: todayData.total || 0,
      success_rate_pct: total ? Math.round(100 * success / total * 100) / 100 : 0,
      average_response_time_ms: raw.average_response_time_ms || 0,
      satisfaction_pct: fbTotal ? Math.round(100 * (fb.positive || 0) / fbTotal * 100) / 100 : null,
      last_updated: raw.last_updated || null,
      stats_endpoint: 'https://intmolt.org/api/v2/stats'
    });
  } catch {
    res.status(503).json({ error: 'Stats unavailable', total_scans: 0 });
  }
});

// Quick Scan - paid endpoint (1.00 USDC = 1000000 micro-USDC)
app.post('/scan/quick', trackFunnel('quick'), requireApiKey, requirePayment(quickPaymentAccepts, 1000000), express.json(), async (req, res) => {
  const address = req.body.address || req.body.target;
  if (!address) return res.status(400).json({ error: 'Missing address field in request body' });

  const safeAddress = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  try {
    const _t0 = Date.now();
    const { stdout } = await runScript('/root/scanner/quick-scan.sh', [safeAddress], 60000);
    const scriptMs = Date.now() - _t0;
    const slug = safeAddress.substring(0, 10).toLowerCase();
    const { reportText, signedEnvelope } = loadLatestReport('/root/scanner/reports', slug, '');
    console.log(`[scan/quick] address=${safeAddress} script=${scriptMs}ms total=${Date.now()-_t0}ms`);
    res.json({
      status: 'complete',
      address: safeAddress,
      report: reportText || stdout,
      signed: signedEnvelope,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

// Deep Audit - paid endpoint (2.00 USDC = 2000000 micro-USDC)
// Volá multi-agent swarm orchestrator (scanner → analyst → reputation → meta-scorecard)
app.post('/scan/deep', trackFunnel('deep'), requireApiKey, requirePayment(deepPaymentAccepts, 2000000), express.json(), async (req, res) => {
  const address = req.body.address || req.body.target;
  if (!address) return res.status(400).json({ error: 'Missing address field in request body' });

  const safeAddress = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  try {
    const _t0 = Date.now();
    const { stdout } = await runScript('/root/swarm/orchestrator/orchestrator.sh', [safeAddress], 120000);
    const scriptMs = Date.now() - _t0;
    console.log(`[scan/deep] address=${safeAddress} script=${scriptMs}ms`);

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

    res.json({
      status: 'complete',
      tier: 'deep-audit',
      pipeline: 'swarm',
      address: safeAddress,
      decision:        swarmResult?.decision        || null,
      aggregate_score: swarmResult?.aggregate_score || null,
      rug_override:    swarmResult?.rug_override    || false,
      agents:          swarmResult?.agents          || null,
      report:          reportText || stdout,
      signed:          signedEnvelope,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

// Token Audit - paid endpoint (1.00 USDC = 1000000 micro-USDC)
app.post('/scan/token', trackFunnel('token'), requireApiKey, requirePayment(tokenAuditPaymentAccepts, 1000000), express.json(), async (req, res) => {
  const address = req.body.address || req.body.mint || req.body.target;
  if (!address) return res.status(400).json({ error: 'Missing address field in request body' });

  const safeAddress = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  try {
    const _t0 = Date.now();
    const { stdout } = await runScript('/root/scanner/enhanced-token-scan.sh', [safeAddress], 150000);
    console.log(`[scan/token] address=${safeAddress} script=${Date.now()-_t0}ms`);
    const slug = safeAddress.substring(0, 10).toLowerCase();
    // Try to parse JSON output from enhanced scanner
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    // Also load latest saved report file
    const { reportText, signedEnvelope } = loadLatestReport('/root/scanner/reports', slug, 'enhanced-token');
    if (data) {
      res.json({
        status: 'complete',
        type: 'enhanced-token-scan',
        scan_version: '2.0',
        address: safeAddress,
        data,
        signed: data.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : null,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        status: 'complete',
        type: 'enhanced-token-scan',
        scan_version: '2.0',
        address: safeAddress,
        report: reportText || stdout,
        signed: signedEnvelope,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Token scan failed', detail: err.message });
  }
});

// Wallet Deep Scan - paid endpoint (1.00 USDC = 1000000 micro-USDC)
app.post('/scan/wallet', trackFunnel('wallet'), requireApiKey, requirePayment(walletProfilePaymentAccepts, 1000000), express.json(), async (req, res) => {
  const address = req.body.address || req.body.wallet || req.body.target;
  if (!address) return res.status(400).json({ error: 'Missing address field in request body' });

  const safeAddress = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  try {
    const _t0 = Date.now();
    const { stdout } = await runScript('/root/scanner/wallet-deep-scan.sh', [safeAddress], 120000);
    console.log(`[scan/wallet] address=${safeAddress} script=${Date.now()-_t0}ms`);
    const slug = safeAddress.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope } = loadLatestReport('/root/scanner/reports', slug, 'wallet-deep');
    if (data) {
      res.json({
        status: 'complete',
        type: 'wallet-deep-scan',
        scan_version: '2.0',
        address: safeAddress,
        data,
        signed: data.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : null,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        status: 'complete',
        type: 'wallet-deep-scan',
        scan_version: '2.0',
        address: safeAddress,
        report: reportText || stdout,
        signed: signedEnvelope,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Wallet scan failed', detail: err.message });
  }
});

// Pool Deep Scan - paid endpoint (1.00 USDC = 1000000 micro-USDC)
app.post('/scan/pool', trackFunnel('pool'), requireApiKey, requirePayment(poolScanPaymentAccepts, 1000000), express.json(), async (req, res) => {
  const address = req.body.address || req.body.pool || req.body.target;
  if (!address) return res.status(400).json({ error: 'Missing address field in request body' });

  const safeAddress = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
  if (!safeAddress || safeAddress.length < 32 || safeAddress.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana address format' });
  }

  try {
    const _t0 = Date.now();
    const { stdout } = await runScript('/root/scanner/pool-deep-scan.sh', [safeAddress], 120000);
    console.log(`[scan/pool] address=${safeAddress} script=${Date.now()-_t0}ms`);
    const slug = safeAddress.substring(0, 10).toLowerCase();
    let data = null;
    try { data = JSON.parse(stdout.trim()); } catch {}
    const { reportText, signedEnvelope } = loadLatestReport('/root/scanner/reports', slug, 'pool-deep');
    if (data) {
      res.json({
        status: 'complete',
        type: 'pool-deep-scan',
        scan_version: '2.0',
        address: safeAddress,
        data,
        signed: data.signed ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' } : null,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        status: 'complete',
        type: 'pool-deep-scan',
        scan_version: '2.0',
        address: safeAddress,
        report: reportText || stdout,
        signed: signedEnvelope,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Pool scan failed', detail: err.message });
  }
});

// EVM Token Risk Scan - paid endpoint (1.00 USDC = 1000000 micro-USDC)
app.post('/scan/evm-token', trackFunnel('evm-token'), requireApiKey, requirePayment(evmTokenPaymentAccepts, 1000000), express.json(), async (req, res) => {
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

  // Sign report
  const _tSign = Date.now();
  let signedEnvelope = null;
  try {
    const { execSync } = require('child_process');
    const raw = execSync(`echo ${JSON.stringify(reportText)} | python3 /root/scanner/sign-report.py`, { timeout: 10000 });
    signedEnvelope = JSON.parse(raw.toString());
  } catch {}
  console.log(`[scan/evm-token] address=${address} chain=${chain} signing=${Date.now()-_tSign}ms`);

  res.json({
    status:     'complete',
    type:       'evm-token-scan',
    chain,
    address,
    score:      scanResult.score,
    recommendation: scanResult.recommendation,
    findings:   scanResult.findings,
    meta:       scanResult.meta,
    report:     reportText,
    signed:     signedEnvelope,
    timestamp:  new Date().toISOString()
  });
});

// ── GET /scan/evm/:address — EVM scan (0.15 USDC, x402) ──────────────────────
// Alias pro /api/v2/scan/evm/:address — address v URL, chain v ?chain= query param
// Příklad: GET /api/v2/scan/evm/0xdAC17F958D2ee523a2206206994597C13D831ec7?chain=ethereum
const EVM_KEY_ENV_MAP = { ethereum:'ETHERSCAN_API_KEY', bsc:'BSCSCAN_API_KEY', polygon:'POLYGONSCAN_API_KEY', arbitrum:'ARBISCAN_API_KEY', base:'BASESCAN_API_KEY' };
function evmPreValidate(req, res, next) {
  const address = (req.params.address || '').trim();
  const chain   = (req.query.chain    || 'ethereum').trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.status(400).json({ error: 'Invalid EVM address (expected 0x + 40 hex chars)' });
  if (!EVM_CHAINS.includes(chain))
    return res.status(400).json({ error: `Invalid chain — use ${EVM_CHAINS.join('|')}` });
  if (!evmHasKey(chain))
    return res.status(400).json({ error: `API key not configured for ${chain}`, hint: `Set ${EVM_KEY_ENV_MAP[chain]} in server .env` });
  next();
}
app.get('/scan/evm/:address', trackFunnel('evm-scan'), evmPreValidate, requireApiKey, requirePayment(evmScanPaymentAccepts, 150000), async (req, res) => {
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

  // Sign report
  let signedEnvelope = null;
  try {
    const { execSync } = require('child_process');
    const raw = execSync(`echo ${JSON.stringify(reportText)} | python3 /root/scanner/sign-report.py`, { timeout: 10000 });
    signedEnvelope = JSON.parse(raw.toString());
  } catch {}

  res.json({
    status:          'complete',
    type:            'evm-token-scan',
    chain,
    address,
    score:           scanResult.score,
    recommendation:  scanResult.recommendation,
    findings:        scanResult.findings,
    meta:            scanResult.meta,
    report:          reportText,
    signed:          signedEnvelope,
    timestamp:       new Date().toISOString()
  });
});

// Contract Audit - paid endpoint (5.00 USDC = 5000000 micro-USDC)
// POST /scan/contract
// Body: { github_url, project_name? }
// Spouští bounty-hunter/deep-scan.sh: cargo-audit + clippy + semgrep + LLM verification
app.post('/scan/contract', trackFunnel('contract'), requireApiKey, requirePayment(contractAuditPaymentAccepts, 5000000), express.json(), async (req, res) => {
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

// ── Token Security Audit — paid endpoint (0.15 USDC = 150000 micro-USDC) ──────
// POST /api/v1/scan/token-audit
// Body: { token_mint, token_name?, callback_url? }
app.post(
  '/api/v1/scan/token-audit',
  trackFunnel('token-security-audit'),
  requireApiKey,
  requirePayment(tokenSecurityAuditPaymentAccepts, 150000),
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
      console.log(`[scan/token-audit] mint=${safeMint} scan=${Date.now()-_t0}ms score=${auditResult.risk_score} category=${auditResult.category}`);

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

      // Sign report with Ed25519
      const _tSign = Date.now();
      let signedEnvelope = null;
      try {
        const { execSync } = require('child_process');
        const raw = execSync(`echo ${JSON.stringify(reportText)} | python3 /root/scanner/sign-report.py`, { timeout: 10000 });
        signedEnvelope = JSON.parse(raw.toString());
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
        scan_ms:    auditResult.scan_ms,
        timestamp:  new Date().toISOString()
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
    message: 'This is a pre-computed example Token Security Audit report. Run a live audit for any Molt.id token via POST /api/v1/scan/token-audit (0.15 USDC via x402).',
    pricing: {
      price:    '0.15 USDC',
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

// ── Adversarial Simulation ─────────────────────────────────────────────────────
// GET  /api/v1/adversarial/playbooks          — list all playbooks (free)
// POST /api/v1/adversarial/simulate           — run simulation (paid, 2.00 USDC)

const adversarialPaymentAccepts = [{
  scheme:            'exact',
  network:           'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  maxAmountRequired: '2000000',
  resource:          'https://intmolt.org/api/v1/adversarial/simulate',
  asset:             'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo:             WALLET,
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
  requirePayment(adversarialPaymentAccepts, 2000000),
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
  maxAmountRequired:'150000',
  resource:         'https://intmolt.org/api/v1/delta',
  asset:            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo:            WALLET,
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

  return signDeltaReport(report);
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
  requirePayment(deltaPaymentAccepts, 150000),
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
  requirePayment(deltaPaymentAccepts, 150000),
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

// POST /watchlist/add — přidat adresu do watchlistu
app.post('/watchlist/add', express.json(), async (req, res) => {
  const { address, label, telegram_chat_id, email } = req.body || {};
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid or missing Solana address' });
  }
  if (!telegram_chat_id && !email) {
    return res.status(400).json({ error: 'Provide telegram_chat_id or email for notifications' });
  }
  try {
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
  quick:       1.00,
  deep:        2.00,
  token:       1.00,
  wallet:      1.00,
  pool:        1.00,
  'evm-token': 1.00,
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
  ? `<div class="upsell"><strong>Deep Audit complete.</strong> Subscribe to <a href="/#plans">Builder ($79/mo)</a> for unlimited deep audits, API access, and watchlist monitoring.</div>`
  : `<div class="upsell"><strong>Quick Scan</strong> — This was a basic on-chain check. Upgrade to <strong>Deep Audit ($2.00)</strong> for full AI vulnerability analysis, insider cluster detection, and wash trading signals. Or subscribe to <a href="/#plans">Builder ($79/mo)</a> for unlimited access.</div>`)
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
  <a href="/scan?address=${escapeHtml(result.address)}&type=deep" class="btn-ghost btn">Deep Audit ($2.00)</a>
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
  builder: process.env.STRIPE_PRICE_BUILDER,
  team:    process.env.STRIPE_PRICE_TEAM
};

// POST /subscribe/:tier — vytvoří Stripe Checkout session a přesměruje
app.post('/subscribe/:tier', express.json(), async (req, res) => {
  const tier = req.params.tier;
  if (!['builder', 'team'].includes(tier)) {
    return res.status(400).json({ error: `Unknown tier: ${tier}. Use 'builder' or 'team'.` });
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
    await db.pool.query(
      `UPDATE subscriptions SET digest_unsubscribed = TRUE WHERE LOWER(email) = $1`,
      [email]
    ).catch(() => {});
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

// GET /scan/captcha-config — vrátí Turnstile site key pro frontend
app.get('/scan/captcha-config', (req, res) => {
  res.json({ site_key: process.env.TURNSTILE_SITE_KEY || null });
});

// GET /scan/quota?ip=auto — vrátí zbývající free scany pro aktuální IP
app.get('/scan/quota', async (req, res) => {
  const ip = req.ip;
  const used = await db.countFreeScansToday(ip).catch(() => 0);
  res.json({
    scans_used: used,
    scans_limit: FREE_SCAN_LIMIT,
    scans_remaining: Math.max(0, FREE_SCAN_LIMIT - used),
    resets_at: 'midnight UTC'
  });
});

// POST /scan/free — bezplatný scan (first 3 per IP/day), pak 402
// Turnstile token verifikace (pokud je nakonfigurováno)
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || secret === 'REPLACE_ME') return true; // graceful fallback — skip if not configured
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip || '' });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const j = await r.json();
    return j.success === true;
  } catch (e) {
    console.error('[turnstile] verification error:', e.message);
    return true; // fail open — lepší než blokovat legitimní uživatele při výpadku CF
  }
}

app.post('/scan/free', express.json(), async (req, res) => {
  const address = (req.body?.address || '').trim();
  const type    = (req.body?.type    || 'quick').trim();
  const chain   = (req.body?.chain   || 'base').trim().toLowerCase();
  const cfToken = (req.body?.cf_token || '').trim();

  if (!address) return res.status(400).json({ error: 'Missing address' });

  // Turnstile CAPTCHA verifikace
  const turnstileOk = await verifyTurnstile(cfToken, req.ip);
  if (!turnstileOk) {
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
        builder: { price: '$79/mo', url: 'https://intmolt.org/subscribe/builder' },
        team:    { price: '$299/mo', url: 'https://intmolt.org/subscribe/team'   }
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
      message:         'Deep Audit requires payment ($2.00 USDC). Use Stripe or x402 micropayments.',
      scans_used:      0,
      scans_limit:     0,
      scans_remaining: 0,
      payment_options: {
        deep: { endpoint: '/scan/deep', price_usdc: 2.00, micro_usdc: 2000000, accepts: deepPaymentAccepts }
      },
      subscription: {
        builder: { price: '$79/mo', url: 'https://intmolt.org/subscribe/builder' },
        team:    { price: '$299/mo', url: 'https://intmolt.org/subscribe/team'   }
      }
    });
  }

  const ip   = req.ip;
  const used = await db.countFreeScansToday(ip).catch(() => FREE_SCAN_LIMIT);

  if (used >= FREE_SCAN_LIMIT) {
    return res.status(402).json({
      error:           'free_quota_exceeded',
      message:         `You have used all ${FREE_SCAN_LIMIT} free scans for today. Resets at midnight UTC.`,
      scans_used:      used,
      scans_limit:     FREE_SCAN_LIMIT,
      scans_remaining: 0,
      payment_options: {
        quick:     { endpoint: '/scan/quick',     price_usdc: 1.00, micro_usdc: 1000000, accepts: quickPaymentAccepts },
        deep:      { endpoint: '/scan/deep',      price_usdc: 2.00, micro_usdc: 2000000, accepts: deepPaymentAccepts },
        token:     { endpoint: '/scan/token',     price_usdc: 1.00, micro_usdc: 1000000, accepts: tokenAuditPaymentAccepts },
        wallet:    { endpoint: '/scan/wallet',    price_usdc: 1.00, micro_usdc: 1000000, accepts: walletProfilePaymentAccepts },
        pool:      { endpoint: '/scan/pool',      price_usdc: 1.00, micro_usdc: 1000000, accepts: poolScanPaymentAccepts },
        'evm-token': { endpoint: '/scan/evm-token', price_usdc: 1.00, micro_usdc: 1000000, accepts: evmTokenPaymentAccepts },
        contract:  { endpoint: '/scan/contract',  price_usdc: 5.00, micro_usdc: 5000000, accepts: contractAuditPaymentAccepts }
      },
      subscription: {
        builder: { price: '$79/mo', url: 'https://intmolt.org/subscribe/builder' },
        team:    { price: '$299/mo', url: 'https://intmolt.org/subscribe/team'   }
      }
    });
  }

  // ── Cache hit — vrátí výsledek okamžitě bez opakování pipeline ──────────────
  const cached = await getCachedScan(safeAddress, type, isEvm ? chain : 'solana');
  if (cached) {
    console.log(`[scan/free] CACHE HIT address=${safeAddress} type=${type} — skipping pipeline`);
    return res.json({
      ...cached,
      scans_used:      used,       // nespotřebovává kvótu
      scans_remaining: Math.max(0, FREE_SCAN_LIMIT - used),
      scans_limit:     FREE_SCAN_LIMIT,
      cached:          true
    });
  }

  // Log před spuštěním — zabrání souběžnému zneužití
  await db.logEvent({ name: 'free_scan_used', resource: type, ip }).catch(() => {});

  const newUsed = used + 1;
  const t0 = Date.now();

  // ── EVM token scan (JS module, bez shell skriptu) ─────────────────────────
  if (isEvm) {
    try {
      const t1 = Date.now();
      const evmResult = await scanEVMToken(safeAddress, chain);
      const scanMs = Date.now() - t1;
      const totalMs = Date.now() - t0;
      console.log(`[scan/free] EVM address=${safeAddress} chain=${chain} scan=${scanMs}ms total=${totalMs}ms`);
      const result = {
        status:          'complete',
        type:            'evm-token',
        chain,
        address:         safeAddress,
        score:           evmResult.score,
        recommendation:  evmResult.recommendation,
        findings:        evmResult.findings,
        meta:            evmResult.meta,
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

    const result = {
      status:    'complete',
      type,
      address:   safeAddress,
      data:      data || null,
      report:    (!data && (reportText || stdout)) || null,
      signed:    data?.signed
                   ? { signature: data.signature, key_id: data.key_id, algorithm: 'Ed25519' }
                   : (signedEnvelope || null),
      timestamp: new Date().toISOString()
    };
    setCachedScan(safeAddress, type, 'solana', result);
    const histEmail2 = (req.isAuthenticated && req.isAuthenticated() && req.user?.email)
                    || req.apiKey?.email || null;
    db.logScanToHistory({
      email: histEmail2 || null, address: safeAddress, scan_type: type,
      risk_score: data?.risk_score ?? null, risk_level: data?.risk_level || null,
      summary: data?.summary || null, cached: false, result_json: data || null
    }).catch(() => {});
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
  if (!['builder', 'team'].includes(tier)) return res.status(400).send('Unknown tier');

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
      await db.pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, req.user.id]
      ).catch(() => {});
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
  try {
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
const WATCHLIST_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hodin
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
    const cpmRow = await db.pool.query('SELECT cpm_usd FROM ads WHERE id = $1', [ad.id]);
    const cpm = parseFloat(cpmRow.rows[0]?.cpm_usd || 0);
    db.trackAdImpression(ad.id, cpm / 1000).catch(() => {});
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

// ── Live Runtime Monitoring — Helius Webhook ──────────────────────────────────
// POST /webhook/helius — přijímá Helius enhanced transaction data
// NGINX: /api/v2/webhook/helius → proxy_pass http://127.0.0.1:3402/ stripuje prefix
// Helius webhook URL: https://intmolt.org/api/v2/webhook/helius
app.post('/webhook/helius', express.json({ limit: '1mb' }), verifyWebhookAuth, handleHeliusWebhook);

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
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`integrity.molt x402 server running on port ${PORT}`);
      // Watchlist monitor — první běh po 1 minutě, pak každých 6h
      setTimeout(() => {
        runWatchlistMonitor().catch(e => console.error('[watchlist-monitor] init run failed:', e.message));
        setInterval(() => runWatchlistMonitor().catch(e => console.error('[watchlist-monitor] interval failed:', e.message)), WATCHLIST_INTERVAL_MS);
      }, 60_000);

      // Weekly digest — každou neděli v 8:00 UTC
      scheduleWeeklyDigest();

      // Live Runtime Monitoring — inicializace Helius webhooku po startu DB
      setTimeout(() => {
        initMonitor().catch(e => console.error('[monitor] Init error:', e.message));
      }, 5_000);
    });
  })
  .catch(e => {
    console.error('FATAL: DB schema init failed:', e.message);
    process.exit(1);
  });
