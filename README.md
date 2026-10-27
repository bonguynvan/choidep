# 🩴 Chọi Dép Peti

Đại chiến ném dép theo đội cho cả phòng: **màn hình lớn là đấu trường, điện thoại là tay cầm**.
Quét QR, nhập tên, tự được chia đội, rồi chạy và ném dép loạn xạ. Đội trúng nhiều nhất sau 3 phút thắng.
Miễn phí, không cần tài khoản, chơi được cả trăm người một phòng. Chơi tại **https://choidep.peti.vn**.

## Cách chơi
- **Host** tạo phòng trên máy tính nối TV / máy chiếu / OBS. Màn hình hiện mã QR và các đội.
- **Người chơi** quét QR, nhập tên, chọn nhân vật (dùng chung dàn nhân vật với [Đua Vịt](https://github.com/bonguynvan/duavit)).
- Điện thoại hiện **đấu trường quanh bạn** (camera theo nhân vật, có mũi tên BẠN). Phía dưới: **cần điều hướng**
  (chạm ở đâu cần hiện ở đó) và nút **NÉM** tự ngắm đối thủ gần nhất phía trước.
- Vào bằng **máy tính**: chạy bằng **W A S D / phím mũi tên**, ném bằng **Space**.
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
  **Điện thoại** chỉ gửi hướng chạy + nút ném; nhận đấu trường quanh mình 10 lần/giây và trạng thái riêng 4 lần/giây.
- Nhân vật vẽ bằng canvas, cache thành sprite (`public/js/spriteCache.js`), chép từ Đua Vịt.

## Chịu tải
Đo bằng `node tools/loadtest.js [người/phòng] [số phòng] [giây]` (điện thoại giả chạy 15 lệnh/giây, ném ~1 lần/giây):

| Kịch bản | CPU server | Phản hồi ném p99 | RAM | Băng thông server |
|---|---|---|---|---|
| 1 phòng × 150 người | ~14% một nhân | 9 ms | ~110 MB | ~10 Mbit/s |
| 4 phòng × 150 = 600 người | ~26% một nhân | 18 ms | ~210 MB | ~41 Mbit/s |

- Giới hạn thật là **băng thông** (~70 kbit/s mỗi điện thoại), không phải CPU.
- Sân **tự nới rộng theo số người** (`fieldFor`), mỗi điện thoại chỉ nhận những gì ở gần nó.
- Mỗi phòng tối đa 150 người; cả server tối đa `MAX_PLAYERS_TOTAL` (mặc định 1200), quá thì người mới được báo
  "Máy chủ đang rất đông" thay vì làm cả server lag.

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
