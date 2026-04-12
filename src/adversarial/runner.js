'use strict';
// src/adversarial/runner.js — AI-powered adversarial simulation orchestrator
// Ties together: fork → discover → select playbooks → LLM analysis → execute →
// sign report. Returns a structured AdversarialReport.

const fs   = require('fs');
const path = require('path');

const { forkState, discoverAccounts, rpcCall, WELL_KNOWN } = require('./fork');
const { selectPlaybooks, getAllPlaybooks }                  = require('./playbooks');
const {
  tryUnauthorizedSolTransfer,
  tryUnauthorizedAccountClose,
  checkAccountOwnerConsistency,
  snapshotBalances,
  probeValidatorSanity
} = require('./executor');
const { signDeltaReport } = require('../delta/signing');  // reuse Ed25519 pipeline

// ── LLM config ────────────────────────────────────────────────────────────────

let OPENROUTER_API_KEY = '';
try { OPENROUTER_API_KEY = fs.readFileSync('/root/.secrets/openrouter_api_key', 'utf-8').trim(); } catch {}
if (!OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY) OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const { runWithAdvisor }          = require('../llm/anthropic-advisor');
const { SECURITY_ANALYST_SYSTEM } = require('../llm/prompts/security-analyst');
const { logAdvisorUsage }         = require('../../db');
const { validateAdversarialResult } = require('../llm/scan-validator');

// OpenRouter fallback (gemini-2.5-flash)
async function analyzeWithOpenRouter(prompt, maxTokens = 800) {
  if (!OPENROUTER_API_KEY) return { error: 'no_api_key', text: '' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:       'google/gemini-2.5-flash',
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens:  maxTokens
      }),
      signal: AbortSignal.timeout(40000)
    });
    if (!res.ok) return { error: `http_${res.status}`, text: '' };
    const json = await res.json();
    const text = (json.choices?.[0]?.message?.content || '').trim();
    return { text };
  } catch (e) {
    return { error: e.message, text: '' };
  }
}

// Anthropic Sonnet + Opus advisor pro komplexní bezpečnostní analýzu
// prebuiltPrompt: pokud je zadán, použije se přímo místo generického šablonového promptu
async function analyzeWithAdvisor(scanData, scanType, prebuiltPrompt = null) {
  const userMessage = prebuiltPrompt ||
    `Analyzuj následující ${scanType} scan data a vytvoř bezpečnostní report:\n\n${JSON.stringify(scanData, null, 2)}`;

  const result = await runWithAdvisor({
    systemPrompt:    SECURITY_ANALYST_SYSTEM,
    userMessage,
    maxAdvisorUses:  scanType === 'deep' ? 3 : 2,
  });

  let parsed = null;
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.error('[adversarial] Failed to parse advisor response:', e.message);
  }

  // Loguj usage do DB (non-blocking)
  try { logAdvisorUsage(null, scanType, result); } catch {}

  return {
    analysis:    parsed,
    rawText:     result.text,
    advisorUsed: result.advisorUsed,
    usage:       result.usage,
  };
}

// Parse JSON out of LLM output even if wrapped in markdown code fences.
function parseLLMJson(text) {
  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch { return null; }
}

// ── Program analysis via LLM ──────────────────────────────────────────────────

async function analyzeProgram(programId, accounts) {
  const accountSummary = accounts.map(a =>
    `${a.pubkey.slice(0, 8)}… type=${a.type} lamports=${a.lamports} dataSize=${a.dataSize}`
  ).join('\n');

  const prompt = `You are a Solana smart contract security auditor.

Program address: ${programId}
Discovered accounts (${accounts.length} total):
${accountSummary}

Based on the account types and sizes, answer in JSON:
{
  "program_type": "<token|defi_amm|nft|staking|bridge|governance|unknown>",
  "likely_instructions": ["<instruction names>"],
  "likely_cpi_targets": ["<program names>"],
  "high_value_accounts": ["<pubkeys likely to hold funds>"],
  "authority_accounts": ["<pubkeys likely to be authority/admin>"],
  "oracle_accounts": ["<pubkeys likely to be price feeds>"],
  "risk_profile": "<brief 2-sentence security risk summary>",
  "recommended_playbooks": ["<playbook ids from: authority_takeover, oracle_manipulation, missing_signer_check, account_confusion, drain_vault, reentrancy_cpi, integer_overflow>"]
}`;

  let analysisResult;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      analysisResult = await analyzeWithAdvisor(null, 'deep', prompt);
    } else {
      const { text } = await analyzeWithOpenRouter(prompt, 600);
      analysisResult = { rawText: text, advisorUsed: false };
    }
  } catch (err) {
    console.error('[adversarial] analyzeProgram advisor failed, falling back:', err.message);
    const { text } = await analyzeWithOpenRouter(prompt, 600);
    analysisResult = { rawText: text, advisorUsed: false };
  }

  return parseLLMJson(analysisResult.rawText) || {
    program_type: 'unknown',
    likely_instructions: [],
    likely_cpi_targets: [],
    high_value_accounts: [],
    authority_accounts: [],
    oracle_accounts: [],
    risk_profile: 'Unable to analyze — LLM unavailable.',
    recommended_playbooks: [],
  };
}

