# Sandbox

Sandbox mode (OCT-297): a developer tests an integration with a SANDBOX key and nothing real
changes. No real member's balance moves, nothing is sent to the chain, no webhook fires.

## The boundary

- **Keys.** `api_credentials.environment` is `LIVE` or `SANDBOX`, fixed at issue. Sandbox keys
  start `octap_test_`. The console issues them (`environment: "SANDBOX"`); since a sandbox key
  cannot change anything real, a Business Developer may create and manage a sandbox `write` key.
- **Routes.** `ApiKeyGuard` refuses a sandbox key on every non-GET route not marked
  `@SandboxSupported()`, with 403 `SANDBOX_NOT_SUPPORTED`. Closed by default: a new write route
  is unavailable to sandbox keys until someone decides what it does in sandbox.
- **Data.** Sandbox writes go only to `sandbox_credit_balances` and
  `sandbox_loyalty_transactions`. They are separate tables, not flags on the live ones, so no
  live read needs a filter and no live write can be pointed at a sandbox row by mistake.
  `SandboxRepository` writes nothing else: no `credit_ownerships`, `loyalty_transactions`,
  `operations` or `organization_events`.

## What a sandbox key can do

| Route | In sandbox |
| --- | --- |
| `POST /v1/credits/earn` | Same checks as live (member, program, `earnBps`, the 0-point rule, idempotency with 409 on a changed payload). CONFIRMED at once with a synthetic `sandbox_…` digest; the points are credited to the sandbox balance. The issuance budget is neither checked nor spent. |
| `POST /v1/credits/redeem/reserve` | Same checks as live; holds the points in the sandbox balance (400 when it cannot cover them). Returns a `sandbox_…` digest and placeholder bytes. No Enoki. |
| `POST /v1/credits/redeem/finalize` | Public, like live. A `sandbox_…` digest settles on the sandbox ledger with any non-empty signature. An unsigned hold is released after 30 minutes, like a live one. |
| `POST /v1/identity/verify` | Live and read-only: it only reads the customer (a POST so the ID token stays out of the URL). |
| `GET /v1/credits/members/:id/balance`, `…/transactions` | The member's sandbox balance and sandbox history. |
| Other GET routes | Live data, read-only. |
| Every other write | 403 `SANDBOX_NOT_SUPPORTED`. |

Every sandbox response carries `isSandbox: true`. Live responses do not have the field.

## Webhook test event

Sandbox writes record no events, so a developer checks their endpoint with
`POST /v1/console/organizations/:id/webhooks/endpoints/:endpointId/test` (Owner) instead: one
`webhook.test` event, delivered to that endpoint only, signed and retried like any other.
