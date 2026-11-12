# @octap/mcp

Read-only Model Context Protocol (MCP) server for Octap Core loyalty points, transactions, and vouchers.

It translates MCP tool calls from LLM hosts into authorized REST calls via `@octap/node`. It never touches PostgreSQL directly, does not hold Sui private keys, and enforces tenant boundaries through the Core API credential.

## Scope & Security Boundary

> [!IMPORTANT]
> **Audience & Credential Scope:**
> This server runs with an organization-scoped API key (`OCTAP_API_KEY`). In the standalone CLI runner (`octap-mcp`), the LLM can query any member belonging to that organization by providing their `memberId`.
>
> This default setup is intended for **merchant operators, business development (BD), and support agents**.
>
> If you are embedding this adapter into an **end-user / customer-facing assistant** (such as a loyalty chat widget for customers), **do NOT** expose the CLI directly with a shared organization key. Instead, use the programmatic factory `createServer()`:
> 1. Pass a `resolveMemberId(context)` callback that maps the authenticated MCP session to a member ID. It automatically omits `memberId` from the tool parameters exposed to the LLM. Return `undefined` when the session is not authenticated; the request fails closed without calling Core.
> 2. Pass `tools: ['get_member_balance', ...]` to restrict available tools to only safe end-user operations.
> 3. Pass `project` to redact any fields before returning data to the model.

## Configuration

Set the following environment variables:

| Variable | Description | Default |
|---|---|---|
| `OCTAP_API_URL` | Base URL for Octap Core REST API (e.g., `http://127.0.0.1:3000` or staging URL). | *(None; required)* |
| `OCTAP_API_KEY` | Dedicated API credential for the organization with `read` scope. | *(None; required)* |

> [!NOTE]
> The server requires both variables to be explicitly set. It deliberately does not default to `http://localhost:3000` to prevent accidental misconfiguration in staging/production environments.

## Installation & Launch

### 1. Build the package

From the repository root:

```bash
npm install
npm run build
```

### 2. Configure your MCP Host (e.g. Antigravity, Claude Desktop, Cursor)

Add the server to your MCP configuration file (e.g., `mcp_config.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "octap-core": {
      "command": "node",
      "args": ["<path-to-octap-core>/ts-sdks/packages/mcp/dist/cli.js"],
      "env": {
        "OCTAP_API_URL": "http://127.0.0.1:3000",
        "OCTAP_API_KEY": "your_test_organization_api_key"
      }
    }
  }
}
```

> [!WARNING]
> **Do not use `npm run` in host launch commands:**
> Tools like `npm run dev` or `npm run start` write lifecycle banners to `stdout`. Because MCP uses `stdout` for JSON-RPC messages, any extraneous console output will corrupt the protocol stream and cause the MCP client to disconnect. Always launch the compiled script directly with `node` or `npx @octap/mcp` (once published).

## Programmatic Usage

For applications that embed MCP within their own server or session lifecycle:

```typescript
import { coreClient, createServer, type CoreClientLike } from '@octap/mcp';
import type { Transport } from '@modelcontextprotocol/server';

type AuthenticatedSessions = {
  getMemberId(sessionId: string): string | undefined | Promise<string | undefined>;
};

export function createCustomerMcpServer(
  authenticatedSessions: AuthenticatedSessions,
  client: CoreClientLike = coreClient(),
) {
  return createServer({
    client,
    tools: ['get_member_balance', 'list_member_transactions'],
    resolveMemberId: ({ sessionId }) => (sessionId ? authenticatedSessions.getMemberId(sessionId) : undefined),
    project: (toolName, data) => data,
  });
}

export async function connectCustomerMcp(authenticatedSessions: AuthenticatedSessions, transport: Transport) {
  const server = createCustomerMcpServer(authenticatedSessions);
  await server.connect(transport);
  return server;
}
```

The repository's `examples/customer-embed.ts` mirrors this snippet; a protocol test checks that they stay identical and executes the example through an MCP client. `authenticatedSessions` must be the host application's trusted authentication/session store; never take the member ID from MCP tool arguments or model-generated text. The host must ensure that the transport's `sessionId` maps to an authenticated application user. If the host cannot resolve a valid member UUID, the tool returns an error without making a Core API request.

## Available Tools

All tools are strictly read-only:

- **`get_member_balance`**: Returns confirmed and pending point balances, plus the observation checkpoint/time for a member.
- **`list_member_transactions`**: Returns up to 50 recent transactions (default 20), including earn, redeem, adjust, and refund records.
- **`list_member_vouchers`**: Returns up to 50 assigned vouchers (default 20) with campaign details and redemption status. Serial codes and sensitive secrets are omitted.

## Error Handling & Tenant Isolation

- **Non-existent or cross-tenant members**: When looking up a member ID that does not exist or belongs to another organization, Core responds with HTTP 404. The adapter returns `"No matching member or resource was found in the configured organization."` to prevent cross-tenant existence enumeration.
- **LLM-friendly messaging**: Rate limits and temporary failures advise the model not to loop or retry within the same turn.
- **Diagnostics**: Operational events and errors are logged strictly to `stderr`, preserving `stdout` for clean JSON-RPC communication.

## Verification

After `npm run build` from the repository root, run `npm run test:mcp:e2e`. This starts disposable PostgreSQL and Redis containers plus a local Core API, seeds a read-only API key and member, then connects an MCP client to the compiled stdio CLI. It checks all three tools with a valid key, safe permission errors with an invalid key, and eager startup failure when `OCTAP_API_KEY` is missing. Docker is required; the disposable services are stopped when the script exits.
