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
| `campaignId` | `string` | Campaign có hệ số nhân áp dụng. Campaign phải thuộc tổ chức của bạn, đang `ACTIVE`, trong thời hạn và có hệ số nhân, nếu không lệnh earn trả 422. Bỏ trống cho lệnh earn thường. |

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

## listCampaigns

Liệt kê các campaign của bạn, mới nhất trước, không gồm campaign đã lưu trữ. Owner tạo và duyệt campaign trên console; máy POS đọc ở đây để cho thu ngân chọn.

`GET /v1/campaigns` · Scope: `read`

```ts
listCampaigns(query?: { live?: boolean }, options?): Promise<CampaignDto[]>
```

Với `live: true`, chỉ trả các campaign có `earnBoostLive` là `true`: đang `ACTIVE`, trong khoảng `startsAt`–`endsAt` và có `multiplierBps`. Gửi `id` được chọn làm `campaignId` trong [`earnPoints`](#earnpoints).

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `id` | `string` | Gửi làm `campaignId` |
| `name`, `description` | `string`, `string \| null` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED' \| 'ENDED' \| 'ARCHIVED'` | |
| `startsAt`, `endsAt` | `string` | ISO 8601 |
| `multiplierBps` | `number \| null` | 20000 là x2. `null` với campaign chỉ gom voucher |
| `earnBoostLive` | `boolean` | Lệnh earn gửi kèm campaign này có đang được nhân điểm không |

Campaign có thể hết hiệu lực giữa lúc lấy danh sách và lúc earn, khi đó lệnh earn trả 422: earn lại không kèm `campaignId`, hoặc lấy lại danh sách.

## getCampaign

`GET /v1/campaigns/:campaignId` · Scope: `read`

```ts
getCampaign(campaignId: string, options?): Promise<CampaignDto>
```

Campaign của tổ chức khác trả 404.

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

## getIssuanceBudget

Đọc số điểm chương trình của bạn còn được phát, trực tiếp từ chain. [Khái niệm](/vi/concepts/issuance-budget/)

`GET /v1/credits/budget` · Scope: `read`

```ts
getIssuanceBudget(options?): Promise<IssuanceBudgetDto>
```

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationId` | `string` | |
| `remaining` | `number` | Số điểm còn lại trên mọi shard. Các lệnh earn đang xử lý chưa bị trừ. |
| `initialBudget` | `number` | Số đặt khi provision, trước mọi lần top-up |
| `capacity` | `number` | `initialBudget` cộng mọi lần top-up đã áp dụng |
| `warningThreshold` | `80 \| 95 \| null` | Mức phần trăm đã dùng mà shard đầy nhất đã vượt |
| `shards` | `{ shardId, remaining }[]` | Shard không mượn nhau |
| `recentTopUps` | `{ operationId, amount, status, createdAt }[]` | Mới nhất trước, tối đa 20 |
| `observedAt` | `string` | Thời điểm đọc, theo ISO 8601 |

Ném `OctaApiError` với status 404 nếu bạn không có chương trình đang hoạt động, và 503 nếu không đọc được chain.

## listTransactions

Liệt kê giao dịch của thành viên theo từng trang, mới nhất trước.

`GET /v1/credits/members/:memberId/transactions` · Scope: `read`

```ts
listTransactions(memberId: string, options?: RequestOptions & { limit?: number; cursor?: string }): Promise<LoyaltyTransactionPage>
```

Trả về `{ items, nextCursor }`. `limit` từ 1 đến 100, mặc định 25. Để đọc trang tiếp theo, truyền lại `nextCursor` vào `cursor`; ở trang cuối `nextCursor` là `null`. `cursor` không thuộc giao dịch của thành viên này trả về 400.

```ts
let cursor: string | undefined;
do {
  const page = await client.listTransactions(memberId, { limit: 100, cursor });
  for (const tx of page.items) handle(tx);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Với lệnh earn chưa xác nhận, `pointsAmount` là `null` và `estimatedPoints` chứa số ước tính. Lệnh earn thất bại có `null` ở cả hai.

## listOrganizationTransactions

Liệt kê giao dịch của cả tổ chức, mới nhất trước, kèm bằng chứng trên Sui của mỗi giao dịch đã xác nhận. Gắn `blockchainDigest` vào một Sui explorer để khách hàng thấy bản ghi công khai.

`GET /v1/credits/transactions` · Scope: `read`

```ts
listOrganizationTransactions(query?: OrganizationTransactionQuery, options?): Promise<LoyaltyTransactionPage>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `type` | `LoyaltyTxType` | Chỉ loại này, ví dụ `EARN` |
| `status` | `LoyaltyTxStatus` | Chỉ trạng thái này, ví dụ `CONFIRMED` |
| `memberId` | `string` | Chỉ thành viên này |
| `limit` | `number` | 1–100 |
| `cursor` | `string` | `nextCursor` của trang trước |

Trả về `{ items, nextCursor }`, như `listTransactions`. Giao dịch đã xác nhận có `blockchainDigest` và `confirmedAt`. Cursor vẫn dùng được khi trạng thái của giao dịch đó đổi sau này.

## getProgram

Đọc chương trình của bạn và chính sách tích điểm đã công bố trên Sui, đặt cạnh luật mà OctaP đang áp dụng.

`GET /v1/credits/program` · Scope: `read`

```ts
getProgram(options?): Promise<ProgramEvidence>
```

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `programId` | `string` | |
| `status` | `string` | |
| `earnBps` | `number` | Tỉ lệ tích điểm OctaP áp dụng, tính theo basis point |
| `expiryMs` | `number` | Thời hạn của điểm đã tích |
| `policyStatus` | `'MATCH' \| 'MISMATCH' \| 'UNAVAILABLE'` | `MATCH` khi luật trên chain đúng là luật OctaP áp dụng. `UNAVAILABLE` khi không đọc được chain. |
| `policy` | `ProgramPolicyEvidence \| null` | Chính sách trên chain: `version`, `earnBps`, `expiryMs`, `publishedDigest`, `publishedAt`. `null` khi `UNAVAILABLE`. |

## getBalanceReconciliation

So số dư của một thành viên mà OctaP ghi nhận với số `CreditAccount` của họ trên Sui có thể chi.

`GET /v1/credits/members/:memberId/reconciliation` · Scope: `read`

```ts
getBalanceReconciliation(memberId: string, options?): Promise<BalanceReconciliation>
```

| Field trả về | Kiểu | Mô tả |
| --- | --- | --- |
| `status` | `'MATCH' \| 'PENDING' \| 'MISMATCH' \| 'UNAVAILABLE'` | `PENDING`: vẫn còn thao tác của thành viên này đang lên chain, hãy hỏi lại sau ít giây. `MISMATCH`: không còn gì đang xử lý mà hai số vẫn khác nhau. |
| `creditAccountId` | `string \| null` | `null` trước lần tích điểm đầu tiên của thành viên |
| `recordedBalance` | `number` | `confirmedBalance` của OctaP |
| `ledgerBalance` | `number \| null` | Số chain cho biết có thể chi; `null` khi `UNAVAILABLE` |
| `difference` | `number \| null` | `ledgerBalance - recordedBalance` |
| `checkedAt` | `string` | ISO 8601. Kết quả được cache tối đa 30 giây. |

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
| `orderReference` | `string` | **Bắt buộc.** Mã đơn hàng của bạn, 1–100 ký tự, không chứa dữ liệu cá nhân. |
| `discountAmount` | `number` | **Bắt buộc.** Mức giảm cho đơn đó, theo đơn vị chính của `currency`. Lớn hơn 0. |
| `currency` | `string` | **Bắt buộc.** Mã ISO 4217, ví dụ `VND`. |

Ba tham số cuối được hash vào giao dịch redeem on-chain mà khách hàng ký.

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

Trả về `reversalTransactionId`, `reversedTransactionId`, `organizationEndUserId`, `pointsAmount`, `newBalance` và `idempotencyKey`. Lệnh earn có điểm đã bị tiêu, đang bị lệnh đổi điểm giữ lại, hoặc sẽ hết hạn trong 10 phút thì không đảo được: `409`.
