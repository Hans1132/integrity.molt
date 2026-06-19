# Měřící mezera: non-whitelist legit set (v1)

**Datum:** 2026-06-19
**Stav:** Návrh — čeká na plan checkpoint (schválení PŘED jakýmkoliv dataset zápisem)
**Kontext:** PR #9, navazuje na floor měření (closed) + recall pivot. Gold dataset = `data/ground-truth/gold-v1.json` (201 tokenů: 100 scam / 35 legit / 66 edge).

## 1. Účel / problém

Gold clean labely jsou **100 % cirkulární**: všech 101 clean tokenů ∈ `legit-tokens.json` = produkční soft-whitelist (`src/scam-db/whitelist.js`). Měření prokázalo: whitelist OFF → FPR 0.19, whitelist ON → FPR 0.00, a všech 19 floored-clean-danger tokenů je ve whitelistu → v produkci 0 FP. Ale to je triviální (test set ⊂ whitelist). **Novel-legit FP — over-flag legit tokenu, který whitelist NEchrání — je dnes neměřitelný.**

Tento set přidává legit tokeny **mimo produkční whitelist**, nezávisle ověřené, aby šlo měřit precision/novel-legit FP při zvedání intrinsic recallu (priorita po floor pivotu).

## 2. Scope

- **A. Non-whitelist legit — SCHVÁLENO.** Jediná 0-coverage osa. Cíl ~40 (v1).
- **B. RugCheck-blind-spot scam top-up — ODLOŽENO.** Discovery ukázalo, že 57 ze 100 stávajících scamů je už RugCheck-blind-spot (label drží on-chain removal, ne RugCheck) → dostatečný independent-detection test bed. Žádné scam přidávání v této iteraci.

## 3. Zdroj (sampling frame)

Jupiter-strict (`token_whitelist` DB tabulka, 499) MINUS `legit-tokens.json` MINUS stávající gold minty. ~466 kandidátů.

## 4. Label = on-chain verifikace (NE „je na Jupiteru")

Konzervativní laťka. **Asymetrie škody platí i na labely:** mislabeled slow-rug v legit setu trestá scorer za správný flag → učí under-detekci. Raději míň tokenů s vysokou jistotou.

Token je legit JEN když platí VŠECHNA ověřitelná kritéria:

| # | Kritérium | Zdroj | Spolehlivost |
|---|---|---|---|
| 1 | Deep liquidity: `total_liquidity_usd ≥ $250k` | `enrichment.external_sources.rugcheck.total_liquidity_usd` | ✅ spolehlivé |
| 2 | `rugcheck.rugged === false` | rugcheck | ✅ |
| 3 | Není v `known_scams` (jakákoliv confidence) | DB | ✅ |
| 4 | 0 liquidity-removal events v `pool_activity` | DB | ⚠️ částečné (viz §6) |
| 5 | Established / survived ≥ 180 dní | — | ❌ **NEspolehlivé z enrichmentu** (viz §5) |

Kandidát, co nesplní VŠECHNA aplikovaná kritéria → vyřadit + zalogovat důvod.

### Label hodnoty
`category: legit`, `label.verdict: safe`, `score_range: [0,39]`, `scam_type: null`, `anchor_confidence: 0.9`, `verified_by: hans-pending`. `sources: [{name:"jupiter-strict", verdict:"legit"}, {name:"onchain_verified", liquidity_usd:X, removal_events:0}]`.

## 5. OTEVŘENÝ KONFLIKT pro checkpoint — age verifikace

Kritérium #5 (established/survived ≥ 180 dní) **nelze věrohodně ověřit ze snapshotu**: jediný age zdroj je `solana_tracker.age_hours`, který je u většiny tokenů prázdný (null). Bez age je laťka slabší — slow-rug, co ještě nestihl odejít, by mohl projít na deep liquidity.

**Rozhodnutí ke schválení (vyber):**
- **(a) Přidat on-chain age fetch** do verifikace (getSignaturesForAddress nejstarší sig / mint account creation slot → age). Drží konzervativní laťku, ale rozšiřuje capture o RPC krok. **Doporučeno** (age je nejsilnější anti-slow-rug signál).
- **(b) Vypustit age**, spolehnout se na deep liquidity (#1) + LP lock + rugged=false + not-known-scam + no-removal jako proxy „dlouhodobě zdravý". Nižší effort, slabší jistota.

Dokud nerozhodneš, kritérium #5 je neaktivní (spec ho nezavádí potichu).

## 6. Známé omezení (zadokumentovat, NEpřeceňovat)

- **Sampling bias zůstává.** Jupiter-strict je kurátorovaný **sampling frame**. On-chain verifikace opravuje **cirkularitu labelu** (label nezávislý na našem oraclu), NE **sampling bias**. Měřené číslo = novel-legit FP **na Jupiter-strict tokenech mimo náš whitelist**, ne na libovolných novel legit. Nepřeceňovat.
- **No-removal je částečný signál.** `pool_activity` pokrývá ~132/26756 mintů s removal events; absence removal záznamu ≠ důkaz no-rug (může být netrackovaný pool). Slouží jako vylučovací filtr, ne pozitivní důkaz.

## 7. Pravidla (anti-drift — KRITICKÉ)

- **NE-whitelist-add:** tyto tokeny se NIKDY nepřidávají do `legit-tokens.json`. Zůstávají non-whitelist. Jinak se v produkci stanou whitelistovanými (×0.51 redukce) → maří účel měření novel-legit FP. Toto pravidlo musí platit i pro veškeré budoucí přidávání.
- **V evalu měřeny s whitelist OFF** (nejsou v něm; i s eval-core toggle ON by nebyly chráněné).
- `snapshot: {enrichment, goplus}` jako ostatní gold tokeny (capture.js).
- Konzervativní laťka platí i při budoucím rozšiřování — nehnat počet na úkor rigoru.

## 8. Split

tune/holdout ~80/20. Holdout legit je teď jen 4 → tento set ho zvětší (lepší holdout reprezentace clean osy).

## 9. Cíl

~40 (v1). Když projde méně (přísná laťka), OK — rozšíříme později. Rigor > počet.

## 10. Verification metoda (implementace, po schválení)

Per kandidát: `capture.js` snapshot → ověř kritéria §4 (liquidity/rugged z enrichment, removal z pool_activity, known_scams z DB, [age dle rozhodnutí §5]) → pass: přidat s ids gt-XXXX; fail: vyřadit + log důvod. Validace `loadAnchor` + re-run harness (OFF i ON toggle) → report novel-legit FP.

## 11. Sekvence

1. **Token-2022 re-měření** (separátní workstream) — první, dimension-strengthening, re-měř intrinsic recall.
2. **Tato příprava** běží paralelně: spec → **plan checkpoint** (schválení tohoto + rozhodnutí §5) → implementace (dataset zápis) → re-měření novel-legit FP.
3. **Pak** dimension-strengthening pro recall, gated na: recall↑ A novel-legit FP ne hůř.

Žádný dataset zápis ani capture před schválením tohoto specu + rozhodnutí §5.
