'use strict';
/**
 * integrity.molt — Premium Report Generator
 * Renders scan results to report.html → report.png + report.pdf
 * using Puppeteer (bundled Chromium).
 */

const fs   = require('fs');
const path = require('path');

// ── Colour palette ────────────────────────────────────────────────────────────
const RISK_META = {
  low:      { color: '#22c55e', glow: '#16a34a33', bg: '#052e16', badge: '#15803d', label: 'LOW RISK'      },
  medium:   { color: '#f59e0b', glow: '#d9770633', bg: '#2d1a00', badge: '#b45309', label: 'MEDIUM RISK'   },
  high:     { color: '#ef4444', glow: '#dc262633', bg: '#2d0a0a', badge: '#b91c1c', label: 'HIGH RISK'     },
  critical: { color: '#ff2222', glow: '#ff000044', bg: '#3a0000', badge: '#991b1b', label: 'CRITICAL RISK' },
  unknown:  { color: '#6b7280', glow: '#37415133', bg: '#111827', badge: '#374151', label: 'UNKNOWN'        },
};

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Parse plain-text swarm report ─────────────────────────────────────────────
function parseSwarmText(text) {
  if (!text) return null;
  const sections = {};

  const scannerMatch  = text.match(/--- Scanner Agent[^\n]*---\n([\s\S]*?)(?=\n---|\n===|$)/);
  const analystMatch  = text.match(/--- Analyst Agent[^\n]*---\n([\s\S]*?)(?=\n---|\n===|$)/);
  const repMatch      = text.match(/--- Reputation Agent[^\n]*---\n([\s\S]*?)(?=\n---|\n===|$)/);
  const metaMatch     = text.match(/--- Meta-Scorecard[^\n]*---\n([\s\S]*?)(?=\n---|\n===|$)/);

  function extractScore(block) {
    if (!block) return null;
    const m = block.match(/Safety Score:\s*([\d.]+)\s*\/\s*100|Score:\s*([\d.]+)\s*\/\s*100|Aggregate Score:\s*([\d.]+)\s*\/\s*100/);
    return m ? parseFloat(m[1] || m[2] || m[3]) : null;
  }
  function extractConf(block) {
    if (!block) return null;
    const m = block.match(/confidence:\s*([\d]+)%/);
    return m ? parseInt(m[1]) : null;
  }
  function extractRisk(block) {
    if (!block) return null;
    const m = block.match(/Risk Level:\s*(\w+)/i);
    return m ? m[1].toLowerCase() : null;
  }
  function extractReason(block) {
    if (!block) return null;
    const m = block.match(/Reason:\s*(.+)/i) || block.match(/Analysis:\s*(.+)/i) || block.match(/Recommendation:\s*(.+)/i);
    return m ? m[1].trim() : null;
  }

  const scanBlock = scannerMatch?.[1] || '';
  const analBlock = analystMatch?.[1] || '';
  const repBlock  = repMatch?.[1]     || '';
  const metaBlock = metaMatch?.[1]    || '';

  // Extract flags from reputation
  const flags = [];
  const flagMatches = repBlock.matchAll(/- ([\w_]+):\s*(.+)/g);
  for (const fm of flagMatches) flags.push({ key: fm[1].replace(/_/g,' '), value: fm[2].trim() });

  // Extract contributions from meta
  const contributions = [];
  const contriMatches = metaBlock.matchAll(/(\w+)\s*:\s*score=([\d.]+)\s*weight=([\d.]+)\s*contribution=([\d.]+)/g);
  for (const cm of contriMatches) contributions.push({
    agent: cm[1], score: parseFloat(cm[2]), weight: parseFloat(cm[3]), contribution: parseFloat(cm[4])
  });

  const decision = (metaBlock.match(/Decision:\s*(\S+)/)?.[1] || '').replace(/-/g,' ');
  const aggScore = extractScore(metaBlock);
  const riskLevel = extractRisk(analBlock) || (aggScore >= 80 ? 'low' : aggScore >= 60 ? 'medium' : 'high');

  // Extract date and address
  const dateMatch = text.match(/Date:\s*(.+)/);
  const addrMatch = text.match(/Address:\s*(.+)/);

  return {
    isSwarm: true,
    date:    dateMatch?.[1]?.trim() || '',
    address: addrMatch?.[1]?.trim() || '',
    aggregate_score: aggScore,
    risk_level: riskLevel,
    decision,
    agents: {
      scanner:    { score: extractScore(scanBlock),  conf: extractConf(scanBlock),  reason: extractReason(scanBlock)  },
      analyst:    { score: extractScore(analBlock),  conf: extractConf(analBlock),  risk: extractRisk(analBlock), reason: extractReason(analBlock) },
      reputation: { score: extractScore(repBlock),   conf: extractConf(repBlock),   flags }
    },
    contributions,
  };
}

