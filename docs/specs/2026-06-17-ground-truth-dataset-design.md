# Ground-truth dataset — closed-loop eval & scoring kalibrace

**Datum:** 2026-06-17
**Stav:** Design schválen Hansem, čeká na implementační plán
**Účel:** Měření přesnosti scanneru (precision/recall/FPR) + ladění scoring rubriky `rules-v2.json`, spojené do uzavřené smyčky se self-rostoucí kotvou.

---

## 1. Kontext & problém

Security oracle stojí a padá s přesností verdiktů. Současný stav to ale neumí spolehlivě měřit:

- `known_scams`: 33 453 řádků, ale jen 15 s confidence 1.0; ~19 tis. má 0.9 a **14 082 má confidence 0.5** (slabá/neověřená, bulk import z akademického SolRPDS).
- `token_whitelist`: 499 „čistých" tokenů (kandidát na negatives).
- `tests/scanner/golden-dataset.json`: pouze **16 tokenů** (6 safe, 5 edge, 5 scam) — na statistiku příliš málo.
- `scan_accuracy_signals`: reálná zpětná vazba = **2 řádky**.
- **Leakage past:** testovací scamy jsou v `known_scams` → scan se zkratuje na floor 76, takže přes ně nejde měřit kvalita LLM/scoring vrstvy (známo z memory `project_iris_test_gate`).

**Potřeba:** spolehlivý, ručně kurátorovaný **zlatý set** (gold), který slouží jako fixní nezávislá kotva pro měření i ladění, a který umí kontrolovaně růst.

## 2. Rozhodnutí (zafixovaná v brainstormingu)

| Otázka | Rozhodnutí |
|---|---|
| Primární účel | Měření přesnosti **+** ladění scoringu (jedna iterující smyčka) |
| Standard labelu | Ručně kurátorovaný zlatý set (nejvyšší důvěra) |
| Velikost & split | **~300 tokenů: 100 scam / 100 legit / 100 edge** |
| Architektura | **Přístup A** (git-verzovaný gold JSON + harness + DB staging), dorůstá do **C** (hybrid gold/silver) |
| Co se točí ve smyčce | **Kotva + auto-promotion kandidátů** — labely nezávislé na scanneru, smyčka ladí rubriku, ověření kandidáti rostou do setu |
| On-chain data | **Snapshot se slotem** (deterministický eval), ne živý lookup |
| Primární metriky | **recall(scam) a FPR zvlášť** (ne jedno F1) |
| Promotion gate | **Povinný lidský PR krok** (žádný auto-sign-off) |
| Stop kritéria | **Deferred calibration** — z baseline, ne hádaná čísla |
| Held-out | **240 ladících / 60 ověřovacích** (anti-overfitting) |

## 3. Architektura

Čtyři oddělené jednotky, každá samostatně testovatelná:

```text
                    ┌─────────────────────────────┐
                    │  1. GOLD ANCHOR (immutable)  │
                    │  data/ground-truth/          │
                    │    gold-v1.json (300 tokenů) │  ← git-verzovaná kotva
                    │    SCHEMA.md, METHODOLOGY.md │
                    └──────────────┬──────────────┘
                                   │ načítá (read-only)
                                   ▼
   rules-v2.json ──────►  ┌──────────────────────┐   ──────► reports/
   (laděno smyčkou)       │  2. EVAL HARNESS     │          eval-<ver>-<ts>.json
                          │  scripts/eval/run.js │          (metriky, confusion
   scanner pipeline ────► │  + leakage guard     │           matrix, diff vs base)
                          └──────────┬───────────┘
                                     │ zapisuje neshody
                                     ▼
                          ┌──────────────────────┐
                          │  3. CANDIDATE STAGING │  ← DB gold_candidates
                          │  (silver pool zárodek)│     (scanner minul/over-flag)
                          └──────────┬───────────┘
                                     │ nezávislá verifikace
                                     ▼
                          ┌──────────────────────┐
                          │  4. PROMOTION GATE    │  ← scripts/eval/promote.js
                          │  on-chain + multisrc  │     → append do gold-v(N+1)
                          │  → povinný PR sign-off│       → re-baseline
                          └──────────────────────┘
```

