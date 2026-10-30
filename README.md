# YouTube API Server (Standalone for Koyeb / Docker)

Dự án API độc lập tách từ `lenytdesktop` chuyên phục vụ các tính năng YouTube:
- Lấy thông tin video, view, like, description
- Lấy kịch bản / transcript phụ đề video
- Lấy danh sách video của toàn bộ kênh YouTube
- Tải Audio gốc (MP3 / M4A)
- Tải Video MP4 (H.264/AAC tương thích mọi thiết bị)
- Tải ảnh thumbnail (tự động chuyển đổi WebP sang JPG)

---

## 1. Cài đặt và chạy Local

```bash
cd /Users/quangnynh/Desktop/project/apiyt
npm install
npm run dev
```

Server sẽ chạy tại `http://localhost:8000`.

---

## 2. Deploy lên Koyeb (Free Tier)

Dự án đã có sẵn **`Dockerfile`** chuẩn chỉnh (tự động cài Node 20, FFmpeg, Python và tải bản `yt-dlp` mới nhất).

### Cách 1: Deploy qua GitHub Repository (Khuyên dùng)
1. Đẩy thư mục này lên một repo GitHub mới của bạn (ví dụ: `apiyt`).
2. Đăng nhập [Koyeb.com](https://app.koyeb.com/).
3. Bấm **Create App** → chọn **GitHub**.
4. Chọn repo `apiyt` của bạn.
5. Koyeb sẽ tự động nhận diện `Dockerfile`.
   - Chọn loại instance: **Free** (Nano 512MB RAM).
   - Port: **8000**.
6. Bấm **Deploy**.

### Cách 2: Tránh bị YouTube chặn IP trên Koyeb (Quan trọng!)
YouTube có thể chặn IP của Datacenter. Để khắc phục:
1. Xuất file `cookies.txt` từ tài khoản YouTube trên trình duyệt của bạn (sử dụng extension như *Get cookies.txt LOCALLY*).
2. Khi deploy trên Koyeb, bạn có thể truyền nội dung cookie hoặc mount file `cookies.txt` vào `/app/cookies.txt`.
3. Hoặc đặt biến môi trường `YT_COOKIES_PATH=/app/cookies.txt`.

---

## 3. Danh sách Endpoints

| Method | Endpoint | Body (JSON) | Mô tả |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Không | Kiểm tra trạng thái server (dùng cho Uptime ping) |
| `POST` | `/api/v1/youtube/transcript` | `{"videoId": "xxx", "lang": "en"}` | Lấy phụ đề / kịch bản của 1 video |
| `POST` | `/api/v1/youtube/transcripts` | `{"videoIds": ["id1", "id2"]}` | Lấy phụ đề hàng loạt video |
| `POST` | `/api/v1/youtube/info` | `{"videoId": "xxx"}` | Lấy thông tin chi tiết (view, like, title, desc) |
| `POST` | `/api/v1/youtube/urls` | `{"url": "https://youtube.com/@channel"}` | Quét toàn bộ video kèm view và ngày đăng |
| `GET` | `/api/v1/youtube/urls/jobs/:id`| Không | Lấy kết quả quét kênh (với kênh dài) |
| `POST` | `/api/v1/youtube/download-image`| `{"imageUrl": "https://..."}` | Tải ảnh thumbnail (WebP tự đổi thành JPG) |
| `POST` | `/api/v1/youtube/audio/youtubei`| `{"url": "https://...", "format": "mp3"}` | Tải audio bằng youtubei (nhẹ, ít bị chặn) |
| `POST` | `/api/v1/youtube/audio` | `{"url": "https://..."}` | Tải audio bằng yt-dlp stream |
| `POST` | `/api/v1/youtube/video` | `{"url": "https://...", "quality": "1080p"}` | Tải video chuẩn MP4 |

### Phản hồi transcript

`/transcript` trả một object; `/transcripts` trả một mảng theo thứ tự `videoIds`.
`success` chỉ là `true` khi có transcript không rỗng. Metadata có thể vẫn có khi lấy phụ đề thất bại.

- `transcript`: mảng `{ text, offset, duration, lang }` (thời gian tính bằng giây), hoặc `null`.
- `text`: toàn bộ kịch bản ghép thành chuỗi, hoặc `null` khi thất bại.
- `error`: thông báo lỗi lấy phụ đề khi thất bại; `null` khi thành công.

Client cần kiểm tra `item.success` trước khi hiển thị `item.text` hoặc ghép `item.transcript.map(segment => segment.text)`.
Không dùng metadata để xác định đã lấy được kịch bản.

Server dùng `yt-dlp` để tìm caption tracks, chọn một track JSON3 rồi tải phụ đề;
không tải video/audio và không gọi endpoint `get_transcript` đang trả 400.
Ưu tiên ngôn ngữ yêu cầu, tiếng Anh rồi ngôn ngữ gốc/có sẵn, ưu tiên track thủ công
trong cùng ngôn ngữ. `transcriptLanguage` là ngôn ngữ thực tế đã chọn.

### Deploy transcript trên Render

- Chọn Docker runtime và Dockerfile của repo để có Python, FFmpeg và `yt-dlp`.
  Docker dùng Node 22, `npm ci`, và tải bản `yt-dlp` mới tại lúc build.
- Health check: `/health`. Server đọc `PORT` do Render cấp.
- Mặc định xử lý một video tại một thời điểm cho cả endpoint đơn và batch;
  mỗi batch tối đa 10 video (khớp client `lenytdesktop`).
- Request trùng video/ngôn ngữ dùng chung tác vụ đang chạy.
  Cache kết quả thành công 1 giờ, tối đa 100 mục và 16 MiB payload mỗi instance;
  cache mất khi restart và không chia sẻ giữa các instance.
- Mỗi video mặc định giới hạn 90 giây chạy extractor + 10 giây tải phụ đề, không retry dồn dập.
  Batch 10 video có thể cần khoảng 1.000 giây khi upstream chậm; nên thử một video trước, client cần timeout phù hợp.
- Nếu Render bị YouTube chặn, cấu hình `YT_PROXY_URL=http://user:password@host:port`
  (hỗ trợ HTTP/HTTPS proxy). Cả bước tìm track và tải phụ đề đều dùng cùng proxy.
  Dùng proxy có IP ổn định trong suốt hai bước; không đưa mật khẩu proxy vào git.
- Cookies tùy chọn: `YT_COOKIES` (Netscape raw/base64) hoặc `YT_COOKIES_PATH`.
  Cookies được truyền vào extractor; cookies không đảm bảo khắc phục IP bị chặn.
- Khi thất bại, `errorCode` phân biệt `YOUTUBE_ACCESS_BLOCKED`, `CAPTIONS_UNAVAILABLE`
  và `TRANSCRIPT_FETCH_FAILED`. API không khẳng định video đã bị xóa chỉ vì request thất bại.
- Rebuild/redeploy để cập nhật extractor khi YouTube thay đổi. Thành công ở local
  không đảm bảo IP Render truy cập được; cần kiểm tra lại bốn video sau deploy.

Kiểm thử: `npm run build` rồi `node --test tests/transcripts.cjs` (mock upstream, không gọi YouTube).

### Chẩn đoán cookies và lỗi Render

`YT_COOKIES` chấp nhận nội dung Netscape nhiều dòng hoặc base64. Dòng dữ liệu phải
có bảy cột phân cách bằng tab; không đặt thêm dấu nháy bao quanh toàn bộ giá trị.
Server chuẩn hóa CRLF và các chuỗi literal `\n`, `\t`, kiểm tra định dạng trước khi chạy.
Mỗi worker dùng file riêng và truyền cookies cập nhật từ extractor cho request caption
(trong phạm vi HTTPS YouTube), sau đó xóa file tạm của worker.

Kết quả thất bại có `stage` (`cookies`, `extract`, `select`, `captions`, `parse`)
và `upstreamStatus` nếu nhận được HTTP status. `INVALID_COOKIES` chỉ lỗi cấu hình;
`TRANSCRIPT_TIMEOUT` chỉ timeout. Cookie đúng định dạng không chứng minh phiên còn hợp lệ
hoặc IP Render được phép truy cập. Không chia sẻ cookie thật trong log, issue hay git.

### Extractor chậm hoặc bị hệ thống dừng

- `YT_TRANSCRIPT_TIMEOUT_MS`: giới hạn tiến trình, mặc định `90000`, chấp nhận `10000`–`180000`.
- `YT_TRANSCRIPT_CONCURRENCY`: mặc định `1`, chấp nhận `1`–`4`; giữ `1` trên instance ít CPU/RAM.
- Lỗi extractor có `diagnostic.reason`, `elapsedMs`, `timeoutMs` và `signal` nếu có.
  Log Render có dòng `[Transcript]` với cùng thông tin, không chứa stderr thô, cookies hay proxy URL.
- `EXTRACTOR_DEADLINE`: tiến trình chạm giới hạn; `EXTRACTOR_TERMINATED`: nhận tín hiệu dừng khác,
  cần đối chiếu log/metrics Render, không tự kết luận là thiếu RAM.
- `YOUTUBE_ACCESS_BLOCKED`, `COOKIE_SESSION_REJECTED`, `PO_TOKEN_REQUIRED`, `JS_CHALLENGE_FAILED`,
  `DNS_FAILURE`, `UPSTREAM_TIMEOUT` là phân loại từ thông báo upstream, không đảm bảo chẩn đoán đầy đủ.
- Tăng timeout không khắc phục được chặn IP hoặc phiên hết hiệu lực. Kiểm tra trên chính Render sau deploy.
