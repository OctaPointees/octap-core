---
title: Manage vouchers
description: Publish vouchers in your own form, grant them, and set their refund terms.
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

If a create times out or its response is lost, the voucher may exist anyway, and a retry gets a 409 for its `code`. Then call `listVouchers` and find it by `code` instead of creating it again.

### Publishing

Asking for `ACTIVE` publishes the voucher's terms on-chain, where nobody can change them. Until the chain confirms, the voucher is `DRAFT` with `publishStatus: 'PUBLISHING'`, and it can't be claimed. Read it until `publishStatus` is `PUBLISHED`. If it is `FAILED`, you can edit it and activate it again. Your organization needs a provisioned program, or you get a 422.

### Your own form of voucher

Your voucher doesn't have to be one of OctaP's discount types. Describe it in `terms`, in whatever shape your business uses, and leave out `discountType`:

```ts
await client.createVoucher({
  code: 'SPA-TET',
  title: 'Tet spa package',
  pointsCost: 500,
  terms: { benefit: 'Two treatments for one', weekdaysOnly: true },
});
```

Terms, title and description together must fit in 8 KB. They are public on-chain, so they must hold no personal data.

Dates are ISO date-times with seconds and a timezone, such as `2030-01-01T00:00:00Z`.

## Edit a voucher

```ts
await client.updateVoucher(voucher.id, { status: 'PAUSED' });
```

Once publishing starts, `code`, `title`, `description`, `pointsCost`, `terms`, discount type and value, and dates can't change. To offer something different, create a new voucher. You can still change metadata, supply and status. Supply can't fall below the number already claimed.

## Give a voucher

Grant a voucher when the customer shouldn't spend points, such as a gift or a campaign reward. How you hand it out is up to you: a QR code, a link or an event can all lead to this call.

```ts
await client.grantVoucher(voucher.id, {
  organizationEndUserId: memberId,
  idempotencyKey: `gift-${campaignId}-${memberId}`,
});
```

It stays `RESERVED` until the chain records it, then `voucher.granted` arrives. The customer doesn't sign to receive it, but they do sign to use it. A granted voucher can't be taken back.

## Read vouchers

```ts
const vouchers = await client.listVouchers();
const owned = await client.listMemberVouchers(memberId);
```

## Refunds

A voucher publishes the refund policy in force when publishing starts, so it is part of the promise. Changing the policy only affects vouchers you publish afterwards.

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
| A use is in progress | 409, until the use settles |
