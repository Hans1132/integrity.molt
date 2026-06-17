# Gold Anchor Schema Reference

Gold dataset pro deterministický eval loop IRIS v2 scoreru.

## Pole nejvyšší úrovně

| Pole           | Typ      | Popis |
|----------------|----------|-------|
| `id`           | string   | Unikátní ID záznamu, formát `gt-NNNN` |
| `mint`         | string   | Solana mint adresa (≥32 znaků) |
| `symbol`       | string   | Token symbol |
| `name`         | string   | Token name |
| `category`     | enum     | Ground-truth třída: `scam`, `legit`, `edge` |
| `split`        | enum     | Dataset split: `tune` (kalibrace), `holdout` (eval) |
| `label`        | object   | Očekávaný výstup oraklu (viz níže) |
| `sources`      | array    | Zdroje labelu, min. 1 prvek |
| `snapshot`     | object   | Deterministické vstupy pro `calculateIRIS_v2` |
| `must_flag`    | array    | Položky, které MUSÍ být přítomny v `iris.risk_factors` |
| `must_not_flag`| array    | Položky, které NESMÍ být přítomny v `iris.risk_factors` |

## category vs label.verdict

**`category`** = ground-truth třída tokenu z pohledu skutečného stavu:
- `scam` — prokázaný podvod nebo rugpull
- `legit` — legitimní token (stablecoin, blue chip, protokol)
- `edge` — hraniční případ (dobrý kontrakt, ale nízká likvidita apod.)

**`label.verdict`** = očekávaný výstup oraklu (lowercase, mapuje na `classifyRisk` výstup):
- `safe` — score < 40
- `caution` — score ≥ 40
- `danger` — score ≥ 70
- `unknown` — scorer nemohl určit výsledek (null score)

`category` a `label.verdict` jsou ortogonální: edge token může mít verdict `caution`, scam token `danger`.

## label objekt

| Pole                | Typ      | Popis |
|---------------------|----------|-------|
| `verdict`           | enum     | Viz výše — lowercase `safe|caution|danger|unknown` |
| `score_range`       | [lo, hi] | Přijatelný rozsah IRIS skóre |
| `scam_type`         | string\|null | Typ scamu (rug, honeypot, …) nebo null |
| `anchor_confidence` | float    | 0.0–1.0, důvěra v label |
| `verified_at`       | date     | ISO datum verifikace (YYYY-MM-DD) |
| `verified_by`       | string   | Kdo verifikoval (hans, automated) |
| `rationale`         | string   | Stručné odůvodnění labelu |

## snapshot objekt

```json
{ "enrichment": {}, "goplus": {} }
```

`snapshot` = deterministické vstupy pro `calculateIRIS_v2` — **nikoliv raw on-chain data**.

- `enrichment` = výstup enrichment pipeline (sociální signály, metadata)
- `goplus` = GoPlus security report pro mint

Prázdné objekty (`{}`) jsou validní pro seed kotvu — yielding `risk_level: 'unknown'` při eval time, dokud capture task (`scripts/eval/capture.js`) nedoplní skutečná data.

## split

- `tune` — kalibrace scoreru (tréninkový set)
- `holdout` — skutečný eval (scorer na tato data neviděl)

## sources[]

Minimálně jeden prvek. Každý zdroj má:
- `name` — identifikátor zdroje (`onchain`, `rugcheck`, `goplus`, `manual`)
- `verdict` — co zdroj říká (`confirmed`, `flagged`, `unknown`)

## must_flag / must_not_flag

Pole stringů odpovídajících položkám v `iris.risk_factors`:
- `must_flag` — tyto risk faktory MUSÍ být v orakulovém výstupu
- `must_not_flag` — tyto risk faktory NESMÍ být v orakulovém výstupu

Prázdné pole = žádná povinnost.
