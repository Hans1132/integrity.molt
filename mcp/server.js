#!/usr/bin/env node
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, handleTool } = require('./lib/tools');

const server = new Server(
  { name: 'integrity-molt', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleTool(name, args || {});
});

async function main() {
  // Validate backend URL at startup — fail fast instead of silently failing on each call.
  const raw = process.env.INTEGRITY_MOLT_BASE_URL || 'https://intmolt.org';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.error(`[integrity-molt MCP] fatal: INTEGRITY_MOLT_BASE_URL "${raw}" is not a valid URL`);
    process.exit(1);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    console.error(`[integrity-molt MCP] fatal: INTEGRITY_MOLT_BASE_URL scheme must be http or https`);
    process.exit(1);
  }
  const base = `${parsed.protocol}//${parsed.host}`;
  if (base !== 'https://intmolt.org') {
    console.error(`[integrity-molt MCP] WARNING: non-default backend in use: ${base}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit cleanly when host closes stdin (e.g. Claude Desktop restarts).
  process.stdin.on('close', () => process.exit(0));

  console.error(`[integrity-molt MCP] ready — backend: ${base}`);
}

main().catch(err => {
  console.error('[integrity-molt MCP] fatal:', err?.message || String(err));
  process.exit(1);
});
