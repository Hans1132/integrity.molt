---
agent: web
priority: P1
estimated_hours: 2
created: 2026-04-12
---

# Task: Opravit stats counters a click targets na landing page

## Proč
Landing page ukazuje nulové/prázdné stats a scan type cards nereagují na klik.
Návštěvník nevidí sociální důkaz a nemůže začít scan → 100% bounce.

## Co udělat
1. Stats counters: fetch /api/v1/stats a naplnit DOM elementy
   - Pokud endpoint nevrací data, zajistit aby backend vracel validní JSON
   - Fallback: "–" místo 0 pokud API selže
2. Scan type cards: opravit onclick/href aby navigovaly na scan formulář
3. Ověřit na mobilu (responsive check)

## Soubory v scope
- public/index.html
- public/js/** (pokud existuje)
- static/**

## Acceptance criteria
- [ ] Stats counters zobrazují nenulová čísla (nebo graceful "–")
- [ ] Klik na scan type card naviguje na scan
- [ ] bash scripts/test-gate.sh projde
