# Ground-truth eval loop (Plán 1/3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postavit deterministickou findings-level eval smyčku, která měří přesnost produkčního IRIS v2 scoreru proti git-verzovanému gold setu a ladí `rules-v2.json` přes non-regression bránu.

**Architecture:** Gold anchor = immutable JSON v `data/ground-truth/`. Harness načte per-token snapshot `{enrichment, goplus}`, zavolá `calculateIRIS_v2(enrichment, EVAL_SCAM_DB, goplus)` (leakage guard = prázdný scamDb vypne known_scam Floor 1), porovná `iris.risk_level`/`iris.score` s gold labelem, spočítá recall(scam)+FPR+MAE. Baseline se zmrazí (Fáze 0), regresní brána blokuje zhoršení.

**Tech Stack:** Node.js (CommonJS), better-sqlite3 (jen pro pozdější Plán 2), čisté JS funkce, `node:assert` testy (vzor `tests/scanner/accuracy.test.js`), `scripts/test-gate.sh`.

---

## Decomposition (proč Plán 1/3)

Spec `docs/specs/2026-06-17-ground-truth-dataset-design.md` pokrývá tři podsystémy. Dle writing-plans scope-check rozděleny:

- **Plán 1 (tento):** findings-level eval smyčka — schéma + capture + harness + leakage guard + metriky + baseline + regresní brána. Produkuje funkční, testovatelný SW: lze měřit přesnost a ladit `rules-v2.json`.
- **Plán 2 (deferred):** promotion pipeline — `gold_candidates` tabulka, `promote.js`, multi-source verifikace, PR sign-off. Roste kotvu (cesta k C).
- **Plán 3 (deferred, volba uživatele):** on-chain fidelity — refactor `token-audit.js` na injektovatelnou RPC závislost pro full-pipeline eval.

**Amendment proti specu (zafixováno v planningu):** Uživatel zvolil „findings-level teď". Snapshot proto NENÍ on-chain (5 polí), ale **`{enrichment, goplus}`** — deterministické vstupy do `calculateIRIS_v2`. Měřená vrstva = IRIS v2 (produkční verdikt A2A oracle), ne `token-audit.raw_score`. `label.verdict` je **lowercase** (`safe`/`caution`/`danger`) dle `classifyRisk`.

## Ověřená fakta o kódu (orientace)

- Produkční scoring: `src/routes/a2a-oracle.js:360-376` staví `[enrichment, scamDb, goplus]` přes `enrichScanResult(address)` + `lookupScamDb(address)` + `getGoplusReport(address)`, pak `calculateIRIS_v2(enrichment, scamDb, goplus)`.
- `calculateIRIS_v2(enrichment, scamDb, goplus)` (`src/features/iris-score.js`) → `{ score:0..100|null, risk_level, risk_factors:string[], breakdown, confidence_level, weights_version }`.
- `classifyRisk(score)` (`src/lib/risk-classification.js`): `>=70 'danger'`, `>=40 'caution'`, `<40 'safe'`, null/NaN `'unknown'`.
- Leakage: Floor 1 v `calculateIRIS_v2` aplikuje `total ≥ T.soft_floor_offset + confidence*T.soft_floor_scale`, jen když `scamDb.known_scam.confidence > T.soft_floor_min_confidence (0.5)`. Prázdný scamDb → floor nezahoří.
- `rules-v2.json` se načítá JEDNOU při module init (`src/features/iris-score.js:15-25`); invariant `Σ weights === 100` (jinak throw). → harness běží jako čerstvý proces per rules verze.
- Existující `tests/scanner/golden-dataset.json` (16 tokenů, kategorie `safe`/`scam`/`edge`) + `tests/scanner/accuracy.test.js` (testuje scan-validator s mock auditData, NE end-to-end).

## File Structure

| Soubor | Odpovědnost | Akce |
|---|---|---|
| `data/ground-truth/gold-v1.json` | Immutable gold anchor (seed z 16 tokenů) | Create |
| `data/ground-truth/SCHEMA.md` | Dokumentace schématu | Create |
| `data/ground-truth/baseline.json` | Zmrazené baseline metriky (Fáze 0) | Create (Task 6) |
| `data/ground-truth/reports/.gitkeep` | Adresář na eval reporty (gitignored obsah) | Create |
| `scripts/eval/lib/schema.js` | Validace gold entry + load anchoru | Create |
| `scripts/eval/lib/metrics.js` | Confusion matrix, recall, FPR, MAE (čisté funkce) | Create |
| `scripts/eval/lib/eval-core.js` | `evalToken` + `EVAL_SCAM_DB` (volá calculateIRIS_v2) | Create |
| `scripts/eval/capture.js` | Snímání `{enrichment, goplus}` pro nový gold entry | Create |
| `scripts/eval/run.js` | CLI: load → eval → report → diff vs baseline | Create |
| `scripts/eval/freeze-baseline.js` | Zmrazí aktuální metriky do baseline.json | Create |
| `tests/eval/metrics.test.js` | Unit testy metrik (stub) | Create |
| `tests/eval/eval-core.test.js` | Leakage guard, determinism, schema | Create |
| `tests/eval/regression-gate.test.js` | Brána FAIL/PASS vs baseline | Create |
| `scripts/test-gate.sh` | Přidat krok eval regresní brány | Modify |

