---
title: API key và scope
description: Cách Node SDK xác thực, scope mà mỗi route cần, và giới hạn tần suất.
---

Node SDK gửi key của bạn dưới dạng `Authorization: Bearer <api key>`. Mỗi key thuộc về một tổ chức, nên thông thường bạn không cần truyền ID tổ chức. Nếu truyền, ID đó phải khớp với tổ chức của key, nếu không request sẽ nhận 403.

Giữ key trên server tin cậy. Việc quản lý API key không nằm trong SDK này.

## Scope

Một key có thể có scope `read`, `write` và `admin`. Key thiếu scope cần thiết sẽ nhận 403.

Key có scope nào thì làm được việc đó, bất kể ai đang cầm key: route không xét vai trò của người đã tạo key. Trên Console, chỉ Owner của tổ chức tạo được key `write`; Business Developer chỉ tạo key `read`.

| Scope | Method của SDK |
| --- | --- |
| `read` | `verifyCustomer`, `getBalance`, `listTransactions`, `getIssuanceBudget`, `getVoucherRefundPolicy`, `listVouchers`, `getVoucher`, `getVoucherClaim`, `listMemberVouchers`, `listWebhookEndpoints`, `listWebhookDeliveries` |
| `write` | `earnPoints`, `reservePosRedemption`, `reverseTransaction`, `createVoucher`, `updateVoucher`, `claimVoucher`, `grantVoucher`, `prepareVoucherUse` |
| `admin` | `setVoucherRefundPolicy`, `listVoucherRefundPolicyHistory`, `registerWebhookEndpoint`, `disableWebhookEndpoint`, `enableWebhookEndpoint`, `rotateWebhookSecret`, `replayWebhookDelivery` |
| Không cần | `finalizePosRedemption`, `finalizeVoucherClaim`, `finalizeVoucherUse`: chữ ký của khách hàng xác nhận các lệnh này |

Một số lần hoàn tiền cũng cần `admin`: khi chính sách hoàn tiền chỉ cho phép đảo giao dịch đối với voucher đã hết hạn hoặc đã redeem.

Hãy cấp cho mỗi service số scope ít nhất mà nó cần.

## Giới hạn tần suất

Giới hạn tính theo cửa sổ cố định 60 giây. Khi vượt giới hạn, bạn nhận 429 kèm header `Retry-After`, SDK cung cấp giá trị này qua `error.retryAfter`.

| Route | Giới hạn theo | Mặc định mỗi phút |
| --- | --- | --- |
| Route dùng API key | Từng key | 120 |
| Route public, gồm finalize và đăng nhập khách hàng | Từng IP client | 60 |

Nếu OctaP không kiểm tra được giới hạn, request sẽ nhận 503 thay vì được cho qua.
