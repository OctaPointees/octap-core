---
title: Cách OctaP hoạt động
description: OctaP vận hành gì, bạn vận hành gì, và ai được phép xác nhận việc gì.
---

OctaP vận hành mọi thứ làm thay đổi điểm và voucher mà OctaP đang giữ. Bạn chọn các giá trị thương mại, và bạn sở hữu đơn hàng, tiền và các cam kết với khách hàng.

## Ai vận hành gì

| Bạn vận hành | OctaP vận hành |
| --- | --- |
| Thanh toán, đơn hàng và quy trình checkout | Core API và các worker |
| Backend của bạn, với `@octap/sdk` | Điểm trên blockchain Sui |
| Website của bạn, với `@octap/browser-sdk` | Dữ liệu voucher và mã serial |
| Giao diện trải nghiệm khách hàng thân thiết | Tài trợ phí giao dịch cho khách hàng |

## Ai xác nhận việc gì

Có hai SDK vì có hai bên giữ quyền khác nhau.

| Hành động | Do ai xác nhận | Bằng cách nào |
| --- | --- | --- |
| Phát điểm | Bạn | API key của bạn, từ server |
| Tạo hoặc redeem serial voucher | Bạn | API key của bạn, từ server |
| Tiêu điểm của khách hàng | Khách hàng | Chữ ký của họ, trên thiết bị của họ |

API key của bạn không bao giờ tiêu được điểm của khách hàng. Nó có thể giữ chỗ một khoản tiêu và nhận về transaction bytes, nhưng chỉ chữ ký zkLogin của khách hàng mới hoàn tất được.

## Dữ liệu chuẩn nằm ở đâu

- **Điểm đã xác nhận nằm trên Sui.** Số dư của OctaP là bản phản chiếu những gì chain đã xác nhận.
- **Lệnh và voucher nằm trong database của OctaP.** Đó là nơi lưu idempotency key, danh mục voucher và mã serial.

Vì sự phân chia này mà SDK thường báo `PENDING` trước. Xem [Vòng đời điểm](/vi/concepts/points-lifecycle/).

## Thuật ngữ chính

| Thuật ngữ | Ý nghĩa |
| --- | --- |
| Organization (tổ chức) | Một merchant. Mọi API key và dữ liệu của nó thuộc đúng một tổ chức. |
| Member (thành viên) | Khách hàng đã đăng ký vào tổ chức của bạn, trong request gọi là `organizationEndUserId`. |
| End user | Một khách hàng trên toàn OctaP, với một `suiAddress`. |
| Program | Chương trình điểm on-chain của tổ chức bạn, gồm cả tỷ lệ earn. |
| Voucher | Phần thưởng do bạn định nghĩa. |
| Ownership | Lần claim voucher của một khách hàng, kèm `serialCode` dùng một lần. |

## Đăng nhập của khách hàng

Khách hàng đăng nhập bằng Google, và zkLogin biến điều đó thành một địa chỉ Sui do họ kiểm soát mà không cần ví. Browser SDK xử lý toàn bộ qua các route public của OctaP.

Hiện tất cả merchant dùng chung một Google client ID của OctaP. Vì vậy, token mà khách hàng đã đưa cho merchant khác cũng xác minh được trên backend của bạn: hãy coi nó là bằng chứng về danh tính, không phải sự đồng ý với bất kỳ việc gì. Việc chuyển sang client riêng cho từng merchant về sau sẽ làm thay đổi ví của khách hàng.
