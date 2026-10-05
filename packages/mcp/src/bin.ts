#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { VERSION } from 'agents-handoff-core';
import { boundaryFrom } from './paths.ts';
import { createServer } from './server.ts';

// stdout is the protocol channel: anything written to it that is not a JSON-RPC message
// corrupts the stream. Diagnostics go to stderr, which clients surface as server logs.
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `agents-handoff-mcp ${VERSION} — the Agents Handoff MCP server, over stdio.\n` +
      'Started by an MCP client, not by hand: see https://github.com/Ryujin-Labs/agents-handoff/blob/main/docs/mcp.md\n' +
      'Options: --root <dir>  refuse to work outside this directory.\n',
  );
  process.exit(0);
}
// Run by hand in a terminal it would sit silently waiting for JSON-RPC; say so.
if (process.stdin.isTTY) {
  process.stderr.write(`agents-handoff-mcp ${VERSION}: waiting for an MCP client on stdio (Ctrl-C to quit).\n`);
}

const boundary = boundaryFrom(argv);
const server = createServer(boundary);
await server.connect(new StdioServerTransport());
