#!/usr/bin/env node
const USAGE = `Usage:
  octap-mcp                 Start the MCP server over stdio (what your MCP host runs)
  octap-mcp setup           Save the Core API URL and API key to a local config file
  octap-mcp setup --clear   Delete the saved config file
  octap-mcp setup --path    Print where the config file lives
`;

const [command, ...args] = process.argv.slice(2);

if (command === 'setup') {
  // Loaded lazily so the stdio server never pulls in terminal prompt code.
  const { runSetup, SetupAbortedError } = await import('./setup.js');
  try {
    await runSetup(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Setup failed');
    process.exit(error instanceof SetupAbortedError ? 130 : 1);
  }
} else if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(USAGE);
} else if (command !== undefined) {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  process.exit(2);
} else {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const { OctaPointClient } = await import('@octap/sdk');
  const { createServer } = await import('./server.js');
  const { resolveCoreConfig } = await import('./config.js');
  try {
    // Eagerly initialize and validate configuration before opening the stdio protocol stream.
    const config = resolveCoreConfig();
    const client = new OctaPointClient({ baseUrl: config.apiUrl, credentials: { apiKey: config.apiKey } });
    void serveStdio(() => createServer({ client }));
    const from = (source: 'env' | 'file') => (source === 'env' ? 'environment' : config.configFile);
    const origin =
      config.source.apiUrl === config.source.apiKey
        ? `URL and key from ${from(config.source.apiKey)}`
        : `URL from ${from(config.source.apiUrl)}, key from ${from(config.source.apiKey)}`;
    console.error(`Octap MCP server running over stdio against ${config.apiUrl} (${origin})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'MCP server failed to start');
    process.exit(1);
  }
}
