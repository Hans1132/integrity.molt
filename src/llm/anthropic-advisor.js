'use strict';

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic.default({ apiKey });
  }
  return _client;
}

// ── OpenRouter fallback (když ANTHROPIC_API_KEY chybí) ───────────────────────
// Volá OpenRouter bez advisor nástroje — vrací stejný tvar výsledku.
async function _runWithOpenRouter({ systemPrompt, userMessage }) {
  let key = '';
  try { key = fs.readFileSync('/root/.secrets/openrouter_api_key', 'utf-8').trim(); } catch {}
  if (!key && process.env.OPENROUTER_API_KEY) key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Žádný dostupný AI klíč (ANTHROPIC_API_KEY ani OpenRouter)');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';

  return {
    text,
    advisorUsed: false,
    usage: {
      input_tokens:          json.usage?.prompt_tokens     || 0,
      output_tokens:         json.usage?.completion_tokens || 0,
      advisor_input_tokens:  0,
      advisor_output_tokens: 0,
    },
    rawContent: [{ type: 'text', text }],
    stopReason: 'end_turn',
    provider: 'openrouter',
  };
}

/**
 * Spustí Sonnet 4.6 jako executor s Opus 4.6 advisor nástrojem (beta API).
 * Pokud ANTHROPIC_API_KEY chybí, automaticky přepne na OpenRouter bez advisora.
 *
 * @param {object} opts
 * @param {string}   opts.systemPrompt   - System prompt pro executor
 * @param {string}   opts.userMessage    - Vstupní data / uživatelská zpráva
 * @param {object[]} opts.tools          - Další nástroje (volitelné)
 * @param {number}   opts.maxAdvisorUses - Max počet volání advisor (default: 3)
 *
 * @returns {{ text, advisorUsed, usage, rawContent, stopReason, provider }}
 */
async function runWithAdvisor({ systemPrompt, userMessage, tools = [], maxAdvisorUses = 3 }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[advisor] ANTHROPIC_API_KEY není nastaven — přepínám na OpenRouter fallback');
    return _runWithOpenRouter({ systemPrompt, userMessage });
  }

  const client = getClient();

  const allTools = [
    {
      type: 'advisor_20260301',
      name: 'advisor',
      model: 'claude-opus-4-6',
      max_uses: maxAdvisorUses,
    },
    ...tools,
  ];

  // Použití beta.messages.create — automaticky nastaví anthropic-beta header.
  const response = await client.beta.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8192,
    system:     systemPrompt,
    tools:      allTools,
    messages:   [{ role: 'user', content: userMessage }],
    betas:      ['advisor-tool-2026-03-01'],
  });

  const textBlocks = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const advisorUsed = response.content.some(
    b => b.type === 'tool_use' && b.name === 'advisor'
  );

  return {
    text:        textBlocks,
    advisorUsed,
    usage:       response.usage || {},
    rawContent:  response.content,
    stopReason:  response.stop_reason,
    provider:    'anthropic',
  };
}

module.exports = { runWithAdvisor };
