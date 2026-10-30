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

Server thử ngôn ngữ yêu cầu, tiếng Anh rồi ngôn ngữ có sẵn nếu lỗi do thiếu ngôn ngữ;
sau đó thử endpoint transcript của `youtubei.js` khi phương thức chính thất bại.
Fallback này dùng ngôn ngữ mặc định của YouTube (có thể khác `lang` yêu cầu).
YouTube vẫn có thể từ chối truy cập; fallback không đảm bảo vượt qua giới hạn IP.

Kiểm thử: `npm run build` rồi `node --test tests/transcripts.cjs` (mock upstream, không gọi YouTube).
