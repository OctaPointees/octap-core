---
title: Manage vouchers
description: Create and edit vouchers, and set the refund terms for future claims.
---

## Create a voucher

```ts
const voucher = await client.createVoucher({
  code: 'COFFEE-25',
  title: 'Free coffee',
  pointsCost: 25,
  discountType: 'FREE_ITEM',
  totalSupply: 500,
  expiresAt: '2030-01-01T00:00:00Z',
});
```

`pointsCost` defaults to 0, which makes a free voucher. `status` defaults to `ACTIVE`, and also accepts `DRAFT` or `PAUSED`. A `code` must be unique in your organization, or you get a 409.

Dates are ISO date-times with seconds and a timezone, such as `2030-01-01T00:00:00Z`.

## Edit a voucher

```ts
await client.updateVoucher(voucher.id, { status: 'PAUSED' });
```

After the first claim, `code`, `pointsCost`, discount type and value, and dates can't change. You can still change the title, description, metadata, supply and status. Supply can't fall below the number already claimed.

## Read vouchers

```ts
const vouchers = await client.listVouchers();
const owned = await client.listMemberVouchers(memberId);
```

## Refunds

Your refund policy sets the terms for future claims. Each claim keeps a copy of the terms in force when it was made, so changing the policy never affects existing claims.

```ts
await client.setVoucherRefundPolicy({
  allowUnused: true,
  allowExpired: false,
  allowRedeemed: false,
  restockUnused: true,
  refundWindowDays: 30,
  reason: 'Thirty-day returns',
});
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `allowUnused` | `true` | Refund a voucher that hasn't been used |
| `allowExpired` | `false` | Refund an expired voucher. Executing it needs an `admin` key. |
| `allowRedeemed` | `false` | Refund a used voucher, as exceptional service recovery. Executing it needs an `admin` key. |
| `restockUnused` | `true` | Return the unit to stock. `false` consumes it permanently. |
| `refundWindowDays` | `null` | Days since the claim, exclusive. `null` means no limit. |

Publishing a policy and reading its history need an `admin` key. `getVoucherRefundPolicy` needs only `read`.

To refund a claim, [reverse](/guides/earn-and-reverse-points/#reverse-a-transaction) its `REDEEM` transaction, whose ID is the claim's `transactionId`. Under the default policy:

| Voucher when reversed | Result |
| --- | --- |
| `RESERVED` | Refused, because it is still pending. Failure or abandonment releases it. |
| `AVAILABLE`, not expired | Cancelled, stock returned and points refunded together |
| `REDEEMED` or expired | 409. To compensate the member, issue a separate earn. |
