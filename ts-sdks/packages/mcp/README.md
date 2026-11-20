# @octap/mcp

Read-only Model Context Protocol (MCP) server for Octap Core loyalty points, transactions, and vouchers.

It translates MCP tool calls from LLM hosts into authorized REST calls via `@octap/sdk`. It never touches PostgreSQL directly, does not hold Sui private keys, and enforces tenant boundaries through the Core API credential.

## Scope & Security Boundary

> [!IMPORTANT]
> **Audience & Credential Scope:**
> This server runs with an organization-scoped API key (`OCTAP_API_KEY`, or the key saved by `octap-mcp setup`). In the standalone CLI runner (`octap-mcp`), the LLM can query any member belonging to that organization by providing their `memberId`.
>
> This default setup is intended for **merchant operators, business development (BD), and support agents**.
>
> If you are embedding this adapter into an **end-user / customer-facing assistant** (such as a loyalty chat widget for customers), **do NOT** expose the CLI directly with a shared organization key. Instead, use the programmatic factory `createServer()`:
> 1. Pass a `resolveMemberId(context)` callback that maps the validated request's `http.authInfo` to a member ID. It automatically omits `memberId` from the tool parameters exposed to the LLM. Return `undefined` when validated auth info is absent or cannot be mapped; the request fails closed without calling Core. Never treat the MCP session ID as authentication.
> 2. Pass `tools: ['get_member_balance', ...]` to restrict available tools to only safe end-user operations.
> 3. Pass `project` to redact any fields before returning data to the model.

## Configuration

The server needs two settings. It takes each one from an environment variable first, and otherwise from a saved config file.

| Setting | Env var | Description |
|---|---|---|
| API URL | `OCTAP_API_URL` | Base URL of the Octap Core REST API, e.g. `http://127.0.0.1:3000` for a local dev server. No default. |
| API key | `OCTAP_API_KEY` | Organization API credential with `read` scope. |

If neither source provides a value, the server refuses to start and prints which setting is missing.

### Save the settings once with `octap-mcp setup`

An MCP host talks to this server over stdio, and stdout carries the JSON-RPC stream, so the server can't ask you for anything itself. Run setup once in a normal terminal, outside the host:

```bash
npx -y @octap/mcp setup
# or, from a checkout after building: node ts-sdks/packages/mcp/dist/cli.js setup
```

It asks for the API URL (press Enter to accept the default shown, `http://127.0.0.1:3000` the first time) and the API key (input hidden; when a key is already saved, Enter keeps it). Run it again whenever you want to point at a different server.

**Where the key is stored:** `~/.octap/mcp.json` (on Windows `%USERPROFILE%.octapmcp.json`). The file is plain JSON, written with owner-only permissions (`0600`) on macOS/Linux; on Windows it is protected by your user profile's permissions. Set `OCTAP_MCP_CONFIG_PATH` to use another location. `octap-mcp setup --path` prints the location in use.

**Revoking local access:** `octap-mcp setup --clear` (or deleting the file). The next time the host starts the server, it exits with `OCTAP_API_KEY is required` and no tools are available. This only removes the local copy; revoke the key itself in the Octap Console if it may have leaked.

## Installation & Launch

### Configure your MCP Host (e.g. Claude Desktop, Cursor, Antigravity)

After `octap-mcp setup`, the host entry needs no env vars:

```json
{
  "mcpServers": {
    "octap": {
      "command": "npx",
      "args": ["-y", "@octap/mcp"]
    }
  }
}
```

From a local checkout, build it first (`npm install && npm run build` at the repository root) and use `"command": "node"`, `"args": ["<path-to-octap-core>/ts-sdks/packages/mcp/dist/cli.js"]` instead.

You can still pass the settings through the host instead of the file, or override just one of them (env vars win per setting):

```json
"env": {
  "OCTAP_API_URL": "http://127.0.0.1:3000",
  "OCTAP_API_KEY": "your_test_organization_api_key"
}
```

On startup the server logs to stderr which URL it is using and whether each setting came from the environment or the config file.

> [!WARNING]
> **Do not use `npm run` in host launch commands:**
> Tools like `npm run dev` or `npm run start` write lifecycle banners to `stdout`. Because MCP uses `stdout` for JSON-RPC messages, any extraneous console output will corrupt the protocol stream and cause the MCP client to disconnect. Launch the compiled script directly with `node`, or use `npx -y @octap/mcp`.

