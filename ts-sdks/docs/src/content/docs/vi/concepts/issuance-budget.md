---
title: Ngân sách phát hành
description: Giới hạn số điểm chương trình của bạn được phát, và cách tăng giới hạn đó.
---

Ngân sách phát hành là tổng số điểm mà chương trình của bạn còn được phép phát. Nó nằm trên chain, và mỗi lệnh earn trừ đi số điểm đã cộng. Nó ngăn lỗi code hoặc số tiền sai phát điểm không giới hạn.

Ngân sách là số điểm, không phải tiền. Top-up chỉ tăng con số đó, không có khoản thanh toán nào. Giá trị của số điểm bạn phát vẫn là cam kết của bạn với khách hàng.

## Cách hoạt động

1. **Đặt một lần.** System Admin của OctaP đặt ngân sách ban đầu khi provision chương trình của bạn.
2. **Earn dùng ngân sách.** Lệnh earn đã xác nhận trừ số điểm của nó. Đảo một lệnh earn có điểm chưa bị tiêu sẽ trả lại số đó.
3. **Không tự reset.** Ngân sách tính trên toàn bộ vòng đời chương trình, không theo tháng.

Điểm đã redeem hoặc hết hạn không quay lại ngân sách.

## Xem số còn lại

```ts
const budget = await client.getIssuanceBudget();
// budget.remaining, budget.initialBudget, budget.shards, budget.recentTopUps
```

Lệnh này cần scope `read`. Nó đọc từ chain, nên các lệnh earn đang xử lý chưa bị trừ. Nếu nhận 503 nghĩa là không đọc được chain, hãy thử lại.

Người dùng portal đọc cùng dữ liệu qua các route sau:

| Ai | Route |
| --- | --- |
| Thành viên của tổ chức | `GET /v1/console/organizations/:id/budget` |
| System Admin | `GET /v1/platform/organizations/:id/budget` |

## Yêu cầu top-up

Owner của tổ chức đề xuất số lượng và lý do:

```http
POST /v1/console/organizations/:id/change-requests
Authorization: Bearer <Google ID token>

{ "requestType": "BUDGET_TOP_UP", "payload": { "amount": 50000 }, "reason": "Campaign in December" }
```

Sau đó System Admin của OctaP duyệt hoặc từ chối tại `POST /v1/platform/change-requests/:id/approve` hoặc `/reject`, bắt buộc có lý do. Người duyệt và lý do được lưu lại. Sau khi duyệt, một worker thực hiện top-up trên chain, và nó xuất hiện trong `recentTopUps`.

| `recentTopUps[].status` | Ý nghĩa |
| --- | --- |
| `PENDING`, `PROCESSING` | Đang chờ chain |
| `SUBMITTED` | Đã áp dụng |
| `FAILED` | Chưa áp dụng, vì chương trình không còn tồn tại |
| `UNKNOWN` | Có thể đã áp dụng. Operator phải kiểm tra, và không bao giờ tự thử lại. |

API này không nằm trong SDK, vì đề xuất và duyệt dùng phiên portal thay vì API key.

## Nhận cảnh báo trước khi cạn

OctaP kiểm tra vài phút một lần và gửi webhook [`budget.low`](/vi/reference/webhook-events/#budgetlow) khi ngân sách vượt mức đã dùng 80% và 95%. Mỗi lần vượt gửi một event. Top-up đưa mức dùng xuống dưới ngưỡng sẽ cho phép cảnh báo được gửi lại.

Mức dùng được tính trên `capacity`, tức ngân sách ban đầu cộng mọi lần top-up đã áp dụng. Nếu có nhiều shard, nó theo shard đầy nhất, vì shard cạn sẽ từ chối earn dù các shard khác còn ngân sách. `warningThreshold` trong `getIssuanceBudget` cho biết mức hiện tại.

## Khi hết ngân sách

- **Trước khi nhận lệnh:** lệnh earn mà ngân sách không đủ sẽ nhận 422, và không có gì được giữ.
- **Sau khi nhận lệnh:** các lệnh earn đang xử lý không được tính trong bước kiểm tra đó, nên lệnh đã nhận vẫn có thể thất bại. Khi đó bạn nhận webhook [`credits.earn.failed`](/vi/reference/webhook-events/#creditsearnfailed) với `failureCode: 'BUDGET_EXHAUSTED'`.

Để thử lại lệnh earn thất bại sau khi top-up, hãy dùng [idempotency key mới](/vi/guides/earn-and-reverse-points/).

Chương trình có nhiều budget shard sẽ chia đều ngân sách, và shard không mượn nhau. Vì vậy lệnh earn có thể bị từ chối dù `remaining` lớn hơn 0. `shards` cho biết số của từng shard.