**Ownership (CLAUDE.md §5):** `scripts/eval/*` + `data/ground-truth/*` = nová cesta (conductor přiřadí, default backend pro harness + llm-economist pro tuning). `tests/eval/*` = qa. `scripts/test-gate.sh` = sdílené (explicit potvrzení). `rules-v2.json` se v Plánu 1 NEMĚNÍ (jen čte) — tuning je následná aktivita po baseline.

---

## Task 1: Gold schema + load + seed migrace

**Files:**
- Create: `scripts/eval/lib/schema.js`
- Create: `data/ground-truth/gold-v1.json`
- Create: `data/ground-truth/SCHEMA.md`
- Test: `tests/eval/eval-core.test.js` (schema část)

- [ ] **Step 1: Napiš failing test pro `validateGoldEntry`**

V `tests/eval/eval-core.test.js`:

```js
'use strict';
const assert = require('node:assert');
const { validateGoldEntry } = require('../../scripts/eval/lib/schema');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const validEntry = {
  id: 'gt-0001', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC', category: 'legit', split: 'tune',
  label: { verdict: 'safe', score_range: [0, 39], scam_type: null,
           anchor_confidence: 1.0, verified_at: '2026-06-15', verified_by: 'hans', rationale: 'Circle stablecoin' },
  sources: [{ name: 'onchain', verdict: 'confirmed' }],
  snapshot: { enrichment: {}, goplus: {} },
  must_flag: [], must_not_flag: ['authority_active'],
};

test('valid entry passes', () => {
  assert.deepStrictEqual(validateGoldEntry(validEntry), []);
});
test('missing snapshot.enrichment → error', () => {
  const bad = { ...validEntry, snapshot: { goplus: {} } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('snapshot.enrichment')));
});
test('verdict must be lowercase enum', () => {
  const bad = { ...validEntry, label: { ...validEntry.label, verdict: 'SAFE' } };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('verdict')));
});
test('category must be scam|legit|edge', () => {
  const bad = { ...validEntry, category: 'safe' };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('category')));
});
test('missing sources[] → error', () => {
  const bad = { ...validEntry, sources: [] };
  assert.ok(validateGoldEntry(bad).some(e => e.includes('sources')));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Spusť test — ověř že selže**

Run: `node tests/eval/eval-core.test.js`
Expected: FAIL — `Cannot find module '../../scripts/eval/lib/schema'`

- [ ] **Step 3: Implementuj `schema.js`**

```js
'use strict';
// scripts/eval/lib/schema.js — validace gold entry + load anchoru. Čisté funkce, žádné RPC.
const fs = require('fs');

const VERDICTS = new Set(['safe', 'caution', 'danger', 'unknown']);
const CATEGORIES = new Set(['scam', 'legit', 'edge']);
const SPLITS = new Set(['tune', 'holdout']);

function validateGoldEntry(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['entry is not an object'];
  if (typeof e.id !== 'string') errs.push('id missing');
  if (typeof e.mint !== 'string' || e.mint.length < 32) errs.push('mint invalid');
  if (!CATEGORIES.has(e.category)) errs.push(`category must be scam|legit|edge, got ${e.category}`);
  if (!SPLITS.has(e.split)) errs.push(`split must be tune|holdout, got ${e.split}`);
  const l = e.label || {};
  if (!VERDICTS.has(l.verdict)) errs.push(`label.verdict must be lowercase safe|caution|danger, got ${l.verdict}`);
  if (!Array.isArray(l.score_range) || l.score_range.length !== 2) errs.push('label.score_range must be [lo,hi]');
  if (!Array.isArray(e.sources) || e.sources.length === 0) errs.push('sources[] must be non-empty');
  const s = e.snapshot || {};
  if (s.enrichment == null) errs.push('snapshot.enrichment missing');
  if (s.goplus == null) errs.push('snapshot.goplus missing');
  if (!Array.isArray(e.must_flag)) errs.push('must_flag must be array');
  if (!Array.isArray(e.must_not_flag)) errs.push('must_not_flag must be array');
  return errs;
}

