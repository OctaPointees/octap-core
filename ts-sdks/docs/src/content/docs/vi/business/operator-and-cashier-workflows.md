---
title: Quy trình vận hành và thu ngân
description: Hướng dẫn từng bước theo vai trò cho đăng nhập, onboarding, tra cứu thành viên, phát điểm, quản lý voucher, khách hàng claim và thu ngân đối soát serial.
---

Tài liệu này mô tả các quy trình vận hành đã được hỗ trợ trên OctaP Business Console và luồng khách hàng/thu ngân. Mỗi quy trình nêu rõ **người thực hiện**, **điều kiện trước**, **các bước**, **kết quả mong đợi** và **cách xử lý khi gặp lỗi**.

:::note[Minh họa giao diện]
Ảnh chụp màn hình từng bước sẽ được bổ sung trong PR tiếp theo sau khi frontend phiên bản mới theo organization được deploy.
:::

---

## 1. Đăng nhập, onboarding và chọn organization

- **Người thực hiện:** Business Owner hoặc Business Developer
- **Điều kiện trước:** Có tài khoản Google. Nếu tham gia organization có sẵn, Owner phải gửi lời mời tới đúng email đó.
- **Các bước:**
  1. Mở Business Console (`/`) và đăng nhập bằng Google.
  2. Tại `/organizations`, chọn organization có sẵn — hoặc chọn **Create organization** (`/onboarding`) nếu tạo merchant mới.
  3. Nếu được mời qua email, mở link lời mời hoặc xác nhận lời mời đang chờ cho tài khoản của bạn.
- **Kết quả mong đợi:** Bạn vào được workspace `/organizations/:slug` với đúng menu và quyền hạn theo vai trò (`BUSINESS_OWNER` hoặc `BUSINESS_DEVELOPER`).
- **Xử lý sự cố:** Nếu không thấy organization hoặc bị từ chối truy cập, kiểm tra lại xem bạn đã đăng nhập đúng email Google được mời chưa, hoặc nhờ Owner kiểm tra mục **Team**.

---

## 2. Mời và quản lý nhân sự (Owner)

- **Người thực hiện:** Business Owner
- **Điều kiện trước:** Đang đăng nhập với vai trò Owner tại `/organizations/:slug`.
- **Các bước:**
  1. Mở mục **Team** (`/organizations/:slug/team`).
  2. Chọn **Invite**, nhập email nhân sự và chọn vai trò (`Business Developer` hoặc `Business Owner`).
  3. Gửi lời mời và theo dõi trạng thái (`pending`, `accepted`, `revoked`, `expired`).
- **Kết quả mong đợi:** Khi nhân sự chấp nhận, tài khoản xuất hiện trong danh sách staff active và có thể truy cập workspace.
- **Xử lý sự cố:** Nếu lời mời hết hạn hoặc nhập nhầm email, thu hồi (revoke) lời mời cũ và gửi lời mời mới.

---

## 3. Tra cứu thành viên, số dư và lịch sử

- **Người thực hiện:** Business Owner, Business Developer hoặc Support
- **Điều kiện trước:** Khách hàng đã được đăng ký (enroll) vào organization.
- **Các bước:**
  1. Mở mục **Members** (`/organizations/:slug/members`).
  2. Tìm theo tên, email, số điện thoại hoặc mã thành viên POS/hệ thống ngoài.
  3. Chọn thành viên để mở bảng chi tiết: kiểm tra **confirmed balance**, **pending earn / pending redemption**, **lịch sử giao dịch** và **voucher đang giữ** (mã serial luôn được ẩn khỏi giao diện nhân sự).
- **Kết quả mong đợi:** Xác minh được ngay điểm đã xác nhận hay đang chờ chain, không cần kiểm tra database.
- **Xử lý sự cố:** Nếu không tìm thấy khách hàng, kiểm tra lại xem khách đã đăng ký đúng organization hiện tại chưa (dữ liệu thành viên tách biệt tuyệt đối giữa các organization).

---

## 4. Phát điểm và đảo điểm (POS / Backend)

- **Người thực hiện:** Hệ thống backend / POS của merchant (Owner và Developer theo dõi)
- **Điều kiện trước:** API key còn hiệu lực có quyền ghi, còn đủ **issuance budget**, và có `memberId` hợp lệ.
- **Các bước:**
  1. Backend gửi lệnh earn (hoặc reversal) kèm `idempotencyKey` cố định.
  2. OctaP lưu lệnh và worker nền gửi giao dịch lên Sui.
  3. Nhân sự kiểm tra kết quả tại **Members** (giao dịch chuyển từ `PENDING` sang `CONFIRMED`) và theo dõi ngân sách còn lại trên **Dashboard**.
- **Kết quả mong đợi:** `confirmedBalance` của khách tăng (hoặc giảm khi đảo điểm) sau khi Sui xác nhận, đồng thời ngân sách phát hành được trừ tương ứng.
- **Xử lý sự cố:** Nếu giao dịch bị kẹt ở `PENDING` hoặc lỗi, **không** tạo `idempotencyKey` mới; hãy kiểm tra trạng thái ngân sách/giao dịch và xem [Xử lý sự cố vận hành](/vi/business/operational-troubleshooting/).

