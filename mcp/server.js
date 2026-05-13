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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const base = process.env.INTEGRITY_MOLT_BASE_URL || 'http://127.0.0.1:3402';
  console.error(`[integrity-molt MCP] ready — backend: ${base}`);
}

main().catch(err => {
  console.error('[integrity-molt MCP] fatal:', err.message);
  process.exit(1);
});
