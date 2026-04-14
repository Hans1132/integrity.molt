# integrity.molt — Multi-Agent Project Rules

## Projekt
Security scanner API pro Solanu. Node.js/Express na portu 3402.
NGINX reverse proxy s TLS. systemd služba: integrity-x402.service.

## Architektura
- 5 scan endpointů: /api/v1/scan/{quick,token,wallet,pool,deep}
- x402 micropayment paywall (USDC/SOL na Solaně)
- Ed25519 signed reports (tweetnacl)
- Multi-agent swarm: Scanner → Analyst → Reputation → Meta-scorecard
- Telegram bot: @integrity_molt_bot (systemd: intmolt-bot.service)
- Helius webhooks pro live monitoring
- Delta reports s LLM diffs (OpenRouter / gemini-2.5-flash)

## ⚠️ BEZPEČNOST — POVINNÉ PRO VŠECHNY AGENTY
1. NIKDY nepřidávej secrety, API klíče, privátní klíče do kódu nebo gitu
2. Secrety POUZE v /root/x402-server/.env (je v .gitignore)
3. Před commitem VŽDY: grep -rn "PRIVATE\|SECRET\|sk_\|api_key" --include="*.js" src/ | grep -v node_modules
4. SOL: 1 SOL = 1_000_000_000 lamports
5. USDC (Solana): 6 decimals, 1 USDC = 1_000_000 micro-units
6. NIKDY nemíchej lamports a USDC do jedné proměnné
7. SPL token destination = ATA (Associated Token Account), NE wallet adresa

## Agent Workflow
1. Přečti svůj role file: agents/{role}.md
2. Přečti aktivní task: tasks/active/*.md (pokud existuje)
3. Pracuj POUZE na souborech ve svém SCOPE
4. Po dokončení POVINNĚ spusť: bash scripts/test-gate.sh
5. Pokud testy PASS → git add + commit + přesuň task do tasks/done/
6. Pokud testy FAIL → NECHEJ ZMĚNY NECOMMITNUTÉ, zapiš důvod do task souboru, přesuň do tasks/failed/

## File Ownership (kdo smí co měnit)
- BACKEND agent: src/middleware/*, src/payment/*, src/routes/api*, server.js, config/*
- WEB agent: public/*, views/*, src/routes/web*, static/*
- MONITOR agent: src/monitor/*, src/watchlist/*, src/delta/*, src/notifications/*
- TESTER agent: tests/*, scripts/test-*.sh
- CONDUCTOR: tasks/*, agents/*.md, CLAUDE.md (pouze metadata, ne kód)
- SDÍLENÉ (změna vyžaduje test-gate): package.json, .env.example

## Commit konvence
- Anglicky, conventional commits: feat|fix|refactor|test|docs(scope): message
- Scope = agent role: feat(payment): add ATA verification
- VŽDY single-purpose commits, ne "fix everything"

## Známé kritické bugy (z auditu zprávy)
1. requiredLamports míchá SOL a USDC thresholds → špatné účtování
2. destination === WALLET místo ATA → platby mohou být nesprávně verifikované
3. Chybí anti-replay → stejný tx_sig může být použit vícekrát
4. Stats endpoint /api/v1/stats nevrací data → landing page counters nefungují
5. Scan type cards nemají funkční click targets
6. Conflicting pricing: openapi.json vs x402.json vs pricing.txt
