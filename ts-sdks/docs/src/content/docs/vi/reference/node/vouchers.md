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
| `perMemberLimit` | `number \| null` | Số voucher loại này một thành viên được giữ, tính cả voucher đã dùng hoặc hết hạn, kể cả khi sau đó được hoàn; không tính voucher đã hủy (gồm voucher chưa dùng đã được hoàn). `null` là không giới hạn. Claim hoặc grant vượt giới hạn trả 409. |
| `startsAt` | `string \| null` | Ngày giờ ISO có giây và múi giờ |
| `expiresAt` | `string \| null` | Ngày giờ ISO có giây và múi giờ |
| `validForDays` | `number \| null` | Voucher của mỗi khách dùng được bấy nhiêu ngày kể từ lúc nhận, không quá `expiresAt`. Từ 1 đến 3650; `null` nghĩa là mọi voucher hết hạn vào `expiresAt`. Không đổi được sau khi bắt đầu publish. |
| `metadata` | `object` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED'` | Mặc định là `ACTIVE`, tức publish điều khoản lên chain trước. Nếu tổ chức bật yêu cầu duyệt, `ACTIVE` đưa voucher vào `PENDING_APPROVAL` cho đến khi Owner duyệt trong console. Mở lại voucher đã publish thì không cần duyệt. |
| `campaignId` | `string` | Campaign của bạn (không `ENDED` hoặc `ARCHIVED`) mà voucher tham gia. Chỉ đặt lúc tạo. |

`expiresAt` của một claim hoặc voucher của thành viên là hạn riêng của khách đó. `VoucherDto` có thêm `id`, `organizationId`, `claimedCount`, `publishStatus`, `suiTermsId`, `refundPolicy`, `approval`, `batchId`, `campaignId`, `createdBy`, `activatedBy`, `activatedAt`, `createdAt` và `updatedAt`. `createdBy` là người tạo voucher, `activatedBy` là người đưa nó lên live (người bấm activate, hoặc Owner đã duyệt). Cả hai có dạng `{ type: 'USER' | 'API_CREDENTIAL', id }`, hoặc `null` khi không có ghi nhận (voucher tạo trước khi Core lưu thông tin này) hoặc khi user hay key đó đã bị xoá. `activatedAt` là lúc bắt đầu publish. `approval` là yêu cầu duyệt gần nhất, `null` nếu chưa từng có. `submittedBy` là `null` khi user hoặc key đó đã bị xoá. Các field: `id` (lượt gửi duyệt mà Owner duyệt hoặc từ chối), `status` (`PENDING`, `APPROVED`, `REJECTED` hoặc `WITHDRAWN`), `submittedBy` (`{ type: 'USER' | 'API_CREDENTIAL', id }`), `submittedAt`, `reviewedById`, `reviewedAt`, `reason` (lý do từ chối) và `snapshot` (điều khoản lúc gửi duyệt, cũng là thứ sẽ được publish khi duyệt; `null` với lượt gửi trước khi Core lưu bản chụp).

## updateVoucher

Nhận bất kỳ field nào của `createVoucher`. Từ khi bắt đầu publish, mọi thứ trong điều khoản được cố định; metadata, số lượng, `perMemberLimit` và trạng thái thì không. `validForDays` thuộc điều khoản. [Hướng dẫn](/vi/guides/manage-vouchers/)

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

## createVouchers

`POST /v1/rewards/voucher-batches` · Scope: `write`

```ts
createVouchers(items: VoucherBatchItem[], batchOptions?: { dryRun?: boolean; name?: string; campaignId?: string }, options?): Promise<CreateVoucherBatchResponse>
```

Tạo tối đa 100 voucher thành một lô **DRAFT**. Chưa voucher nào live cho đến khi gọi `activateVoucherBatch`. Mỗi item nhận các field của `createVoucher`, trừ `status`; gửi `status` thì item đó lỗi. Không có item nào hoặc quá 100 item thì cả request trả 400.

Với `dryRun: true`, Core chạy mọi kiểm tra và trả kết quả từng item nhưng không ghi gì: dùng để xem trước một file. `name` đặt tên cho lô, ví dụ tên file (tối đa 120 ký tự, không cần duy nhất). `campaignId` đưa mọi voucher lô tạo ra vào campaign đó; từng item không được gửi riêng.

Mỗi item được xử lý riêng, và `items[i]` của response mô tả `items[i]`. `code` là khoá:

