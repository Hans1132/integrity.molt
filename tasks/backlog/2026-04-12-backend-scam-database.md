---
agent: backend
priority: P2
estimated_hours: 6
created: 2026-04-12
---

# Task: Integrovat scam token databázi

## Proč
Akademické datasety SolRPDS (62k poolů) a SolRugDetector (76k tokenů) 
jsou volně dostupné. Lookup proti nim dramaticky zvýší přesnost skenů.

## Co udělat
1. Stáhnout SolRPDS dataset z https://arxiv.org/abs/2504.07132
2. Stáhnout SolRugDetector dataset z https://arxiv.org/abs/2603.24625  
3. Importovat do SQLite tabulky known_scams (mint TEXT PK, source, type, confidence)
4. Při scan/quick a scan/token: lookup proti known_scams
5. Integrovat RugCheck API (api.rugcheck.xyz) jako enrichment
6. Přidat do reportu sekci "Known database matches"

## Acceptance criteria
- [ ] SQLite tabulka known_scams naplněná
- [ ] Scan reporty obsahují database match info
- [ ] bash scripts/test-gate.sh PASS
