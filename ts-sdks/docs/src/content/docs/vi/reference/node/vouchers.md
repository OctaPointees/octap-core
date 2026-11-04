---
title: Voucher
description: Các method Node SDK cho danh mục voucher, claim, redeem và chính sách hoàn tiền.
---

## createVoucher

`POST /v1/rewards/vouchers` · Scope: `write`

```ts
createVoucher(request: CreateVoucherRequest, options?): Promise<VoucherDto>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `code` | `string` | **Bắt buộc.** Duy nhất trong tổ chức của bạn. |
| `title` | `string` | **Bắt buộc.** |
| `discountType` | `'PERCENTAGE' \| 'FIXED_AMOUNT' \| 'FREE_ITEM'` | **Bắt buộc.** |
| `description` | `string` | |
| `pointsCost` | `number` | Mặc định là 0, tức voucher miễn phí. |
| `discountValue` | `string` | |
| `totalSupply` | `number \| null` | |
| `startsAt` | `string \| null` | Ngày giờ ISO có giây và múi giờ |
| `expiresAt` | `string \| null` | Ngày giờ ISO có giây và múi giờ |
| `metadata` | `object` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED'` | Mặc định là `ACTIVE`. |

`VoucherDto` có thêm `id`, `organizationId`, `claimedCount`, `createdAt` và `updatedAt`.

## updateVoucher

Nhận bất kỳ field nào của `createVoucher`. Sau lần claim đầu tiên, `code`, `pointsCost`, giảm giá và các mốc ngày được cố định. [Hướng dẫn](/vi/guides/manage-vouchers/)

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

Giữ chỗ một voucher. Claim trả phí ở trạng thái `RESERVED` cho đến khi chain xác nhận. [Hướng dẫn](/vi/guides/claim-a-paid-voucher/)

`POST /v1/rewards/vouchers/:id/claim` · Scope: `write`

```ts
claimVoucher(voucherId: string, request: ClaimVoucherRequest, options?): Promise<ClaimVoucherResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Bắt buộc.** Một UUID. |
| `idempotencyKey` | `string` | **Bắt buộc với claim trả phí.** 1–100 chữ cái, chữ số, `:`, `_` hoặc `-`. |

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | Dùng với `getVoucherClaim`. |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | Dùng với `redeemVoucher` khi đã `AVAILABLE`. |
| `status` | [`VoucherOwnershipStatus`](/vi/reference/status-values/) | |
| `pointsDeducted` | `number` | Bằng 0 cho đến khi chain xác nhận. |
| `pointsCost` | `number` | |
| `transactionId` | `string \| null` | Giao dịch `REDEEM`. Dùng để đảo claim. |
| `digest` | `string \| null` | Có trong response của claim khi `RESERVED` |
| `transactionBytes` | `string \| null` | Có trong response của claim khi `RESERVED` |
| `refundPolicy` | `VoucherRefundPolicySnapshot` | Điều khoản lưu cùng claim này |
| `claimedAt` | `string` | |
| `expiresAt` | `string \| null` | |

## getVoucherClaim

Đọc trạng thái đã lưu của claim. Không trả về signing bytes hay digest.

`GET /v1/rewards/claims/:id` · Scope: `read`

```ts
getVoucherClaim(ownershipId: string, options?): Promise<ClaimVoucherResponse>
```

## finalizeVoucherClaim

Gửi chữ ký của khách hàng cho một claim, trên cùng route với `finalizePosRedemption`. API key của bạn không phải thứ xác nhận lệnh này.

`POST /v1/credits/redeem/finalize` · Public: chữ ký xác nhận lệnh này

```ts
finalizeVoucherClaim(request: { digest: string; signature: string }, options?): Promise<FinalizePosRedemptionResponse>
```

## redeemVoucher

Dùng một voucher đã claim. Không có điểm nào thay đổi. Mỗi serial chỉ redeem được một lần.

`POST /v1/rewards/vouchers/redeem` · Scope: `write`

```ts
redeemVoucher(request: RedeemVoucherRequest, options?): Promise<RedeemVoucherResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `serialCode` | `string` | **Bắt buộc.** 1–100 chữ cái, chữ số, `_` hoặc `-`. |
| `receiptReference` | `string` | Mã tham chiếu của bạn. |

Trả về `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `redeemedAt`, `voucherTitle`, `discountType` và `discountValue`.

## listMemberVouchers

`GET /v1/rewards/members/:memberId/vouchers` · Scope: `read`

```ts
listMemberVouchers(memberId: string, options?): Promise<VoucherOwnershipDto[]>
```

## getVoucherRefundPolicy

Đọc điều khoản cho các claim sau này.

`GET /v1/rewards/refund-policy` · Scope: `read`

```ts
getVoucherRefundPolicy(options?): Promise<VoucherRefundPolicyDto>
```

## setVoucherRefundPolicy

Publish điều khoản mới cho các claim sau này. [Thiết lập](/vi/guides/manage-vouchers/)

`PUT /v1/rewards/refund-policy` · Scope: `admin`

```ts
setVoucherRefundPolicy(request: SetVoucherRefundPolicyRequest, options?): Promise<VoucherRefundPolicyDto>
```

## listVoucherRefundPolicyHistory

Liệt kê các phiên bản chính sách, mới nhất trước.

`GET /v1/rewards/refund-policy/history` · Scope: `admin`

```ts
listVoucherRefundPolicyHistory(query?: { limit?: number; beforeVersion?: number }, options?): Promise<VoucherRefundPolicyDto[]>
```

`limit` từ 1 đến 100, mặc định 50. `beforeVersion` là cursor loại trừ: truyền phiên bản cuối của trang trước.
