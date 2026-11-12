# Octap MCP: purpose, first use case, and proposed work

**Status:** Local/staging read-only pilot  
**Scope:** Initial implementation of read tools only. This document does not approve production MCP access.

## What MCP would do for Octap

The Model Context Protocol (MCP) gives an AI application a standard way to discover and call tools exposed by a server. For Octap, that server could translate a user's request into a narrow, validated call to an existing Core API. MCP does not supply Octap permissions or business rules: Core must still authenticate the caller, authorize the tenant and operation, and enforce the same limits as the portal and SDKs.

```mermaid
flowchart LR
  U[Merchant staff or developer] --> H[AI host and MCP client]
  H --> M[Octap MCP adapter]
  M --> A[Authorized Core API or SDK]
  A --> C[Core auth, domain rules and data]
```

The model can suggest a tool call; the adapter validates its inputs and Core decides whether the caller is allowed to perform it. A model-supplied tenant ID is never proof of tenant access.

## What exists today

- **Octap Core:** REST APIs and Node/browser SDKs for credits, vouchers, identity and related workflows. The roadmap marks campaigns as planned, not implemented.
- **MCP POC (OCT-144):** A completed NestJS learning/example POC documented in Linear. It demonstrates generic product-catalog tools and resources, including a mock `ProductService`; it is not connected to Octap Core and is not production loyalty functionality.
- **Product direction:** Existing design documents describe an AI-drafted campaign that is previewed, approved by a different authorized member, then executed against the exact approved manifest and budget. That workflow remains proposed until Core campaign services and authorization are implemented.

## Candidate use cases

| Candidate | User need and benefit | Data/actions and API readiness | Main constraints |
|---|---|---|---|
| **Member support lookup** | Merchant operators, BD and support staff need to answer “did this earn land?” or “what is this member's current voucher status?” without manually joining several screens. | Read a member's balance, recent transactions and vouchers through the merchant's shared organization API key. | The key grants organization-wide access. Hosts must protect it and restrict who can use the MCP server. Any end-user assistant must bind the validated request identity to a member and restrict tools itself; a shared organization key alone is not per-customer authentication. |
| **Owner operations summary** | An owner wants a concise view of recent activity, pending operations and program budget warnings. | Aggregate existing transaction/balance and budget information. Some source reads exist; a safe, bounded summary endpoint may be needed to avoid many calls and to define what staff may see. | Keep summaries tenant-scoped and time-bounded. Do not expose signer material or internal database records. |
| **Campaign draft and preview** | A marketing manager wants to describe a promotion in natural language and see its audience and estimated cost before approval. | Create a draft and deterministic preview; later, a different authorized member approves a content-bound manifest; execution references that approval. Campaign APIs and the campaign domain are not implemented yet. | The AI must not approve its own draft, change the approved manifest, exceed budget, issue arbitrary points or bypass campaign limits. Execution is a later phase, never a raw `mint_points` tool. |
| **Developer integration help** | A developer wants examples or help interpreting SDK/API errors. | Search published API/SDK documentation and return relevant examples. Existing docs and SDKs provide a source; this could be a documentation-only MCP capability. | It must distinguish published facts from suggestions and must not imply access to a merchant's live tenant data. For basic lookups, the docs site may already be simpler. |

## Recommendation

Start with **read-only member support lookup in a local/staging pilot**. It has a concrete Octap business problem and uses Core reads that already exist. The CLI uses the merchant's shared organization API key; customer data remains tenant-scoped by Core. It avoids introducing point-changing behavior.

Keep the first tool set narrow: get one member's balance, list that member's recent transactions, and list that member's vouchers. Only add transaction failure diagnostics after Core has a supported endpoint for the specific fields. Compare the result with the existing portal/API flow to show whether the assistant reduces time to answer a support question without leaking another tenant's data.

Campaign drafting and preview remain the stronger strategic extension, but depend on the planned campaign module, deterministic previews, immutable approval manifests and a second-person approval workflow. They should follow only after those Core capabilities exist and are tested without an AI client.

## Location and boundaries

The adapter lives in **`ts-sdks/packages/mcp`** (`@octap/mcp`) in `octap-core`, and runs/deploys as its own process. Its dependencies, configuration and startup command remain isolated from the NestJS API and workers. It calls Core through the authorized API/SDK boundary (`@octap/sdk`); it does not import domain or infrastructure internals, access PostgreSQL directly, or contain its own source of truth.

For this staging/developer pilot, stdio is the connection mechanism. The pilot is scoped to **merchant operators, business development (BD), and support staff** operating under an organization-level API credential. That credential grants organization-wide access. Do not embed it in end-user systems unless the host binds each validated HTTP request identity to a member with `resolveMemberId` and restricts the exposed tools. A shared remote server requires a token verification/delegation design and caller-level audit logging before deployment.

