---
agent: backend
priority: P3
estimated_hours: 4-6
created: 2026-04-12
depends_on: []
blocks: []
---

# Task: Scan Validator Module (`src/llm/scan-validator.js`)

## Problém a motivace

V `scanners/token-audit.js` funkci `buildResult()` (řádek 787) LLM skóre bezpodmínečně
přepíše deterministické skóre:

```js
risk_score: llm?.risk_score ?? rawScore,
```

LLM může vrátit libovolné číslo 0–100 bez ohledu na to, co deterministický scanner naměřil.
Příklad: scam token s rawScore = 90 může dostat od LLM risk_score = 25 a scanner ho označí
jako SAFE. Pokud útočník dokáže konzistentně tuto cestu zneužít, jde o P1.

Druhý problém: `src/adversarial/runner.js` vrací adversarial report bez konzistencní
kontroly vůči deterministickým findings.

Cíl: přidat validační vrstvu (`src/llm/scan-validator.js`) která tiše opravuje
LLM skóre na základě dat, která pipeline již má. Žádná nová RPC volání.

---

## KRITICKÉ OMEZENÍ: ŽÁDNÁ NOVÁ HELIUS RPC VOLÁNÍ

**Scan validator NESMÍ volat Helius API ani žádný jiný RPC nebo blockchain endpoint.**

Modul pracuje výhradně s daty předanými jako argumenty funkcí.
Zákaz se vztahuje na: `fetch`, `axios`, `helius`, `rpcCall`, `Connection`
a jakýkoliv HTTP klient volající externí API.

Důvod: Helius kredity byly v minulosti vyčerpány (10 milionů tokenů za 2 dny)
kvůli nadměrnému počtu volání. Tento modul nesmí zvýšit počet Helius volání
ani o jedno.

---

## Architektura modulu

Nový soubor `src/llm/scan-validator.js` — čisté funkce, žádné side-effects,
žádné I/O, žádné importy s RPC závislostmi.

```
scanners/token-audit.js
  auditToken()
    -> summarizeWithLLM(auditData)                            // stávající, beze změny
    -> validateLLMScore(rawScore, llm, auditData)             // NOVÉ
    -> buildResult({ ..., llm: corrected, validationFlags })  // rozšířená signatura

src/adversarial/runner.js
  runAdversarialScan()
    -> validateAdversarialResult(report, deterministicCtx)    // NOVÉ
    -> return validated
```

---

## Implementační kroky

### Krok 1 — Vytvořit `src/llm/scan-validator.js`

```js
'use strict';
// src/llm/scan-validator.js
// Validates and corrects LLM output against deterministic scan data.
// ŽÁDNÁ RPC VOLÁNÍ. ŽÁDNÉ I/O. Pure functions only.

const MAX_DRIFT_BELOW_DETERMINISTIC = 20;

function validateLLMScore(rawScore, llm, auditData) {
  if (!llm || typeof llm.risk_score !== 'number') {
    return { corrected: llm, flags: ['llm_score_missing'] };
  }

  const flags = [];
  let score = llm.risk_score;

  // Pravidlo 1: drift limit
  const drift = rawScore - score;
  if (drift > MAX_DRIFT_BELOW_DETERMINISTIC) {
    score = rawScore - MAX_DRIFT_BELOW_DETERMINISTIC;
    flags.push(`llm_score_corrected_drift:${Math.round(drift)}`);
  }

  // Pravidlo 2: aktivní mint authority -> score >= 40
  const mintActive = auditData?.on_chain?.mint_authority &&
    auditData.on_chain.mint_authority !== 'renounced' &&
    auditData.on_chain.mint_authority !== null;
  if (mintActive && score < 40) {
    score = 40;
    flags.push('llm_score_corrected_mint_authority_active');
  }

  // Pravidlo 3: aktivní freeze authority -> score >= 35
  const freezeActive = auditData?.on_chain?.freeze_authority != null &&
    auditData.on_chain.freeze_authority !== 'renounced';
  if (freezeActive && score < 35) {
    score = 35;
    flags.push('llm_score_corrected_freeze_authority_active');
  }

  // Pravidlo 4: top-1 holder > 50 % supply -> score >= 31
  const top1Pct = auditData?.concentration?.top1_pct ?? 0;
  if (top1Pct > 50 && score < 31) {
    score = 31;
    flags.push(`llm_score_corrected_concentration:top1=${top1Pct}%`);
  }

  // Pravidlo 5: critical/high findings -> score >= 31
  const hasDanger = (auditData?.findings || [])
    .some(f => f.severity === 'critical' || f.severity === 'high');
  if (hasDanger && score < 31) {
    score = 31;
    flags.push('llm_score_corrected_danger_findings_present');
  }

  score = Math.round(Math.min(100, Math.max(0, score)));
  const corrected = { ...llm, risk_score: score, category: scoreToCategory(score) };
  return { corrected, flags };
}

function validateAdversarialResult(adversarialResult, deterministicContext) {
  if (!adversarialResult || !deterministicContext) return adversarialResult;

  const flags = [];
  const { rawScore, findings } = deterministicContext;
  const reportedScore = adversarialResult.risk_score ?? adversarialResult.score;

  if (typeof reportedScore === 'number' && typeof rawScore === 'number') {
    const drift = rawScore - reportedScore;
    if (drift > MAX_DRIFT_BELOW_DETERMINISTIC) {
      flags.push(`adversarial_score_drift:${Math.round(drift)}`);
    }
  }

  const hasCritical = (findings || []).some(f => f.severity === 'critical');
  if (hasCritical && adversarialResult.verdict === 'SAFE') {
    flags.push('adversarial_verdict_conflicts_critical_findings');
  }

  return { ...adversarialResult, llm_validation_flags: flags };
}

function scoreToCategory(score) {
  if (score <= 30) return 'SAFE';
  if (score <= 65) return 'CAUTION';
  return 'DANGER';
}

module.exports = { validateLLMScore, validateAdversarialResult };
```

