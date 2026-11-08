---
title: Idempotency và phục hồi
description: Cách thử lại an toàn, và phải làm gì khi không biết request đã thành công hay chưa.
---

Mạng có thể lỗi sau khi request đã được xử lý. Idempotency key giúp việc gửi lại request trở nên an toàn.

## Key hoạt động thế nào

Gửi key với mọi lệnh earn, giữ chỗ, reversal và claim trả phí. Key là duy nhất trong tổ chức của bạn. Hãy tạo key từ bản ghi của chính bạn, ví dụ ID đơn hàng, và lưu lại trước khi gửi request.

| Bạn gửi | Bạn nhận |
| --- | --- |
| Key mới | Một thao tác mới |
| Cùng key và cùng request | Kết quả ban đầu, không có thao tác hay webhook thứ hai |
| Cùng key, gửi đồng thời | Một thao tác. Với earn và claim voucher, mọi bên gọi đều nhận kết quả đó. |
| Cùng key nhưng đổi request | 409 với earn, giữ chỗ và claim voucher, và không có gì thay đổi |
| Key đã dùng cho loại thao tác khác | 409, và không có gì thay đổi |

## Phục hồi khi chưa rõ kết quả

Timeout, hủy request, lỗi mạng hay 5xx không cho bạn biết điều gì đã xảy ra. Request có thể đã được ghi nhận. Vì vậy:

1. **Giữ nguyên key.** Đừng bao giờ đổi sang key mới, vì có thể tạo ra lệnh earn hoặc lệnh tiêu thứ hai.
2. **Đọc trạng thái** bằng `listTransactions`, `getBalance`, `getVoucherClaim` hoặc bản ghi webhook của bạn.
3. **Gửi lại request với cùng key** nếu trạng thái chưa cho câu trả lời. Cùng key chỉ có thể trả về kết quả ban đầu.

SDK không bao giờ tự thử lại, nên quyết định này thuộc về bạn.

## Lệnh earn thất bại

Lệnh earn `FAILED` giữ nguyên key, và gửi lại request sẽ lại trả về `FAILED`. Vì chắc chắn không cộng gì, hãy thử lại với key mới. Xem [Earn và đảo điểm](/vi/guides/earn-and-reverse-points/).

## Voucher trả phí

Claim trả phí tuân theo cùng quy tắc, với chữ ký của khách hàng ở giữa.

- Voucher `RESERVED` chưa thuộc về khách hàng. Hãy hiển thị là đang chờ.
- Nếu finalize chưa rõ kết quả, đọc claim, hoặc claim lại với **cùng** key.
- Chỉ dùng key mới sau khi claim ở trạng thái `CANCELLED`.

## Thao tác không có key

| Thao tác | Trước khi thử lại |
| --- | --- |
| `finalizeVoucherClaim`, `finalizeVoucherUse`, `finalizePosRedemption` | Dùng lại chữ ký và digest ban đầu, hoặc đọc trạng thái hiện tại. |
| `registerWebhookEndpoint`, `rotateWebhookSecret` | Đừng thử lại mù quáng. Liệt kê endpoint của bạn trước. |
| Các lệnh đọc | Thử lại với backoff có giới hạn, và chờ `retryAfter` sau 429. |

## Hủy request

Truyền `AbortSignal` chỉ làm code của bạn ngừng chờ. Nó không hoàn tác gì trên OctaP hay trên chain, nên hãy coi một lệnh ghi bị hủy là chưa rõ kết quả.