| Voucher đang giữ `code` | Giá trị giống hệt | Giá trị khác |
| --- | --- | --- |
| Chưa có | `created` | `created` |
| Đã publish, đang publish hoặc đang chờ duyệt | `unchanged` | `conflict`: giữ nguyên |
| Nháp của lô đang mở, hoặc tạo lẻ | `unchanged` | `conflict`: giữ nguyên |
| `ARCHIVED` (nháp của lô đã archive) | `unchanged`, về lại `DRAFT` ở lô này (`movedToBatch: true`) | `replaced`: nhận giá trị mới, thành `DRAFT` ở lô này |

`error` nghĩa là item không được ghi: `error.code` là `INVALID` (kèm `field`) hoặc `DUPLICATE_IN_BATCH` (cùng `code` với một item trước đó trong request). `conflict` và `replaced` trả `differences: [{ field, stored, sent }]`.

Giá trị được so sau khi chuẩn hoá: field không gửi coi như giá trị mặc định, ngày so theo thời điểm (`…Z` bằng `…+07:00` nếu cùng một lúc), `"20"` bằng `"20.00"`, và key của object theo thứ tự nào cũng được. Vì vậy gửi lại nguyên danh sách vẫn an toàn: chỉ item mới được tạo. Muốn đổi điều khoản của một `code` đã live thì dùng `code` mới.

`batch` là `null` khi dry run, và khi không item nào vào lô (toàn `unchanged`, `conflict` hoặc `error`).

## parseVoucherCsv

Không gọi API: chạy ngay trong tiến trình của bạn.

```ts
parseVoucherCsv(text: string, options?: { utcOffset?: string }): ParsedVoucherCsv
```

Đọc file CSV theo mẫu voucher của Octap (đúng file mà console import, `VOUCHER_CSV_TEMPLATE`) thành các item cho `createVouchers`. Hàm kiểm tra giống console: dòng không đọc được, sai luật, hoặc trùng `code` với dòng trước sẽ có `problem` ghi rõ cột CSV, và không nằm trong `items`. Core vẫn kiểm tra lại mọi item nhận được.

```ts
import { readFile } from 'node:fs/promises';
import { parseVoucherCsv } from '@octap/sdk';

const { items, rows, error } = parseVoucherCsv(await readFile('rewards.csv', 'utf8'));
if (error) throw new Error(error); // file rỗng, thiếu cột, quá 100 dòng
for (const row of rows) if (row.problem) console.warn(`dòng ${row.line}: ${row.problem}`);
const preview = await client.createVouchers(items, { dryRun: true });
```

- `rows`: mọi dòng, kèm `line` (dòng tiêu đề là dòng 1), `code`, và `item` hoặc `problem`. `items[i]` là item của `rows.filter((row) => row.item)[i]`, nên `index` trong kết quả dẫn về đúng dòng.
- Ngày: `claims_open_on` bắt đầu lúc 00:00:00, `claims_close_on` kết thúc lúc 23:59:59 của ngày đó theo `utcOffset` (mặc định `+07:00`). Ngày bị Excel đổi định dạng (`31/12/2027`, `12/31/2027`) vẫn đọc được; ngày có thể hiểu theo hai cách thì bị từ chối.
- `code` để trống thì được tạo từ tiêu đề, giống console (`suggestVoucherCode`).

### Điều khoản ưu đãi (`octap.benefit.v1`)

Console hiển thị ưu đãi của voucher từ `terms`. Muốn voucher hiện trên console giống voucher tạo ở console, hãy ghi `terms` theo dạng này (`parseVoucherCsv` đã làm sẵn):

| Cột `type` | `terms.kind` | `discountType` | Các trường khác trong `terms` |
| --- | --- | --- | --- |
| `percent_off` | `PERCENT_OFF` | `PERCENTAGE` (`discountValue`: 1–100) | `maxDiscountVnd` |
| `amount_off` | `AMOUNT_OFF` | `FIXED_AMOUNT` (`discountValue`: VND) | |
| `free_item` | `FREE_ITEM` | `FREE_ITEM` | `item` |
| `buy_x_get_y` | `BUY_X_GET_Y` | không có | `buyQuantity`, `getQuantity`, `item` |
| `free_shipping` | `FREE_SHIPPING` | không có | `maxDiscountVnd` |
| `fixed_price` | `FIXED_PRICE` | không có | `priceVnd`, `item` |
| `custom` | `CUSTOM` | không có | `benefit` |

