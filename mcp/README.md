# integrity-molt MCP Server

Solana security oracle as MCP tools for Claude Desktop and Codex CLI. Wraps 5 free skills from [integrity.molt](https://intmolt.org) — no API key required.

| Tool | What it does |
|------|-------------|
| `scan_solana_address` | IRIS risk scan + Ed25519-signed receipt (iris_score, risk_level, risk_factors) |
| `quick_scan` | Lightweight risk scan, no signed receipt, faster |
| `verify_signed_receipt` | Verify authenticity of an Ed25519-signed oracle receipt |
| `get_new_spl_tokens` | Feed of new SPL token mints (last 24h) |
| `check_program_verification` | OtterSec bytecode verification status for a program |

## Quick install

```bash
git clone https://github.com/Hans1132/integrity.molt.git
cd integrity.molt/mcp
npm install
node server.js   # verify it starts (stderr: "[integrity-molt MCP] ready")
```

Then configure Claude Desktop or Codex CLI as shown below.

## Prerequisites

- Node.js ≥ 18
- Internet connection (calls `https://intmolt.org` by default — no local backend needed)

## Install

```bash
cd /path/to/integrity.molt/mcp
npm install
```

## Claude Desktop configuration

Add to your Claude Desktop config file:

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "integrity-molt": {
      "command": "/path/to/node",
      "args": ["/path/to/integrity.molt/mcp/server.js"]
    }
  }
}
```

> **Important — use the full path to `node`.** Claude Desktop launches with a minimal `PATH` that often skips nvm and Homebrew. Find yours:
> ```bash
> which node   # e.g. /opt/homebrew/bin/node or /Users/you/.nvm/versions/node/v22.x.x/bin/node
> ```
> Paste that full path as `"command"`. Using just `"node"` causes "command not found" or picks up a system Node < 18 (no built-in `fetch`).

Restart Claude Desktop after saving. The 5 tools will appear in the tool picker.

## Codex CLI configuration

Codex runs from the terminal and inherits your shell `PATH`, so `node` usually works as-is. If you use nvm, run from a shell where `node --version` returns ≥ 18.

Config file: `~/.codex/config.yaml`

```yaml
mcpServers:
  integrity-molt:
    command: node
    args:
      - /path/to/integrity.molt/mcp/server.js
    type: stdio
```

## Claude Code configuration

Claude Code is also terminal-based — `PATH` is inherited. Add the server once:

```bash
claude mcp add integrity-molt -- node /path/to/integrity.molt/mcp/server.js
```

Or with a full node path if needed:

```bash
claude mcp add integrity-molt -- /opt/homebrew/bin/node /path/to/integrity.molt/mcp/server.js
```

## Cursor / Windsurf / other GUI editors

GUI editors (Cursor, Windsurf, VS Code extensions) launch with a minimal `PATH`, same as Claude Desktop. Use the full node path in the MCP config:

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "integrity-molt": {
      "command": "/path/to/node",
      "args": ["/path/to/integrity.molt/mcp/server.js"]
    }
  }
}
```

For any other MCP client: if `node` can't be found or `fetch` fails, replace `"node"` with the full path from `which node`.

## Manual test (stdio pipe)

Verify the server responds correctly before configuring Claude Desktop:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node server.js 2>/dev/null | jq .result.tools[].name
```

Expected output (5 tool names):

```
"scan_solana_address"
"verify_signed_receipt"
"get_new_spl_tokens"
"quick_scan"
"check_program_verification"
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INTEGRITY_MOLT_BASE_URL` | `https://intmolt.org` | URL of the integrity.molt backend. Override to `http://127.0.0.1:3402` only when running on the VPS itself. |
| `INTEGRITY_MOLT_LOCAL_VERIFY` | *(opt-out via `0`)* | Set to `0` to disable local Ed25519 verification for `verify_signed_receipt` and use the remote endpoint instead. Any custom `INTEGRITY_MOLT_BASE_URL` always forces local verification regardless of this flag. |

## Privacy & Data

