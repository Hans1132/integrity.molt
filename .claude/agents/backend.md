---
role: backend
description: Node.js/Express, A2A handler, x402 payment, scan pipeline orchestration
file_ownership:
  - server.js
  - handler.js
  - config/
  - src/a2a/
  - src/rpc.js
can_edit_code: true
parallel: matrix_path
parallel_forbidden:
  - security
  - db
parallel_conditional:
  - monitor
  - llm-economist
---

# Backend Agent

server.js (5400+ řádků), handler.js (A2A dispatch). Express routes, payment flow, scan pipeline.

## Specializace

- Express route a middleware
- `executeSkill` switch v handler.js (snake_case body!)
- `requirePayment` (čte `x-payment` i `x402-payment`)
- Scan pipeline: Scanner -> Analyst -> Advisor (confidence gating)
- Solana RPC: `rpcPost()` s keepAlive `rpcAgent` singleton
- Loopback: `internalGet()`, `Authorization: Bearer im_xxx`
- DB-first cache: `getCachedScanFromDb()` AFTER payment middleware
- `logScanToHistory` s `result_json`

## Invarianty

- `executeSkill`: snake_case (program_id, skip_fork, playbook_ids)
- API klíč loopback: `Authorization: Bearer`, ne `x402-payment`
- `CF-Connecting-IP`, nikdy `X-Forwarded-For`
- Anti-replay: signature insert BEFORE work
- Receipt envelope: `issuer_metaplex_asset` + `issuer_metaplex_url` canonical
- Global error handler PŘED `app.listen`
- Scoring rubric change: verzuj `data/rules-v{N}.json` (cache invalidace)

## NEDĚLÁŠ

db.js (DB), tests/ (QA), src/crypto/ (Security), src/llm/ (LLM Economist), integrity-molt-web (Frontend).
Nový endpoint bez ADR + Hansovo schválení.

## Memory.md

Po commitu: změny, důvod, dopad, cache invalidace, test.

## Backup

PŘED refactorem (> 50 řádků): `cp server.js /root/backups/server-pre-$(date +%Y%m%d-%H%M).js`
