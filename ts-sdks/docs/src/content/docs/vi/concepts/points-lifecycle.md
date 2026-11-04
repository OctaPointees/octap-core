---
title: Vòng đời điểm
description: Giao dịch mua trở thành điểm như thế nào, và pending với confirmed nghĩa là gì.
---

Sui là nguồn chuẩn về điểm đã xác nhận, và giao dịch trên chain cần thời gian. Vì vậy OctaP nhận lệnh của bạn trước, rồi báo kết quả khi chain trả lời.

## Earn điểm

1. **Bạn gửi số tiền mua.** OctaP tính `floor(purchaseAmount × earnBps ÷ 10000)`, trong đó `earnBps` là tỷ lệ của chương trình tính theo basis point.
2. **Số ước tính được giữ lại.** Giao dịch ở trạng thái `PENDING` và số ước tính nằm trong `pendingEarn`. Khách hàng chưa tiêu được.
3. **Chain trả lời.** Khi xác nhận, số thực tế được chuyển vào `confirmedBalance`. Khi thất bại, phần giữ được giải phóng và không có gì được cộng.

Ví dụ, 100.000 với 100 basis point (1%) giữ 1.000 điểm ước tính và xác nhận 1.000 điểm. Số ước tính có thể khác kết quả, nên chỉ tin vào số đã xác nhận.

Giao dịch làm tròn xuống còn 0 điểm sẽ bị từ chối với 400, vì chain sẽ abort nó.

## Ý nghĩa của từng field

| Ở đâu | Field | Khi đang chờ | Sau khi xác nhận |
| --- | --- | --- | --- |
| Response của earn | `estimatedPoints` | Số ước tính | `null` |
| Response của earn | `pointsEarned` | `null` | Số điểm thực tế |
| Lịch sử | `pointsAmount` | `null` với lệnh earn | Số điểm thực tế |
| Lịch sử | `estimatedPoints` | Số ước tính | `null` |
| Số dư | `pendingEarn` | Gồm số ước tính | Đã giải phóng |
| Số dư | `confirmedBalance` | Chưa gồm | Gồm số điểm thực tế |

Số dư có `stale: true` nghĩa là còn khoản đang chờ, nên một phần có thể còn thay đổi.

## Tiêu điểm

Tiêu điểm đi theo chiều ngược lại: giữ chỗ trước, rồi đến chữ ký của khách hàng.

1. **Bạn giữ chỗ.** Server của bạn giữ số điểm, chuyển chúng vào `pendingRedemption`, và nhận transaction bytes.
2. **Khách hàng ký.** Thiết bị của họ ký các bytes đó.
3. **Giao dịch được finalize.** Giao dịch đã ký được gửi lên chain. Chỉ phán quyết của chain mới trừ `confirmedBalance`.

Khoản giữ không bao giờ được ký sẽ được giải phóng sau 30 phút. Việc giải phóng chạy ở lần đọc số dư hoặc giữ chỗ tiếp theo của thành viên đó, và một worker cũng quét các claim voucher bị bỏ dở. Khoản giữ đã có giao dịch được gửi đi thì không bao giờ được giải phóng chỉ vì quá hạn.

## Hết hạn

Điểm hết hạn theo chính sách chương trình của bạn. OctaP loại điểm hết hạn khỏi số dư ở lần đọc hoặc tiêu tiếp theo, kể cả trước khi chain báo về.

## Đảo giao dịch

Reversal đảo một lệnh earn hoặc redeem đã xác nhận trong sổ cái ngay lập tức, và giao dịch gốc đã xác nhận trên chain cũng được phản ánh on-chain sau đó. Đảo một lệnh earn đã bị tiêu có thể để lại số dư âm: đó là khoản nợ của thành viên, và nó chặn việc tiêu điểm cho đến khi được bù. `balanceWentNegative` cho bạn biết khi nào điều này xảy ra.
