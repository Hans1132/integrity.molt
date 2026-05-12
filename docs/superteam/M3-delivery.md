# M3 Delivery Proof — Superteam Agentic Engineering Grant

**Project:** integrity.molt
**URL:** https://intmolt.org
**Milestone:** M3 — Webhook callback tested end-to-end with external agent
**Deadline:** May 31, 2026
**Delivered:** 2026-05-12

---

## What was built

`postCallback(taskId, callbackUrl, result)` in `src/a2a/handler.js`:
- POST to `callbackUrl` after `tasks/send` completes (success or failure)
- 5 s timeout, 1 automatic retry on network error
- Accepts `callbackUrl` at top-level or inside `metadata`
- SSRF deny-list: blocks localhost, private RFC-1918 ranges, cloud metadata endpoints (169.254.x.x)

## End-to-end test

File: `tests/a2a-handler.test.js`
Test name: `tasks/send webhook callback — receiver gets correct payload within 2s`

Steps the test performs:
1. Spustí HTTP server na portu 13403 jako callback receiver
2. Zavolá `POST /a2a` s `method=tasks/send` a `callbackUrl=http://127.0.0.1:13403/cb`
3. Čeká max 2 000 ms na příchozí POST
4. Ověří payload: `taskId` odpovídá, `status.state === "completed"`, `artifacts` je Array

## Evidence

- Commit: e498ccc (2026-05-12, branch main)
- Test gate: 11/11 suites PASS (`scripts/test-gate.sh`)
- Live endpoint: `https://intmolt.org/a2a` — POST JSON-RPC 2.0, method `tasks/send`
- SSRF protection: `validateCallbackUrl()` blokuje private adresy v produkci; bypass jen při `NODE_ENV=test`

## All milestones

| Milestone | Deliverable | Status |
|-----------|-------------|--------|
| M1 | SQLite task store — tasks survive restart | ✅ 2026-05-10 |
| M2 | SSE streaming live, `tasks/sendSubscribe` | ✅ 2026-05-10 |
| M3 | Webhook callback e2e with external agent | ✅ 2026-05-12 |