function loadAnchor(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const allErrs = [];
  (data.tokens || []).forEach((t, i) => {
    const errs = validateGoldEntry(t);
    if (errs.length) allErrs.push(`token[${i}] (${t.id || t.mint}): ${errs.join('; ')}`);
  });
  if (allErrs.length) throw new Error(`Gold anchor validation failed:\n${allErrs.join('\n')}`);
  return data;
}

module.exports = { validateGoldEntry, loadAnchor, VERDICTS, CATEGORIES, SPLITS };
```

- [ ] **Step 4: Spusť test — ověř PASS**

Run: `node tests/eval/eval-core.test.js`
Expected: PASS (5 testů)

- [ ] **Step 5: Vytvoř `gold-v1.json` se 2 seed tokeny + `SCHEMA.md`**

`data/ground-truth/gold-v1.json` (2 ručně ověřené tokeny jako počáteční kotva; zbytek doplní capture workflow):

```json
{
  "_meta": {
    "version": "1.0",
    "frozen_at": "2026-06-17",
    "snapshot_level": "findings (enrichment+goplus)",
    "verdict_enum": "safe|caution|danger (lowercase, classifyRisk)",
    "counts": { "scam": 0, "legit": 1, "edge": 0 },
    "split": { "tune": 1, "holdout": 1 },
    "stop_criteria": null,
    "note": "Seed kotva. Cíl 100/100/100 přes scripts/eval/capture.js + ruční label."
  },
  "tokens": [
    {
      "id": "gt-0001",
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC", "name": "USD Coin",
      "category": "legit", "split": "tune",
      "label": { "verdict": "safe", "score_range": [0, 39], "scam_type": null,
                 "anchor_confidence": 1.0, "verified_at": "2026-06-17", "verified_by": "hans",
                 "rationale": "Circle stablecoin, mint/freeze authority null" },
      "sources": [{ "name": "onchain", "verdict": "confirmed" }],
      "snapshot": { "enrichment": {}, "goplus": {} },
      "must_flag": [], "must_not_flag": ["authority_active"]
    },
    {
      "id": "gt-0002",
      "mint": "So11111111111111111111111111111111111111112",
      "symbol": "wSOL", "name": "Wrapped SOL",
      "category": "legit", "split": "holdout",
      "label": { "verdict": "safe", "score_range": [0, 39], "scam_type": null,
                 "anchor_confidence": 1.0, "verified_at": "2026-06-17", "verified_by": "hans",
                 "rationale": "Canonical wrapped SOL" },
      "sources": [{ "name": "onchain", "verdict": "confirmed" }],
      "snapshot": { "enrichment": {}, "goplus": {} },
      "must_flag": [], "must_not_flag": ["authority_active"]
    }
  ]
}
```

`data/ground-truth/SCHEMA.md` — popis polí (category vs label.verdict, snapshot=enrichment+goplus, split tune/holdout, must_flag = očekávané položky `iris.risk_factors`). Krátký referenční dokument.

> **Pozn.:** prázdné `snapshot.enrichment: {}` projde schématem, ale dá `iris.risk_level: 'unknown'` (≥3 dimenze spadnou na circuit breaker). Reálné snapshoty doplní Task 2 (capture). Seed slouží jen k rozběhnutí harness; baseline (Task 6) se zmrazí až po naplnění reálnými snapshoty.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval/lib/schema.js data/ground-truth/ tests/eval/eval-core.test.js
git commit -m "feat(eval): gold anchor schema + validace + seed kotva"
```

---

## Task 2: Snapshot capture skript

**Files:**
- Create: `scripts/eval/capture.js`

Capture je side-effectful (živé RPC/enrichment) → netestuje se unit testem, ověří se manuálně. Reuse produkčních funkcí, žádná duplikace scoring logiky.

- [ ] **Step 1: Implementuj `capture.js`**

```js
'use strict';
// scripts/eval/capture.js — sejme deterministický snapshot {enrichment, goplus} pro gold entry.
// Použití: node scripts/eval/capture.js <mint> [--id gt-0301] [--category scam] [--split tune]
// Reuse produkčních enrichment funkcí (stejná cesta jako a2a-oracle.js:360-363).
require('dotenv').config({ path: '/root/x402-server/.env' });
const { enrichScanResult } = require('../../src/enrichment');         // src/enrichment/index.js (ověřeno)
const { getGoplusReport }  = require('../../src/enrichment/goplus');  // src/enrichment/goplus.js (ověřeno)
const { calculateIRIS_v2 } = require('../../src/features/iris-score');

async function main() {
  const mint = process.argv[2];
  if (!mint) { console.error('Usage: node scripts/eval/capture.js <mint> [--id ..] [--category ..] [--split ..]'); process.exit(1); }
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };

  const [enrichment, goplus] = await Promise.all([
    enrichScanResult(mint).catch(() => null),
    getGoplusReport(mint).catch(() => ({ source_health: 'circuit_breaker_open' })),
  ]);

  // Náhled produkčního verdiktu (s reálným scamDb=null pro orientaci, ne pro label)
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

  console.error(`[capture] preview verdict=${preview.risk_level} score=${preview.score} factors=${preview.risk_factors.join(',')}`);
  console.error('[capture] DOPLŇ label.verdict/score_range/category a přidej do gold-vN.json po lidském ověření.');
  console.log(JSON.stringify(entry, null, 2));
}
main();
```

