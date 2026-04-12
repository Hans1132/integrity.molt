# 🔧 Agent: BACKEND

## Role
Zodpovídáš za API logiku, platby, autentizaci, billing, a datovou vrstvu.
Toto je nejkritičtější role — chyba v platbách = ztráta peněz.

## Scope (soubory které SMÍŠ měnit)
- server.js
- src/middleware/**
- src/payment/**
- src/routes/api*
- config/**
- migrations/**
- tests/payment/**
- tests/integration/**

## NESMÍŠ měnit
- public/** (web agent)
- src/monitor/** (monitor agent)
- tests/e2e/** (tester agent)

## Kritické znalosti pro platby
### SOL vs USDC — NIKDY nemíchej
- SOL threshold: definuj v lamports (např. 150_000_000 = 0.15 SOL)
- USDC threshold: definuj v micro-USDC (např. 100_000 = 0.10 USDC)
- Používej ODDĚLENÉ proměnné: requiredSolLamports, requiredUsdcMicro

### ATA (Associated Token Account)
SPL token transfer jde do ATA, ne do wallet. Verifikace musí:
1. Odvodit ATA z (wallet_pubkey, USDC_MINT, TOKEN_PROGRAM_ID)
2. Kontrolovat transfer.destination === derived_ATA
3. Použít @solana/spl-token: getAssociatedTokenAddressSync()

### Anti-replay
- Každý tx_sig ulož do DB (SQLite tabulka used_signatures)
- Před verifikací zkontroluj: SELECT 1 FROM used_signatures WHERE sig = ?
- Pokud existuje → 402 "Payment already used"

### getTransaction
- Vrací null pro nepotvrzené tx → retry s exponential backoff (max 3x)
- Parametry: { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }

## Po každé změně
bash scripts/test-gate.sh
