---
title: Xử lý sự cố vận hành
description: Hướng dẫn chẩn đoán và xử lý lỗi phân quyền, thiếu điểm, giao dịch pending/lỗi, hết hạn, dùng trùng serial và điều khoản hoàn điểm.
---

Sử dụng tài liệu này để chẩn đoán các sự cố vận hành thường gặp từ Business Console hoặc quầy thu ngân mà không cần kiểm tra database hay làm lộ secret. Khi cần điều tra sâu ở tầng tích hợp backend/API, xem thêm các trang tham chiếu cho developer được liên kết bên dưới.

---

## Lỗi phân quyền và truy cập

| Hiện tượng | Nguyên nhân thường gặp | Cách kiểm tra & xử lý |
| --- | --- | --- |
| Không thể duyệt voucher, sửa refund policy, mời nhân sự hoặc gửi `UPDATE_IDENTITY` (403) | Đang đăng nhập với vai trò **Business Developer**, không phải **Business Owner** | Nhờ Owner thực hiện hoặc cập nhật vai trò tại `/organizations/:slug/team`. |
| Đang dùng Console bình thường thì bị lỗi 401/403 toàn bộ | Tài khoản nhân sự vừa bị **tạm ngưng (suspended)** hoặc đổi quyền | Nhờ Owner kiểm tra lại trạng thái trong **Team** rồi đăng nhập lại. |
| Không thấy organization hoặc không tìm thấy thành viên/voucher | Đang mở nhầm organization slug | Kiểm tra `:slug` trên URL xem có khớp đúng merchant của khách hàng không. |

---

## Vấn đề số dư điểm và ngân sách phát hành

| Hiện tượng | Nguyên nhân thường gặp | Cách kiểm tra & xử lý |
| --- | --- | --- |
| Khách báo đủ điểm nhưng claim/redeem báo **không đủ điểm** | Điểm vẫn đang ở **`pendingEarn`** (chờ Sui xác nhận) hoặc đang bị giữ trong **`pendingRedemption`** | Mở **Members** (`/organizations/:slug/members`) để đối chiếu `confirmedBalance` với `pendingEarn` và `pendingRedemption`. Chờ giao dịch earn xác nhận xong hoặc chờ phiên giữ chỗ bị bỏ dở tự hết hạn. |
| POS / backend phát điểm bị từ chối do ngân sách | **Issuance budget** của organization đã cạn | Kiểm tra thẻ ngân sách trên **Dashboard**. Owner cần yêu cầu/nạp thêm ngân sách trước khi tiếp tục phát điểm. |
| Xuất hiện cảnh báo ngân sách thấp trên Dashboard | Ngân sách còn lại đã xuống dưới ngưỡng cảnh báo | Chủ động nạp thêm ngân sách sớm để không gián đoạn giao dịch tại quầy. Xem [Ngân sách phát hành](/vi/concepts/issuance-budget/). |

---

## Giao dịch bị kẹt `PENDING`, `FAILED` hoặc `UNKNOWN`

| Hiện tượng | Nguyên nhân thường gặp | Cách kiểm tra & xử lý |
| --- | --- | --- |
| Lệnh earn hoặc reversal ở trạng thái **`PENDING`** lâu hơn vài giây | Worker nền hoặc Sui RPC đang trễ | Chờ một lát rồi tải lại lịch sử giao dịch của thành viên. **Không** gửi lại lệnh mới với `idempotencyKey` khác. |
| Claim voucher trả phí hoặc trừ điểm tại quầy bị kẹt **`PENDING`** | Khách hàng chưa ký xác nhận trên thiết bị của họ, hoặc đã đóng tab | Nhắc khách hoàn tất bước ký trên thiết bị. Nếu khách hủy ngang, hệ thống sẽ tự hết hạn lượt giữ chỗ và giải phóng điểm. |
| Giao dịch báo **`FAILED`** hoặc **`UNKNOWN`** | Thực thi on-chain thất bại hoặc chưa xác nhận được kết quả trước khi hết hạn | Chuyển cho đội kỹ thuật kèm `transactionId` / `requestId` (không gửi kèm API key). Xem [Idempotency và phục hồi](/vi/concepts/idempotency-and-recovery/). |

