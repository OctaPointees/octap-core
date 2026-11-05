---
title: Các giá trị trạng thái
description: Ý nghĩa của từng trạng thái giao dịch, voucher và webhook.
---

## Trạng thái giao dịch

`LoyaltyTxStatus`, trên các lệnh earn, redeem và lịch sử.

| Trạng thái | Ý nghĩa |
| --- | --- |
| `PENDING` | Đã nhận và đang chờ chain, hoặc chờ chữ ký của khách hàng |
| `CONFIRMED` | Chain đã xác nhận |
| `FAILED` | Chắc chắn thất bại, và mọi khoản giữ đã được giải phóng |
| `REVERSED` | Đã xác nhận, và sau đó bị đảo |

## Loại giao dịch

`LoyaltyTxType`: `EARN`, `REDEEM`, `REVERSAL`, `TRANSFER`, `EXPIRY` hoặc `ADJUSTMENT`.

## Trạng thái claim voucher

`VoucherOwnershipStatus`, trên các claim và voucher của thành viên.

| Trạng thái | Ý nghĩa | Tiếp theo |
| --- | --- | --- |
| `RESERVED` | Đang chờ chain, khách hàng chưa sở hữu | Claim trả phí: ký và finalize. Tặng hoặc claim miễn phí: chờ. |
| `AVAILABLE` | Đã sở hữu và sẵn sàng dùng | Chuẩn bị lượt dùng để khách hàng ký |
| `REDEEMED` | Đã dùng | Không có |
| `EXPIRED` | Đã quá hạn | Không có |
| `CANCELLED` | Thất bại, bị bỏ dở hoặc đã hoàn tiền | Key mới có thể claim lại |

## Trạng thái voucher

`VoucherStatus`, trong danh mục.

| Trạng thái | Ý nghĩa |
| --- | --- |
| `DRAFT` | Chưa mở |
| `ACTIVE` | Có thể claim |
| `PAUSED` | Tạm dừng claim |
| `EXPIRED` | Đã qua ngày kết thúc |
| `DEPLETED` | Hết tồn kho. Lần hoàn tiền trả lại tồn kho sẽ đưa nó về `ACTIVE`. |

## Trạng thái webhook

| Kiểu | Giá trị |
| --- | --- |
| `WebhookEndpointStatus` | `ACTIVE`, `DISABLED` |
| `WebhookDeliveryStatus` | `PENDING`, `DELIVERED`, `DEAD_LETTER` |