**What is sent to intmolt.org**: Solana addresses only — no wallet private keys, no personal information, no transaction signing.

**Data retention**: Request logs are retained for rate limiting and abuse prevention. See the [Privacy Policy](https://intmolt.org/privacy) for full details.

**verify_signed_receipt**: By default this tool verifies receipts **locally** using a pinned Ed25519 public key — no data is sent to any server. Set `INTEGRITY_MOLT_LOCAL_VERIFY=0` to use the remote endpoint instead.

**Not financial advice**: IRIS scores are informational risk indicators. They do not constitute investment advice or a guarantee of safety.

**Legal**: See the [Privacy Policy](https://intmolt.org/privacy) for data handling details and the [Terms of Service](https://intmolt.org/terms) for usage terms, payment policy, and advisory disclaimer.
## Verification & Security

All scan results from `scan_solana_address` include an Ed25519-signed receipt:

```
kid:  integrity-molt-primary-2026
x:    qzppeeRmbyQ4hE4BYOW-4VbQ5muyplTP4GP4uxIhVwY  (base64url, Ed25519)
src:  https://intmolt.org/.well-known/jwks.json
```

The `verify_signed_receipt` tool checks this receipt locally using the pinned public key. No round-trip to the oracle is required — the trust anchor is the key, not the URL.

**Metaplex agent token_audit receipts** use a wrapped format — pass the nested `receipt` object from the `token_audit` response (not the full response):

```json
{
  "payload": {
    "subject_type": "metaplex_agent",
    "subject_metaplex_asset": "<Core Asset address>",
    "subject_metaplex_risk": "safe|caution|danger",
    "subject_metaplex_score": 82,
    "subject_metaplex_uri": "https://www.metaplex.com/agents/...",
    "issuer": "integrity.molt",
    "issuer_kid": "integrity-molt-primary-2026"
  },
  "signature": "<base64 Ed25519 sig>",
  "verify_key": "<base64 raw 32-byte public key>",
  "key_id": "...",
  "signed_at": "...",
  "signer": "integrity.molt",
  "algorithm": "Ed25519"
}
```

Receipt format: [ADR-012 — Ed25519 Local Verification at MCP Boundary](docs/adr-012-mcp-local-verify.md)

## Troubleshooting

**Tools not showing in Claude Desktop**: Restart Claude Desktop after editing the config file. Check for JSON syntax errors in the config.

**`Error: fetch is not a function` / `ReferenceError: fetch is not defined`**: The `node` in your config is older than v18. Built-in `fetch` requires Node ≥ 18. Verify: `node --version`. Then use the full path (`which node`) to your ≥18 binary in the config.

**`spawn node ENOENT` or server doesn't start**: Claude Desktop can't find `node`. Use the absolute path returned by `which node` in your terminal (e.g. `/opt/homebrew/bin/node`).

**`[integrity-molt MCP] fatal: INTEGRITY_MOLT_BASE_URL "..." is not a valid URL`**: The env var is set to a malformed URL. Unset it to use the default (`https://intmolt.org`).

**`Error: backend error (HTTP 429)`**: Rate limit hit. Wait a minute and retry. Free tier is limited to protect the oracle.

**`Error: backend error (HTTP 5xx)`**: Transient backend error. Retry in a few seconds. Check [intmolt.org](https://intmolt.org) if the problem persists.

**`verified_locally: false` in verify_signed_receipt**: The receipt's `verify_key` does not match the pinned key. The receipt may have been issued by a different oracle instance or tampered with.

## Contributing

This is an open MCP wrapper around the free tier of [integrity.molt](https://intmolt.org). Bug reports and suggestions welcome at [GitHub Issues](https://github.com/Hans1132/integrity.molt/issues).

## Paid skills

Paid skills (`token_audit`, `wallet_profile`, `deep_audit`, `adversarial_sim`, `agent_token_scan`, `governance_change`) are available via the A2A protocol with x402 USDC payment. See [intmolt.org](https://intmolt.org) for details.
