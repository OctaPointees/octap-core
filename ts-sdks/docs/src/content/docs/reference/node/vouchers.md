---
title: Vouchers
description: Node SDK methods for the voucher catalog, claims, redemption and refund policy.
---

## createVoucher

`POST /v1/rewards/vouchers` · Scope: `write`

```ts
createVoucher(request: CreateVoucherRequest, options?): Promise<VoucherDto>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `code` | `string` | **Required.** Unique in your organization. |
| `title` | `string` | **Required.** |
| `discountType` | `'PERCENTAGE' \| 'FIXED_AMOUNT' \| 'FREE_ITEM'` | **Required.** |
| `description` | `string` | |
| `pointsCost` | `number` | Defaults to 0, a free voucher. |
| `discountValue` | `string` | |
| `totalSupply` | `number \| null` | |
| `startsAt` | `string \| null` | ISO date-time with seconds and timezone |
| `expiresAt` | `string \| null` | ISO date-time with seconds and timezone |
| `metadata` | `object` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED'` | Defaults to `ACTIVE`. |

`VoucherDto` adds `id`, `organizationId`, `claimedCount`, `createdAt` and `updatedAt`.

## updateVoucher

Takes any fields from `createVoucher`. After the first claim, `code`, `pointsCost`, discount and dates are fixed. [Guide](/guides/manage-vouchers/#edit-a-voucher)

`PATCH /v1/rewards/vouchers/:id` · Scope: `write`

```ts
updateVoucher(voucherId: string, request: UpdateVoucherRequest, options?): Promise<VoucherDto>
```

## listVouchers

`GET /v1/rewards/vouchers` · Scope: `read`

```ts
listVouchers(options?): Promise<VoucherDto[]>
```

## getVoucher

`GET /v1/rewards/vouchers/:id` · Scope: `read`

```ts
getVoucher(voucherId: string, options?): Promise<VoucherDto>
```

## claimVoucher

Reserves a voucher. A paid claim stays `RESERVED` until the chain confirms. [Guide](/guides/claim-a-paid-voucher/)

`POST /v1/rewards/vouchers/:id/claim` · Scope: `write`

```ts
claimVoucher(voucherId: string, request: ClaimVoucherRequest, options?): Promise<ClaimVoucherResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Required.** A UUID. |
| `idempotencyKey` | `string` | **Required for paid claims.** 1–100 letters, numbers, `:`, `_` or `-`. |

| Returned field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | Use it with `getVoucherClaim`. |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | Use it with `redeemVoucher` once `AVAILABLE`. |
| `status` | [`VoucherOwnershipStatus`](/reference/status-values/) | |
| `pointsDeducted` | `number` | Zero until the chain confirms. |
| `pointsCost` | `number` | |
| `transactionId` | `string \| null` | The `REDEEM` transaction. Use it to reverse the claim. |
| `digest` | `string \| null` | Present on a claim response while `RESERVED` |
| `transactionBytes` | `string \| null` | Present on a claim response while `RESERVED` |
| `refundPolicy` | `VoucherRefundPolicySnapshot` | Terms kept with this claim |
| `claimedAt` | `string` | |
| `expiresAt` | `string \| null` | |

## getVoucherClaim

Reads the saved state of a claim. It doesn't return signing bytes or a digest.

`GET /v1/rewards/claims/:id` · Scope: `read`

```ts
getVoucherClaim(ownershipId: string, options?): Promise<ClaimVoucherResponse>
```

## finalizeVoucherClaim

Submits the customer's signature for a claim, on the same route as `finalizePosRedemption`. Your API key isn't what authorizes it.

`POST /v1/credits/redeem/finalize` · Public: the signature authorizes it

```ts
finalizeVoucherClaim(request: { digest: string; signature: string }, options?): Promise<FinalizePosRedemptionResponse>
```

## redeemVoucher

Uses a claimed voucher. No points move. A serial can only be redeemed once.

`POST /v1/rewards/vouchers/redeem` · Scope: `write`

```ts
redeemVoucher(request: RedeemVoucherRequest, options?): Promise<RedeemVoucherResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `serialCode` | `string` | **Required.** 1–100 letters, numbers, `_` or `-`. |
| `receiptReference` | `string` | Your reference. |

Returns `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `redeemedAt`, `voucherTitle`, `discountType` and `discountValue`.

## listMemberVouchers

`GET /v1/rewards/members/:memberId/vouchers` · Scope: `read`

```ts
listMemberVouchers(memberId: string, options?): Promise<VoucherOwnershipDto[]>
```

## getVoucherRefundPolicy

Reads the terms for future claims.

`GET /v1/rewards/refund-policy` · Scope: `read`

```ts
getVoucherRefundPolicy(options?): Promise<VoucherRefundPolicyDto>
```

## setVoucherRefundPolicy

Publishes new terms for future claims. [Settings](/guides/manage-vouchers/#refunds)

`PUT /v1/rewards/refund-policy` · Scope: `admin`

```ts
setVoucherRefundPolicy(request: SetVoucherRefundPolicyRequest, options?): Promise<VoucherRefundPolicyDto>
```

## listVoucherRefundPolicyHistory

Lists policy versions, newest first.

`GET /v1/rewards/refund-policy/history` · Scope: `admin`

```ts
listVoucherRefundPolicyHistory(query?: { limit?: number; beforeVersion?: number }, options?): Promise<VoucherRefundPolicyDto[]>
```

`limit` is 1–100 and defaults to 50. `beforeVersion` is an exclusive cursor: pass the last version of the previous page.
