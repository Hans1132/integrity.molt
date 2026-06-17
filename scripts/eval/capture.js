'use strict';
// scripts/eval/capture.js — sejme deterministický snapshot {enrichment, goplus} pro gold entry.
// Použití: node scripts/eval/capture.js <mint> [--id gt-0301] [--category scam] [--split tune]
// Reuse produkčních enrichment funkcí (stejná cesta jako a2a-oracle.js:355-359).

// src/rpc.js:61 loguje na stdout při require → bez redirectu by zkorumpoval JSON výstup
const _stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, enc, cb) => process.stderr.write(chunk, enc, cb);

require('dotenv').config({ path: '/root/x402-server/.env', quiet: true });
const { enrichScanResult } = require('../../src/enrichment');         // src/enrichment/index.js
const { getGoplusReport }  = require('../../src/enrichment/goplus');  // src/enrichment/goplus.js
const { calculateIRIS_v2 } = require('../../src/features/iris-score');

// Obnov stdout pro JSON výstup v main()
process.stdout.write = _stdoutWrite;

async function main() {
  const mint = process.argv[2];
  if (!mint) { console.error('Usage: node scripts/eval/capture.js <mint> [--id ..] [--category ..] [--split ..]'); process.exit(1); }
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };

  const [enrichment, goplus] = await Promise.all([
    enrichScanResult(mint).catch(() => null),
    getGoplusReport(mint).catch(() => ({ source_health: 'circuit_breaker_open' })),
  ]);

  // Náhled produkčního verdiktu (s prázdným scamDb pro orientaci, ne pro label)
  const preview = calculateIRIS_v2(enrichment, { known_scam: null, scam_creators: null, whitelisted: false }, goplus);

  const entry = {
    id: arg('--id', 'gt-XXXX'),
    mint,
    symbol: enrichment?.symbol || null,
    name: enrichment?.name || null,
    category: arg('--category', 'TODO'),
    split: arg('--split', 'tune'),
    label: { verdict: 'TODO', score_range: [0, 0], scam_type: null,
             anchor_confidence: 1.0, verified_at: new Date().toISOString().slice(0, 10),
             verified_by: 'hans', rationale: 'TODO' },
    sources: [{ name: 'onchain', verdict: 'confirmed' }],
    snapshot: { enrichment: enrichment || {}, goplus: goplus || {} },
    must_flag: [], must_not_flag: [],
  };

  console.error(`[capture] preview verdict=${preview.risk_level} score=${preview.score} factors=${(preview.risk_factors||[]).join(',')}`);
  console.error('[capture] DOPLŇ label.verdict/score_range/category a přidej do gold-vN.json po lidském ověření.');
  console.log(JSON.stringify(entry, null, 2));
}
main().catch(e => { console.error('[capture] fatal:', e); process.exit(1); });