// ── SVG risk gauge ────────────────────────────────────────────────────────────
function riskGaugeSvg(score, col) {
  const r = 52, cx = 64, cy = 64;
  const circ = 2 * Math.PI * r;
  const validScore = (typeof score === 'number' && !isNaN(score)) ? Math.min(100, Math.max(0, score)) : 0;
  const dash = (validScore / 100) * circ;
  return `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1e293b" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="10"
      stroke-dasharray="${dash} ${circ}" stroke-dashoffset="${circ * 0.25}"
      stroke-linecap="round"/>
    <text x="${cx}" y="${cy + 8}" text-anchor="middle"
      font-family="'SF Mono','Fira Code','Consolas',monospace"
      font-size="28" font-weight="700" fill="${col}">${validScore}</text>
    <text x="${cx}" y="${cy + 26}" text-anchor="middle"
      font-family="sans-serif" font-size="9" fill="#6b7280">/100</text>
  </svg>`;
}

// ── Agent bar ─────────────────────────────────────────────────────────────────
function agentBar(label, score, weight, col) {
  const pct = Math.round((score ?? 0));
  return `
  <div style="margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
      <span style="font-family:monospace;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px">${escHtml(label)}</span>
      <span style="font-family:monospace;font-size:13px;font-weight:700;color:${col}">${score ?? '—'}<span style="font-size:10px;color:#475569;font-weight:400">/100</span></span>
    </div>
    <div style="height:6px;background:#1e293b;border-radius:3px;overflow:hidden">
      <div style="height:100%;width:${pct}%;background:${col};border-radius:3px;transition:width .3s"></div>
    </div>
    <div style="font-size:10px;color:#475569;margin-top:3px">weight ${weight ?? '—'}</div>
  </div>`;
}

// ── Severity badge ────────────────────────────────────────────────────────────
function severityBadge(risk) {
  const r = (risk || 'unknown').toLowerCase();
  const m = RISK_META[r] || RISK_META.unknown;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${m.badge}22;border:1px solid ${m.badge}66;font-family:monospace;font-size:10px;font-weight:700;color:${m.color};text-transform:uppercase;letter-spacing:.6px">${m.label}</span>`;
}