**Klíčový princip:** anchor je read-only soubor, ne DB tabulka. Harness ho nikdy nepřepisuje — jediná cesta ke změně vede přes promotion gate + PR. Tím je fyzicky vyloučen sebepotvrzující kruh.

### Ownership (cross-cutting, conductor rozloží — CLAUDE.md sekce 5)

| Cesta / artefakt | Vlastník |
|---|---|
| `data/ground-truth/*` (anchor, schema, methodology, baseline, reports) | nová cesta — conductor přiřadí |
| `scripts/eval/*` (run.js, promote.js) | nová cesta — conductor přiřadí |
| `gold_candidates` tabulka + migrace | **db** |
| Ladění `rules-v2.json` | **llm-economist** |
| Regresní brána v `test-gate.sh` + testy | **qa** |
| Leakage guard / snapshot injection ve scanneru | **backend** (scanner pipeline) |

## 4. Datové schéma

### A) Gold anchor — `data/ground-truth/gold-v1.json` (immutable, git-verzovaný)

```jsonc
{
  "_meta": {
    "version": "1.0",
    "frozen_at": "2026-06-17",
    "counts": { "scam": 100, "legit": 100, "edge": 100 },
    "split": { "tune": 240, "holdout": 60 },
    "stop_criteria": null,           // doplní se po baseline (deferred calibration)
    "methodology_ref": "data/ground-truth/METHODOLOGY.md"
  },
  "tokens": [
    {
      "id": "gt-0001",
      "mint": "...",
      "symbol": "...", "name": "...",
      "category": "scam",                 // scam | legit | edge
      "split": "tune",                    // tune | holdout

      // ── LABEL (nezávislá kotva — scanner sem NESMÍ psát) ──
      "label": {
        "verdict": "DANGER",              // očekávaný oracle verdikt
        "score_range": [80, 100],         // očekávaný rozsah skóre
        "scam_type": "rug_pull",          // null pro legit/edge
        "anchor_confidence": 1.0,
        "verified_at": "2026-06-15",
        "verified_by": "hans | agent:guardian",
        "rationale": "human-readable proč"
      },

      // ── PROVENANCE (co řekl každý nezávislý zdroj) ──
      "sources": [
        { "name": "solrpds",  "verdict": "rug_pull",  "confidence": 0.9 },
        { "name": "rugcheck", "verdict": "danger",    "ref": "url" },
        { "name": "onchain",  "verdict": "confirmed" }
      ],

      // ── ON-CHAIN SNAPSHOT (v čase verifikace, pro reprodukci) ──
      "onchain_snapshot": {
        "mint_authority": null,
        "freeze_authority": null,
        "liquidity_usd": 0,
        "pool_status": "drained",
        "snapshot_slot": 123456789
      },

      // ── EVAL HINTY ──
      "must_flag":     ["liquidity_removed"],    // scam: tohle MUSÍ chytit
      "must_not_flag": ["mint_authority_active"] // edge/legit: FP pasti
    }
  ]
}
```

Stávajících 16 tokenů z `tests/scanner/golden-dataset.json` se migruje jako seed (doplní se chybějící pole).

### B) Staging — `gold_candidates` DB tabulka (mutable, silver pool zárodek)

```sql
CREATE TABLE gold_candidates (
  mint                TEXT PRIMARY KEY,
  discovered_at       TEXT NOT NULL DEFAULT (datetime('now')),
  scanner_verdict     TEXT,            -- co řekl scanner (selhal/minul)
  scanner_score       INTEGER,
  source_consensus    TEXT,            -- JSON: zdroje + jejich verdikty
  disagreement_type   TEXT,            -- 'false_negative' | 'false_positive'
  onchain_snapshot    TEXT,            -- JSON
  verification_status TEXT DEFAULT 'pending', -- pending|verified|rejected
  promoted_to         TEXT,            -- 'gt-0301' až po promoci, jinak null
  notes               TEXT
);
```

## 5. Eval harness & metriky

Harness (`scripts/eval/run.js`) je čistá funkce: `gold anchor + rules-v2.json + scanner → report`. Žádný zápis do anchoru, žádný živý on-chain.

