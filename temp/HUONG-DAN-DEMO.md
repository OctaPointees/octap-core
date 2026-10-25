# Chạy demo OctaP trên máy khác

## 0. Yêu cầu
- Node.js 24+, Docker (hoặc Podman) có docker-compose. **Không cần biết gì về Sui/blockchain/key**
  — script ở bước 3 tự làm hết.
- Checkout branch `dinhviethieu2910/temp-demo` của `OctaPointees/octap-core`

## 1. Cài đặt + build
```bash
npm install
npm run build
```

## 2. Hạ tầng local (Postgres :5433, Redis :6379)
```bash
docker-compose up -d
```

## 3. Tạo `.env`
Copy `.env.example` → `.env`, điền:
```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/octap_dev
```
Rồi chạy script này — nó tự tạo 2 ví testnet mới (issuer + admin) riêng cho máy này, tự xin
gas từ faucet, tự ghi `SUI_ISSUER_PRIVATE_KEY`/`SUI_PROGRAM_ADMIN_PRIVATE_KEY`/`SUI_NETWORK`
vào `.env` — không cần cài Sui CLI, không cần vào trang faucet, không cần biết gì về wallet:
```bash
node temp/generate-testnet-keys.mjs
```
`ENOKI_API_KEY` có thể để trống — trang demo tự fallback sang khách hàng demo nếu không có Enoki.

## 4. Migrate database
```bash
npm run db:migrate
```

## 5. Setup org + program + khách demo (1 lệnh)
```bash
node --env-file=.env temp/demo-setup.mjs
```
Script này tự tạo 1 organization mới, provision program on-chain, phát 1 API key, tạo 1 khách
hàng demo (keypair thật, không qua Google) và enroll sẵn. Cuối cùng in ra 1 block 5 dòng —
copy block đó, dán thay thế 5 dòng `FILL_ME_...` ở đầu `<script type="module">` trong
`temp/login.html`.

## 6. Chạy API + Worker
```bash
node --env-file=.env api/dist/main.js      # terminal 1
node --env-file=.env api/dist/worker.js    # terminal 2
```

## 7. Serve trang demo
```bash
node temp/static-server.mjs 5500           # terminal 3
```
Mở `http://localhost:5500/login.html`, bấm theo thứ tự các Act. Nội dung nói gì ở mỗi bước xem
`temp/demo-narration.md`. Kịch bản curl chi tiết (nếu muốn chạy tay từng lệnh) xem
`docs/demo-script.md`.

## Lưu ý
- Tất cả transaction là thật trên **Sui testnet** — mỗi kết quả có link "Xem trên Suiscan".
- Không dùng chung `.env` hay `temp/login.html` đã điền key giữa 2 máy khác nhau — mỗi máy có
  org/khách/key riêng.
