# CLAUDE.md

Bộ đo độ tin cậy của dịch vụ nhận diện nhạc trên video YouTube. Hướng dẫn dùng: `README.md`.
Công cụ của mảng Content Hub; luật chung ở `CLAUDE.md` gốc repo. Chạy các lệnh dưới đây từ folder này.

## Lệnh

```bash
python3 -m unittest discover -s tests   # kiểm thử, dùng máy chủ ACRCloud và AudD giả
python3 audit.py --help                 # các lệnh con: list-videos, sample, audio-links, download-audio, detect-music, create-container, use-container, submit, compare-clips, fetch, report, export, identify, identify-file, durations, channel-check, channel-status, channel-report
```

Python 3.11 trở lên, code chỉ dùng thư viện chuẩn. Cần `ffmpeg` nếu quét file video trên máy, cần thêm `yt-dlp` cho `identify --extract`.
Ngoại lệ duy nhất: `detect-music` cần `requirements-detect.txt` (ai-edge-litert, numpy) và mô hình trong `models/`.
Nạp chúng trong `music_audit/detect.py` khi chạy thật, không import ở đầu file, để các lệnh khác, web app và kiểm thử chạy không cần cài.

`tai_am_thanh.bat` tải âm thanh (yt-dlp, m4a) từ `data/audio/links.txt` vào `data/audio/<video_id>.m4a`.
`submit` gửi file đó thay cho link nếu có, nhưng khóa trong `submissions.json` và `raw/` vẫn là link.

## Kiến trúc

- `audit.py`: lệnh dòng lệnh. Trạng thái lưu trong `out/` để chạy tiếp được khi bị ngắt.
- `.claude/skills/identify-music/`: skill để agent gọi lệnh `identify` khi có người dán link YouTube.
- `music_audit/acrcloud.py`: gọi API ACRCloud. `music_audit/youtube.py`: lấy danh sách video từ YouTube Data API.
- `music_audit/audd.py`: gọi API AudD cho `identify` và `identify-file`. AudD không phát hiện "không có nhạc", nên không khớp là `hold`.
- `web/`: web app nhận link hoặc file, nhận diện bằng AudD qua server của Vite rồi đối chiếu với YouTube Audio Library.
- `music_audit/extract.py`: tách mp3 từ một video YouTube cho `identify --extract`, gọi `yt-dlp` như công cụ ngoài.
- `web/server/channelRunner.ts`: tab Quét cả kênh, gọi `download-audio`, `detect-music`, rồi `submit --video-id` từng video sau khi có người xác nhận chi phí. Không được bỏ bước xác nhận hay tự chạy tiếp sau khi khởi động lại.
- `Dockerfile`, `compose.yml`: đóng gói web app. `web/server/productionServer.ts` là server chạy thật.
- `music_audit/detect.py`: máy lọc có nhạc hay không (YAMNet) và chọn đoạn cắt cho `--clips`.
- `music_audit/grouping.py`: lệnh `export`, gom theo bài (`songs.csv`) và báo cáo mỗi video một dòng (`bao-cao-quet.csv`). Thông tin Studio (Library, Policy) không bao giờ đưa video vào `sach`.
- `music_audit/evaluate.py`: phân loại kết quả, tính tỷ lệ kèm khoảng tin cậy, viết báo cáo.
- `music_audit/common.py`: đọc `.env`, đọc và kiểm tra danh sách video.

## Quy tắc

- **Khớp thì tin, không khớp thì chưa biết.** Video chỉ được cho qua khi không có nhạc hoặc có giấy phép.
  Không đổi `gate_decision` theo hướng cho qua video có nhạc không nhận ra.
- Token nằm trong `.env`, không in ra log hay thông báo lỗi, không dán vào chat.
- `data/` và `out/` chứa danh sách video và kết quả quét, nhạy cảm về pháp lý: không vào git, không gửi ra ngoài.
- Không thêm tính năng đổi cao độ, tăng tốc hay cách khác để né nhận diện.
- AudD không tự gửi lại khi lỗi vì mỗi lần gửi đều tính phí. `submit` giữ giới hạn `AUDD_MAX_CHUNKS`; tham số quét liền mạch (`full_scan`) chỉ dùng cho quét cả kênh, không đổi lệnh `identify` của web app.
- Máy lọc (`detect.py`) chỉ có 2 nhóm; phân vân, lỗi đọc file đều là `co-nhac`. Chỉnh ngưỡng theo hướng không bỏ sót, chấp nhận báo dư. Kết quả lọc không bao giờ đưa video vào `sach`.
- `--music-only` và `--clips` không bật mặc định: người chạy phải chọn. `--clips` có thể sót nhạc nằm giữa hai đoạn.
- `resources/audio_library.csv` chỉ xác nhận bài có trong Library; không thấy trong danh sách thì vẫn là `chua-tra`.
- Không dùng cookie tài khoản kênh hay cách vượt kiểm tra bot của YouTube khi tải âm thanh.
- Kết quả thật có thể khác tài liệu API vì công cụ chưa chạy với tài khoản thật. Sai định dạng thì sửa bộ đọc và thêm kiểm thử.