// ── Build premium HTML ────────────────────────────────────────────────────────
function buildHtml(result) {
  const isError = result.status === 'error';
  const typeName = (result.type || 'scan').charAt(0).toUpperCase() + (result.type || 'scan').slice(1);
  const now = new Date().toUTCString();

  // Determine data source
  let d = result.data && typeof result.data === 'object' ? result.data : null;
  let swarm = null;
  let textReport = null;

  // If data has a `report` text field (swarm signed.json loaded as data)
  if (d && typeof d.report === 'string' && d.signature) {
    swarm = parseSwarmText(d.report);
    textReport = d.report;
    d = null; // Use swarm object instead of d
  } else if (result.report) {
    // Plain text report — check if swarm
    swarm = parseSwarmText(result.report);
    textReport = result.report;
  }

  // EVM scans vracejí `score` a `risk_level` na root úrovni result (ne v data)
  const score = swarm?.aggregate_score ?? d?.risk_score ?? d?.aggregate_score ?? result.score ?? null;
  const risk  = (swarm?.risk_level || d?.risk_level || result.risk_level || 'unknown').toLowerCase();
  const meta  = RISK_META[risk] || RISK_META.unknown;
  const col   = meta.color;
  const address = result.address || swarm?.address || '';

  // ── Sections HTML ──────────────────────────────────────────────────────────

  // Executive summary
  let execSummary = '';
  if (swarm) {
    execSummary = `
    <div style="background:${meta.bg};border:1px solid ${col}33;border-radius:12px;padding:28px 32px;margin-bottom:28px;box-shadow:0 0 40px ${meta.glow}">
      <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap">
        <div style="flex-shrink:0">${riskGaugeSvg(score, col)}</div>
        <div style="flex:1;min-width:220px">
          <div style="margin-bottom:10px">${severityBadge(risk)}</div>
          <div style="font-size:26px;font-weight:800;color:#f1f5f9;margin-bottom:8px;line-height:1.2">
            Aggregate Score: <span style="color:${col}">${score ?? '?'}</span><span style="font-size:14px;color:#475569;font-weight:400"> / 100</span>
          </div>
          <div style="font-family:monospace;font-size:12px;color:#64748b;word-break:break-all;margin-bottom:10px">${escHtml(address)}</div>
          ${swarm.decision ? `<div style="font-size:13px;color:#94a3b8">Decision: <strong style="color:#e2e8f0">${escHtml(swarm.decision)}</strong></div>` : ''}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:monospace;font-size:10px;padding:4px 12px;background:#0f2414;border:1px solid #166534;color:#22c55e;border-radius:4px;margin-bottom:8px">✓ Ed25519 Signed</div>
          <div style="font-family:monospace;font-size:10px;color:#374151">${escHtml(swarm.date || now)}</div>
        </div>
      </div>
    </div>`;
  } else if (d) {
    const summary  = d.summary || '';
    const tokName  = d.name   ? `<span style="font-size:22px;font-weight:800;color:#f1f5f9">${escHtml(d.name)}</span>` : '';
    const tokSym   = d.symbol ? `<span style="font-size:14px;color:#64748b;font-family:monospace;margin-left:8px">${escHtml(d.symbol)}</span>` : '';
    execSummary = `
    <div style="background:${meta.bg};border:1px solid ${col}33;border-radius:12px;padding:28px 32px;margin-bottom:28px;box-shadow:0 0 40px ${meta.glow}">
      <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap">
        <div style="flex-shrink:0">${riskGaugeSvg(score, col)}</div>
        <div style="flex:1;min-width:220px">
          <div style="margin-bottom:8px">${severityBadge(risk)}</div>
          ${tokName || tokSym ? `<div style="margin-bottom:8px">${tokName}${tokSym}</div>` : ''}
          ${summary ? `<div style="font-size:14px;color:#94a3b8;line-height:1.6;margin-bottom:8px">${escHtml(summary)}</div>` : ''}
          <div style="font-family:monospace;font-size:11px;color:#374151;word-break:break-all">${escHtml(address)}</div>
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:monospace;font-size:10px;padding:4px 12px;background:#0f2414;border:1px solid #166534;color:#22c55e;border-radius:4px">✓ Ed25519 Signed</div>
          <div style="font-family:monospace;font-size:10px;color:#374151;margin-top:6px">${escHtml(d.scanned_at ? new Date(d.scanned_at).toUTCString() : now)}</div>
        </div>
      </div>
    </div>`;
  } else {
    execSummary = `
    <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:28px 32px;margin-bottom:28px">
      <div style="font-family:monospace;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Address</div>
      <div style="font-family:monospace;font-size:13px;color:#e2e8f0;word-break:break-all">${escHtml(address)}</div>
    </div>`;
  }

  // Agent scorecard (swarm only)
  let scorecardHtml = '';
  if (swarm) {
    const agents = swarm.agents;
    const contribs = swarm.contributions;
    const agentColor = (s) => s >= 80 ? '#22c55e' : s >= 60 ? '#f59e0b' : '#ef4444';

    scorecardHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Agent Scorecard</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">
        ${['scanner','analyst','reputation'].map(name => {
          const ag = agents[name] || {};
          const sc = ag.score ?? null;
          const ac = agentColor(sc ?? 0);
          return `
          <div style="background:#111827;border:1px solid #1f2937;border-radius:10px;padding:20px">
            <div style="font-family:monospace;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px">${name} agent</div>
            ${agentBar(name, sc, contribs.find(c=>c.agent===name)?.weight, ac)}
            ${ag.reason ? `<div style="font-size:12px;color:#94a3b8;margin-top:8px;line-height:1.5">${escHtml(ag.reason.slice(0,160))}${ag.reason.length>160?'…':''}</div>` : ''}
            ${ag.risk   ? `<div style="margin-top:8px">${severityBadge(ag.risk)}</div>` : ''}
            ${ag.conf   ? `<div style="font-family:monospace;font-size:10px;color:#475569;margin-top:6px">confidence ${ag.conf}%</div>` : ''}
            ${(ag.flags||[]).slice(0,3).map(f=>`<div style="font-size:11px;color:#64748b;margin-top:4px">• ${escHtml(f.key)}: <span style="color:#94a3b8">${escHtml(f.value)}</span></div>`).join('')}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Security checks (structured data)
  let checksHtml = '';
  if (d?.checks && typeof d.checks === 'object') {
    const entries = Object.entries(d.checks);
    checksHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Security Checks</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
        ${entries.map(([key, val]) => {
          const rk  = (val?.risk || '').toLowerCase();
          const bc  = rk === 'high' || rk === 'critical' ? '#ef4444' : rk === 'medium' ? '#f59e0b' : '#22c55e';
          const bg  = rk === 'high' || rk === 'critical' ? '#2d0a0a' : rk === 'medium' ? '#2d1a00' : '#052e16';
          const bdr = rk === 'high' || rk === 'critical' ? '#7f1d1d' : rk === 'medium' ? '#78350f' : '#14532d';
          const label = key.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
          const valueText = val?.status || val?.risk || '—';
          const detail = val?.detail || val?.message || '';
          return `
          <div style="background:${bg};border:1px solid ${bdr};border-left:3px solid ${bc};border-radius:8px;padding:16px">
            <div style="font-family:monospace;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">${escHtml(label)}</div>
            <div style="font-size:14px;font-weight:600;color:#e2e8f0;margin-bottom:4px">${escHtml(String(valueText))}</div>
            ${detail ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;line-height:1.4">${escHtml(String(detail).slice(0,100))}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // ── Risk Factors (findings) ───────────────────────────────────────────────
  let findingsHtml = '';
  const findings = d?.findings || d?.flags || result.findings || [];
  if (Array.isArray(findings) && findings.length > 0) {
    // Ikony jako SVG (emoji nefungují v Chromium headless PDF)
    const sevMeta = {
      critical: { color: '#ef4444', bg: '#2d0a0a', bdr: '#7f1d1d', dot: '#ef4444' },
      high:     { color: '#f97316', bg: '#2d1400', bdr: '#7c2d12', dot: '#f97316' },
      medium:   { color: '#eab308', bg: '#2d2200', bdr: '#713f12', dot: '#eab308' },
      low:      { color: '#22c55e', bg: '#052e16', bdr: '#14532d', dot: '#22c55e' },
    };
    findingsHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Risk Factors Detected</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        ${findings.slice(0, 10).map(item => {
          const label = typeof item === 'string' ? item : (item.label || item.flag || item.description || '');
          const sev   = (typeof item === 'object' ? (item.severity || item.risk || 'medium') : 'medium').toLowerCase();
          const cat   = typeof item === 'object' ? (item.category || '') : '';
          const sm    = sevMeta[sev] || sevMeta.medium;
          return `<div style="background:${sm.bg};border:1px solid ${sm.bdr};border-left:3px solid ${sm.color};border-radius:7px;padding:11px 14px;display:flex;align-items:center;gap:12px">
            <span style="width:8px;height:8px;border-radius:50%;background:${sm.dot};flex-shrink:0;display:inline-block"></span>
            <div style="flex:1;font-size:13px;color:#e2e8f0;line-height:1.4">${escHtml(label)}</div>
            ${cat ? `<span style="font-family:monospace;font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.5px;background:#0f172a;padding:2px 6px;border-radius:3px;flex-shrink:0">${escHtml(cat)}</span>` : ''}
            <span style="font-family:monospace;font-size:9px;font-weight:700;color:${sm.color};text-transform:uppercase;letter-spacing:.5px;flex-shrink:0">${sev}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // ── Trust Signals ──────────────────────────────────────────────────────────
  let trustHtml = '';
  const trustSignals = d?.trust_signals || d?.positive_signals || result.trust_signals || [];
  if (Array.isArray(trustSignals) && trustSignals.length > 0) {
    trustHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Trust Signals</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px">
        ${trustSignals.slice(0, 8).map(sig => {
          const label = String(sig).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          return `<div style="background:#052e16;border:1px solid #14532d;border-left:3px solid #22c55e;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px">
            <span style="width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0;display:inline-block"></span>
            <span style="font-size:12px;color:#86efac">${escHtml(label)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Evidence / transactions
  let evidenceHtml = '';
  if (d?.evidence && d.evidence.length) {
    evidenceHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Recent On-Chain Evidence</div>
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:12px">
          <thead>
            <tr style="background:#1e293b">
              <th style="padding:10px 16px;text-align:left;color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.6px">Signature</th>
              <th style="padding:10px 16px;text-align:left;color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.6px">Time</th>
              <th style="padding:10px 16px;text-align:center;color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.6px">Status</th>
            </tr>
          </thead>
          <tbody>
            ${d.evidence.slice(0,10).map((ev,i) => {
              const ts = ev.blockTime ? new Date(ev.blockTime * 1000).toLocaleString() : '—';
              const ok = !ev.err;
              return `<tr style="border-top:1px solid #1e293b${i===0?';border-top:none':''}">
                <td style="padding:10px 16px;color:#60a5fa;word-break:break-all;max-width:280px">${escHtml((ev.signature||'').slice(0,24))}…</td>
                <td style="padding:10px 16px;color:#94a3b8;white-space:nowrap">${escHtml(ts)}</td>
                <td style="padding:10px 16px;text-align:center">
                  <span style="padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;${ok?'background:#052e16;color:#22c55e;':'background:#2d0a0a;color:#ef4444;'}">
                    ${ok ? '✓ OK' : '✕ FAIL'}
                  </span>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  // Recommendation / Remediation — zobrazit jen pokud je high/critical riziko
  let remediationHtml = '';
  const isHighRisk = ['critical', 'high', 'medium'].includes(risk);
  const recText = d?.recommendation || d?.llm_safety_rating || result.recommendation || '';

  if (isHighRisk && recText && recText.toLowerCase() !== 'none') {
    const m = RISK_META[risk] || RISK_META.medium;
    // Symbol bez emoji — použij CSS box
    const icon = `<span style="width:14px;height:14px;border:2px solid ${m.color};border-radius:2px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${m.color};flex-shrink:0">!</span>`;
    remediationHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Recommendation</div>
      <div style="background:${m.bg};border:1px solid ${m.color}33;border-left:3px solid ${m.color};border-radius:8px;padding:16px 18px;display:flex;gap:12px;align-items:flex-start">
        ${icon}
        <div>
          <div style="margin-bottom:6px">${severityBadge(risk)}</div>
          <div style="font-size:13px;color:#cbd5e1;line-height:1.6">${escHtml(recText)}</div>
        </div>
      </div>
    </div>`;
  } else if (!isHighRisk && recText) {
    // LOW/SAFE — zobraz jako pozitivní assessment (zelená)
    remediationHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Assessment</div>
      <div style="background:#052e16;border:1px solid #14532d;border-left:3px solid #22c55e;border-radius:8px;padding:16px 18px">
        <div style="font-size:13px;color:#86efac;line-height:1.6">${escHtml(recText)}</div>
      </div>
    </div>`;
  }

  // Swarm analyst reason (extra)
  if (swarm && swarm.agents.analyst?.reason) {
    const rec = swarm.agents.analyst.reason;
    if (rec.toLowerCase() !== 'none' && rec.toLowerCase() !== 'n/a') {
      const m2 = RISK_META[swarm.risk_level] || RISK_META.medium;
      remediationHtml += `
      <div style="margin-bottom:28px">
        <div style="background:${m2.bg};border:1px solid ${m2.color}33;border-left:3px solid ${m2.color};border-radius:8px;padding:14px 18px">
          <div style="font-size:13px;color:#cbd5e1;line-height:1.5">${escHtml(rec)}</div>
        </div>
      </div>`;
    }
  }

  // Raw text fallback (for non-structured non-swarm reports)
  let rawReportHtml = '';
  if (!swarm && !d && textReport) {
    rawReportHtml = `
    <div style="margin-bottom:28px">
      <div class="section-title">Report</div>
      <pre style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:20px;font-family:'SF Mono','Fira Code',monospace;font-size:11.5px;line-height:1.7;color:#94a3b8;white-space:pre-wrap;word-break:break-all">${escHtml(textReport)}</pre>
    </div>`;
  }

  // Error state
  let errorHtml = '';
  if (isError) {
    errorHtml = `
    <div style="background:#2d0a0a;border:1px solid #7f1d1d;border-left:4px solid #ef4444;border-radius:10px;padding:24px;margin-bottom:28px">
      <div style="font-family:monospace;font-size:12px;color:#ef4444;margin-bottom:8px;font-weight:700">Scan Error</div>
      <div style="font-size:14px;color:#fca5a5;line-height:1.5">${escHtml(result.error || 'Unknown error')}</div>
    </div>`;
  }

  // ── Full page HTML ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(typeName)} Scan Report — integrity.molt</title>
<style>
  /* Systémové fonty — bez síťových požadavků pro rychlé renderování */

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    background: #060912;
    color: #e2e8f0;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 40px 40px 60px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 24px;
    border-bottom: 1px solid #1e293b;
    margin-bottom: 36px;
  }
  .logo {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 20px;
    font-weight: 700;
    color: #f8fafc;
    letter-spacing: -.3px;
  }
  .logo .dot { color: #3b82f6; }
  .header-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .scan-type-badge {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 5px;
    background: #1e3a5f;
    border: 1px solid #2563eb55;
    color: #60a5fa;
    text-transform: uppercase;
    letter-spacing: .8px;
  }
  .timestamp {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 10px;
    color: #374151;
  }

  /* Report title */
  .report-title {
    font-size: 28px;
    font-weight: 800;
    color: #f8fafc;
    margin-bottom: 6px;
    letter-spacing: -.5px;
  }
  .report-subtitle {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 12px;
    color: #475569;
    margin-bottom: 32px;
    word-break: break-all;
  }

  .section-title {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 10px;
    font-weight: 600;
    color: #374151;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid #1e293b;
  }

  /* Footer */
  .footer {
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid #1e293b;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .footer-logo {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 12px;
    color: #374151;
  }
  .footer-logo strong { color: #64748b; }
  .footer-sig {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 10px;
    color: #1f2937;
    max-width: 480px;
    word-break: break-all;
    text-align: right;
  }

  /* Watermark band — top accent line (not fixed, aby se neopakoval na str. 2) */
  .watermark-band {
    height: 3px;
    background: linear-gradient(90deg, #1d4ed8, #7c3aed, #0ea5e9);
    margin-bottom: 0;
  }
</style>
</head>
<body>
<div class="watermark-band"></div>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="logo">integrity<span class="dot">.</span>molt</div>
    <div class="header-right">
      <span class="scan-type-badge">${escHtml(typeName)} Scan</span>
      <span class="timestamp">${escHtml(now)}</span>
    </div>
  </div>

  <!-- Title -->
  <div class="report-title">Security Audit Report</div>
  <div class="report-subtitle">${escHtml(typeName)} Scan · ${escHtml(address || 'N/A')}</div>

  ${errorHtml}
  ${execSummary}
  ${scorecardHtml}
  ${findingsHtml}
  ${trustHtml}
  ${checksHtml}
  ${evidenceHtml}
  ${remediationHtml}
  ${rawReportHtml}

  <!-- Footer -->
  <div class="footer">
    <div class="footer-logo"><strong>integrity.molt</strong> — AI-native Solana security scanner</div>
    <div class="footer-sig">Ed25519 signed · verify at intmolt.org/verify · key_id: ${escHtml(result.data?.key_id || result.signed?.key_id || '—')}</div>
  </div>

</div>
</body>
</html>`;
}

// ── Main export — generate PNG + PDF ─────────────────────────────────────────
/**
 * @param {object} result  — scan result object from server
 * @param {string} outDir  — directory to write files into
 * @returns {Promise<{htmlPath, pngPath, pdfPath}>}
 */
async function generateReport(result, outDir) {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const addr = (result.address || 'unknown').slice(0, 12).toLowerCase();
  const base = path.join(outDir, `${ts}-report-${addr}`);

  const htmlPath = base + '.html';
  const pngPath  = base + '.png';
  const pdfPath  = base + '.pdf';

  // Write HTML
  const html = buildHtml(result);
  fs.writeFileSync(htmlPath, html, 'utf-8');

  // Launch Puppeteer
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // PNG — full-page screenshot
    await page.screenshot({
      path: pngPath,
      fullPage: true,
    });

    // PDF — A4
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }

  return { htmlPath, pngPath, pdfPath };
}

// ── Buffer exports — pro HTTP streaming (bez zápisu na disk) ─────────────────
let _browser = null;

async function _getBrowser() {
  if (_browser && _browser.connected) return _browser;
  const puppeteer = require('puppeteer');
  // Zkus bundled Chromium, pak systémový
  const execPath = (() => {
    try { return puppeteer.executablePath(); } catch (_) {}
    return '/usr/bin/chromium-browser';
  })();
  _browser = await puppeteer.launch({
    executablePath: execPath,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],
    headless: true,
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

/**
 * Vrátí PDF jako Buffer pro přímé HTTP odeslání.
 * @param {object} result  — scan result objekt (stejná struktura jako generateReport)
 * @returns {Promise<Buffer>}
 */
async function generatePDFBuffer(result) {
  const html    = buildHtml(result);
  const browser = await _getBrowser();
  const page    = await browser.newPage();
  try {
    // Nastav viewport — malá výška aby se nezkreslilo měření
    await page.setViewport({ width: 960, height: 900, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // scrollHeight přesně odráží výšku obsahu po vykreslení
    const contentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    return await page.pdf({
      width:           '960px',
      height:          `${contentHeight + 4}px`,   // 4px buffer pro border/shadow
      printBackground: true,
      pageRanges:      '1',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await page.close();
  }
}

/**
 * Vrátí PNG jako Buffer pro přímé HTTP odeslání (2× DPR, full-page).
 * @param {object} result
 * @returns {Promise<Buffer>}
 */
async function generatePNGBuffer(result) {
  const html    = buildHtml(result);
  const browser = await _getBrowser();
  const page    = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Zjisti skutečnou výšku po vykreslení
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewport({ width: 1200, height: Math.max(900, height), deviceScaleFactor: 2 });
    return await page.screenshot({ fullPage: true, type: 'png' });
  } finally {
    await page.close();
  }
}

module.exports = { generateReport, buildHtml, generatePDFBuffer, generatePNGBuffer };
