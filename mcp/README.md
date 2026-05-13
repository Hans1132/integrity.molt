# integrity-molt MCP Server

Solana security oracle as MCP tools for Claude Desktop. Wraps 5 free skills from [integrity.molt](https://intmolt.org) — no API key required.

| Tool | What it does |
|------|-------------|
| `scan_solana_address` | IRIS risk scan + Ed25519-signed receipt (iris_score, risk_level, risk_factors) |
| `quick_scan` | Lightweight risk scan, no signed receipt, faster |
| `verify_signed_receipt` | Verify authenticity of an Ed25519-signed oracle receipt |
| `get_new_spl_tokens` | Feed of new SPL token mints (last 24h) |
| `check_program_verification` | OtterSec bytecode verification status for a program |

## Prerequisites

- Node.js ≥ 18
- Internet connection (calls `https://intmolt.org` by default — no local backend needed)

## Install

```bash
cd /path/to/x402-server/mcp
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
      "command": "node",
      "args": ["/path/to/x402-server/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop after saving. The 5 tools will appear in the tool picker.

## Codex CLI configuration

```json
{
  "mcpServers": {
    "integrity-molt": {
      "command": "node",
      "args": ["/path/to/x402-server/mcp/server.js"],
      "type": "stdio"
    }
  }
}
```

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

## Paid skills

Paid skills (`token_audit`, `wallet_profile`, `deep_audit`, `adversarial_sim`, `agent_token_scan`, `governance_change`) are available via the A2A protocol with x402 USDC payment. See [intmolt.org](https://intmolt.org) for details.