## Security and consent rules

- Derive tenant, user and role from verified server-side credentials, never from model-generated arguments.
- Keep merchant/API credentials on the server side, scoped to the minimum Core reads required; never return credentials or signer keys to the model.
- Treat tool input, retrieved member data and user-provided content as untrusted. Validate inputs and restrict lookup scope.
- For this local stdio pilot, log tool names and outcomes to stderr without member IDs or secrets. Centralized durable audit logging and caller attribution are deferred to a later remote deployment ticket.
- The first pilot is strictly read-only. Any later write tool must create a bounded draft and record an audit trail; an authorized human must approve the exact action before execution.
- MCP cannot spend a customer's points on their behalf. Customer redemption and voucher use continue to require the customer's own signature.

## Decision and prerequisites

**Location decision:** keep this plan in `docs/` and co-locate the isolated adapter at `ts-sdks/packages/mcp` (`@octap/mcp`) in this repository. The adapter is a developer/staging pilot only and is not approved for production.

## Implementation status and work breakdown

### Implemented in pilot (OCT-286)

1. **Package structure:** Co-located in `ts-sdks/packages/mcp` (`@octap/mcp`) as a private TypeScript package with clean separation between library (`.` -> `./dist/index.js`) and CLI (`bin["octap-mcp"]` -> `./dist/cli.js`).
2. **Three read tools:** Implemented `get_member_balance`, `list_member_transactions`, and `list_member_vouchers` using the `@octap/sdk` REST client.
3. **Input validation:** Strict Zod schemas enforcing regex patterns, non-empty IDs, and bounded pagination limits (max 50, default 20).
4. **Safe operations & error mapping:** Redacts internal error details; returns LLM-friendly messages preventing infinite retry loops; maps 404 to generic not-found messages to avoid cross-tenant member existence oracles; enforces 12-second timeouts and combines them with host cancellation via `AbortSignal.any`.
5. **Programmatic factory:** `createServer({ client, tools?, resolveMemberId?, project? })` allows embedding hosts to omit `memberId` from client schemas and bind users from validated HTTP `authInfo`. MCP session IDs are never authentication.
6. **Protocol-level test suite:** 24 tests exercising the MCP `Client` over `InMemoryTransport` without private SDK reflection, including host cancellation and `http.authInfo` member binding.
7. **Stdio end-to-end check:** CI runs the built CLI against disposable Postgres, Redis and Core services, including valid/invalid credentials, missing configuration, and cross-tenant reads returning a generic 404.

### Deferred to future tickets

1. **Durable audit trail:** Logging tool executions, caller identity, and tenant context to a persistent audit store (currently logs operational event names to `stderr` only).
2. **Remote Streamable HTTP transport:** Multi-user SSE/HTTP transport with bearer token auth.
3. **End-user identity delegation:** Per-user session token exchange for loyalty chat interfaces.
4. **Write workflows:** Campaign drafting, deterministic preview manifests, and human-in-the-loop approvals (OCT-229 follow-ups).

## Proposed test plan and acceptance checks

- **Tool-schema tests:** valid calls are accepted; malformed IDs, invalid limits, oversized input, and unknown arguments are rejected before Core is called.
- **Core adapter tests:** success responses are mapped correctly; unauthorized responses, timeouts, and Core errors return safe, useful MCP errors without leaking credentials or stack traces.
- **Tenant-isolation integration tests:** the stdio E2E verifies the merchant key reads its own member and receives the same generic not-found message for another organization's member.
- **Read-only guarantee:** tool discovery exposes no mutation tool; tool handlers make no write calls to Core.
- **MCP Inspector check:** connect over stdio, list capabilities, invoke each tool with valid and invalid inputs, and inspect the returned content.
- **Host smoke check:** connect one supported host to the local stdio command and complete one balance/history/voucher lookup using test data.

The implemented pilot remains private and is not a production customer-facing identity service. Its CI checks use disposable services and generated credentials; no production or real customer data is needed.

## References

- Linear: [OCT-229 MCP parent](https://linear.app/octapointees/issue/OCT-229/mcp), [OCT-230 use-case research](https://linear.app/octapointees/issue/OCT-230/mcp-research-use-cases-and-explain-mcps-purpose), [OCT-144 NestJS POC](https://linear.app/octapointees/issue/OCT-144/poc-mcp-tools-over-nestjs-with-rbac-boundaries).
- Core: [architecture](architecture.md), [feature roadmap](roadmap.md), and [repository README](../README.md).
- Design source: `OctaP-Designing/brainstorming/outputs/02-product-and-scope.md` (UC-05) and `03-solution-architecture.md` (MCP and permissions).
- Protocol: [MCP architecture overview](https://modelcontextprotocol.io/docs/learn/architecture).
