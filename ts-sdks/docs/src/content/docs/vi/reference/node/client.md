---
title: Client
description: Tạo và cấu hình client của Node SDK.
---

```ts
import { createOctaPointClient } from '@octap/sdk';

const client = createOctaPointClient({
  baseUrl: process.env.OCTAP_API_URL,
  credentials: { apiKey: process.env.OCTAP_API_KEY },
});
```

`new OctaPointClient(options)` có tác dụng tương tự.

## Tùy chọn

| Tùy chọn | Kiểu | Mô tả |
| --- | --- | --- |
| `baseUrl` | `string` | URL của Core API. Mặc định là `http://localhost:3000`, nên hãy đặt giá trị này khi không phát triển local. |
| `credentials.apiKey` | `string` | API key của bạn. Gửi dưới dạng `Authorization: Bearer`. |
| `organizationId` | `string` | Gửi dưới dạng `x-organization-id`. Phải khớp với tổ chức của key. |
| `fetchFn` | `typeof fetch` | Thay thế `fetch` toàn cục. |
| `transport` | `RestTransport` | Cách khác để cung cấp `baseUrl` và `fetchFn`. |

Việc tạo client sẽ ném `OctaSdkError` nếu runtime không có `fetch` và bạn cũng không cung cấp.

## Tùy chọn của request

Mọi method nhận `RequestOptions` làm tham số cuối.

| Tùy chọn | Kiểu | Mô tả |
| --- | --- | --- |
| `organizationId` | `string` | Ghi đè giá trị của client cho lần gọi này. |
| `signal` | `AbortSignal` | Hủy việc chờ ở phía bạn. Không hoàn tác gì trên OctaP hay chain. |

## Các method

| Nhóm | Method |
| --- | --- |
| [Định danh và credits](/vi/reference/node/credits/) | `verifyCustomer`, `earnPoints`, `getBalance`, `listTransactions`, `reservePosRedemption`, `finalizePosRedemption`, `reverseTransaction` |
| [Voucher](/vi/reference/node/vouchers/) | `createVoucher`, `updateVoucher`, `listVouchers`, `getVoucher`, `claimVoucher`, `getVoucherClaim`, `finalizeVoucherClaim`, `redeemVoucher`, `listMemberVouchers`, `getVoucherRefundPolicy`, `setVoucherRefundPolicy`, `listVoucherRefundPolicyHistory` |
| [Webhook](/vi/reference/node/webhooks/) | `registerWebhookEndpoint`, `listWebhookEndpoints`, `disableWebhookEndpoint`, `enableWebhookEndpoint`, `rotateWebhookSecret`, `listWebhookDeliveries`, `replayWebhookDelivery`, `verifyWebhookSignature`, `constructWebhookEvent` |

## Ngoài phạm vi

Các route của console và platform dùng phiên đăng nhập portal, không dùng API key, nên client này không bao gồm. Việc quản lý API key cũng nằm ngoài client.

## Kiểu dữ liệu

`@octap/sdk` re-export các kiểu request, response và webhook từ `@octap/contracts`, nên bạn có thể import từ một nơi:

```ts
import type { EarnPointsRequest, VoucherDto, WebhookEvent } from '@octap/sdk';
```