**Běh per token:**
1. Injektuj `onchain_snapshot` místo živého RPC (determinismus).
2. **Leakage guard:** obejdi `known_scams` short-circuit (parametr `evalMode`) → test skutečné scoring vrstvy.
3. Spusť scanner pipeline (raw → rules-v2 → kategorie/skóre/flags).
4. Porovnej s `label`: verdict? score v range? `must_flag` hoří? `must_not_flag` NEhoří?

**Dva integrační mechanismy ve scanneru** (ne nová logika):
- **Leakage guard** — `evalMode` parametr / allow-list gold mintů, který přeskočí `known_scams` lookup. Aktivní JEN v eval režimu, nikdy v produkci (jinak by vypnul rychlou cache cestu).
- **Snapshot injection** — scanner přijme on-chain data jako vstup místo živého fetche. Pokud to dnes neumí, malý refactor: extrahovat fetch do injektovatelné závislosti.

**Metriky** (`data/ground-truth/reports/eval-<rules-version>-<timestamp>.json`):

| Metrika | Co měří | Proč klíčové |
|---|---|---|
| Confusion matrix per kategorie | scam/legit/edge × predikce | celkový obraz |
| **Recall (scam)** | % scamů správně chycených | miss = uživatel ztratí peníze |
| **FPR (legit+edge)** | % čistých chybně označených | false positive = ztráta důvěry |
| Precision (scam) | z označených kolik fakt scam | |
| Score MAE | průměrná odchylka skóre od range | jemné ladění rubriky |
| must_flag / must_not_flag pass rate | hoří správné signály? | ladíš ze správných důvodů |
| **Diff vs. baseline** | změna oproti baseline | regresní brána |

Recall(scam) a FPR jsou **dvě oddělené primární metriky** — chyby jsou asymetrické (false negative dražší než false positive, ale edge kategorie hlídá over-flagging). Jedno F1 by je zprůměrovalo a schovalo.

## 6. Promotion pipeline (anchor roste → cesta k C)

**Princip:** scanner kandidáta jen navrhne, label rozhodne nezávislá verifikace.

```text
1. TRIGGER (automatický, z harness)
   scanner ≠ realita → zápis do gold_candidates
   - false_negative: scanner řekl SAFE, ale zdroje křičí scam
   - false_positive: scanner řekl DANGER, ale token je ověřeně čistý

2. VERIFIKACE (scripts/eval/promote.js — NEZÁVISLÁ na scanneru)
   pro každý pending kandidát:
     - fresh on-chain lookup (mint/freeze authority, likvidita, pool stav)
     - dotaz ≥2 nezávislé zdroje (RugCheck, GoPlus, SolRPDS)
     - konsenzus? (≥2 zdroje + on-chain souhlas) → 'verified'
     - jinak → 'rejected' (NEopakovat automaticky)

3. NÁVRH (jen verified)
   vygeneruj gold entry: label z KONSENZU (ne z verdiktu scanneru),
   onchain_snapshot se slotem, sources[], must_flag/must_not_flag
   → append do gold-v(N+1).json  (nová verze, stará zmrazená)

4. GATE (povinný lidský sign-off)
   PR review: Hans schválí diff → merge → nová zmrazená kotva → re-baseline
```

- **Label z konsenzu, ne z opraveného scanneru** — jinak by si smyčka potvrzovala vlastní opravy (sebepotvrzující kruh). Scanner je detektor neshody, ne autorita.
- **`rejected` se neopakuje** — jinak by každý běh cpal stejné sporné tokeny do fronty.
- **Balance guard:** `promote.js` hlídá rozpad 100/100/100; nadbytek nechá v silver poolu.

## 7. Closed-loop workflow & regresní brána

**Stop kritéria nejsou hádaná čísla** (memory `feedback_evidence_over_guesswork`). Vzejdou z první kalibrace.

