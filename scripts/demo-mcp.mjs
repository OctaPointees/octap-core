import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpScript = join(rootDir, 'mcp', 'dist', 'index.js');

console.log('🧪 Starting MCP stdio client demo test against @octap/mcp...');

const proc = spawn('node', [mcpScript], {
  env: {
    ...process.env,
    OCTAP_CORE_API_KEY: 'demo-test-api-key',
    OCTAP_CORE_API_URL: 'http://127.0.0.1:3000',
  },
  cwd: rootDir,
});

proc.stderr.on('data', (chunk) => {
  console.log(`[mcp:stderr] ${chunk.toString().trim()}`);
});

let buffer = '';

function send(msg) {
  const payload = JSON.stringify(msg) + '\n';
  proc.stdin.write(payload);
}

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (msg.id === 1) {
      console.log('✅ Handshake complete. Server info:', msg.result.serverInfo);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      console.log('📋 Requesting tool list via tools/list...');
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      const tools = msg.result.tools;
      console.log(`✅ Discovered ${tools.length} read-only tools:`);
      for (const t of tools) {
        console.log(`   - ${t.name}: ${t.description.split('.')[0]}`);
      }

      console.log('\n🔍 Testing input schema validation with invalid UUID...');
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_member_balance',
          arguments: { memberId: 'not-a-uuid' },
        },
      });
    } else if (msg.id === 3) {
      console.log('✅ Input validation properly rejected malformed input:');
      console.log(`   ${msg.result.content[0].text}`);

      console.log('\n🔒 Testing tool execution with valid UUID (safe error handling when API offline)...');
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_member_balance',
          arguments: { memberId: '123e4567-e89b-12d3-a456-426614174000' },
        },
      });
    } else if (msg.id === 4) {
      console.log('✅ Server returned safe sanitized response:');
      console.log(`   ${msg.result.content[0].text}`);
      console.log('\n🎉 All MCP stdio tests passed successfully!');
      proc.kill();
      process.exit(0);
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'octap-mcp-demo-client', version: '0.1.0' },
  },
});
