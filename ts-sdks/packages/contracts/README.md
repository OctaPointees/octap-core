# @octap/contracts

TypeScript types for the Octap Core REST API: every request and response body, the webhook events,
and the status values. `@octap/sdk`, `@octap/browser-sdk`, `@octap/mcp` and `@octap/verify` all use
them, and so does Core itself.

It is types only: nothing here runs, and nothing validates a value at runtime.

```bash
npm install @octap/contracts
```

```ts
import type { WebhookEvent } from '@octap/contracts';

function onEvent(event: WebhookEvent) {
  if (event.type === 'credits.earn.confirmed') {
    // event.data is CreditsChainConfirmedEventData
  }
}
```

You don't need this package if you use `@octap/sdk`: it re-exports the types its methods take and
return. Install it on its own for code that only handles the data, such as a webhook receiver in
another service or a typed frontend.

## What's in it

| Area | Examples |
| --- | --- |
| Points | `EarnPointsRequest`, `CreditBalanceSnapshot`, `LoyaltyTransactionDto`, `ReservePosRedemptionResponse` |
| Vouchers | `VoucherDto`, `VoucherStatus`, `VoucherOwnershipDto`, `VoucherOwnershipStatus`, `ClaimVoucherResponse` |
| Voucher batches and refunds | `VoucherBatchDto`, `VoucherBatchItem`, `VoucherRefundPolicyDto` |
| Webhooks | `WebhookEvent` (discriminated on `type`), `WebhookEventType`, `WebhookEventData<T>` |
| Members and identity | `VerifyCustomerResponse`, `MemberProfile` |
| Evidence, audit and analytics | `EvidenceBundle`, `AuditLogEntry`, `ProgramAnalyticsSummary` |

Each type's JSDoc says what its fields mean. The same comments describe the fields in Core's OpenAPI
document.

This package is not the on-chain Move contracts: those are in `contracts/` in the
[octap-core repository](https://github.com/OctaPointees/octap-core).
