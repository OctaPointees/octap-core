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
| **Member support lookup** | Merchant support staff need to answer “did this earn land?” or “what is this member's current voucher status?” without manually joining several screens. | Read a tenant member's balance, recent transactions and vouchers. Core already exposes balance/history and member-voucher reads. A useful operation-level diagnostic may need a narrowly scoped API if current member endpoints omit the error/status detail. | Customer data is tenant-sensitive. Require an authenticated staff identity and read scopes; derive the tenant from that identity, audit access, and avoid broad member searches by default. |
| **Owner operations summary** | An owner wants a concise view of recent activity, pending operations and program budget warnings. | Aggregate existing transaction/balance and budget information. Some source reads exist; a safe, bounded summary endpoint may be needed to avoid many calls and to define what staff may see. | Keep summaries tenant-scoped and time-bounded. Do not expose signer material or internal database records. |
| **Campaign draft and preview** | A marketing manager wants to describe a promotion in natural language and see its audience and estimated cost before approval. | Create a draft and deterministic preview; later, a different authorized member approves a content-bound manifest; execution references that approval. Campaign APIs and the campaign domain are not implemented yet. | The AI must not approve its own draft, change the approved manifest, exceed budget, issue arbitrary points or bypass campaign limits. Execution is a later phase, never a raw `mint_points` tool. |
| **Developer integration help** | A developer wants examples or help interpreting SDK/API errors. | Search published API/SDK documentation and return relevant examples. Existing docs and SDKs provide a source; this could be a documentation-only MCP capability. | It must distinguish published facts from suggestions and must not imply access to a merchant's live tenant data. For basic lookups, the docs site may already be simpler. |

## Recommendation

Start with **read-only member support lookup in a local/staging pilot**. It has a concrete Octap business problem, uses Core reads that already exist, and tests the most important MCP-specific boundary: each tool call must act with the authenticated merchant staff member's tenant and scopes. It avoids introducing point-changing behavior before the authorization and audit path is proven.

Keep the first tool set narrow: get one member's balance, list that member's recent transactions, and list that member's vouchers. Only add transaction failure diagnostics after Core has a supported endpoint for the specific fields. Compare the result with the existing portal/API flow to show whether the assistant reduces time to answer a support question without leaking another tenant's data.

Campaign drafting and preview remain the stronger strategic extension, but depend on the planned campaign module, deterministic previews, immutable approval manifests and a second-person approval workflow. They should follow only after those Core capabilities exist and are tested without an AI client.

## Location and boundaries

If implementation is approved, place the adapter in the root-level **`mcp/`** package in `octap-core`, and run/deploy it as its own process. Keep its dependencies, configuration and startup command isolated from the NestJS API and workers. It calls Core through the authorized API/SDK boundary; it does not import domain or infrastructure internals, access PostgreSQL directly, or contain its own source of truth.

For a developer-only local pilot, stdio is the simplest connection. A shared remote server can use Streamable HTTP, but needs a user authentication design and tenant/role mapping before deployment. Transport authentication alone does not replace Core's object-level and tenant authorization.

## Security and consent rules

- Derive tenant, user and role from verified server-side credentials, never from model-generated arguments.
- Keep merchant/API credentials on the server side, scoped to the minimum Core reads required; never return credentials or signer keys to the model.
- Treat tool input, retrieved member data and user-provided content as untrusted. Validate inputs and restrict lookup scope.
- For this local stdio pilot, log tool names and outcomes to stderr without member IDs or secrets. A shared remote deployment must add verified caller/tenant attribution and a durable audit trail first.
- The first pilot is read-only. Any later write tool creates a bounded draft and records an audit trail; an authorized human approves the exact action before execution.
- MCP cannot spend a customer's points on their behalf. Customer redemption and voucher use continue to require the customer's own signature.

## Decision and prerequisites

**Location decision:** keep this plan in `docs/` and co-locate the isolated adapter at `mcp/` in this repository. This updates the earlier separate-repository direction in `README.md` and `docs/architecture.md`. The adapter is a local/staging pilot only and is not approved for production.

Before implementation, agree on the pilot actor and host, choose how local/remote callers authenticate, map identity to Core tenant and scopes, confirm the required read endpoints, and define the audit fields and negative cross-tenant tests. The research task itself does not build or deploy the server.

## Proposed work breakdown (future implementation)

The first five items are represented by this local/staging pilot; campaign write workflows remain future work.

1. **Define the caller boundary.** Select the pilot host and identity flow. Specify how the authenticated caller maps to a Core credential, organization, and read scopes. Reject caller-supplied tenant IDs as authorization.
2. **Create the isolated adapter.** Add `mcp/` with its own package manifest, configuration, startup command, and stdio transport. Keep Core business rules in Core; the adapter calls only supported API/SDK operations.
3. **Add three read tools.** Implement `get_member_balance`, `list_member_transactions`, and `list_member_vouchers`. Give each tool a narrow schema, bounded result count, clear errors, and descriptions that state its scope.
4. **Add safe operations.** Redact credentials and unnecessary personal data from logs and tool results; set request timeouts; record the authenticated caller, tenant, tool, target, and outcome.
5. **Document local setup.** Explain prerequisites, environment variables without values, how to launch the stdio process, and how to connect an MCP host. Do not commit credentials.
6. **Review later write workflows separately.** Campaign draft/preview/approval/execution requires the Campaign domain, immutable previews, a different authorized approver, budget enforcement, and audit records. Do not add write tools to the read-only pilot.

## Proposed test plan and acceptance checks

- **Tool-schema tests:** valid calls are accepted; malformed IDs, invalid limits, oversized input, and unknown arguments are rejected before Core is called.
- **Core adapter tests:** success responses are mapped correctly; unauthorized responses, timeouts, and Core errors return safe, useful MCP errors without leaking credentials or stack traces.
- **Tenant-isolation integration tests:** an authenticated caller can read an allowed member in their own organization; cross-tenant and out-of-scope reads are denied. Changing a model-supplied tenant argument must not change authorization.
- **Read-only guarantee:** tool discovery exposes no mutation tool; tool handlers make no write calls to Core.
- **MCP Inspector check:** connect over stdio, list capabilities, invoke each tool with valid and invalid inputs, and inspect the returned content.
- **Host smoke check:** connect one supported host to the local stdio command and complete one balance/history/voucher lookup using test data.

The work is ready for a future implementation review when all checks pass, the host setup is repeatable without committed secrets, and the behavior matches Core's authorization. No production or real customer data is needed for the pilot.

## References

- Linear: [OCT-229 MCP parent](https://linear.app/octapointees/issue/OCT-229/mcp), [OCT-230 use-case research](https://linear.app/octapointees/issue/OCT-230/mcp-research-use-cases-and-explain-mcps-purpose), [OCT-144 NestJS POC](https://linear.app/octapointees/issue/OCT-144/poc-mcp-tools-over-nestjs-with-rbac-boundaries).
- Core: [architecture](architecture.md), [feature roadmap](roadmap.md), and [repository README](../README.md).
- Design source: `OctaP-Designing/brainstorming/outputs/02-product-and-scope.md` (UC-05) and `03-solution-architecture.md` (MCP and permissions).
- Protocol: [MCP architecture overview](https://modelcontextprotocol.io/docs/learn/architecture).
