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

- integrity.molt backend running on `127.0.0.1:3402` (the `integrity-x402.service` systemd unit)
- Node.js ≥ 18

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
      "args": ["/root/x402-server/mcp/server.js"],
      "env": {
        "INTEGRITY_MOLT_BASE_URL": "http://127.0.0.1:3402"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The 5 tools will appear in the tool picker.

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
| `INTEGRITY_MOLT_BASE_URL` | `http://127.0.0.1:3402` | URL of the integrity.molt backend |

## Paid skills

Paid skills (`token_audit`, `wallet_profile`, `deep_audit`, `adversarial_sim`, `agent_token_scan`, `governance_change`) are available via the A2A protocol with x402 USDC payment. See [intmolt.org](https://intmolt.org) for details.
