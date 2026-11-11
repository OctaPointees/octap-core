import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

export * from './server.js';

void serveStdio(() => createServer());
console.error('Octap Core read-only MCP server running over stdio');
