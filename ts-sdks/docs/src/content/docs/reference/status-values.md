---
title: Status values
description: What each transaction, voucher and webhook status means.
---

## Transaction status

`LoyaltyTxStatus`, on earns, redemptions and history.

| Status | Meaning |
| --- | --- |
| `PENDING` | Accepted and waiting for the chain, or for a customer's signature |
| `CONFIRMED` | The chain confirmed it |
| `FAILED` | It definitely failed, and any hold was released |
| `REVERSED` | It was confirmed, and later reversed |

## Transaction type

`LoyaltyTxType`: `EARN`, `REDEEM`, `REVERSAL`, `TRANSFER`, `EXPIRY` or `ADJUSTMENT`.

## Voucher claim status

`VoucherOwnershipStatus`, on claims and member vouchers.

| Status | Meaning | Next |
| --- | --- | --- |
| `RESERVED` | Points and stock are held, and the customer doesn't own it yet | Sign and finalize |
| `AVAILABLE` | Owned, and ready to use | Redeem the serial |
| `REDEEMED` | Used | None |
| `EXPIRED` | Passed its expiry | None |
| `CANCELLED` | Failed, abandoned or refunded | A new key can claim again |

## Voucher status

`VoucherStatus`, on the catalog.

| Status | Meaning |
| --- | --- |
| `DRAFT` | Not offered yet |
| `ACTIVE` | Can be claimed |
| `PAUSED` | Claims are paused |
| `EXPIRED` | Past its end date |
| `DEPLETED` | Out of stock. A refund that returns stock makes it `ACTIVE` again. |

## Webhook status

| Type | Values |
| --- | --- |
| `WebhookEndpointStatus` | `ACTIVE`, `DISABLED` |
| `WebhookDeliveryStatus` | `PENDING`, `DELIVERED`, `DEAD_LETTER` |
