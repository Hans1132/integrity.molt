---
agent: backend
priority: P1
estimated_hours: 6
created: 2026-04-14
depends_on: 2026-04-14-backend-iris-database-analysis
---

# Task: IRIS — Implementovat scoring engine

## Proč
Po analýze databáze máme statistické prahy. Teď je zabudovat
do scan pipeline jako IRIS score 0-100.

## Co udělat

### 1. Vytvoř src/features/iris-score.js
```javascript
// IRIS = Inflows + Rights + Imbalance + Speed
// Každá dimenze 0-25 bodů, celkem 0-100

function calculateIRIS(features) {
  const inflows = scoreInflows(features);   // 0-25
  const rights = scoreRights(features);     // 0-25
  const imbalance = scoreImbalance(features); // 0-25
  const speed = scoreSpeed(features);       // 0-25

  const total = inflows + rights + imbalance + speed;

  return {
    score: total,
    grade: total >= 75 ? 'CRITICAL' : total >= 50 ? 'HIGH'
           : total >= 25 ? 'MEDIUM' : 'LOW',
    breakdown: {
      inflows: { score: inflows, details: [...] },
      rights: { score: rights, details: [...] },
      imbalance: { score: imbalance, details: [...] },
      speed: { score: speed, details: [...] }
    },
    methodology: 'IRIS v1.0 — intmolt.org/iris'
  };
}
```

### 2. Prahy z analýzy
Použij statistické prahy z data/iris-analysis-results.json.
Každý práh musí mít komentář odkud pochází:

```javascript
// Práh z IRIS DB analýzy: median deploy→rug pro scam = Xh
const SPEED_THRESHOLDS = {
  deploy_to_pool_critical: 300,  // <5 min, source: iris-analysis Q11
  deploy_to_pool_high: 3600,     // <1h, source: iris-analysis Q11
  // ...
};
```

### 3. Integruj do scan pipeline
- Quick scan: vrací IRIS score + grade
- Token scan: vrací IRIS score + full breakdown
- Deep scan: vrací IRIS score + breakdown + raw data

### 4. Přidej do LLM promptu
```
Token IRIS Score: {score}/100 ({grade})
Breakdown:
  I — Inflows: {inflows}/25 — {inflows_details}
  R — Rights: {rights}/25 — {rights_details}
  I — Imbalance: {imbalance}/25 — {imbalance_details}
  S — Speed: {speed}/25 — {speed_details}

Vysvětli toto skóre uživateli srozumitelně.
```

### 5. Landing page + report
- IRIS score badge v HTML reportu (vizuální gauge 0-100)
- Odkaz na metodiku: intmolt.org/iris

## Acceptance criteria
- [ ] calculateIRIS() vrací score 0-100 se 4 dimenzemi
- [ ] Prahy odpovídají výsledkům DB analýzy
- [ ] Scan reporty obsahují IRIS score a breakdown
- [ ] LLM prompt obsahuje IRIS data
- [ ] bash scripts/test-gate.sh PASS

## Test
```bash
# USDC by měl mít IRIS < 10 (LOW)
curl -s http://127.0.0.1:3402/scan/token -X POST \
  -H "Content-Type: application/json" \
  -d '{"address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}' \
  | jq '.iris'
```
