---
title: API key và scope
description: Cách Node SDK xác thực, scope mà mỗi route cần, và giới hạn tần suất.
---

Node SDK gửi key của bạn dưới dạng `Authorization: Bearer <api key>`. Mỗi key thuộc về một tổ chức, nên thông thường bạn không cần truyền ID tổ chức. Nếu truyền, ID đó phải khớp với tổ chức của key, nếu không request sẽ nhận 403.

Giữ key trên server tin cậy. Việc quản lý API key không nằm trong SDK này.

## Scope

Một key có scope `read`, hoặc `read` và `write`. Key thiếu scope cần thiết sẽ nhận 403. Key tạo trên Console dùng được mọi method bên dưới mà scope của nó cho phép.

Key có scope nào thì làm được việc đó, bất kể ai đang cầm key: route không xét vai trò của người đã tạo key. Trên Console, chỉ Owner của tổ chức tạo được key `write`; Business Developer chỉ tạo key `read`.

| Scope | Method của SDK |
| --- | --- |
| `read` | `verifyCustomer`, `getBalance`, `listTransactions`, `getIssuanceBudget`, `getVoucherRefundPolicy`, `listVoucherRefundPolicyHistory`, `listVouchers`, `getVoucher`, `getVoucherClaim`, `listMemberVouchers`, `listWebhookEndpoints`, `listWebhookDeliveries` |
| `write` | `earnPoints`, `reservePosRedemption`, `reverseTransaction`, `createVoucher`, `updateVoucher`, `claimVoucher`, `grantVoucher`, `prepareVoucherUse` |
| Không cần | `finalizePosRedemption`, `finalizeVoucherClaim`, `finalizeVoucherUse`: chữ ký của khách hàng xác nhận các lệnh này |

`reverseTransaction` hoàn được mọi thứ mà chính sách hoàn tiền của tổ chức cho phép, kể cả voucher đã hết hạn hoặc đã redeem nếu chính sách cho phép. Chính sách là lớp kiểm soát duy nhất, và chỉ Owner đặt được chính sách.

## Việc không key nào làm được

Quản lý webhook và chính sách hoàn tiền là việc của Owner, trên Console: đăng ký, tắt, bật và xoay secret của webhook endpoint, gửi lại một delivery, và publish chính sách hoàn tiền. Key chỉ đọc được (`listWebhookEndpoints`, `listWebhookDeliveries`, `getVoucherRefundPolicy`, `listVoucherRefundPolicyHistory`), không bao giờ thay đổi được. Xem [Nhận webhook](/vi/guides/receive-webhooks/) và [Quản lý voucher](/vi/guides/manage-vouchers/).

Key tạo trước khi OctaP bỏ scope `admin` có thể vẫn còn ghi scope này. OctaP bỏ qua nó: key đó chỉ làm được những gì scope `read` và `write` của nó cho phép.

Hãy cấp cho mỗi service số scope ít nhất mà nó cần.

## Giới hạn tần suất

Giới hạn tính theo cửa sổ cố định 60 giây. Khi vượt giới hạn, bạn nhận 429 kèm header `Retry-After`, SDK cung cấp giá trị này qua `error.retryAfter`.

| Route | Giới hạn theo | Mặc định mỗi phút |
| --- | --- | --- |
| Route dùng API key | Từng key | 120 |
| Route public, gồm finalize và đăng nhập khách hàng | Từng IP client | 60 |

Nếu OctaP không kiểm tra được giới hạn, request sẽ nhận 503 thay vì được cho qua.
