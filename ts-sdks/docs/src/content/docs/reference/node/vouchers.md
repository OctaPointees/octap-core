---
title: Vouchers
description: Node SDK methods for the voucher catalog, claims, grants, customer-signed use and refund policy.
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
| `discountType` | `'PERCENTAGE' \| 'FIXED_AMOUNT' \| 'FREE_ITEM'` | **Required** unless `terms` is set. |
| `terms` | `object` | Your own description of the promise. Published on-chain, so no personal data. |
| `description` | `string` | |
| `pointsCost` | `number` | Defaults to 0, a free voucher. |
| `discountValue` | `string` | |
| `totalSupply` | `number \| null` | |
| `startsAt` | `string \| null` | ISO date-time with seconds and timezone |
| `expiresAt` | `string \| null` | ISO date-time with seconds and timezone |
| `metadata` | `object` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED'` | Defaults to `ACTIVE`, which publishes the terms on-chain first. |

`VoucherDto` adds `id`, `organizationId`, `claimedCount`, `publishStatus`, `suiTermsId`, `refundPolicy`, `createdAt` and `updatedAt`.

## updateVoucher

Takes any fields from `createVoucher`. Once publishing starts, everything in the terms is fixed; metadata, supply and status are not. [Guide](/guides/manage-vouchers/#edit-a-voucher)

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

Reserves a voucher. It stays `RESERVED` until the chain confirms. [Guide](/guides/claim-a-paid-voucher/)

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
| `serialCode` | `string` | Use it with `prepareVoucherUse` once `AVAILABLE`. |
| `status` | [`VoucherOwnershipStatus`](/reference/status-values/) | |
| `pointsDeducted` | `number` | Zero until the chain confirms. |
| `pointsCost` | `number` | |
| `transactionId` | `string \| null` | The `REDEEM` transaction. Use it to reverse the claim. |
| `digest` | `string \| null` | Present on a claim response while `RESERVED` |
| `transactionBytes` | `string \| null` | Present on a claim response while `RESERVED` |
| `refundPolicy` | `VoucherRefundPolicySnapshot` | Published with the voucher's terms |
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

## grantVoucher

Gives a customer a voucher without spending their points. It stays `RESERVED` until the chain records it, and `voucher.granted` reports that. [Guide](/guides/manage-vouchers/#give-a-voucher)

`POST /v1/rewards/vouchers/:id/grant` · Scope: `write`

```ts
grantVoucher(voucherId: string, request: GrantVoucherRequest, options?): Promise<ClaimVoucherResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Required.** A UUID. |
| `idempotencyKey` | `string` | **Required.** 1–100 letters, numbers, `:`, `_` or `-`. |

## prepareVoucherUse

Asks the customer to use a voucher. It returns bytes for their device to sign and marks nothing used. [Guide](/guides/claim-a-paid-voucher/#4-use-the-voucher)

`POST /v1/rewards/vouchers/use` · Scope: `write`

```ts
prepareVoucherUse(request: PrepareVoucherUseRequest, options?): Promise<PrepareVoucherUseResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `serialCode` | `string` | **Required.** 1–100 letters, numbers, `_` or `-`. |
| `idempotencyKey` | `string` | **Required.** 1–100 letters, numbers, `:`, `_` or `-`. |

Returns `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `digest`, `transactionBytes`, `voucherTitle`, `discountType` and `discountValue`. `digest` and `transactionBytes` are null once the use has settled.

## finalizeVoucherUse

Submits the customer's signature for a use. In a browser, use `auth.signAndFinalizeVoucherUse`.

`POST /v1/rewards/vouchers/use/finalize` · Public: the signature authorizes it

```ts
finalizeVoucherUse(request: { digest: string; signature: string }, options?): Promise<RedeemVoucherResponse>
```

Returns `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `redeemedAt`, `voucherTitle`, `discountType`, `discountValue` and `blockchainDigest`.

## listMemberVouchers

`GET /v1/rewards/members/:memberId/vouchers` · Scope: `read`

```ts
listMemberVouchers(memberId: string, options?): Promise<VoucherOwnershipDto[]>
```

## getVoucherRefundPolicy

Reads the policy the next published voucher takes.

`GET /v1/rewards/refund-policy` · Scope: `read`

```ts
getVoucherRefundPolicy(options?): Promise<VoucherRefundPolicyDto>
```

## setVoucherRefundPolicy

Sets the policy for vouchers published from now on. [Settings](/guides/manage-vouchers/#refunds)

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
