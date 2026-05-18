# Changelog

All notable changes to the integrity-molt MCP server will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.1.1] - 2026-05-18

### Changed
- `verify_signed_receipt` tool description now mentions `receipt` object from token_audit Metaplex agent responses
- `verify_signed_receipt` inputSchema: envelope description updated to reference token_audit receipt field
- Metaplex agent wrapped receipt verification test coverage added

### Note
`verifier.js` unchanged — wrapped format was already supported.

---

## [0.1.0] — 2026-05-14

Initial pre-publish release. Wraps the 5 free integrity.molt skills as MCP tools.

### Tools

- `scan_solana_address` — IRIS risk scan with Ed25519-signed receipt
- `quick_scan` — Lightweight risk scan, no receipt
- `verify_signed_receipt` — Local Ed25519 receipt verification (default) or remote
- `get_new_spl_tokens` — Feed of new SPL token mints (last 24h)
- `check_program_verification` — OtterSec bytecode verification status

### Security

- Ed25519 local verification at MCP boundary (ADR-012) — trust anchor is the key, not the URL
- `verify_signed_receipt` uses local verification by default (opt-out: `INTEGRITY_MOLT_LOCAL_VERIFY=0`)
- Custom `INTEGRITY_MOLT_BASE_URL` always forces local verification (circular trust prevention)
- Concurrency semaphore (max 4 in-flight) prevents memory exhaustion from LLM loops
- Output wrapped in `<oracle_output trust="data">` delimiters to prevent prompt injection
- Control character sanitization on all oracle output
- `BASE_URL` frozen at module-load time (TOCTOU prevention)
- Prototype pollution guard (`__proto__`, `constructor`, `prototype` stripped from payload)
- `key_id` set to `null` on all error responses (no attacker-controlled value leakage)
- `mathematically_valid` hidden when `key_pinned: false`

### Changes from internal phases

- Phase 1 (P1): H5 opt-out default, M4 BASE_URL freeze, M5 prototype guard, M6 key_id null, M7 hide math_valid, M8 semaphore text, M9 exact SDK pin
- Phase 2 (P2): package.json metadata, privacy links in descriptions, oracle_output wrapper, schema additionalProperties:false, destructiveHint:false

[0.1.0]: https://github.com/Hans1132/integrity.molt/tree/main/mcp
