---
title: Webhook events
description: Mọi event mà OctaP gửi, và dữ liệu đi kèm từng event.
---

Mọi event đều có dạng này, và `data` phụ thuộc vào `type`:

```ts
{ id: string; type: WebhookEventType; data: … }
```

`id` không đổi qua các lần retry và replay, và giống nhau ở mọi endpoint, nên hãy khử trùng lặp theo nó.

| Event | Gửi khi | Cách gửi |
| --- | --- | --- |
| [`credits.earned`](#creditsearned) | Lệnh earn được nhận và vẫn đang chờ | Xếp hàng cùng lệnh earn |
| [`credits.earn.confirmed`](#creditsearnconfirmed) | Chain xác nhận lệnh earn | Xếp hàng đúng một lần cho mỗi giao dịch |
| [`credits.earn.failed`](#creditsearnfailed) | Lệnh earn đã nhận chắc chắn thất bại | Xếp hàng cùng lúc ghi nhận thất bại |
| [`credits.redemption.confirmed`](#creditsredemptionconfirmed) | Chain xác nhận lệnh tiêu, cho thanh toán hoặc voucher trả phí | Xếp hàng đúng một lần cho mỗi giao dịch |
| [`credits.reversed`](#creditsreversed) | Lệnh earn hoặc redeem đã xác nhận bị đảo | Xếp hàng cùng lệnh đảo |
| [`voucher.granted`](#vouchergranted) | Chain ghi nhận voucher được tặng hoặc claim miễn phí | Xếp hàng đúng một lần cho mỗi voucher |
| [`voucher.redeemed`](#voucherredeemed) | Khách hàng đã ký và chain đánh dấu voucher đã dùng | Xếp hàng đúng một lần cho mỗi voucher |
| [`budget.low`](#budgetlow) | Ngân sách phát hành vượt mức đã dùng 80% hoặc 95% | Kiểm tra vài phút một lần, mỗi lần vượt gửi một event |
| [`license.usage_threshold`](#licenseusage_threshold) | Số giao dịch trong tháng license chạm 80% hoặc 100% hạn mức của license | Xếp hàng cùng giao dịch, mỗi mốc một lần mỗi tháng license |
| [`license.expiry_notice`](#licenseexpiry_notice) | License còn 30, 7 hoặc 1 ngày là hết hạn, vào thời gian ân hạn, hoặc đã hết hạn | Kiểm tra 15 phút một lần, mỗi mốc gửi một lần |
| [`voucher.created` và các event voucher khác](#event-vòng-đời-voucher) | Voucher được tạo, gửi duyệt, trả về, activate, publish thất bại, tạm dừng hoặc archive | Xếp hàng cùng thay đổi |

Event đã xếp hàng vẫn có thể được retry, nên phía nhận có thể thấy cùng `id` nhiều lần.

## credits.earned

Lệnh earn đang trên đường lên chain. Hãy chờ `credits.earn.confirmed` trước khi coi điểm là tiêu được.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `purchaseAmount` | `number` | |
| `estimatedPoints` | `number` | Số ước tính, không phải số được cộng |
| `newBalance` | `number` | Số dư đã xác nhận, chưa gồm lệnh earn này |
| `campaignId` | `string` | Chỉ có khi một campaign đã nhân điểm cho lệnh earn |

## credits.earn.confirmed

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | Số điểm thực sự được cộng on-chain |
| `newBalance` | `number` | Số dư đã xác nhận ngay sau giao dịch này |
| `blockchainDigest` | `string` | |

## credits.earn.failed

Khoản giữ đã được giải phóng và không có gì được cộng. Key vẫn được tính là đã dùng, nên [thử lại cần key mới](/vi/guides/earn-and-reverse-points/).

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `purchaseAmount` | `number \| null` | Chỉ `null` với giao dịch cũ |
| `estimatedPoints` | `number` | Số ước tính đã giữ |
| `failureCode` | `'BUDGET_EXHAUSTED' \| 'REJECTED'` | `BUDGET_EXHAUSTED`: [yêu cầu top-up](/vi/concepts/issuance-budget/), rồi thử lại. `REJECTED`: mọi thất bại chắc chắn khác. |

## credits.redemption.confirmed

Có cùng các field với `credits.earn.confirmed`, trong đó `pointsAmount` là số điểm bị trừ. Claim voucher trả phí có thêm `voucher`:

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `voucher.voucherOwnershipId` | `string` | Voucher mà lần trừ điểm này mua, giờ đã `AVAILABLE` |
| `voucher.expiresAt` | `string \| null` | Hạn dùng cuối cùng, tính từ lúc chain phát voucher. `expiresAt` trong response của claim chỉ là tạm. |

## credits.reversed

Được xử lý trong sổ cái ngay lập tức. Giao dịch gốc đã xác nhận trên chain cũng được phản ánh on-chain sau đó, và không gửi thêm event riêng.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `reversalTransactionId` | `string` | |
| `reversedTransactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | |
| `newBalance` | `number` | |

## voucher.granted

Khách hàng đã giữ voucher. Claim trả phí báo qua `credits.redemption.confirmed`.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `AVAILABLE` |
| `expiresAt` | `string \| null` | Hạn dùng cuối cùng của khách này, tính từ lúc chain phát voucher. `expiresAt` trong response của grant chỉ là tạm. `null` là không hết hạn. |
| `blockchainDigest` | `string` | |

## voucher.redeemed

Hãy giao quyền lợi khi nhận sự kiện này. Không có điểm nào thay đổi ở đây. Claim trả phí đã gửi `credits.redemption.confirmed` cho chi phí của nó.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `REDEEMED` |
| `redeemedAt` | `string` | |
| `voucherTitle` | `string` | |
| `discountType` | `string \| null` | |
| `discountValue` | `string \| null` | |
| `blockchainDigest` | `string` | Giao dịch do khách hàng ký |

## voucher.member_expired

Voucher của một khách đã tới hạn dùng của riêng nó (`expiresAt`) mà chưa dùng. Voucher chuyển sang `EXPIRED` và không dùng được nữa. Event này đến một lần, trong khoảng một phút sau hạn, hoặc sớm hơn nếu voucher được đọc trước.

| Field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `EXPIRED` |
| `expiresAt` | `string \| null` | Hạn đã qua |

## budget.low

[Ngân sách phát hành](/vi/concepts/issuance-budget/) của bạn sắp cạn. Hãy [yêu cầu top-up](/vi/concepts/issuance-budget/) trước khi lệnh earn bắt đầu bị từ chối.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `threshold` | `80 \| 95` | Mức phần trăm đã dùng vừa vượt |
| `remaining` | `number` | Số điểm còn lại trên mọi shard |
| `capacity` | `number` | Ngân sách ban đầu cộng mọi lần top-up đã áp dụng |


## license.usage_threshold

Số giao dịch của tổ chức bạn trong tháng license này (earn, đổi điểm tại POS và nhận voucher trả phí) đã chạm 80% hoặc 100% mức license cho phép. Quá 100% vẫn nhận tiếp tới 110%, sau đó mỗi giao dịch bị từ chối với 402 `LICENSE_LIMIT_REACHED` cho tới khi tháng license mới bắt đầu ở `periodEnd`. Nâng gói license để tăng hạn mức.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `limit` | `'transactionsMonthly'` | Hạn mức được nói tới |
| `threshold` | `80 \| 100` | Mốc phần trăm đã chạm |
| `used` | `number` | Số giao dịch đã đếm trong tháng license, tính cả giao dịch này |
| `allowed` | `number` | Hạn mức mỗi tháng của license |
| `periodStart` | `string` | Lúc tháng license này bắt đầu |
| `periodEnd` | `string` | Lúc tháng kết thúc và bộ đếm bắt đầu lại |

## license.expiry_notice

License của tổ chức bạn vừa tới một mốc sắp hết hạn. Hãy gia hạn trước `graceEndsAt`.

| `stage` | Khi nào | Những gì vẫn chạy |
| --- | --- | --- |
| `DAYS_30`, `DAYS_7`, `DAYS_1` | 30, 7 hoặc 1 ngày trước `endsAt`. Mốc nhắc dài hơn chính license thì được bỏ qua (trial 14 ngày chỉ nhận `DAYS_7` và `DAYS_1`) | Mọi thứ |
| `GRACE` | Đã qua `endsAt` | Mọi thứ, thêm 7 ngày |
| `EXPIRED` | Đã qua `graceEndsAt` | Mọi thứ trừ giao dịch mới: earn, đổi điểm tại POS và nhận voucher trả phí trả 402 `LICENSE_EXPIRED`. Xác nhận giao dịch, hoàn điểm, số dư và voucher khách đang có vẫn chạy |

Mỗi mốc gửi một lần. License đã được gia hạn thì không gửi gì thêm. Nếu nhiều mốc trôi qua mà không ai kiểm tra, chỉ mốc hiện tại được gửi. Gia hạn được tính tiếp từ `endsAt`, nên gia hạn sớm không mất ngày nào.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `licenseId` | `string` | |
| `stage` | `'DAYS_30' \| 'DAYS_7' \| 'DAYS_1' \| 'GRACE' \| 'EXPIRED'` | |
| `tier` | `string` | `TRIAL`, `STARTER`, `GROWTH` hoặc `ENTERPRISE` |
| `planName` | `string` | |
| `endsAt` | `string` | |
| `graceEndsAt` | `string` | Lúc giao dịch mới bị dừng |
| `daysLeft` | `number` | Số ngày tròn tới `endsAt`, bằng 0 khi đã qua |

## Event vòng đời voucher

`voucher.created`, `voucher.submitted`, `voucher.returned`, `voucher.activated`, `voucher.publish.failed`, `voucher.paused`, `voucher.archived` và `voucher.expired` giúp catalog của bạn khớp với OctaP. Mỗi event được xếp hàng trong cùng database transaction với thay đổi mà nó báo. Mỗi event mang voucher đúng như ngay sau thay đổi đó:

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `voucherId` | `string` | |
| `code` | `string` | |
| `title` | `string` | |
| `batchId` | `string \| null` | Batch tạo ra nó, hoặc batch import nó gần nhất |
| `status` | `string` | `DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `PAUSED`, `ARCHIVED`, … |
| `publishStatus` | `string` | `NOT_PUBLISHED`, `PUBLISHING`, `PUBLISHED` hoặc `FAILED` |
| `suiTermsId` | `string \| null` | Điều khoản on-chain, khi đã publish |
| `createdBy` | `{ type: 'USER' \| 'API_CREDENTIAL'; id: string } \| null` | |
| `activatedBy` | `{ type: 'USER' \| 'API_CREDENTIAL'; id: string } \| null` | Người activate nó, hoặc Owner đã duyệt nó |
| `activatedAt` | `string \| null` | |
| `updatedAt` | `string` | |

| Event | Gửi khi |
| --- | --- |
| `voucher.created` | Một voucher được tạo riêng lẻ hoặc qua batch, hoặc một code đã archive được import lại. Tạo với `ACTIVE` thì sau đó có `voucher.submitted`, hoặc `voucher.activated` khi đã publish. |
| `voucher.submitted` | Một lần activate đang chờ Owner, vì tổ chức của bạn yêu cầu duyệt. Có thêm `approvalRequestId` và `submittedBy`. |
| `voucher.returned` | Một lần gửi duyệt bị từ chối hoặc rút lại, voucher quay về `DRAFT`. Có thêm `approvalRequestId`, `outcome` (`REJECTED` hoặc `WITHDRAWN`), `reason` và `reviewedById`. |
| `voucher.activated` | Voucher đã `ACTIVE` và khách hàng claim được: chain xác nhận điều khoản, hoặc voucher đang tạm dừng được chạy lại. Hãy bắt đầu bán theo event này, không theo response của lệnh activate. |
| `voucher.publish.failed` | Điều khoản không lên được chain. Sửa voucher rồi activate lại. |
| `voucher.paused` | Owner hoặc API key đã tạm dừng nó. Claim dừng lại. |
| `voucher.archived` | Batch của nó bị archive trước khi lên chain. Voucher không dùng được nữa. |
| `voucher.expired` | Thời hạn claim (`expiresAt`) đã đóng khi voucher đang chạy, tạm dừng hoặc hết số lượng. Voucher chuyển sang `EXPIRED`: không ai claim được nữa, và không tạm dừng hay chạy lại được. Voucher khách đã nhận vẫn giữ hạn dùng riêng (`voucher.member_expired`). |

Lần duyệt không có event riêng: việc publish bắt đầu, sau đó là `voucher.activated` hoặc `voucher.publish.failed`. Voucher bị tạm dừng trong lúc publish vẫn tạm dừng sau khi publish xong, nên chỉ gửi `voucher.activated` khi được chạy lại. Hết số lượng không gửi event. Event hết hạn đến trong khoảng một phút sau hạn.
