#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer, coreClient } from './server.js';

// Eagerly initialize and validate the Core API client and environment variables at startup
const client = coreClient();
void serveStdio(() => createServer({ client }));
console.error('Octap MCP server running over stdio');
