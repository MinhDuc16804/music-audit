# CLAUDE.md

Bộ đo độ tin cậy của dịch vụ nhận diện nhạc trên video YouTube. Hướng dẫn dùng: `README.md`.
Công cụ của mảng Content Hub; luật chung ở `CLAUDE.md` gốc repo. Chạy các lệnh dưới đây từ folder này.

## Lệnh

```bash
python3 -m unittest discover -s tests   # kiểm thử, dùng máy chủ ACRCloud và AudD giả
python3 audit.py --help                 # các lệnh con: list-videos, sample, create-container, use-container, submit, fetch, report, identify, identify-file
```

Python 3.11 trở lên, code chỉ dùng thư viện chuẩn. Cần `ffmpeg` nếu quét file video trên máy, cần thêm `yt-dlp` cho `identify --extract`.

## Kiến trúc

- `audit.py`: lệnh dòng lệnh. Trạng thái lưu trong `out/` để chạy tiếp được khi bị ngắt.
- `.claude/skills/identify-music/`: skill để agent gọi lệnh `identify` khi có người dán link YouTube.
- `music_audit/acrcloud.py`: gọi API ACRCloud. `music_audit/youtube.py`: lấy danh sách video từ YouTube Data API.
- `music_audit/audd.py`: gọi API AudD cho `identify` và `identify-file`. AudD không phát hiện "không có nhạc", nên không khớp là `hold`.
- `tool/credit_checker/`: web app nhận link hoặc file, nhận diện bằng AudD qua server của Vite rồi đối chiếu với YouTube Audio Library.
- `music_audit/extract.py`: tách mp3 từ một video YouTube cho `identify --extract`, gọi `yt-dlp` như công cụ ngoài.
- `Dockerfile`, `compose.yml`: đóng gói web app. `tool/credit_checker/server/productionServer.ts` là server chạy thật.
- `music_audit/evaluate.py`: phân loại kết quả, tính tỷ lệ kèm khoảng tin cậy, viết báo cáo.
- `music_audit/common.py`: đọc `.env`, đọc và kiểm tra danh sách video.

## Quy tắc

- **Khớp thì tin, không khớp thì chưa biết.** Video chỉ được cho qua khi không có nhạc hoặc có giấy phép.
  Không đổi `gate_decision` theo hướng cho qua video có nhạc không nhận ra.
- Token nằm trong `.env`, không in ra log hay thông báo lỗi, không dán vào chat.
- `data/` và `out/` chứa danh sách video và kết quả quét, nhạy cảm về pháp lý: không vào git, không gửi ra ngoài.
- Không thêm tính năng đổi cao độ, tăng tốc hay cách khác để né nhận diện.
- Kết quả thật có thể khác tài liệu API vì công cụ chưa chạy với tài khoản thật. Sai định dạng thì sửa bộ đọc và thêm kiểm thử.