---

## 5. Tạo, duyệt và kích hoạt voucher & batch

- **Người thực hiện:** Business Developer (tạo/import) và Business Owner (duyệt/kích hoạt khi bật chế độ duyệt)
- **Điều kiện trước:** Có quyền truy cập `/organizations/:slug/vouchers`.
- **Các bước:**
  1. Tại **Vouchers** (`/organizations/:slug/vouchers`) hoặc **Imports** (`/organizations/:slug/vouchers/imports`), tạo voucher lẻ hoặc import file CSV/XLSX. Batch mới tạo luôn ở trạng thái **`DRAFT`**.
  2. Rà soát danh sách voucher nháp tại `/organizations/:slug/vouchers/imports/:batchId`.
  3. Nếu organization bật yêu cầu duyệt, gửi voucher/batch sang **`PENDING_APPROVAL`**; Owner xem xét và duyệt (hoặc từ chối kèm lý do).
  4. Kích hoạt (Activate) batch/voucher để chuyển sang **`ACTIVE`** và publish lên chain.
- **Kết quả mong đợi:** Khách hàng nhìn thấy và có thể claim các voucher `ACTIVE` trong phạm vi tồn kho và thời hạn.
- **Xử lý sự cố:** Nếu voucher bị `REJECTED`, đọc lý do từ chối trên bảng chi tiết voucher, chỉnh sửa bản nháp rồi gửi lại.

---

## 6. Khách hàng claim voucher trả phí (Trên thiết bị khách hàng)

- **Người thực hiện:** Khách hàng cuối (trên website của bạn hoặc partner app mẫu)
- **Điều kiện trước:** Khách đã đăng nhập Google/Enoki zkLogin (`@octap/browser-sdk`), voucher đang `ACTIVE`, và `confirmedBalance` đủ điểm.
- **Các bước:**
  1. Backend giữ chỗ (reserve) lượt claim và trả transaction bytes chưa ký về trình duyệt của khách.
  2. Khách hàng ký xác nhận trên thiết bị của mình (zkLogin) và gửi hoàn tất.
  3. Chờ blockchain xác nhận: voucher chuyển từ `PENDING` sang `ACTIVE` kèm mã `serialCode` dùng một lần.
- **Kết quả mong đợi:** Điểm được trừ, tồn kho giảm, và khách nhận được voucher `ACTIVE` kèm `serialCode`.
- **Xử lý sự cố:** Lưu ý rằng **claim** chỉ cấp voucher cho khách — **không** đồng thời sử dụng voucher tại quầy. Nếu khách đóng trình duyệt trước khi ký, lượt giữ chỗ sẽ tự hết hạn và hoàn trả điểm đang giữ.

---

## 7. Thu ngân đối soát & sử dụng serial một lần (Bước tách biệt)

- **Người thực hiện:** Thu ngân (tại quầy POS) + Khách hàng (trên thiết bị của khách)
- **Điều kiện trước:** Khách hàng đưa ra `serialCode` của một voucher đang ở trạng thái `ACTIVE`.
- **Các bước:**
  1. Thu ngân nhập hoặc quét `serialCode` trên màn hình POS / thu ngân.
  2. Backend kiểm tra voucher thuộc đúng organization, đang `ACTIVE` và còn hạn sử dụng.
  3. Khách hàng ký xác nhận dùng voucher trên thiết bị của mình để ghi nhận trạng thái `REDEEMED` lên chain.
- **Kết quả mong đợi:** Voucher chuyển sang `REDEEMED` và `serialCode` không thể dùng lại lần thứ hai.
- **Xử lý sự cố:** Nếu hệ thống báo `ALREADY_REDEEMED` hoặc `EXPIRED`, không áp dụng ưu đãi và kiểm tra lại trạng thái voucher trong mục **Members**.

---

## 8. Cấu hình organization, thông tin pháp lý & chính sách hoàn điểm (Owner)

- **Người thực hiện:** Business Owner
- **Điều kiện trước:** Đăng nhập với vai trò Owner tại `/organizations/:slug/settings`.
- **Các bước:**
  1. Cập nhật thông tin hiển thị (tên hiển thị, logo) trực tiếp trong **Settings**.
  2. Khi cần đổi thông tin pháp lý (tên pháp lý, mã số thuế/giấy tờ), gửi yêu cầu **`UPDATE_IDENTITY`** — quản trị viên nền tảng (Platform Admin) phải duyệt trước khi áp dụng.
  3. Tại mục **Refund Policy**, cấu hình `allowUnused`, `allowExpired`, `allowRedeemed`, `restockUnused`, `refundWindowDays`, nhập lý do thay đổi và publish phiên bản mới.
- **Kết quả mong đợi:** Thông tin hiển thị cập nhật ngay; thay đổi pháp lý chờ Platform Admin duyệt; mỗi lần đổi chính sách hoàn điểm tạo một phiên bản mới để lưu vết đối soát.
- **Xử lý sự cố:** Mở **Refund Policy History** để kiểm tra chính sách áp dụng tại thời điểm phát sinh khiếu nại hoàn điểm.