Loại nào cũng có `schema: "octap.benefit.v1"`, và có thể có `minOrderVnd`, `appliesTo`. Số tiền là số, đơn vị VND. `terms` được ghi lên chain khi activate và không bao giờ đổi được.

## listVoucherBatches

`GET /v1/rewards/voucher-batches` · Scope: `read`

```ts
listVoucherBatches(query?: { includeArchived?: boolean }, options?): Promise<VoucherBatchDto[]>
```

Mới nhất trước. Chỉ có lô đã archive khi truyền `includeArchived: true`. Mỗi lô có `name`, `source` (`API` hoặc `CONSOLE`), `createdBy`, `archivedAt` và `statusCounts` (ví dụ `{ DRAFT: 98, ACTIVE: 2 }`).

## getVoucherBatch

`GET /v1/rewards/voucher-batches/:batchId` · Scope: `read`

```ts
getVoucherBatch(batchId: string, options?): Promise<VoucherBatchDetailDto>
```

Lô kèm danh sách voucher. Lô của tổ chức khác trả 404.

## activateVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/activate` · Scope: `write`

```ts
activateVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Activate mọi nháp trong lô, mỗi voucher qua đúng các kiểm tra như khi activate riêng, chạy lại tại thời điểm gọi. Kết quả từng voucher có `outcome` và `status` sau khi gọi:

| `outcome` | Ý nghĩa |
| --- | --- |
| `publishing` | Điều khoản đang được đưa lên chain; thành `ACTIVE` khi chain xác nhận |
| `pendingApproval` | Tổ chức của bạn bật yêu cầu duyệt: voucher chờ Owner duyệt trong console |
| `skipped` | Đã publish, đang publish, hoặc đang chờ Owner duyệt, nên gọi lại vẫn an toàn; `status` cho biết là trường hợp nào |
| `failed` | Vẫn là `DRAFT`; `reason` cho biết lý do (ví dụ còn dưới 24 giờ tới `expiresAt`) |

Chưa có loyalty program trên chain thì trả 422; lô đã archive thì trả 409. Việc publish chạy vài voucher mỗi lượt, nên lô lớn mất vài phút mới live hết.

## pauseVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/pause` · Scope: `write`

```ts
pauseVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Tạm dừng mọi voucher của lô đang live hoặc đang publish (`outcome: "paused"`): thành viên không claim được nữa, còn voucher họ đã giữ vẫn dùng được. Nháp và voucher đang chờ duyệt thì `skipped`. Dùng hàm này để dừng một đợt khuyến mãi: archive lô không dừng được claim. Lô đã archive cũng tạm dừng được.

## resumeVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/resume` · Scope: `write`

```ts
resumeVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Chạy lại mọi voucher đang tạm dừng của lô đã publish (`outcome: "resumed"`). Chạy lại không cần duyệt, vì điều khoản trên chain không đổi. Voucher không chạy lại được (ví dụ đã hết hạn claim) thì `failed`, kèm `reason`.

Duyệt hoặc từ chối cả lô là việc của Owner, chỉ làm trong console, giống voucher lẻ.

## archiveVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/archive` · Scope: `write`

```ts
archiveVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Dành cho lô bạn không dùng nữa (nhầm file, huỷ đợt khuyến mãi). Lô bị ẩn khỏi `listVoucherBatches` và không activate được nữa. Mọi voucher chưa từng live trong lô thành `ARCHIVED` (`outcome: "archived"`; voucher đang chờ duyệt thì yêu cầu duyệt bị rút lại): không sửa, gửi duyệt hay live được nữa. Import lại `code` của nó thì nó về lại `DRAFT` ở lô mới. Voucher đã live vẫn live (`skipped`): muốn dừng claim thì tạm dừng lô. Không có un-archive.

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

## listVoucherRefundPolicyHistory

Liệt kê các phiên bản chính sách, mới nhất trước. Owner publish phiên bản mới trên Console; không API key nào làm được. [Thiết lập](/vi/guides/manage-vouchers/)

`GET /v1/rewards/refund-policy/history` · Scope: `read`

```ts
listVoucherRefundPolicyHistory(query?: { limit?: number; beforeVersion?: number }, options?): Promise<VoucherRefundPolicyDto[]>
```

`limit` từ 1 đến 100, mặc định 50. `beforeVersion` là cursor loại trừ: truyền phiên bản cuối của trang trước.
