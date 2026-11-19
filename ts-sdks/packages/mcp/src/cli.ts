#!/usr/bin/env node
const USAGE = `Usage:
  octap-mcp                 Start the MCP server over stdio (what your MCP host runs)
  octap-mcp setup           Save the Core API URL and API key to a local config file
  octap-mcp setup --clear   Delete the saved config file
  octap-mcp setup --path    Print where the config file lives
  octap-mcp serve-http      Serve remote MCP over HTTP; users sign in with their console Google account
                            Env: OCTAP_API_URL (Core), OCTAP_MCP_PUBLIC_URL (this server's public URL),
                            OCTAP_MCP_PORT (default 4100), OCTAP_MCP_HOST (default 127.0.0.1)
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
} else if (command === 'serve-http') {
  const { createHttpHandler, listen } = await import('./http.js');
  try {
    const apiUrl = process.env.OCTAP_API_URL?.trim();
    if (!apiUrl) throw new Error('Set OCTAP_API_URL to the Core API URL');
    const port = Number(process.env.OCTAP_MCP_PORT ?? 4100);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('OCTAP_MCP_PORT must be a port number');
    const host = process.env.OCTAP_MCP_HOST?.trim() || '127.0.0.1';
    const publicUrl = process.env.OCTAP_MCP_PUBLIC_URL?.trim() || `http://localhost:${port}`;
    const handler = await createHttpHandler({ apiUrl, publicUrl });
    await listen(handler, port, host);
    console.error(
      `Octap MCP server at ${new URL('/mcp', publicUrl)} (listening on ${host}:${port}), signing in through ${apiUrl}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'MCP HTTP server failed to start');
    process.exit(1);
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
