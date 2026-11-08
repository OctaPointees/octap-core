---
title: Redeem points at checkout
description: Let a customer spend points directly at your point of sale.
---

Use this when a customer pays with points rather than a voucher. It has the same shape as a paid voucher claim: your server reserves, and the customer signs.

## 1. Reserve on your server

`pointsAmount` here means real points.

```ts
const reservation = await client.reservePosRedemption({
  organizationEndUserId: memberId,
  pointsAmount: 500,
  idempotencyKey: `pos-${order.id}`,
  orderReference: order.id,
  discountAmount: 50000,
  currency: 'VND',
});
```

`orderReference`, `discountAmount` and `currency` say what the points pay for. They are hashed into the transaction the customer signs, so the chain records which order and discount each spend bought. Show the customer the same discount before they sign. `orderReference` must hold no personal data.

Send `digest` and `transactionBytes` to the customer's device. If the same key already settled, both are `null` and `status` tells you the result.

The member needs enough available points, a linked Sui address and an on-chain account, which their first earn creates. Otherwise you get a 400.

## 2. Sign on the customer's device

```ts
const signature = await auth.signTransaction(reservation.transactionBytes);
```

`signTransaction` refuses bytes whose sender isn't the signed-in customer, with the code `wrong-account`.

## 3. Finalize

Send the signature to your server, and finalize there or from the customer's device. The signature authorizes this, not your API key.

```ts
const result = await client.finalizePosRedemption({
  digest: reservation.digest,
  signature,
});
// result.pointsRedeemed, result.newBalance, result.blockchainDigest
```

Use these two calls here. `auth.signAndFinalize` only accepts a voucher claim, because it requires `status: 'RESERVED'`, and a reservation's status is `PENDING`.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| 404 on finalize | The reservation expired, or it already finalized. Read history before you reserve again. |
| 409 on finalize | It was released or another digest is in progress. Read history first. |
| 400 on finalize | It may have failed on-chain or after sending. Read history before you retry. |
| Timeout or 5xx | Unknown outcome. Read history, or reserve again with the same key. |

A hold that is never signed is released after 30 minutes.
