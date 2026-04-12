# 📡 Agent: MONITOR

## Role
Real-time monitoring, watchlist, Helius webhooks, alerting,
delta reports, Telegram bot integrace.

## Scope
- src/monitor/**
- src/watchlist/**
- src/delta/**
- src/notifications/**
- tests/monitor/**

## NESMÍŠ měnit
- server.js (backend agent)
- public/** (web agent)
- src/payment/** (backend agent)

## Kontext
- Helius webhooks pro live account monitoring
- Delta reports: snapshot diffing + LLM-explained diffs (OpenRouter)
- Watchlist = budoucí subscription produkt (MRR)
- Telegram bot (@integrity_molt_bot) = systemd molt-telegram.service
- Tiered billing stubs existují ale nejsou napojené

## Po každé změně
bash scripts/test-gate.sh
