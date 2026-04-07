'use strict';
// src/delta/diff.js — Diff engine for Verified Delta Reports
// Compares two scan snapshots and returns a structured, LLM-explained diff.

const fs = require('fs');

let OPENROUTER_API_KEY = '';
try { OPENROUTER_API_KEY = fs.readFileSync('/root/.secrets/openrouter_api_key', 'utf-8').trim(); } catch {}
if (!OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY) OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ── LLM helper ─────────────────────────────────────────────────────────────────

async function explainChange(field, oldValue, newValue) {
  if (!OPENROUTER_API_KEY) {
    return `${field} changed from "${String(oldValue).slice(0, 80)}" to "${String(newValue).slice(0, 80)}".`;
  }
  const prompt =
    `Explain the security impact of this change in a Solana program or token: ` +
    `"${field}" changed from "${String(oldValue).slice(0, 200)}" to "${String(newValue).slice(0, 200)}". ` +
    `Reply in 1-2 sentences focused on security implications. Be direct.`;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:      'google/gemini-2.5-flash',
        messages:   [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens:  120
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return `${field} changed.`;
    const json = await res.json();
    return (json.choices?.[0]?.message?.content || '').trim() || `${field} changed.`;
  } catch {
    return `${field} changed from "${String(oldValue).slice(0, 80)}" to "${String(newValue).slice(0, 80)}".`;
  }
}

// ── Utility ────────────────────────────────────────────────────────────────────

