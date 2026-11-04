---
title: Lỗi
description: Các mã lỗi mà Browser SDK báo, và cách xử lý từng mã.
---

Mọi lỗi đều là `OctapAuthError` có `code`. Lỗi API còn có `status` và `body`.

```ts
import { OctapAuthError } from '@octap/browser-sdk';

try {
  await auth.signAndFinalize(claim);
} catch (error) {
  if (error instanceof OctapAuthError && error.code === 'outcome-unknown') {
    await refreshClaimFromBackend();
  }
}
```

Lỗi trong lúc đăng nhập đến với bạn qua tùy chọn `onError` của `renderGoogleButton`.

| Mã | Ý nghĩa | Cần làm |
| --- | --- | --- |
| `sign-in-canceled` | Khách hàng đóng cửa sổ Google | Không cần làm gì. Nút vẫn hoạt động. |
| `nonce-mismatch` | Token của Google không được cấp cho lần đăng nhập này | Yêu cầu họ đăng nhập lại |
| `provider-unavailable` | Script của Google không tải được, hoặc SDK chạy ngoài trình duyệt | Kiểm tra script bị chặn |
| `not-signed-in` | Không có khách hàng nào đang đăng nhập | Hiển thị nút |
| `session-expired` | Phiên ký đã quá `maxEpoch` | Yêu cầu họ đăng nhập lại |
| `token-expired` | Token của Google hết hạn, sau khoảng một giờ | Yêu cầu họ đăng nhập lại |
| `wrong-account` | Giao dịch thuộc về khách hàng khác | Yêu cầu họ dùng đúng tài khoản |
| `invalid-claim` | Claim không có gì để ký, hoặc bytes không hợp lệ | Kiểm tra trạng thái claim |
| `outcome-unknown` | Finalize có thể đã tới chain | Đọc claim. Đừng tạo lại. |
| `api-error` | OctaP trả về lỗi | Xem `status` và `message` |
| `network-error` | Không kết nối được tới OctaP | Thử lại sau |
| `timeout` | Request mất quá nhiều thời gian | Thử lại sau |
| `aborted` | `AbortSignal` của bạn được kích hoạt | Không cần làm gì |
| `invalid-response` | Không đọc được response của OctaP | Báo lại |

:::note
`sign-in-canceled` chỉ là phán đoán dựa trên việc trang nhận lại focus, vì nút của Google không báo việc hủy. Nó có thể xuất hiện khi popup vẫn mở nếu khách bấm trở lại trang, và cũng có thể không xuất hiện. Chỉ dùng nó để hiển thị thông báo.
:::
