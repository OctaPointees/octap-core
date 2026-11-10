# Octap Core read-only MCP adapter

This local stdio server exposes read-only member balance, transaction-history and voucher tools. It calls the existing Octap Core REST API using the Node SDK; it does not access Postgres or accept a tenant ID. The API credential pins the organization and must have only the `read` scope.

This is a developer/staging pilot. It is not configured for remote multi-user access or production customer data.

## Configure

Copy `.env.example` to `.env` and set:

- `OCTAP_CORE_API_URL`: Core API base URL.
- `OCTAP_CORE_API_KEY`: a dedicated, read-only API credential for one test organization.

Do not commit `.env` or pass the credential as a tool argument. The server reads it from the process environment.

## Build and launch

From the Core repository root:

```sh
npm install
npm run build
npm run dev --workspace @octap/mcp
```

`dev` speaks MCP over stdin/stdout and waits for an MCP host. Diagnostics go to stderr. Configure an MCP host to run `npm run dev --workspace @octap/mcp` from the repository root. Use test member IDs only.

## Tools

- `get_member_balance(memberId)` returns confirmed/pending totals and the observation checkpoint/time.
- `list_member_transactions(memberId, limit?)` returns at most 50 recent transaction summaries (default 20).
- `list_member_vouchers(memberId, limit?)` returns at most 50 voucher statuses (default 20); serial codes are omitted.

Every tool is read-only. Core remains responsible for authentication, read-scope checks and tenant membership checks.
