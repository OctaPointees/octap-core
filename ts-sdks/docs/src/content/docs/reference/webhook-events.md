---
title: Webhook events
description: Every event OctaP delivers, and the data each one carries.
---

Every event has this shape, and `data` depends on `type`:

```ts
{ id: string; type: WebhookEventType; data: … }
```

`id` is stable across retries and replays, and the same for every endpoint, so deduplicate on it.

| Event | Sent when | Delivery |
| --- | --- | --- |
| [`credits.earned`](#creditsearned) | An earn was accepted, and is still pending | Queued with the earn |
| [`credits.earn.confirmed`](#creditsearnconfirmed) | The chain confirmed an earn | Exactly one per transaction is queued |
| [`credits.earn.failed`](#creditsearnfailed) | An accepted earn definitely failed | Queued with the failure |
| [`credits.redemption.confirmed`](#creditsredemptionconfirmed) | The chain confirmed a spend, for checkout or a paid voucher | Exactly one per transaction is queued |
| [`credits.reversed`](#creditsreversed) | A confirmed earn or redemption was reversed | Queued with the reversal |
| [`voucher.granted`](#vouchergranted) | The chain recorded a grant or free claim | Exactly one per voucher is queued |
| [`voucher.redeemed`](#voucherredeemed) | The customer signed and the chain marked a voucher used | Exactly one per voucher is queued |
| [`budget.low`](#budgetlow) | The issuance budget crossed 80% or 95% used | Checked every few minutes, one per crossing |
| [`license.usage_threshold`](#licenseusage_threshold) | This license month's transactions reached 80% or 100% of the license's limit | Queued with the transaction, once per threshold and license month |
| [`license.expiry_notice`](#licenseexpiry_notice) | Your license is 30, 7 or 1 days from its end, entered its grace period, or expired | Checked every 15 minutes, one per step |
| [`voucher.created` and the other voucher events](#voucher-lifecycle-events) | A voucher was created, submitted, returned, activated, failed to publish, paused or archived | Queued with the change |

Queued events can still be retried, so your receiver may see the same `id` more than once.

## credits.earned

An earn is on its way to the chain. Wait for `credits.earn.confirmed` before treating the points as spendable.

| Field | Type | Description |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `purchaseAmount` | `number` | |
| `estimatedPoints` | `number` | An estimate, not the credited amount |
| `newBalance` | `number` | Confirmed balance, which doesn't include this earn yet |

## credits.earn.confirmed

| Field | Type | Description |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | The amount actually credited on-chain |
| `newBalance` | `number` | Confirmed balance right after this transaction |
| `blockchainDigest` | `string` | |

## credits.earn.failed

The hold was released and nothing was credited. The key stays used, so [a retry needs a new key](/guides/earn-and-reverse-points/#when-an-earn-fails).

| Field | Type | Description |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `purchaseAmount` | `number \| null` | `null` only for older transactions |
| `estimatedPoints` | `number` | The estimate that was held |
| `failureCode` | `'BUDGET_EXHAUSTED' \| 'REJECTED'` | `BUDGET_EXHAUSTED`: [request a top-up](/concepts/issuance-budget/#request-a-top-up), then retry. `REJECTED`: any other definite failure. |

## credits.redemption.confirmed

Has the same fields as `credits.earn.confirmed`, where `pointsAmount` is the amount debited. A paid voucher claim also carries `voucher`:

| Field | Type | Description |
| --- | --- | --- |
| `voucher.voucherOwnershipId` | `string` | The voucher this spend bought, now `AVAILABLE` |
| `voucher.expiresAt` | `string \| null` | Its final use deadline, counted from when the chain issued it. The claim response's `expiresAt` was provisional. |

## credits.reversed

Settled in the ledger immediately. A chain-confirmed original is also mirrored on-chain afterwards, which sends no separate event.

| Field | Type | Description |
| --- | --- | --- |
| `reversalTransactionId` | `string` | |
| `reversedTransactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | |
| `newBalance` | `number` | |

## voucher.granted

The customer now holds the voucher. A paid claim reports through `credits.redemption.confirmed` instead.

| Field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `AVAILABLE` |
| `expiresAt` | `string \| null` | This customer's final use deadline, counted from when the chain issued it. The grant response's `expiresAt` was provisional. `null` never expires. |
| `blockchainDigest` | `string` | |

## voucher.redeemed

Deliver the benefit on this event. No points move here. A paid claim already sent `credits.redemption.confirmed` for its cost.

| Field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `REDEEMED` |
| `redeemedAt` | `string` | |
| `voucherTitle` | `string` | |
| `discountType` | `string \| null` | |
| `discountValue` | `string \| null` | |
| `blockchainDigest` | `string` | The customer-signed transaction |

## voucher.member_expired

A customer's voucher reached its own deadline (`expiresAt`) unused. It is `EXPIRED` and can no longer be used. It arrives once, within about a minute of the deadline, or sooner if the voucher is read first.

| Field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `EXPIRED` |
| `expiresAt` | `string \| null` | The deadline that passed |

## budget.low

Your [issuance budget](/concepts/issuance-budget/) is running low. [Request a top-up](/concepts/issuance-budget/#request-a-top-up) before earns start being refused.

| Field | Type | Description |
| --- | --- | --- |
| `threshold` | `80 \| 95` | The percentage used that was crossed |
| `remaining` | `number` | Points left across all shards |
| `capacity` | `number` | Initial budget plus every applied top-up |

## license.usage_threshold

Your organization's transactions this license month (earns, POS redemptions and paid voucher claims) reached 80% or 100% of what its license allows. Past 100% they keep going until 110%, then each is refused with 402 `LICENSE_LIMIT_REACHED` until the next license month starts at `periodEnd`. Upgrade the license to raise the limit.

| Field | Type | Description |
| --- | --- | --- |
| `limit` | `'transactionsMonthly'` | The limit it is about |
| `threshold` | `80 \| 100` | The percentage reached |
| `used` | `number` | Transactions counted this license month, this one included |
| `allowed` | `number` | The license's monthly limit |
| `periodStart` | `string` | When this license month started |
| `periodEnd` | `string` | When it ends and the count starts again |

## license.expiry_notice

Your organization's license reached a step of its end. Renew it before `graceEndsAt`.

| `stage` | When | What still works |
| --- | --- | --- |
| `DAYS_30`, `DAYS_7`, `DAYS_1` | 30, 7 or 1 days before `endsAt`. A reminder longer than the license itself is skipped (a 14-day trial gets `DAYS_7` and `DAYS_1`) | Everything |
| `GRACE` | `endsAt` has passed | Everything, for 7 more days |
| `EXPIRED` | `graceEndsAt` has passed | Everything except new transactions: earns, POS redemptions and paid voucher claims answer 402 `LICENSE_EXPIRED`. Confirmations, reversals, balances and vouchers customers already hold keep working |

Each step is sent once. A license that was already renewed sends nothing more. If several steps passed while nothing was checked, only the current one is sent. Renewing extends from `endsAt`, so renewing early loses no day.

| Field | Type | Description |
| --- | --- | --- |
| `licenseId` | `string` | |
| `stage` | `'DAYS_30' \| 'DAYS_7' \| 'DAYS_1' \| 'GRACE' \| 'EXPIRED'` | |
| `tier` | `string` | `TRIAL`, `STARTER`, `GROWTH` or `ENTERPRISE` |
| `planName` | `string` | |
| `endsAt` | `string` | |
| `graceEndsAt` | `string` | When new transactions stop |
| `daysLeft` | `number` | Whole days until `endsAt`, 0 once it has passed |

## Voucher lifecycle events

`voucher.created`, `voucher.submitted`, `voucher.returned`, `voucher.activated`, `voucher.publish.failed`, `voucher.paused`, `voucher.archived` and `voucher.expired` keep your catalog in step with OctaP. Each one is queued in the same database transaction as the change it reports. Each carries the voucher as it is right after that change:

| Field | Type | Description |
| --- | --- | --- |
| `voucherId` | `string` | |
| `code` | `string` | |
| `title` | `string` | |
| `batchId` | `string \| null` | The batch it was created or last imported in |
| `status` | `string` | `DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `PAUSED`, `ARCHIVED`, … |
| `publishStatus` | `string` | `NOT_PUBLISHED`, `PUBLISHING`, `PUBLISHED` or `FAILED` |
| `suiTermsId` | `string \| null` | The on-chain terms, once published |
| `createdBy` | `{ type: 'USER' \| 'API_CREDENTIAL'; id: string } \| null` | |
| `activatedBy` | `{ type: 'USER' \| 'API_CREDENTIAL'; id: string } \| null` | Whoever activated it, or the Owner who approved it |
| `activatedAt` | `string \| null` | |
| `updatedAt` | `string` | |

| Event | Sent when |
| --- | --- |
| `voucher.created` | A voucher was created on its own or by a batch, or an archived code was imported again. Created as `ACTIVE`, it is followed by `voucher.submitted`, or by `voucher.activated` once published. |
| `voucher.submitted` | An activation is waiting for an Owner, because your organization requires approval. Also carries `approvalRequestId` and `submittedBy`. |
| `voucher.returned` | A submission was rejected or withdrawn, and the voucher is back to `DRAFT`. Also carries `approvalRequestId`, `outcome` (`REJECTED` or `WITHDRAWN`), `reason` and `reviewedById`. |
| `voucher.activated` | The voucher is `ACTIVE` and customers can claim it: the chain confirmed its terms, or a paused voucher was resumed. Start selling on this event, not on the activate response. |
| `voucher.publish.failed` | Its terms never reached the chain. Fix the voucher and activate it again. |
| `voucher.paused` | An Owner or an API key paused it. Claims stop. |
| `voucher.archived` | Its batch was archived before it went live. It can't be used any more. |
| `voucher.expired` | Its claim window (`expiresAt`) closed while it was live, paused or sold out. It is `EXPIRED`: nobody can claim it, and it can't be paused or resumed. Vouchers customers already hold keep their own deadline (`voucher.member_expired`). |

An approval sends no event of its own: publishing starts, and `voucher.activated` or `voucher.publish.failed` follows. A voucher paused while publishing stays paused once published, so it sends `voucher.activated` only when it is resumed. Running out of supply sends no event. Expiry events arrive within about a minute of the deadline.