// ── Per-playbook LLM analysis ─────────────────────────────────────────────────

async function analyzePlaybook(playbook, programId, accounts, txResults) {
  const txSummary = txResults.length
    ? txResults.map(r => `[${r.outcome}] ${r.exploitId}: ${r.detail?.slice(0, 100)}`).join('\n')
    : 'No transaction tests executed for this playbook.';

  const prompt = `You are a Solana security expert running adversarial simulation.

Program: ${programId}
Attack playbook: "${playbook.name}" (${playbook.id})
Description: ${playbook.description}
CWE: ${playbook.cwe}

Accounts available:
${accounts.map(a => `  ${a.pubkey.slice(0, 8)}… ${a.type} lamports=${a.lamports}`).join('\n')}

Transaction-level test results:
${txSummary}

Based on the account structure and test results, provide a security analysis in JSON:
{
  "verdict": "<VULNERABLE|LIKELY_VULNERABLE|PROTECTED|INCONCLUSIVE>",
  "confidence": <0-100>,
  "evidence": ["<specific observations>"],
  "exploitation_path": "<step-by-step how an attacker would exploit this, or 'N/A'>",
  "remediation": ["<concrete fix recommendations>"],
  "severity": "<critical|high|medium|low|info>"
}`;

  let analysisResult;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      analysisResult = await analyzeWithAdvisor(null, 'adversarial', prompt);
    } else {
      const { text } = await analyzeWithOpenRouter(prompt, 500);
      analysisResult = { rawText: text, advisorUsed: false };
    }
  } catch (err) {
    console.error('[adversarial] analyzePlaybook advisor failed, falling back:', err.message);
    const { text } = await analyzeWithOpenRouter(prompt, 500);
    analysisResult = { rawText: text, advisorUsed: false };
  }

  return parseLLMJson(analysisResult.rawText) || {
    verdict: 'INCONCLUSIVE',
    confidence: 0,
    evidence: ['LLM analysis unavailable'],
    exploitation_path: 'N/A',
    remediation: [],
    severity: 'info',
  };
}

// ── Execution: map playbook → executor functions ──────────────────────────────