function deepGet(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function safeStr(v) {
  if (v == null)              return 'null';
  if (typeof v === 'object')  return JSON.stringify(v);
  return String(v);
}

function changed(old, cur, path) {
  const o = deepGet(old, path);
  const n = deepGet(cur, path);
  if (o === undefined && n === undefined) return false;
  return safeStr(o) !== safeStr(n);
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Compare two snapshot objects and return an array of structured changes.
 * Each change: { category, field, old_value, new_value, severity, explanation }
 * Calls LLM for every distinct change — callers must handle timeouts gracefully.
 *
 * @param {object} oldSnapshot  full snapshot (with .data)
 * @param {object} newSnapshot  full snapshot (with .data)
 * @returns {Promise<Array>}
 */
async function computeDelta(oldSnapshot, newSnapshot) {
  const old = oldSnapshot.data || {};
  const cur = newSnapshot.data || {};
  const changes = [];

  // ── 1. Authority changes ───────────────────────────────────────────────────
  const authorityPaths = [
    { path: 'detail.mint_info.mint_authority',   label: 'Mint Authority' },
    { path: 'detail.mint_info.freeze_authority', label: 'Freeze Authority' },
    { path: 'meta.owner',                        label: 'Token Owner (EVM)' },
    { path: 'upgrade_authority',                 label: 'Upgrade Authority' },
    { path: 'data.upgrade_authority',            label: 'Program Upgrade Authority' }
  ];
  for (const { path, label } of authorityPaths) {
    const o = deepGet(old, path);
    const n = deepGet(cur, path);
    if (o === undefined && n === undefined) continue;
    if (safeStr(o) === safeStr(n)) continue;

    const explanation = await explainChange(label, safeStr(o), safeStr(n));
    const nStr = safeStr(n).toLowerCase();
    const oStr = safeStr(o).toLowerCase();
    let severity = 'warning';
    if (nStr === 'null' || nStr === 'none' || nStr === 'renounced') {
      severity = 'info';   // authority renounced — generally good
    } else if (oStr === 'null' || oStr === 'none' || oStr === 'renounced') {
      severity = 'critical'; // authority re-enabled — always alarming
    }
    changes.push({ category: 'authority_changes', field: label, old_value: safeStr(o), new_value: safeStr(n), severity, explanation });
  }

  // ── 2. Risk score change ───────────────────────────────────────────────────
  const scorePaths = ['risk_score', 'score', 'data.risk_score'];
  for (const p of scorePaths) {
    const o = deepGet(old, p);
    const n = deepGet(cur, p);
    if (o === undefined || n === undefined || safeStr(o) === safeStr(n)) continue;
    const delta   = (Number(n) || 0) - (Number(o) || 0);
    const severity = Math.abs(delta) >= 20 ? 'critical' : Math.abs(delta) >= 10 ? 'warning' : 'info';
    const explanation = await explainChange('Risk Score', o, n);
    changes.push({ category: 'risk_score_change', field: 'Risk Score', old_value: safeStr(o), new_value: safeStr(n), severity, explanation });
    break; // only first match
  }

  // ── 3. Token / program config changes ─────────────────────────────────────
  const configPaths = [
    { path: 'detail.mint_info.supply',              label: 'Token Supply',              severity: 'warning' },
    { path: 'detail.mint_info.decimals',            label: 'Token Decimals',            severity: 'warning' },
    { path: 'detail.mint_info.is_token_2022',       label: 'Token-2022 Program',        severity: 'info'    },
    { path: 'detail.concentration.top10_pct',       label: 'Top-10 Holder %',           severity: 'warning' },
    { path: 'detail.concentration.top1_pct',        label: 'Top-1 Holder %',            severity: 'warning' },
    { path: 'meta.name',                            label: 'Token Name (EVM)',           severity: 'warning' },
    { path: 'meta.symbol',                          label: 'Token Symbol (EVM)',         severity: 'warning' },
    { path: 'meta.totalSupply',                     label: 'Total Supply (EVM)',         severity: 'warning' },
    { path: 'meta.verified',                        label: 'Contract Verified (EVM)',    severity: 'info'    },
    { path: 'meta.isProxy',                         label: 'Proxy Contract (EVM)',       severity: 'warning' }
  ];
  for (const { path, label, severity } of configPaths) {
    const o = deepGet(old, path);
    const n = deepGet(cur, path);
    if (o === undefined && n === undefined) continue;
    if (safeStr(o) === safeStr(n)) continue;
    const explanation = await explainChange(label, safeStr(o), safeStr(n));
    changes.push({ category: 'token_config_changes', field: label, old_value: safeStr(o), new_value: safeStr(n), severity, explanation });
  }

  // ── 4. New instructions / findings ────────────────────────────────────────
  const oldFindingKeys = (old.findings || []).map(f => `${f.category}:${f.label}`);
  const newFindingKeys = (cur.findings || []).map(f => `${f.category}:${f.label}`);

  for (const f of (cur.findings || [])) {
    const key = `${f.category}:${f.label}`;
    if (oldFindingKeys.includes(key)) continue;
    const explanation = await explainChange('new finding', 'absent', f.label);
    const severity = f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'warning' : 'info';
    changes.push({ category: 'new_instructions', field: `New Finding: ${f.label}`, old_value: 'absent', new_value: f.label, severity, explanation });
  }

  // ── 5. Removed checks / findings ──────────────────────────────────────────
  for (const f of (old.findings || [])) {
    const key = `${f.category}:${f.label}`;
    if (newFindingKeys.includes(key)) continue;
    const explanation = await explainChange('removed finding', f.label, 'absent');
    // Removing an access/validation check is suspicious; removing a warning finding is neutral
    const isAccessCheck = /check|valid|access|control|guard/i.test(key);
    const severity = isAccessCheck ? 'warning' : 'info';
    changes.push({ category: 'removed_checks', field: `Removed: ${f.label}`, old_value: f.label, new_value: 'absent', severity, explanation });
  }

  // ── 6. Generic catch-all ───────────────────────────────────────────────────
  const genericPaths = [
    { path: 'category',                      label: 'Risk Category' },
    { path: 'recommendation',               label: 'Recommendation (EVM)' },
    { path: 'detail.treasury.is_multisig',  label: 'Treasury Multisig' },
    { path: 'detail.treasury.drain_risk',   label: 'Drain Risk' },
    { path: 'address_type',                 label: 'Address Type' }
  ];
  const coveredFields = new Set(changes.map(c => c.field));
  for (const { path, label } of genericPaths) {
    if (coveredFields.has(label)) continue;
    const o = deepGet(old, path);
    const n = deepGet(cur, path);
    if (o === undefined && n === undefined) continue;
    if (safeStr(o) === safeStr(n)) continue;
    const explanation = await explainChange(label, safeStr(o), safeStr(n));
    const severity = 'info';
    changes.push({ category: 'generic_changes', field: label, old_value: safeStr(o), new_value: safeStr(n), severity, explanation });
  }

  return changes;
}

module.exports = { computeDelta };