## Remote server with console sign-in (`serve-http`)

Instead of an API key, people can sign in with the Google account they use on the OctaP Console.
Each sign-in is bound to one organization and the user's persona there, and lasts one hour. All
tools stay read-only, and Core refuses the token once the user's access changes.

```bash
OCTAP_API_URL=https://api.octap.example OCTAP_MCP_PUBLIC_URL=https://mcp.octap.example OCTAP_MCP_PORT=4100 npx -y @octap/mcp serve-http
```

Point the host at `<OCTAP_MCP_PUBLIC_URL>/mcp` as a remote (Streamable HTTP) server. It discovers
Core's sign-in from the 401 challenge, registers itself, and opens the sign-in page in a browser.
Core must have `MCP_OAUTH_ISSUER_URL` and `MCP_OAUTH_SIGNING_KEY` set, and its origin must be an
authorized JavaScript origin of the console's Google client.

Locally: run Core on `http://localhost:3000` with `MCP_OAUTH_ISSUER_URL=http://localhost:3000`, then
`OCTAP_API_URL=http://localhost:3000 octap-mcp serve-http` and connect MCP Inspector to
`http://localhost:4100/mcp`.

## Programmatic Usage

For applications that embed MCP within their own server or session lifecycle:

```typescript
import { createServer, type CoreClientLike } from '@octap/mcp';
import type { ServerContext, Transport } from '@modelcontextprotocol/server';

type AuthenticatedSessions = {
  getMemberId(
    authInfo: NonNullable<ServerContext['http']>['authInfo'],
  ): string | undefined | Promise<string | undefined>;
};

export function createCustomerMcpServer(authenticatedSessions: AuthenticatedSessions, client?: CoreClientLike) {
  return createServer({
    ...(client ? { client } : {}),
    tools: ['get_member_balance', 'list_member_transactions'],
    resolveMemberId: ({ http }) => (http?.authInfo ? authenticatedSessions.getMemberId(http.authInfo) : undefined),
    project: (toolName, data) => data,
  });
}

export async function connectCustomerMcp(authenticatedSessions: AuthenticatedSessions, transport: Transport) {
  const server = createCustomerMcpServer(authenticatedSessions);
  await server.connect(transport);
  return server;
}
```

The repository's `examples/customer-embed.ts` mirrors this snippet; a protocol test checks that they stay identical and executes the example through an MCP client. The host's configured token verifier must populate `http.authInfo`; `authenticatedSessions` maps that validated request identity to the member. Never use the MCP session ID or model-supplied arguments as authentication. If validated auth info is absent or cannot resolve a valid member UUID, the tool returns an error without making a Core API request.

## Available Tools

All tools are strictly read-only:

- **`get_member_balance`**: Returns confirmed and pending point balances, plus the observation checkpoint/time for a member.
- **`list_member_transactions`**: Returns up to 50 recent transactions (default 20), including earn, redeem, adjust, and refund records.
- **`list_member_vouchers`**: Returns up to 50 assigned vouchers (default 20) with voucher titles and redemption status. Serial codes and sensitive secrets are omitted.

## Error Handling & Tenant Isolation

- **Non-existent or cross-tenant members**: When looking up a member ID that does not exist or belongs to another organization, Core responds with HTTP 404. The adapter returns `"No matching member or resource was found in the configured organization."` to prevent cross-tenant existence enumeration.
- **LLM-friendly messaging**: Rate limits and temporary failures advise the model not to loop or retry within the same turn.
- **Diagnostics**: Operational events and errors are logged strictly to `stderr`, preserving `stdout` for clean JSON-RPC communication.

## Verification

After `npm run build` from the repository root, run `npm run test:mcp:e2e`. This starts disposable PostgreSQL and Redis containers plus a local Core API, seeds two organizations and members plus a read-only API key for one organization, then connects an MCP client to the compiled stdio CLI. It checks all three tools with a valid key, generic 404 responses for cross-tenant reads, safe permission errors with an invalid key, and eager startup failure when `OCTAP_API_KEY` is missing. Docker is required; the disposable services are stopped when the script exits.