```text
FÁZE 0 — Baseline (jednorázově)
  harness s aktuální rules-v2.json proti gold-v1 (jen tune split, 240)
  → zmraz baseline metriky do data/ground-truth/baseline.json
  → TEPRVE TEĎ Hans nastaví stop kritéria RELATIVNĚ k baseline

FÁZE 1 — Ladící smyčka (iterativní, llm-economist)
  uprav prahy/váhy v rules-v2.json → harness re-run → diff vs. baseline
  lepší? posuň baseline. horší? revert.
  stop: kritéria splněna NEBO konvergence (3 běhy bez zlepšení)

FÁZE 2 — Finální ověření (held-out)
  pusť harness na 60 holdout tokenů (NIKDY nevstoupily do ladění)
  → potvrzení generalizace, ne overfit na 240

FÁZE 3 — Promoce (občas, viz sekce 6) → re-baseline
```

**Regresní brána** (`test-gate.sh`) — **non-regression, ne absolutní cíl:**
```text
PASS pokud: recall_scam ≥ baseline.recall_scam − tolerance
       AND: FPR        ≤ baseline.FPR        + tolerance
       AND: žádný must_flag/must_not_flag regres
FAIL → blokuje commit, ukáže který token a metrika spadly
```
`data/ground-truth/baseline.json` je git-verzovaná, mění se jen vědomě (zlepšení nebo re-baseline po promoci).

**Held-out izolace:** 60 holdout tokenů nikdy nevstoupí do ladící smyčky ani do baseline — jen do Fáze 2. Split je disjunktní a vynucený testem.

## 8. Testing

TDD, temp SQLite + syntetické fixtures, nikdy živá data (vzor `scripts/test-scanner-logic.js`).

| Test | Co dokazuje |
|---|---|
| Harness math | confusion matrix, recall, FPR, MAE se počítají správně (stub scanner) |
| **Leakage guard** | gold mint v `known_scams` se v `evalMode` nezkratuje na floor 76 |
| Snapshot injection | scanner použije injektovaný snapshot, živé RPC se nezavolá (mock, assert not-called) |
| Held-out izolace | 60 holdout tokenů nikdy nevstoupí do ladění; split disjunktní |
| **Promotion = konsenzus** | kandidát scanner=X, zdroje=Y → promovaný label = Y |
| rejected ≠ retry | zamítnutý kandidát se znovu nenavrhne |
| Balance guard | promoce vychylující 100/100/100 zůstane v silver poolu |
| Regresní brána | horší metriky než baseline → FAIL; stejné/lepší → PASS |
| Schema validace | gold JSON splňuje schéma; chybí `sources[]`/`onchain_snapshot` → fail |

**Dva nejdůležitější testy:** leakage guard (hlídá short-circuit leakage) a promotion=konsenzus (hlídá self-confirmation). Každý kryje jednu ze dvou hlavních pastí návrhu.

## 9. Otevřené body pro implementační plán

- Pořadí stavby: schéma + seed gold → harness + leakage guard → baseline → ladící smyčka → promotion + staging → regresní brána.
- Skutečný formát výstupu scanner pipeline (verdikt enum, score škála) ověřit proti `handler.js` / scannerům před psaním harness comparátoru.
- Zdroj 300 kandidátů na seed: SolRPDS (scam), Jupiter validated list (legit), edge ručně z historických false positives. Sběr je agent-assisted, label rozhoduje Hans.
- **Sekvenční závislost baseline → brána (deferred calibration):** regresní brána (sekce 7) a její test (sekce 8) NEJDOU napsat s konkrétními assertions, dokud neproběhne Fáze 0. Pořadí je vynucené:
  1. **Fáze 0 — baseline run** změří metriky a jejich variabilitu na tune splitu (240).
  2. Z naměřené variability se odvodí konkrétní `tolerance` hodnoty (ne odhad — viz `feedback_evidence_over_guesswork`).
  3. **Teprve pak** se test regresní brány (`test-gate.sh`) napíše s těmi konkrétními čísly.
  4. **Teprve pak** se brána zapne jako blokující v CI.

  Proto `stop_criteria: null` ve schématu (sekce 4) a chybějící čísla v sekcích 7–8 nejsou nedokončené — jsou to vědomé deferred-calibration placeholdery, které se doplní po baseline běhu.
