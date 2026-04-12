---
agent: tester
priority: P0
estimated_hours: 2
created: 2026-04-12
---

# Task: Vytvořit E2E smoke test suite

## Proč
Bez automatických testů každá změna potenciálně rozbije produkci
a Hans to musí složitě debugovat. Test gate je základ celého
multi-agent workflow.

## Co udělat
1. Vytvoř tests/e2e/smoke.js — Node.js script (žádné dependencies navíc)
   - Používej http modul (ne axios/fetch) pro zero-dependency
2. Testuj: homepage 200, health 200, stats 200+JSON, scan 402, x402 200+JSON
3. Vytvoř tests/security/no-secrets.js — grep přes src/ na secrety
4. Uprav scripts/test-gate.sh aby volal tyto skripty
5. Přidej do package.json: "test": "node tests/e2e/smoke.js"

## Soubory v scope
- tests/e2e/smoke.js (vytvořit)
- tests/security/no-secrets.js (vytvořit)
- scripts/test-gate.sh (upravit)
- package.json (scripts sekce)

## Acceptance criteria
- [ ] node tests/e2e/smoke.js běží a reportuje výsledky
- [ ] bash scripts/test-gate.sh integruje smoke testy
- [ ] Žádné externí dependencies (čistý Node.js)
