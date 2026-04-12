---
agent: backend
priority: P0
estimated_hours: 4
created: 2026-04-12
---

# Task: Opravit verifikaci plateb (KRITICKÉ)

## Proč (business dopad)
Současný kód míchá SOL lamports a USDC micro-units do jedné proměnné
(requiredLamports). Quick scan za 0.10 USDC je splnitelný zaplacením
0.0001 SOL. Zároveň SPL transfer kontroluje wallet adresu místo ATA.
Dokud tohle neopravíme, NEMŮŽEME monetizovat.

## Co udělat
1. Najdi v kódu proměnnou requiredLamports a rozděl na dvě:
   - requiredSolLamports (pro SOL platby)
   - requiredUsdcMicro (pro USDC platby, 6 decimals)
2. Uprav verifikaci: SOL platba kontroluje SOL threshold, USDC kontroluje USDC threshold
3. Pro USDC: odvoď ATA z wallet pubkey + USDC mint + TOKEN_PROGRAM_ID
   - Použij getAssociatedTokenAddressSync() z @solana/spl-token
   - Kontroluj destination === ATA (ne === wallet)
4. Přidej anti-replay: SQLite tabulka used_signatures (sig TEXT PRIMARY KEY, created_at)
   - Před verifikací: SELECT 1 FROM used_signatures WHERE sig = ?
   - Po úspěšné verifikaci: INSERT INTO used_signatures
5. Sjednoť pricing: jeden zdroj pravdy (config/pricing.js) → generuj openapi.json i x402.json

## Soubory v scope
- server.js (payment middleware)
- src/payment/** (pokud existuje, jinak vytvoř)
- src/middleware/paywall*.js
- config/pricing.js (vytvořit jako single source of truth)
- tests/payment/**

## Acceptance criteria
- [ ] SOL a USDC mají oddělené threshold proměnné
- [ ] USDC verifikace kontroluje ATA, ne wallet adresu
- [ ] Stejný tx_sig nelze použít dvakrát (anti-replay)
- [ ] Config/pricing.js je jediný zdroj cen
- [ ] bash scripts/test-gate.sh projde

## Test příkazy
```bash
# Manuální ověření po restartu service
systemctl restart intmolt.service
sleep 2
# Smoke test
bash scripts/test-gate.sh
# Specifický test anti-replay (pokud existuje test suite)
node tests/payment/anti-replay.test.js 2>/dev/null || echo "Test suite TBD"
```
