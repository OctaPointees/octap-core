# Kịch bản Demo/POC — OctaP Core (chưa có UI)

> **OCT-50** (reverse/clawback on-chain, PR #33) và **OCT-81** (budget shard top-up, PR #32)
> đã merge vào `main` — mọi Act dưới đây chạy được thật, không còn là giả định.
> Toàn bộ chạy qua `curl` thẳng vào API — chưa cần UI sản phẩm, chỉ cần một trang HTML tối
> giản để lấy Google `id_token` ở Act 1.
>
> Base URL giả định: `http://127.0.0.1:3000` (theo `API_HOST`/`API_PORT` trong `.env.example`).
> Mọi route/DTO dưới đây lấy trực tiếp từ `main` (`api/src/api/rest/*.controller.ts`,
> `api/src/api/dto/*.dto.ts`) — không đoán.

## Chuẩn bị (one-time, trước giờ demo)

```bash
# 1. Build xong thì seed credential cho org demo đã seed sẵn trong DB
node scripts/seed-dev-credential.mjs <org-id-demo> "demo-key"
# -> lưu rawKey, gọi là $KEY_A

# 2. (Tùy chọn — để chứng minh multi-tenant OCT-73) tạo thủ công 1 org thứ 2 trong Postgres,
# rồi provision on-chain cho nó:
node scripts/provision-program.mjs <org-id-2> 500 365 1000000
node scripts/seed-dev-credential.mjs <org-id-2> "demo-key-2"   # -> $KEY_B
```

Checklist cần chuẩn bị **trước** giờ demo, không làm giữa lúc trình bày:
- [ ] `$KEY_A`, `$KEY_B` đã có sẵn, dán vào biến môi trường trong terminal demo.
- [ ] `<org-id-demo>`, `<org-id-2>` ghi sẵn ra một file cạnh đây.
- [ ] Một trang HTML tối giản (nút "Sign in with Google") để lấy `id_token` thật ở Act 1 — không
  phải UI sản phẩm, chỉ cần nút đăng nhập.
- [ ] Một script Node nhỏ đóng vai "customer device" ký giao dịch ở Act 4, dùng
  `@octap/browser-sdk` — vì chữ ký của khách phải ký bằng ephemeral key phía client, server
  không bao giờ cầm private key này.

---

## Act 1 — Đăng nhập khách hàng (zkLogin qua Enoki)

```bash
curl -X POST http://127.0.0.1:3000/v1/identity/google-login \
  -H 'content-type: application/json' \
  -d '{"idToken":"<id_token thật từ Google>"}'
# -> { "endUserId": "...", "suiAddress": "0x...", "isNewUser": true }

curl -X POST http://127.0.0.1:3000/v1/identity/organizations/<org-id-demo>/enroll \
  -H 'content-type: application/json' \
  -d '{"endUserId":"<endUserId>"}'
# -> { "organizationEndUserId": "...", "isNewEnrollment": true }
```

`organizationEndUserId` trả về ở bước enroll chính là id dùng cho **mọi** lệnh earn/redeem bên
dưới — lưu lại làm `$OEU_ID`.

---

## Act 2 — Earn điểm thật trên-chain

```bash
curl -X POST http://127.0.0.1:3000/v1/credits/earn \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"organizationEndUserId":"'"$OEU_ID"'","pointsAmount":500,"idempotencyKey":"demo-earn-1"}'

curl http://127.0.0.1:3000/v1/credits/members/$OEU_ID/balance -H "Authorization: Bearer $KEY_A"
# -> confirmedBalance, asOfCheckpoint, observedAt, stale
#    nhấn mạnh: số này đọc lại từ chain qua indexer, không phải chỉ ghi Postgres

curl http://127.0.0.1:3000/v1/credits/members/$OEU_ID/transactions -H "Authorization: Bearer $KEY_A"
```

Mở Suiscan/testnet explorer bằng `sui_tx_digest` trong transaction trả về để chứng minh đây là
giao dịch thật trên-chain, không phải giả lập.

---

## Act 3 — Voucher (claim/redeem, thuần Postgres)

```bash
curl -X POST http://127.0.0.1:3000/v1/rewards/vouchers \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"code":"DEMO10","title":"10% off","discountType":"PERCENTAGE","discountValue":"10","totalSupply":100}'

curl -X POST http://127.0.0.1:3000/v1/rewards/vouchers/<voucher-id>/claim \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"organizationEndUserId":"'"$OEU_ID"'"}'

curl -X POST http://127.0.0.1:3000/v1/rewards/vouchers/redeem \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"serialCode":"<serial trả về từ bước claim>"}'
```

---

## Act 4 — POS redemption thật, khách tự ký (điểm nhấn kỹ thuật nhất)

```bash
curl -X POST http://127.0.0.1:3000/v1/credits/redeem/reserve \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"organizationEndUserId":"'"$OEU_ID"'","pointsAmount":100,"idempotencyKey":"demo-pos-1"}'
# -> { "digest": "...", ...bytes cần khách ký... }
```

Merchant (POS) chỉ **initiate** — không tự ký. Khách tự ký bằng ephemeral key của chính họ (script
Node mô phỏng "customer device", dùng `@octap/browser-sdk`), sau đó:

```bash
curl -X POST http://127.0.0.1:3000/v1/credits/redeem/finalize \
  -H 'content-type: application/json' \
  -d '{"digest":"<digest>","signature":"<chữ ký khách vừa tạo>"}'
```

**Điểm cần nói khi demo**: route `finalize` là `@Public()` — merchant API key không liên quan gì ở
bước này. Chữ ký của khách là bằng chứng duy nhất, chứng minh đây là sponsorship + customer-signed
thật, không phải worker giả danh khách hàng.

---

## Act 5 — Reversal thật trên-chain (OCT-50, PR #33 — đã merge)

```bash
curl -X POST http://127.0.0.1:3000/v1/credits/transactions/<earn-tx-id>/reverse \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"idempotencyKey":"demo-reverse-1","reason":"demo clawback"}'
```

Mở lại cùng `sui_tx_digest` trên explorer, chỉ ra bucket của `CreditAccount` đã bị trừ thật
trên-chain — không chỉ ghi lại trong Postgres. Trước PR #33, lệnh reverse chỉ sửa Postgres;
giờ nó phát ra một giao dịch on-chain thật, dùng cùng digest để kiểm chứng trước/sau.

---

## Act 6 — Budget cạn → top-up (OCT-81, PR #32 — đã merge)

```bash
# Earn liên tục tới khi BudgetShard cạn -> earn abort EBudgetExceeded (dựng sẵn kịch bản lỗi này)
node scripts/top-up-budget.mjs <org-id-demo> 500000
# earn lại ngay sau đó -> thành công, không cần re-provision lại cả program
```

"Wow moment" tốt cho demo: trước PR #32, cạn budget = program chết hẳn, phải provision lại từ
đầu; giờ chỉ cần **một** lệnh admin (AdminCap-gated) để top-up và tiếp tục earn ngay.

---

## Act 7 — Webhook + chứng minh multi-tenant isolation (OCT-73)

```bash
curl -X POST http://127.0.0.1:3000/v1/webhooks/endpoints \
  -H "Authorization: Bearer $KEY_A" -H 'content-type: application/json' \
  -d '{"url":"https://webhook.site/<your-id>","description":"demo"}'

# Earn lại -> mở webhook.site xem credits.earn.confirmed được gửi tới
# verify chữ ký bằng Node SDK: constructWebhookEvent(...)
```

```bash
# Earn với $KEY_B (org thứ 2) rồi so sánh sui_tx_digest của 2 giao dịch trên explorer
# -> landing trên 2 ProgramControl object id khác nhau, chứng minh multi-tenant thật
```

---

## Những gì KHÔNG nằm trong kịch bản này (chưa làm, đừng hứa khi demo)

- Tạo organization mới qua API (OCT-36 chưa làm) — org thứ 2 ở Act 7 phải tạo tay trong Postgres.
- Login merchant/dashboard admin (OCT-39/208/63 chưa làm) — mọi thứ ở đây chạy bằng API key, không
  có session người dùng hệ thống.
- Campaign draft/approval (OCT-59), Audit export (OCT-77) — chưa tồn tại.