- [ ] **Step 2: Potvrď cesty modulů (už ověřeno v planningu)**

Run: `node -e "require('./src/enrichment'); require('./src/enrichment/goplus'); console.log('ok')"`
Expected: `ok` (moduly `src/enrichment/index.js` + `src/enrichment/goplus.js` existují; capture je importuje — shodné s `a2a-oracle.js:24-25`).

- [ ] **Step 3: Manuální smoke (vyžaduje .env s RPC klíči)**

Run: `node scripts/eval/capture.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --id gt-0001 --category legit --split tune > /tmp/cap.json`
Expected: stderr ukáže `preview verdict=safe ...`, stdout je validní JSON entry.

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/capture.js
git commit -m "feat(eval): snapshot capture skript (enrichment+goplus)"
```

---

## Task 3: Metriky (čisté funkce)

**Files:**
- Create: `scripts/eval/lib/metrics.js`
- Test: `tests/eval/metrics.test.js`

- [ ] **Step 1: Napiš failing testy metrik**

`tests/eval/metrics.test.js`:

```js
'use strict';
const assert = require('node:assert');
const { computeMetrics } = require('../../scripts/eval/lib/metrics');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Per-token eval výsledky: { category, predictedVerdict, predictedScore, label }
const rows = [
  // 2 scamy: 1 chycen (danger), 1 minut (caution) → recall_scam = 0.5
  { category: 'scam', predictedVerdict: 'danger',  predictedScore: 85, label: { score_range: [70, 100] } },
  { category: 'scam', predictedVerdict: 'caution', predictedScore: 55, label: { score_range: [70, 100] } },
  // 2 legit: oba safe → 0 false positive
  { category: 'legit', predictedVerdict: 'safe', predictedScore: 10, label: { score_range: [0, 39] } },
  { category: 'legit', predictedVerdict: 'safe', predictedScore: 20, label: { score_range: [0, 39] } },
  // 1 edge: predikováno danger → false positive
  { category: 'edge', predictedVerdict: 'danger', predictedScore: 80, label: { score_range: [0, 69] } },
];