---

## Lỗi claim voucher, hết hạn và trùng mã serial

| Hiện tượng | Nguyên nhân thường gặp | Cách kiểm tra & xử lý |
| --- | --- | --- |
| Khách không thấy hoặc không claim được voucher | Voucher vẫn đang ở **`DRAFT`**, **`PENDING_APPROVAL`**, **`REJECTED`** hoặc **`ARCHIVED`** | Kiểm tra `/organizations/:slug/vouchers`. Đảm bảo Owner đã duyệt (nếu bật chế độ duyệt) và batch đã được kích hoạt (`ACTIVE`). |
| Bị từ chối claim do hết lượt | Voucher đã **`SOLD_OUT`** hoặc khách đạt giới hạn **per-member limit** | Kiểm tra tồn kho và giới hạn mỗi thành viên trên trang chi tiết voucher. Owner/Developer có thể tăng số lượng để mở lại nếu cần. |
| Thu ngân nhập serial báo **Hết hạn (Expired)** | Đã quá ngày kết thúc hoặc quá số ngày `validForDays` tính từ lúc phát hành/claim | Kiểm tra `expiresAt` trong **Members**; không áp dụng mã đã hết hạn trừ khi thuộc diện hoàn theo refund policy. |
| Thu ngân nhập serial báo **`ALREADY_REDEEMED`** (dùng trùng) | Khách đã dùng mã `serialCode` này trước đó (hoặc đưa ảnh chụp màn hình cũ) | Kiểm tra trạng thái và `redeemedAt` trong **Members**, từ chối áp dụng lại. |
| Khách hỏi "Tôi đã claim rồi sao chưa thấy giảm giá?" | Claim chỉ mới **cấp voucher** cho khách; **dùng serial** tại quầy là bước khách ký xác nhận riêng | Hướng dẫn khách đưa `serialCode` cho thu ngân và hoàn tất bước ký xác nhận sử dụng voucher. |

---

## Hoàn điểm và chính sách hoàn điểm

Khi khách hàng yêu cầu hoàn điểm cho một voucher:

1. Kiểm tra **Refund Policy** đang áp dụng (và **Refund Policy History** nếu voucher được claim ở phiên bản chính sách cũ) tại `/organizations/:slug/settings`:
   - `allowUnused`: cho phép hoàn voucher `ACTIVE` chưa sử dụng hay không.
   - `allowExpired`: cho phép hoàn voucher đã `EXPIRED` hay không.
   - `allowRedeemed`: cho phép hoàn voucher đã `REDEEMED` hay không.
   - `restockUnused`: hoàn voucher chưa dùng có trả lại số lượng vào tồn kho không.
   - `refundWindowDays`: số ngày tối đa kể từ lúc claim/cấp được phép yêu cầu hoàn.
2. Đối chiếu trạng thái hiện tại của voucher (`ACTIVE`, `REDEEMED`, `EXPIRED`) và mốc thời gian trong **Members** trước khi xử lý.

## Thông tin cần gửi khi báo lỗi cho kỹ thuật

Chỉ gửi các mã định danh an toàn:
- Organization slug / ID
- Member UUID (`organizationEndUserId`) hoặc POS ID
- `transactionId`, `ownershipId` hoặc `X-Request-Id`

Khi các công cụ trên Console đã bật, bạn cũng có thể kiểm tra thêm:
- **API key Sandbox vs Live:** đảm bảo giao dịch thật không dùng nhầm sandbox key (và dùng webhook test event khi kiểm tra endpoint).
- **Nhật ký request theo API key:** lọc theo `requestId` hoặc mã lỗi (`4xx`/`5xx`) để xác định request gặp sự cố.
- **Audit log (Owner) & đối soát on-chain:** kiểm tra ai đã thực hiện thao tác thay đổi cấu hình/duyệt voucher và đối chiếu số dư với bằng chứng on-chain.

Tuyệt đối không gửi raw API key, webhook signing secret, link mời nhân sự hay giấy tờ định danh của khách hàng vào ticket/chat.
