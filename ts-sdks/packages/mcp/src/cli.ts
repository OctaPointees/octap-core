#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer, coreClient } from './server.js';

try {
  // Eagerly initialize and validate configuration before opening the stdio protocol stream.
  const client = coreClient();
  void serveStdio(() => createServer({ client }));
  console.error('Octap MCP server running over stdio');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP server failed to start');
  process.exit(1);
}