test('recall_scam = chycené scamy / všechny scamy', () => {
  const m = computeMetrics(rows);
  assert.strictEqual(m.recall_scam, 0.5);
});
test('FPR = clean predikované danger / všechny clean', () => {
  const m = computeMetrics(rows);
  // clean = 2 legit + 1 edge = 3; danger mezi nimi = 1 (edge) → 1/3
  assert.ok(Math.abs(m.fpr - 1 / 3) < 1e-9);
});
test('score MAE počítá odchylku od nejbližší hrany range', () => {
  const m = computeMetrics(rows);
  // scam#2 score 55, range[70,100] → odchylka 15; ostatní v range → 0; edge 80 vs [0,69] → 11
  // MAE = (0 + 15 + 0 + 0 + 11) / 5 = 5.2
  assert.ok(Math.abs(m.score_mae - 5.2) < 1e-9);
});
test('prázdný vstup → nuly, ne NaN', () => {
  const m = computeMetrics([]);
  assert.strictEqual(m.recall_scam, 0);
  assert.strictEqual(m.fpr, 0);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Spusť test — ověř selhání**

Run: `node tests/eval/metrics.test.js`
Expected: FAIL — `Cannot find module '.../metrics'`

- [ ] **Step 3: Implementuj `metrics.js`**

```js
'use strict';
// scripts/eval/lib/metrics.js — čisté metriky nad per-token eval výsledky. Žádné I/O.

function distFromRange(score, [lo, hi]) {
  if (score == null) return null;
  if (score < lo) return lo - score;
  if (score > hi) return score - hi;
  return 0;
}

function computeMetrics(rows) {
  const scams = rows.filter(r => r.category === 'scam');
  const clean = rows.filter(r => r.category === 'legit' || r.category === 'edge');

  const scamCaught = scams.filter(r => r.predictedVerdict === 'danger').length;
  const cleanFalsePos = clean.filter(r => r.predictedVerdict === 'danger').length;

  const maes = rows.map(r => distFromRange(r.predictedScore, r.label.score_range)).filter(d => d != null);
  const scoreMae = maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : 0;

  // confusion matrix: category × predictedVerdict
  const matrix = {};
  for (const cat of ['scam', 'legit', 'edge']) {
    matrix[cat] = { safe: 0, caution: 0, danger: 0, unknown: 0 };
    for (const r of rows.filter(x => x.category === cat)) {
      matrix[cat][r.predictedVerdict] = (matrix[cat][r.predictedVerdict] || 0) + 1;
    }
  }

  return {
    n: rows.length,
    recall_scam: scams.length ? scamCaught / scams.length : 0,
    precision_scam: (() => {
      const predictedDanger = rows.filter(r => r.predictedVerdict === 'danger').length;
      return predictedDanger ? scamCaught / predictedDanger : 0;
    })(),
    fpr: clean.length ? cleanFalsePos / clean.length : 0,
    score_mae: Math.round(scoreMae * 1000) / 1000,
    matrix,
  };
}

module.exports = { computeMetrics, distFromRange };
```

- [ ] **Step 4: Spusť test — ověř PASS**

Run: `node tests/eval/metrics.test.js`
Expected: PASS (4 testy)

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/metrics.js tests/eval/metrics.test.js
git commit -m "feat(eval): metriky recall/FPR/MAE/confusion matrix"
```

---

## Task 4: Eval core + leakage guard

**Files:**
- Create: `scripts/eval/lib/eval-core.js`
- Test: `tests/eval/eval-core.test.js` (přidat leakage + determinism testy)

- [ ] **Step 1: Přidej failing testy do `tests/eval/eval-core.test.js`**

Přidej na konec (před summary `console.log`):

```js
const { evalToken, EVAL_SCAM_DB } = require('../../scripts/eval/lib/eval-core');

// Minimální enrichment, který dá nenulové skóre přes dimenze (tvar ověřit v Step 3 proti scoreLiquidity atd.)
function scamSnapshot() {
  return require('./fixtures/scam-enrichment.json'); // vytvoříš v Step 3 z reálného capture
}

test('leakage guard: evalToken NEPOUŽÍVÁ scamDb known_scam floor', () => {
  // Stejný snapshot, dvě volání: harness musí dávat shodný výsledek bez ohledu na DB.
  const token = { category: 'scam', label: { verdict: 'danger', score_range: [70, 100] },
                  must_flag: [], must_not_flag: [], snapshot: scamSnapshot() };
  const r1 = evalToken(token);
  const r2 = evalToken(token);
  assert.strictEqual(r1.predictedScore, r2.predictedScore, 'eval musí být deterministický');
  // EVAL_SCAM_DB nesmí nést known_scam (jinak by floor zkreslil měření)
  assert.strictEqual(EVAL_SCAM_DB.known_scam, null);
  assert.strictEqual(EVAL_SCAM_DB.whitelisted, false);
});

test('evalToken vrací verdictMatch + scoreInRange + mustFlagOk', () => {
  const token = { category: 'legit', label: { verdict: 'safe', score_range: [0, 39] },
                  must_flag: [], must_not_flag: ['nonexistent_factor'], snapshot: { enrichment: {}, goplus: {} } };
  const r = evalToken(token);
  assert.ok('verdictMatch' in r && 'scoreInRange' in r && 'mustFlagOk' in r && 'mustNotFlagOk' in r);
  assert.strictEqual(r.mustNotFlagOk, true, 'neexistující factor nesmí hořet');
});
```

- [ ] **Step 2: Spusť — ověř selhání**

Run: `node tests/eval/eval-core.test.js`
Expected: FAIL — `Cannot find module '.../eval-core'`

- [ ] **Step 3: Implementuj `eval-core.js` + vytvoř fixture**

```js
'use strict';
// scripts/eval/lib/eval-core.js — per-token eval přes produkční IRIS v2. Žádné RPC (snapshot only).
const { calculateIRIS_v2 } = require('../../../src/features/iris-score');

// Leakage guard: prázdný scamDb vypne Floor 1 (known_scam soft floor) i soft whitelist.
// Skóre tak měří enrichment-derived dimenze, ne DB label. Zmrazený = stejný pro každé volání.
const EVAL_SCAM_DB = Object.freeze({ known_scam: null, scam_creators: null, whitelisted: false, rugcheck: null });

function evalToken(token) {
  const { enrichment, goplus } = token.snapshot;
  const iris = calculateIRIS_v2(enrichment, EVAL_SCAM_DB, goplus);
  const predictedVerdict = iris.risk_level;            // 'safe'|'caution'|'danger'|'unknown'
  const predictedScore = iris.score;                   // 0..100 | null
  const factors = iris.risk_factors || [];
  const [lo, hi] = token.label.score_range;
  return {
    category: token.category,
    predictedVerdict,
    predictedScore,
    label: token.label,
    verdictMatch: predictedVerdict === token.label.verdict,
    scoreInRange: predictedScore != null && predictedScore >= lo && predictedScore <= hi,
    mustFlagOk: (token.must_flag || []).every(f => factors.includes(f)),
    mustNotFlagOk: (token.must_not_flag || []).every(f => !factors.includes(f)),
    risk_factors: factors,
  };
}

module.exports = { evalToken, EVAL_SCAM_DB };
```

Vytvoř `tests/eval/fixtures/scam-enrichment.json` z reálného capture jednoho známého scamu (`node scripts/eval/capture.js <scam_mint> ...`, vezmi `.snapshot`), aby leakage test běžel na realistickém tvaru. Pokud capture vyžaduje klíče nedostupné v CI, použij minimální ručně sestavený enrichment dle tvaru ze `scoreLiquidity`/`scoreAuthority` (ověř `grep -n "enrichment\." src/features/iris-score.js`).

- [ ] **Step 4: Spusť — ověř PASS**

Run: `node tests/eval/eval-core.test.js`
Expected: PASS (všechny, vč. schema z Task 1)

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/eval-core.js tests/eval/eval-core.test.js tests/eval/fixtures/
git commit -m "feat(eval): eval-core + leakage guard (EVAL_SCAM_DB)"
```

---

## Task 5: Harness runner + report

**Files:**
- Create: `scripts/eval/run.js`
- Create: `data/ground-truth/reports/.gitkeep`

Runner integruje load + eval + metrics. Held-out split: hlavní metriky jen `tune`, holdout samostatně.

- [ ] **Step 1: Implementuj `run.js`**

```js
'use strict';
// scripts/eval/run.js — načte gold anchor, spustí eval, zapíše report + diff vs baseline.
// Běží jako čerstvý proces → načte aktuální rules-v2.json (module-init load v iris-score.js).
// Usage: node scripts/eval/run.js [--anchor data/ground-truth/gold-v1.json] [--split tune|holdout|all]
const fs = require('fs');
const path = require('path');
const { loadAnchor } = require('./lib/schema');
const { evalToken } = require('./lib/eval-core');
const { computeMetrics } = require('./lib/metrics');

function arg(k, d) { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; }

function main() {
  const anchorPath = arg('--anchor', 'data/ground-truth/gold-v1.json');
  const splitFilter = arg('--split', 'tune');
  const data = loadAnchor(anchorPath);
  const tokens = data.tokens.filter(t => splitFilter === 'all' || t.split === splitFilter);

  const rows = tokens.map(evalToken);
  const metrics = computeMetrics(rows);
  const rulesVersion = require('../../data/rules-v2.json').version;

  const report = {
    generated_at: new Date().toISOString(),
    anchor: anchorPath, anchor_version: data._meta.version,
    rules_version: rulesVersion, split: splitFilter,
    metrics,
    failures: rows.filter(r => !r.verdictMatch || !r.scoreInRange || !r.mustFlagOk || !r.mustNotFlagOk)
      .map(r => ({ category: r.category, predicted: r.predictedVerdict, score: r.predictedScore,
                   expected: r.label.verdict, verdictMatch: r.verdictMatch, scoreInRange: r.scoreInRange })),
  };

  const ts = report.generated_at.replace(/[:.]/g, '-');
  const outDir = path.join('data/ground-truth/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `eval-${rulesVersion}-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\n━━━ EVAL ${rulesVersion} [${splitFilter}] ━━━`);
  console.log(`n=${metrics.n}  recall_scam=${metrics.recall_scam.toFixed(3)}  fpr=${metrics.fpr.toFixed(3)}  mae=${metrics.score_mae}`);
  console.log(`failures: ${report.failures.length}`);
  console.log(`report: ${outFile}\n`);
  return report;
}

if (require.main === module) main();
module.exports = { main };
```

- [ ] **Step 2: Přidej `.gitkeep` + gitignore reportů**

Run:
```bash
mkdir -p data/ground-truth/reports
touch data/ground-truth/reports/.gitkeep
echo "data/ground-truth/reports/*.json" >> .gitignore
```
Expected: reporty se neverzují (jsou odvozené), adresář ano.

- [ ] **Step 3: Smoke run proti seed kotvě**

Run: `node scripts/eval/run.js --split all`
Expected: vypíše metriky bez chyby (seed má prázdné snapshoty → verdikt `unknown`, to je OK; ověřujeme že harness běží end-to-end).

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/run.js data/ground-truth/reports/.gitkeep .gitignore
git commit -m "feat(eval): harness runner + report (held-out split)"
```

---

## Task 6: Baseline freeze (Fáze 0)

**Files:**
- Create: `scripts/eval/freeze-baseline.js`
- Create: `data/ground-truth/baseline.json` (generovaný)

> **Sekvenční závislost (spec §9):** baseline se zmrazí AŽ po naplnění kotvy reálnými snapshoty (capture workflow → ≥ desítky tokenů). Tolerance v regresní bráně (Task 7) se odvodí z naměřené variability baseline, ne odhadem. Tento task dodá *mechanismus*; konkrétní baseline.json vznikne po seedu.

- [ ] **Step 1: Implementuj `freeze-baseline.js`**

```js
'use strict';
// scripts/eval/freeze-baseline.js — zmrazí aktuální tune-split metriky jako referenci pro regresní bránu.
// Usage: node scripts/eval/freeze-baseline.js
const fs = require('fs');
const { loadAnchor } = require('./lib/schema');
const { evalToken } = require('./lib/eval-core');
const { computeMetrics } = require('./lib/metrics');

const data = loadAnchor('data/ground-truth/gold-v1.json');
const rows = data.tokens.filter(t => t.split === 'tune').map(evalToken);
const metrics = computeMetrics(rows);
const baseline = {
  frozen_at: new Date().toISOString(),
  rules_version: require('../../data/rules-v2.json').version,
  anchor_version: data._meta.version,
  split: 'tune', n: metrics.n,
  recall_scam: metrics.recall_scam,
  fpr: metrics.fpr,
  score_mae: metrics.score_mae,
};
fs.writeFileSync('data/ground-truth/baseline.json', JSON.stringify(baseline, null, 2));
console.log('[baseline] frozen:', JSON.stringify(baseline, null, 2));
```

- [ ] **Step 2: Smoke run**

Run: `node scripts/eval/freeze-baseline.js`
Expected: vytvoří `data/ground-truth/baseline.json` s aktuálními metrikami.

- [ ] **Step 3: Commit (jen skript, ne baseline.json — ten po seedu)**

```bash
git add scripts/eval/freeze-baseline.js
git commit -m "feat(eval): baseline freeze mechanismus (Fáze 0)"
```

---

## Task 7: Regresní brána + test-gate integrace

**Files:**
- Create: `tests/eval/regression-gate.test.js`
- Create: `scripts/eval/check-regression.js`
- Modify: `scripts/test-gate.sh`

- [ ] **Step 1: Napiš failing test brány**

`tests/eval/regression-gate.test.js`:

```js
'use strict';
const assert = require('node:assert');
const { checkRegression } = require('../../scripts/eval/check-regression');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const baseline = { recall_scam: 0.90, fpr: 0.05 };
const TOL = 0.02; // placeholder tolerance — finální hodnota z baseline variability (spec §9)

test('stejné metriky → PASS', () => {
  assert.strictEqual(checkRegression({ recall_scam: 0.90, fpr: 0.05 }, baseline, TOL).pass, true);
});
test('recall klesl pod baseline-tol → FAIL', () => {
  const r = checkRegression({ recall_scam: 0.85, fpr: 0.05 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('recall')));
});
test('FPR stoupl nad baseline+tol → FAIL', () => {
  const r = checkRegression({ recall_scam: 0.90, fpr: 0.09 }, baseline, TOL);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.some(x => x.includes('fpr')));
});
test('zlepšení (vyšší recall, nižší FPR) → PASS', () => {
  assert.strictEqual(checkRegression({ recall_scam: 0.95, fpr: 0.02 }, baseline, TOL).pass, true);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Spusť — ověř selhání**

Run: `node tests/eval/regression-gate.test.js`
Expected: FAIL — `Cannot find module '.../check-regression'`

- [ ] **Step 3: Implementuj `check-regression.js`**

```js
'use strict';
// scripts/eval/check-regression.js — non-regression brána proti baseline.json.
// Čistá funkce checkRegression + CLI wrapper. Tolerance = parametr (z baseline variability, spec §9).
const fs = require('fs');

function checkRegression(current, baseline, tol) {
  const reasons = [];
  if (current.recall_scam < baseline.recall_scam - tol) {
    reasons.push(`recall_scam ${current.recall_scam.toFixed(3)} < baseline ${baseline.recall_scam.toFixed(3)} - tol ${tol}`);
  }
  if (current.fpr > baseline.fpr + tol) {
    reasons.push(`fpr ${current.fpr.toFixed(3)} > baseline ${baseline.fpr.toFixed(3)} + tol ${tol}`);
  }
  return { pass: reasons.length === 0, reasons };
}

function main() {
  const baselinePath = 'data/ground-truth/baseline.json';
  if (!fs.existsSync(baselinePath)) {
    console.log('[regression] ⏭  baseline.json chybí — SKIP (zmraz přes freeze-baseline.js po seedu)');
    process.exit(0); // neblokuj dokud baseline neexistuje
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const { evalToken } = require('./lib/eval-core');
  const { computeMetrics } = require('./lib/metrics');
  const { loadAnchor } = require('./lib/schema');
  const data = loadAnchor('data/ground-truth/gold-v1.json');
  const rows = data.tokens.filter(t => t.split === 'tune').map(evalToken);
  const current = computeMetrics(rows);
  const tol = baseline.tolerance ?? 0.02; // finální hodnota z baseline variability
  const res = checkRegression(current, baseline, tol);
  if (res.pass) { console.log('[regression] ✅ PASS'); process.exit(0); }
  console.error('[regression] ❌ FAIL:\n' + res.reasons.map(r => '  - ' + r).join('\n'));
  process.exit(1);
}

if (require.main === module) main();
module.exports = { checkRegression };
```

- [ ] **Step 4: Spusť — ověř PASS**

Run: `node tests/eval/regression-gate.test.js`
Expected: PASS (4 testy)

- [ ] **Step 5: Přidej krok do `scripts/test-gate.sh`**

Najdi konec sekce „9. Golden dataset accuracy tests" a za ni přidej (vzor existujících kroků):

```bash
# 9b. Ground-truth eval — unit testy harness
echo "📐 Eval harness unit tests..."
if node tests/eval/metrics.test.js >/dev/null 2>&1 \
   && node tests/eval/eval-core.test.js >/dev/null 2>&1 \
   && node tests/eval/regression-gate.test.js >/dev/null 2>&1; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Eval harness unit tests failed"
fi

# 9c. Ground-truth non-regression brána (SKIP dokud baseline.json neexistuje)
echo "🎯 Eval non-regression..."
if node scripts/eval/check-regression.js; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Ground-truth regression gate failed"
fi
```

- [ ] **Step 6: Ověř test-gate běží**

Run: `bash scripts/test-gate.sh 2>&1 | grep -A1 "Eval"`
Expected: oba nové kroky se objeví; regrese SKIP (baseline ještě není), unit testy PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/eval/regression-gate.test.js scripts/eval/check-regression.js scripts/test-gate.sh
git commit -m "feat(eval): non-regression brána + test-gate integrace"
```

---

## Self-Review

**Spec coverage** (proti `docs/specs/2026-06-17-ground-truth-dataset-design.md`):
- §3 Architektura (jednotky 1 anchor, 2 harness) → Task 1, 5. Jednotky 3+4 (staging, promotion) → **Plán 2** (deferred, uvedeno).
- §4 Schéma → Task 1 (gold JSON; `gold_candidates` tabulka → Plán 2).
- §5 Harness + leakage guard + snapshot → Task 2, 4, 5. Snapshot = findings-level (amendment).
- §5 Metriky recall/FPR/MAE/must_flag → Task 3.
- §6 Promotion → **Plán 2** (deferred).
- §7 Workflow + baseline + regresní brána + held-out → Task 5 (split), 6 (baseline), 7 (brána).
- §8 Testing → Task 1/3/4/7 (schema, metrics math, leakage guard, determinism, regression FAIL/PASS). Promotion=konsenzus + rejected≠retry + balance guard → **Plán 2**.
- §9 Deferred calibration / sekvenční závislost → Task 6 note + Task 7 tolerance jako parametr.

**Placeholder scan:** `label: { verdict: 'TODO' }` v capture.js je záměrný output template (člověk doplní), ne plán-placeholder. Fixture v Task 4 Step 3 má fallback instrukci. Žádné „TBD" v krocích.

**Type consistency:** `evalToken` vrací `{category, predictedVerdict, predictedScore, label, verdictMatch, scoreInRange, mustFlagOk, mustNotFlagOk, risk_factors}` — `computeMetrics` čte `category/predictedVerdict/predictedScore/label.score_range`; `checkRegression` čte `recall_scam/fpr`. Shoduje se napříč tasky. `EVAL_SCAM_DB` konzistentní (Task 4 def, Task 6/7 import).

**Známá rizika k ověření při exekuci:**
1. Cesty `enrichScanResult` (`src/enrichment`) + `getGoplusReport` (`src/enrichment/goplus`) — ověřeno v planningu, shodné s `a2a-oracle.js:24-25`.
2. Tvar `enrichment` pro realistickou fixture (Task 4 Step 3 — z reálného capture, ne vymyšlený).
3. `rules-v2` module-init cache: harness MUSÍ běžet jako čerstvý proces per rules verze (CLI splňuje; nepsat in-process re-require test).
