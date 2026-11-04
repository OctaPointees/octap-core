---
title: Webhook events
description: Mọi event mà OctaP gửi, và dữ liệu đi kèm từng event.
---

Mọi event đều có dạng này, và `data` phụ thuộc vào `type`:

```ts
{ id: string; type: WebhookEventType; data: … }
```

`id` không đổi qua các lần retry và replay, nên hãy khử trùng lặp theo nó.

| Event | Gửi khi | Cách gửi |
| --- | --- | --- |
| [`credits.earned`](#creditsearned) | Lệnh earn được nhận và vẫn đang chờ | Best-effort |
| [`credits.earn.confirmed`](#creditsearnconfirmed) | Chain xác nhận lệnh earn | Xếp hàng đúng một lần cho mỗi giao dịch |
| [`credits.redemption.confirmed`](#creditsredemptionconfirmed) | Chain xác nhận lệnh tiêu, cho thanh toán hoặc voucher trả phí | Xếp hàng đúng một lần cho mỗi giao dịch |
| [`credits.reversed`](#creditsreversed) | Lệnh earn hoặc redeem đã xác nhận bị đảo | Xếp hàng cùng lệnh đảo |
| [`voucher.redeemed`](#voucherredeemed) | Một serial voucher được sử dụng | Xếp hàng cùng lệnh redeem |

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

## credits.earn.confirmed

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | Số điểm thực sự được cộng on-chain |
| `newBalance` | `number` | Số dư đã xác nhận ngay sau giao dịch này |
| `blockchainDigest` | `string` | |

## credits.redemption.confirmed

Có cùng các field với `credits.earn.confirmed`, trong đó `pointsAmount` là số điểm bị trừ.

## credits.reversed

Được xử lý trong sổ cái ngay lập tức. Giao dịch gốc đã xác nhận trên chain cũng được phản ánh on-chain sau đó, và không gửi thêm event riêng.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `reversalTransactionId` | `string` | |
| `reversedTransactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `pointsAmount` | `number` | |
| `newBalance` | `number` | |
| `balanceWentNegative` | `boolean` | True khi đảo một lệnh earn đã bị tiêu và để lại khoản nợ |

## voucher.redeemed

Không có điểm nào thay đổi ở đây. Claim trả phí đã gửi `credits.redemption.confirmed` cho chi phí của nó.

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | |
| `status` | `string` | `REDEEMED` |
| `redeemedAt` | `string` | |
| `voucherTitle` | `string` | |
| `discountType` | `string` | |
| `discountValue` | `string \| null` | |
