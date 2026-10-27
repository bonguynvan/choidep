# 🩴 Chọi Dép Peti

Đại chiến ném dép theo đội cho cả phòng: **màn hình lớn là đấu trường, điện thoại là tay cầm**.
Quét QR, nhập tên, tự được chia đội, rồi chạy và ném dép loạn xạ. Đội trúng nhiều nhất sau 3 phút thắng.
Miễn phí, không cần tài khoản, chơi được cả trăm người một phòng. Chơi tại **https://choidep.peti.vn**.

## Cách chơi
- **Host** tạo phòng trên máy tính nối TV / máy chiếu / OBS. Màn hình hiện mã QR và các đội.
- **Người chơi** quét QR, nhập tên, chọn nhân vật (dùng chung dàn nhân vật với [Đua Vịt](https://github.com/bonguynvan/duavit)).
- Bên trái điện thoại là **cần điều hướng**, bên phải là nút **NÉM**: tự ngắm đối thủ gần nhất phía trước.
- Trúng dép thì **choáng** 1,8 giây (nằm bẹp, sao bay), đứng dậy được miễn nhiễm 1 giây. Không ai bị loại.
- Đồ nhặt trên sân: 🩴 dép tổ ong (ném 3 chiếc), 🎈 bóng nước (nổ cả vùng), ⛑️ mũ bảo hiểm (đỡ 1 lần), 🧋 trà sữa (chạy nhanh).
- Cuối trận: đội thắng, **Thánh ném** (trúng nhiều nhất) và **Bao cát** (bị trúng nhiều nhất).
- Host chọn 2–4 đội, 1–5 phút, xáo đội, thêm bot cho đông vui. Có trang OBS riêng (`/r/MÃ/live`) cho livestream.

## Chạy thử trên máy
```bash
npm install
npm run dev        # http://localhost:3000
npm test
```
Mở trang chủ → **Tạo phòng** (màn hình lớn), rồi mở `/r/MÃ` ở tab hoặc điện thoại khác để chơi.
Trên máy tính, tay cầm điều khiển được bằng **WASD / mũi tên** và **Space**.

## Kiến trúc
- Node 22+, Express, Socket.IO, canvas, không có bước build.
- **Server quyết định mọi thứ** (`src/game/arena.js`): mô phỏng 20 lần/giây, tự ngắm, va chạm, đồ nhặt, bot.
- **Màn hình lớn / OBS** nhận vị trí 20 lần/giây và nội suy cho mượt (`public/js/arenaView.js`).
  **Điện thoại** chỉ gửi hướng chạy + nút ném, chỉ nhận trạng thái của chính mình 4 lần/giây.
- Nhân vật vẽ bằng canvas, cache thành sprite (`public/js/spriteCache.js`), chép từ Đua Vịt.

## Triển khai (VPS dùng chung Caddy với các game Peti khác)
```bash
cd /srv && git clone https://github.com/bonguynvan/choidep.git && cd choidep
cp .env.example .env && nano .env    # PUBLIC_URL=https://choidep.peti.vn, GA4_ID, OPS_TOKEN
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build         # app ở 127.0.0.1:3201
sudo cp deploy/choidep.caddy /srv/edge/conf/sites/
docker exec edge-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```
- DNS: bản ghi A `choidep` → IP VPS.
- Cập nhật: `./deploy/update.sh`. Sao lưu hằng ngày: `deploy/backup.sh` (xem chú thích trong file).
- Admin tổng **admin.peti.vn**: thêm `choidep|Chọi dép|http://127.0.0.1:3201|https://choidep.peti.vn` vào `GAMES`
  trong `.env` của peti.vn, dùng cùng `OPS_TOKEN`.

## Giấy phép
MIT. Nhân vật dùng chung với Đua Vịt (cũng MIT).
