---
title: Webhook events
description: Every event OctaP delivers, and the data each one carries.
---

Every event has this shape, and `data` depends on `type`:

```ts
{ id: string; type: WebhookEventType; data: … }
```

`id` is stable across retries and replays, so deduplicate on it.

| Event | Sent when | Delivery |
| --- | --- | --- |
| [`credits.earned`](#creditsearned) | An earn was accepted, and is still pending | Best-effort |
| [`credits.earn.confirmed`](#creditsearnconfirmed) | The chain confirmed an earn | Exactly one per transaction is queued |
| [`credits.earn.failed`](#creditsearnfailed) | An accepted earn definitely failed | Queued with the failure |
| [`credits.redemption.confirmed`](#creditsredemptionconfirmed) | The chain confirmed a spend, for checkout or a paid voucher | Exactly one per transaction is queued |
| [`credits.reversed`](#creditsreversed) | A confirmed earn or redemption was reversed | Queued with the reversal |
| [`voucher.granted`](#vouchergranted) | The chain recorded a grant or free claim | Exactly one per voucher is queued |
| [`voucher.redeemed`](#voucherredeemed) | The customer signed and the chain marked a voucher used | Exactly one per voucher is queued |
| [`budget.low`](#budgetlow) | The issuance budget crossed 80% or 95% used | Checked every few minutes, one per crossing |

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

Has the same fields as `credits.earn.confirmed`, where `pointsAmount` is the amount debited.

## credits.reversed

Settled in the ledger immediately. A chain-confirmed original is also mirrored on-chain afterwards, which sends no separate event.

| Field | Type | Description |
| --- | --- | --- |
| `reversalTransactionId` | `string` | |
| `reversedTransactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | |
| `newBalance` | `number` | |
| `balanceWentNegative` | `boolean` | True when reversing a spent earn left a debt |

## voucher.granted

The customer now holds the voucher. A paid claim reports through `credits.redemption.confirmed` instead.

| Field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `AVAILABLE` |
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

## budget.low

Your [issuance budget](/concepts/issuance-budget/) is running low. [Request a top-up](/concepts/issuance-budget/#request-a-top-up) before earns start being refused.

| Field | Type | Description |
| --- | --- | --- |
| `threshold` | `80 \| 95` | The percentage used that was crossed |
| `remaining` | `number` | Points left across all shards |
| `capacity` | `number` | Initial budget plus every applied top-up |
