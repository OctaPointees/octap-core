---
title: Định danh và credits
description: Các method Node SDK để xác minh khách hàng, earn, đọc số dư và tiêu điểm.
---

## verifyCustomer

Kiểm tra id_token của khách hàng. Không ghi gì.

`POST /v1/identity/verify` · Scope: `read`

```ts
verifyCustomer(idToken: string, options?): Promise<VerifyCustomerResponse>
```

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `endUserId` | `string \| null` | `null` nếu tài khoản Google này chưa từng đăng nhập vào OctaP |
| `suiAddress` | `string` | Địa chỉ của khách hàng |
| `memberId` | `string \| null` | ID của họ trong tổ chức của bạn. `null` cho đến khi đăng ký. |
| `active` | `boolean` | Chỉ true khi các thao tác phần thưởng sẽ chấp nhận thành viên này |

Ném `OctaApiError` với status 401 nếu token không hợp lệ hoặc hết hạn.

## earnPoints

Nhận một lệnh earn cho giao dịch mua. [Hướng dẫn](/vi/guides/earn-and-reverse-points/)

`POST /v1/credits/earn` · Scope: `write`

```ts
earnPoints(request: EarnPointsRequest, options?): Promise<EarnPointsResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Bắt buộc.** Thành viên. |
| `purchaseAmount` | `number` | **Bắt buộc.** Số nguyên dương an toàn, theo đơn vị nhỏ nhất của loại tiền. |
| `idempotencyKey` | `string` | **Bắt buộc.** Không đổi qua các lần thử lại. |
| `receiptReference` | `string` | Mã tham chiếu của bạn. |
| `metadata` | `object` | Dữ liệu của bạn, lưu cùng giao dịch. |

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `purchaseAmount` | `number \| null` | Chỉ `null` với giao dịch cũ |
| `estimatedPoints` | `number \| null` | Có giá trị khi `PENDING` |
| `pointsEarned` | `number \| null` | Số điểm thực tế, sau khi xác nhận |
| `newBalance` | `number` | Số dư đã xác nhận, chưa gồm lệnh earn đang chờ này |
| `status` | [`LoyaltyTxStatus`](/vi/reference/status-values/) | |
| `idempotencyKey` | `string` | |

## getBalance

Đọc số dư của thành viên.

`GET /v1/credits/members/:memberId/balance` · Scope: `read`

```ts
getBalance(memberId: string, options?): Promise<CreditBalanceSnapshot>
getBalance(programId: string, memberId: string, options?): Promise<BalanceSnapshot>
```

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationEndUserId` | `string` | |
| `confirmedBalance` | `number` | Số điểm tiêu được |
| `pendingEarn` | `number` | Số điểm ước tính đang về |
| `pendingRedemption` | `number` | Số điểm đang giữ cho một lệnh tiêu |
| `lifetimeEarned` | `number` | |
| `lifetimeRedeemed` | `number` | |
| `asOfCheckpoint` | `string \| null` | Checkpoint Sui gần nhất đã index |
| `observedAt` | `string` | Thời điểm đọc, theo ISO 8601 |
| `stale` | `boolean` | True khi còn khoản đang chờ |

Khi có `programId`, giá trị có thể là ID dòng hoặc ID on-chain của chương trình, các giá trị khác nhận 404. Dạng này trả về `BalanceSnapshot`: `confirmed_balance`, `pending_earn` và `pending_redemption` dạng chuỗi, cùng `as_of_checkpoint`, `observed_at` và `stale`.

## listTransactions

Liệt kê giao dịch của thành viên.

`GET /v1/credits/members/:memberId/transactions` · Scope: `read`

```ts
listTransactions(memberId: string, options?: RequestOptions & { limit?: number }): Promise<LoyaltyTransactionDto[]>
```

`limit` mặc định là 50. Với lệnh earn chưa xác nhận, `pointsAmount` là `null` và `estimatedPoints` chứa số ước tính. Lệnh earn thất bại có `null` ở cả hai.

## reservePosRedemption

Giữ điểm của thành viên và trả về bytes để họ ký. [Hướng dẫn](/vi/guides/redeem-points-at-checkout/)

`POST /v1/credits/redeem/reserve` · Scope: `write`

```ts
reservePosRedemption(request: ReservePosRedemptionRequest, options?): Promise<ReservePosRedemptionResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Bắt buộc.** |
| `pointsAmount` | `number` | **Bắt buộc.** Lớn hơn 0. |
| `idempotencyKey` | `string` | **Bắt buộc.** |

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | |
| `digest` | `string \| null` | Chỉ `null` nếu key này đã xử lý xong |
| `transactionBytes` | `string \| null` | Base64, để khách hàng ký |
| `status` | [`LoyaltyTxStatus`](/vi/reference/status-values/) | |
| `idempotencyKey` | `string` | |

## finalizePosRedemption

Gửi chữ ký của khách hàng. Hủy request không hoàn tác được giao dịch đã gửi.

`POST /v1/credits/redeem/finalize` · Public: chữ ký xác nhận lệnh này

```ts
finalizePosRedemption(request: { digest: string; signature: string }, options?): Promise<FinalizePosRedemptionResponse>
```

Trả về `transactionId`, `organizationEndUserId`, `pointsRedeemed`, `newBalance`, `status` và `blockchainDigest`.

## reverseTransaction

Đảo một giao dịch `EARN` hoặc `REDEEM` đã xác nhận. [Hướng dẫn](/vi/guides/earn-and-reverse-points/)

`POST /v1/credits/transactions/:transactionId/reverse` · Scope: `write`

```ts
reverseTransaction(request: ReverseTransactionRequest, options?): Promise<ReverseTransactionResponse>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | **Bắt buộc.** Giao dịch cần đảo. |
| `idempotencyKey` | `string` | **Bắt buộc.** |
| `reason` | `string` | **Bắt buộc.** |

Trả về `reversalTransactionId`, `reversedTransactionId`, `organizationEndUserId`, `pointsAmount`, `newBalance`, `balanceWentNegative` và `idempotencyKey`.
