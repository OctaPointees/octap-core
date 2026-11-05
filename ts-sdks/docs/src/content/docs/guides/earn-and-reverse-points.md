---
title: Earn and reverse points
description: Issue points for a purchase, and take them back after a refund or chargeback.
---

## Earn points

Call this from your server after a customer pays. Send money, not points: OctaP applies your program's earn rate.

```ts
const earn = await client.earnPoints({
  organizationEndUserId: memberId,
  purchaseAmount: order.totalMinorUnits,
  idempotencyKey: `earn-${order.id}`,
  receiptReference: order.id,
  metadata: { store: 'district-1' },
});
```

`receiptReference` and `metadata` are optional, and they count as part of the request when a key is reused.

### Know when points are spendable

The response is `PENDING`. Act on the [`credits.earn.confirmed`](/reference/webhook-events/#creditsearnconfirmed) webhook, or read history:

```ts
const [latest] = await client.listTransactions(memberId, { limit: 1 });
if (latest.status === 'CONFIRMED') {
  showPoints(latest.pointsAmount);
}
```

A member's first earn also opens their on-chain account, so it can take longer than later ones.

### Refusals

| Status | Meaning |
| --- | --- |
| 400 | Invalid amount, or too small to earn one point |
| 403 | The organization or member isn't active, or the key lacks `write` |
| 404 | The member isn't in your organization |
| 409 | The key was already used for a different request |
| 422 | Your organization's program isn't provisioned, or the [issuance budget](/concepts/issuance-budget/) can't cover this earn |

### When an earn fails

An accepted earn can still fail on the chain. The hold is released, nothing is credited, and you get the [`credits.earn.failed`](/reference/webhook-events/#creditsearnfailed) webhook.

The key stays used, so repeating the request returns the same `FAILED` result. A `FAILED` earn definitely credited nothing, so it is safe to try again with a **new** key. Do this only for `FAILED`: after a timeout or a `PENDING` status, keep the same key.

## Reverse a transaction

Reverse a confirmed earn after a refund or chargeback. `reason` is required.

```ts
const reversal = await client.reverseTransaction({
  transactionId: earn.transactionId,
  idempotencyKey: `refund-${order.id}`,
  reason: 'Customer returned the order',
});

if (reversal.balanceWentNegative) {
  // They already spent these points. The negative balance is a debt that blocks further spending.
}
```

You can reverse confirmed `EARN` and `REDEEM` transactions. A `PENDING` transaction can't be reversed: it either settles or gets released.

To reverse a paid voucher claim, reverse its `REDEEM` transaction. See [Refunds](/guides/manage-vouchers/#refunds).
