---
title: Lỗi
description: Các lớp lỗi mà Node SDK ném ra, và ý nghĩa của từng status code.
---

Mọi lỗi mà SDK ném ra đều kế thừa `OctaSdkError`.

```ts
import { OctaApiError, OctaNetworkError, OctaRequestAbortedError } from '@octap/sdk';
```

| Lớp | Ném ra khi | Đã tới OctaP chưa? |
| --- | --- | --- |
| `OctaApiError` | OctaP trả về status lỗi | Rồi |
| `OctaNetworkError` | Request hoặc response lỗi trên đường truyền. `cause` chứa lỗi gốc. | Có thể |
| `OctaRequestAbortedError` | `AbortSignal` của bạn được kích hoạt | Có thể |
| `OctaSdkError` | Không có `fetch`, hoặc chữ ký webhook không hợp lệ | Chưa |

## OctaApiError

| Thuộc tính | Kiểu | Mô tả |
| --- | --- | --- |
| `statusCode` | `number` | HTTP status |
| `statusText` | `string` | |
| `responseBody` | `unknown` | Body đã parse. Đừng log nguyên bản. |
| `message` | `string` | Lấy từ body nếu có |
| `retryAfter` | `string \| undefined` | Header `Retry-After`, tính bằng giây |

## Status code

| Status | Ý nghĩa | Cần làm |
| --- | --- | --- |
| 400 | Request không hợp lệ, hoặc bị một quy tắc từ chối | Sửa request. Với finalize, hãy đọc trạng thái trước, vì giao dịch có thể đã được gửi. |
| 401 | API key hoặc token khách hàng bị thiếu, sai hoặc hết hạn | Kiểm tra key, hoặc yêu cầu khách đăng nhập lại |
| 403 | Key thiếu scope, hoặc tổ chức hay thành viên không hoạt động | Kiểm tra [scope](/vi/concepts/api-keys-and-scopes/) và trạng thái thành viên |
| 404 | Không tìm thấy trong tổ chức của bạn | Kiểm tra ID |
| 409 | Key đã dùng cho request khác, hoặc trạng thái không cho phép | Đọc trạng thái. Đừng đổi key để né lỗi. |
| 422 | Chương trình của tổ chức bạn chưa được provision | Hoàn tất provision |
| 429 | Bị giới hạn tần suất | Chờ `retryAfter` giây |
| 5xx | Lỗi server, chưa rõ kết quả | [Đọc trạng thái trước](/vi/concepts/idempotency-and-recovery/) |
| 503 | OctaP không kiểm tra được giới hạn nên đã từ chối request | Thử lại sau |

Đừng bao giờ log nguyên bản body, token, chữ ký hay API key.