---

### Krok 2 — Integrace do `scanners/token-audit.js`

```js
const { validateLLMScore } = require('../src/llm/scan-validator');

// nahradit v auditToken():
const llmRaw = await summarizeWithLLM(auditData);
const { corrected: llm, flags: validationFlags } = validateLLMScore(rawScore, llmRaw, auditData);
return buildResult({ mintAddress, tokenName, findings, rawScore, t0, auditData, llm, validationFlags });

// přidat do buildResult() return objektu:
llm_validation_flags: validationFlags || [],
```

### Krok 3 — Integrace do `src/adversarial/runner.js`

```js
const { validateAdversarialResult } = require('../llm/scan-validator');

// před return finálního reportu:
return validateAdversarialResult(report, { rawScore, findings, auditData: context });
```

---

## Validační pravidla (souhrn)

| # | Pravidlo | Podmínka | Korekce | Flag |
|---|----------|----------|---------|------|
| 1 | Drift limit | `rawScore - llmScore > 20` | `score = rawScore - 20` | `llm_score_corrected_drift:N` |
| 2 | Mint authority | aktivní + `score < 40` | `score = 40` | `llm_score_corrected_mint_authority_active` |
| 3 | Freeze authority | aktivní + `score < 35` | `score = 35` | `llm_score_corrected_freeze_authority_active` |
| 4 | Koncentrace | `top1_pct > 50` + `score < 31` | `score = 31` | `llm_score_corrected_concentration:top1=X%` |
| 5 | Danger findings | critical/high + `score < 31` | `score = 31` | `llm_score_corrected_danger_findings_present` |

Všechna pravidla: tiché opravení + flag do response. Žádné blokování scanu.

---

## Test plán

Unit testy (`tests/scan-validator.test.js`):
1. LLM=10, rawScore=80 → score=60, flag `llm_score_corrected_drift:70`
2. LLM=45, rawScore=50 → beze změny (drift=5)
3. LLM=95, rawScore=20 → beze změny (LLM přísnější je OK)
4. LLM=25, mint_authority=aktivní → score=40
5. LLM=20, freeze_authority=aktivní → score=35
6. LLM=20, top1_pct=75 → score=31
7. LLM=10, findings=[{severity:"critical"}] → score=31
8. LLM=null → `{ corrected: null, flags: ["llm_score_missing"] }`
9. validateAdversarialResult: verdict SAFE + critical finding → flag přidán
10. validateAdversarialResult: null input → vrátí původní objekt

Integration smoke: `curl .../api/v1/scan/token | jq '.llm_validation_flags'` — nikdy null.

Finální: `bash /root/x402-server/scripts/test-gate.sh`

---

## Prioritizace (stav 2026-04-12)

| Task | Priorita | Stav |
|------|----------|------|
| `web-backend-captcha-math` | P1 | dokončeno |
| `web-fix-stats-and-clicks` | P1 | backlog |
| `scan-validator-module` (tento) | P3 | backlog |

Doporučené pořadí: stats fix → scan validator.

**Eskalace na P1** pokud bude potvrzeno, že LLM hodnotil scam token jako SAFE při critical/high findings.
