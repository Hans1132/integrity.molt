---
name: Test suite layout
description: Přehled struktury testů, scope a integrace v integrity.molt projektu
type: project
---

E2E smoke suite a security scan jsou hotovy a commitnuty (commit aa5fe0e, 2026-04-12).

Soubory:
- tests/e2e/smoke.js — 7 testů, čistý Node.js http modul, 5 endpointů
- tests/security/no-secrets.js — grep src/ + server.js na PRIVATE_KEY, BEGIN.*PRIVATE, sk_live, sk_test
- scripts/test-gate.sh sekce 5 volá node tests/e2e/smoke.js
- package.json "test": "node tests/e2e/smoke.js && node tests/security/no-secrets.js"

**Why:** Základ multi-agent workflow — test gate blokuje commity při selhání.

**How to apply:** Před každou novou sadou testů ověř, že test-gate.sh stále prochází. Scope no-secrets.js je úmyslně omezený na src/ a server.js (ne public/ nebo config/).