async function executePlaybook(playbook, forkInfo, programId, accounts, programAnalysis) {
  const { rpcUrl } = forkInfo;
  const txResults  = [];

  // No fork available — skip all transaction-level tests and go straight to LLM-only analysis.
  // Prevents crash from new Connection(null) when skipFork=true or fork startup failed.
  if (!rpcUrl) {
    txResults.push({
      exploitId: `${playbook.id}:no_fork`,
      outcome:   'info',
      detail:    'Fork unavailable — transaction-level tests skipped, using LLM-only analysis.',
      ts:        new Date().toISOString()
    });
    const analysisRaw = await analyzePlaybook(playbook, programId, accounts, txResults);
    const analysis = validateAdversarialResult(analysisRaw, {
      rawScore: null,
      findings: txResults.map(r => ({ severity: r.outcome === 'fail' ? 'critical' : 'info', label: r.exploitId }))
    });
    return {
      playbook_id:   playbook.id,
      playbook_name: playbook.name,
      cwe:           playbook.cwe,
      tx_results:    txResults,
      analysis,
      severity:      analysis.severity || playbook.severity_if_success
    };
  }

  try {
    switch (playbook.id) {
      case 'drain_vault': {
        // Try to drain high-value accounts
        const targets = [
          ...programAnalysis.high_value_accounts,
          ...accounts.filter(a => a.lamports > 1e9).map(a => a.pubkey)  // > 1 SOL
        ].slice(0, 5);

        for (const target of targets) {
          txResults.push(await tryUnauthorizedSolTransfer(rpcUrl, target));
          txResults.push(await tryUnauthorizedAccountClose(rpcUrl, target));
        }
        break;
      }

      case 'authority_takeover': {
        // Check ownership consistency of authority accounts
        const authAccts = [
          ...programAnalysis.authority_accounts,
          ...accounts.filter(a => a.type === 'config_small').map(a => a.pubkey)
        ].slice(0, 8);

        if (authAccts.length >= 2) {
          txResults.push(await checkAccountOwnerConsistency(rpcUrl, authAccts));
        }
        // Also try unauthorized SOL drain on each authority account
        for (const pk of authAccts.slice(0, 3)) {
          txResults.push(await tryUnauthorizedSolTransfer(rpcUrl, pk));
        }
        break;
      }

      case 'missing_signer_check': {
        // Probe: try sending transactions with wrong signers on all discovered accounts
        const pubkeys = accounts.map(a => a.pubkey).slice(0, 10);
        if (pubkeys.length >= 2) {
          txResults.push(await checkAccountOwnerConsistency(rpcUrl, pubkeys));
        }
        break;
      }

      case 'account_confusion': {
        const pubkeys = accounts.map(a => a.pubkey);
        if (pubkeys.length >= 2) {
          txResults.push(await checkAccountOwnerConsistency(rpcUrl, pubkeys.slice(0, 15)));
        }
        break;
      }

      case 'oracle_manipulation': {
        // Inspect oracle account data sizes (manipulation feasibility)
        const oracles = [
          ...programAnalysis.oracle_accounts,
          ...accounts.filter(a => /data_store|config/.test(a.type)).map(a => a.pubkey)
        ].slice(0, 5);

        for (const pk of oracles) {
          try {
            const info = await rpcCall(rpcUrl, 'getAccountInfo', [pk, { encoding: 'base64' }]);
            const dataB64 = info?.result?.value?.data?.[0] || '';
            const size    = dataB64 ? Buffer.from(dataB64, 'base64').length : 0;
            txResults.push({
              exploitId: 'oracle_manipulation:inspect',
              outcome:   'info',
              detail:    `Oracle candidate ${pk.slice(0, 8)}… data_size=${size} lamports=${info?.result?.value?.lamports || 0}`,
              ts:        new Date().toISOString()
            });
          } catch {}
        }
        break;
      }

      case 'reentrancy_cpi':
      case 'integer_overflow': {
        // These require deploying custom programs — mark as LLM-only analysis
        txResults.push({
          exploitId: `${playbook.id}:static_analysis_only`,
          outcome:   'info',
          detail:    'This attack requires deploying a malicious program — analysis is LLM-based only.',
          ts:        new Date().toISOString()
        });
        break;
      }
    }
  } catch (e) {
    txResults.push({
      exploitId: `${playbook.id}:executor_error`,
      outcome:   'error',
      detail:    e.message?.slice(0, 200) || 'Unknown executor error',
      ts:        new Date().toISOString()
    });
  }

  // LLM analysis for this playbook
  const analysisRaw = await analyzePlaybook(playbook, programId, accounts, txResults);
  const analysis = validateAdversarialResult(analysisRaw, {
    rawScore: null,
    findings: txResults.map(r => ({ severity: r.outcome === 'fail' ? 'critical' : 'info', label: r.exploitId }))
  });

  return {
    playbook_id:   playbook.id,
    playbook_name: playbook.name,
    cwe:           playbook.cwe,
    tx_results:    txResults,
    analysis,
    severity:      analysis.severity || playbook.severity_if_success
  };
}

// ── Report signing ────────────────────────────────────────────────────────────

