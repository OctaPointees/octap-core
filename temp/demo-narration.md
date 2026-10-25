# Script thuyết minh demo OctaP (ngắn)

Mở `http://localhost:5500/login.html`, bấm theo thứ tự. Mỗi bước nói 1-2 câu dưới đây.

**1. Đăng nhập**
"Khách hàng đăng nhập bằng tài khoản Google có sẵn — không cần tạo ví, không cần nhớ mật khẩu riêng. Hệ thống tự tạo một địa chỉ blockchain cho họ ở lần đầu."
→ Dùng khi: cửa hàng/app muốn onboard khách phổ thông mà không bắt họ học crypto wallet.

**2. Earn điểm**
"Khách mua hàng, cửa hàng gọi API cộng điểm — điểm này được ghi thật trên blockchain, không phải số trong database có thể sửa tay."
→ Dùng khi: mọi giao dịch tích điểm tại POS, app, hoặc tích hợp với hệ thống bán hàng hiện có.

**3. Voucher**
"Cửa hàng tạo một voucher giảm giá, khách đổi điểm lấy voucher, rồi dùng voucher đó khi thanh toán."
→ Dùng khi: chạy khuyến mãi, đổi điểm thành ưu đãi cụ thể thay vì chỉ cộng/trừ điểm.

**4. Thanh toán bằng điểm tại POS (quan trọng nhất)**
"Nhân viên quét mã khách để trừ điểm — nhưng nhân viên **không có quyền tự ý trừ**, giao dịch chỉ xảy ra khi chính khách hàng xác nhận bằng chữ ký điện tử của họ. Giống như quẹt thẻ cần nhập PIN, chỉ khác đây là chữ ký số."
→ Dùng khi: thanh toán tại điểm bán, chống nhân viên/hệ thống tự ý trừ điểm khách mà không được phép.

**5. Hoàn/huỷ giao dịch (reversal)**
"Nếu đơn hàng bị huỷ hoặc gian lận, cửa hàng có thể hoàn lại điểm — việc hoàn này cũng được ghi thật trên blockchain, không chỉ sửa số trong database."
→ Dùng khi: khách trả hàng, đơn lỗi, hoặc phát hiện gian lận cần thu hồi điểm.

**6. Ngân sách khuyến mãi cạn → nạp thêm**
"Mỗi chương trình tích điểm có một ngân sách giới hạn (để tránh phát điểm vô tội vạ). Khi cạn, hệ thống tự chặn earn — quản trị viên chỉ cần nạp thêm ngân sách, không phải dừng cả chương trình để sửa."
→ Dùng khi: kiểm soát chi phí khuyến mãi, tránh một lỗi hệ thống làm phát điểm không giới hạn.

**7. Webhook thông báo**
"Khi có giao dịch, hệ thống tự động báo cho hệ thống khác của doanh nghiệp (CRM, app riêng, Slack...) qua webhook — không cần họ liên tục hỏi lại server."
→ Dùng khi: tích hợp với hệ thống nội bộ của khách hàng doanh nghiệp (B2B), đồng bộ dữ liệu real-time.

---
**Câu chốt**: "Tất cả điểm, giao dịch, thanh toán ở đây đều là dữ liệu thật trên blockchain testnet — không phải giả lập. Khi lên production chỉ đổi network, logic giữ nguyên."
