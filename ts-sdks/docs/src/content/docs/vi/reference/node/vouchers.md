---
title: Voucher
description: Các method Node SDK cho danh mục voucher, claim, tặng voucher, dùng voucher do khách ký và chính sách hoàn tiền.
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
| `discountType` | `'PERCENTAGE' \| 'FIXED_AMOUNT' \| 'FREE_ITEM'` | **Bắt buộc** trừ khi có `terms`. |
| `terms` | `object` | Mô tả lời hứa theo cách của bạn. Publish lên chain, nên không chứa dữ liệu cá nhân. |
| `description` | `string` | |
| `pointsCost` | `number` | Mặc định là 0, tức voucher miễn phí. |
| `discountValue` | `string` | |
| `totalSupply` | `number \| null` | |
| `startsAt` | `string \| null` | Ngày giờ ISO có giây và múi giờ |
| `expiresAt` | `string \| null` | Ngày giờ ISO có giây và múi giờ |
| `metadata` | `object` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED'` | Mặc định là `ACTIVE`, tức publish điều khoản lên chain trước. |

`VoucherDto` có thêm `id`, `organizationId`, `claimedCount`, `publishStatus`, `suiTermsId`, `refundPolicy`, `createdAt` và `updatedAt`.

## updateVoucher

Nhận bất kỳ field nào của `createVoucher`. Từ khi bắt đầu publish, mọi thứ trong điều khoản được cố định; metadata, số lượng và trạng thái thì không. [Hướng dẫn](/vi/guides/manage-vouchers/)

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
| `idempotencyKey` | `string` | **Bắt buộc.** 1–100 chữ cái, chữ số, `:`, `_` hoặc `-`. |

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | Dùng với `getVoucherClaim`. |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | Dùng với `prepareVoucherUse` khi đã `AVAILABLE`. |
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

## grantVoucher

Tặng voucher cho khách hàng mà không tiêu điểm của họ. Voucher ở `RESERVED` cho đến khi chain ghi nhận, và `voucher.granted` sẽ báo điều đó. [Hướng dẫn](/vi/guides/manage-vouchers/)

`POST /v1/rewards/vouchers/:id/grant` · Scope: `write`

```ts
grantVoucher(voucherId: string, request: GrantVoucherRequest, options?): Promise<ClaimVoucherResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Bắt buộc.** Một UUID. |
| `idempotencyKey` | `string` | **Bắt buộc.** 1–100 chữ cái, chữ số, `:`, `_` hoặc `-`. |

## prepareVoucherUse

Yêu cầu khách hàng dùng voucher. Trả về bytes để thiết bị của họ ký, và chưa đánh dấu gì là đã dùng. [Hướng dẫn](/vi/guides/claim-a-paid-voucher/)

`POST /v1/rewards/vouchers/use` · Scope: `write`

```ts
prepareVoucherUse(request: PrepareVoucherUseRequest, options?): Promise<PrepareVoucherUseResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `serialCode` | `string` | **Bắt buộc.** 1–100 chữ cái, chữ số, `_` hoặc `-`. |
| `idempotencyKey` | `string` | **Bắt buộc.** 1–100 chữ cái, chữ số, `:`, `_` hoặc `-`. |

Trả về `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `digest`, `transactionBytes`, `voucherTitle`, `discountType` và `discountValue`. `digest` và `transactionBytes` là null khi lượt dùng đã kết thúc.

## finalizeVoucherUse

Gửi chữ ký của khách hàng cho một lượt dùng. Trên trình duyệt, hãy dùng `auth.signAndFinalizeVoucherUse`.

`POST /v1/rewards/vouchers/use/finalize` · Công khai: chữ ký là thứ cho phép

```ts
finalizeVoucherUse(request: { digest: string; signature: string }, options?): Promise<RedeemVoucherResponse>
```

Trả về `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `redeemedAt`, `voucherTitle`, `discountType`, `discountValue` và `blockchainDigest`.

## listMemberVouchers

`GET /v1/rewards/members/:memberId/vouchers` · Scope: `read`

```ts
listMemberVouchers(memberId: string, options?): Promise<VoucherOwnershipDto[]>
```

## getVoucherRefundPolicy

Đọc chính sách mà voucher publish tiếp theo sẽ dùng.

`GET /v1/rewards/refund-policy` · Scope: `read`

```ts
getVoucherRefundPolicy(options?): Promise<VoucherRefundPolicyDto>
```

## setVoucherRefundPolicy

Đặt chính sách cho các voucher publish từ bây giờ. [Thiết lập](/vi/guides/manage-vouchers/)

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