function buildUnsignedReport(programId, accounts, programAnalysis, playbookResults, meta) {
  const findings = playbookResults.filter(r =>
    ['VULNERABLE', 'LIKELY_VULNERABLE'].includes(r.analysis.verdict)
  );
  const critical = findings.filter(r => r.severity === 'critical').length;
  const high     = findings.filter(r => r.severity === 'high').length;

  return {
    type:         'adversarial_simulation_report',
    version:      1,
    program_id:   programId,
    program_type: programAnalysis.program_type || 'unknown',
    generated_at: new Date().toISOString(),
    scan_meta:    meta,
    account_discovery: {
      total:   accounts.length,
      accounts: accounts.map(a => ({
        pubkey:   a.pubkey,
        type:     a.type,
        lamports: a.lamports,
        dataSize: a.dataSize
      }))
    },
    program_analysis: programAnalysis,
    playbook_results: playbookResults,
    summary: {
      playbooks_run:    playbookResults.length,
      vulnerable:       findings.filter(r => r.analysis.verdict === 'VULNERABLE').length,
      likely_vulnerable:findings.filter(r => r.analysis.verdict === 'LIKELY_VULNERABLE').length,
      protected:        playbookResults.filter(r => r.analysis.verdict === 'PROTECTED').length,
      inconclusive:     playbookResults.filter(r => r.analysis.verdict === 'INCONCLUSIVE').length,
      critical,
      high,
      overall_risk:     critical > 0 ? 'CRITICAL' : high > 0 ? 'HIGH' : findings.length > 0 ? 'MEDIUM' : 'LOW'
    }
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a full adversarial simulation against a Solana program.
 *
 * @param {string} programId  base58 program address
 * @param {object} options
 * @param {string[]} [options.playbookIds]   restrict to specific playbook IDs
 * @param {boolean}  [options.skipFork=false] skip local validator (analysis-only mode)
 * @param {number}   [options.rpcPort=8899]
 * @param {number}   [options.timeoutMs=300000]
 * @returns {Promise<object>}  signed adversarial report
 */
async function runAdversarialSim(programId, options = {}) {
  const timeoutMs = options.timeoutMs || 5 * 60 * 1000; // 5 min default

  // Wrap simulation in a top-level timeout so a stuck validator never blocks the request
  const simPromise = _runAdversarialSimInner(programId, options);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Adversarial simulation timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([simPromise, timeoutPromise]);
}

async function _runAdversarialSimInner(programId, options = {}) {
  const t0   = Date.now();
  const meta = { programId, options, started_at: new Date().toISOString() };

  console.log(`[adversarial] starting simulation for ${programId}`);

  // Step 1: Discover accounts on mainnet (once — reused by forkState to avoid double RPC call)
  let accounts = [];
  try {
    accounts = await discoverAccounts(programId);
    console.log(`[adversarial] discovered ${accounts.length} accounts`);
  } catch (e) {
    console.error('[adversarial] account discovery failed:', e.message);
  }

  // Step 2: LLM program analysis
  const programAnalysis = await analyzeProgram(programId, accounts);
  console.log(`[adversarial] program_type=${programAnalysis.program_type}`);

  // Step 3: Select playbooks
  const playbookIds = options.playbookIds?.length ? options.playbookIds : programAnalysis.recommended_playbooks;
  const playbooks   = selectPlaybooks(accounts, playbookIds);
  console.log(`[adversarial] running ${playbooks.length} playbooks: ${playbooks.map(p => p.id).join(', ')}`);

  // Step 4: Fork or analysis-only mode
  let forkInfo = null;
  if (!options.skipFork) {
    try {
      forkInfo = await forkState(programId, {
        rpcPort:   options.rpcPort || 8899,
        timeoutMs: options.timeoutMs || 5 * 60 * 1000,
        accounts,  // pass pre-discovered accounts to avoid double discoverAccounts call
      });

      // Sanity probe
      const sanity = await probeValidatorSanity(forkInfo.rpcUrl);
      console.log(`[adversarial] validator sanity: ${sanity.outcome}`);
    } catch (e) {
      console.error('[adversarial] fork failed, falling back to analysis-only:', e.message);
      options.skipFork = true;
    }
  }

  // Step 5: Snapshot balances before attacks (detects unexpected fund movements)
  let balancesBefore = {};
  if (forkInfo?.rpcUrl) {
    try {
      balancesBefore = await snapshotBalances(forkInfo.rpcUrl, accounts.map(a => a.pubkey));
    } catch {}
  }

  // Step 6: Execute playbooks
  const playbookResults = [];
  for (const playbook of playbooks) {
    console.log(`[adversarial] executing playbook: ${playbook.id}`);
    const pbResult = await executePlaybook(
      playbook,
      forkInfo || { rpcUrl: null },
      programId,
      accounts,
      programAnalysis
    );
    playbookResults.push(pbResult);
  }

  // Step 7: Snapshot balances after attacks
  if (forkInfo?.rpcUrl) {
    try {
      const balancesAfter = await snapshotBalances(forkInfo.rpcUrl, accounts.map(a => a.pubkey));
      const delta = Object.fromEntries(
        Object.keys(balancesBefore)
          .filter(k => balancesBefore[k] !== (balancesAfter[k] ?? 0))
          .map(k => [k, { before: balancesBefore[k], after: balancesAfter[k] ?? 0 }])
      );
      if (Object.keys(delta).length > 0) {
        console.log(`[adversarial] balance delta detected for ${Object.keys(delta).length} accounts`);
        meta.balance_delta = delta;
      }
    } catch {}
  }

  // Step 8: Cleanup fork
  if (forkInfo) {
    forkInfo.cleanup();
    console.log('[adversarial] validator cleanup done');
  }

  meta.duration_ms = Date.now() - t0;
  meta.fork_used   = !!forkInfo;

  // Step 9: Build and sign report
  const unsigned = buildUnsignedReport(programId, accounts, programAnalysis, playbookResults, meta);
  const signed   = signDeltaReport(unsigned);  // reuses same Ed25519 pipeline

  console.log(`[adversarial] simulation complete in ${meta.duration_ms}ms — overall_risk=${unsigned.summary.overall_risk}`);
  return signed;
}

module.exports = { runAdversarialSim, parseLLMJson, buildUnsignedReport, executePlaybook };
