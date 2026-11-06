# music-audit

Đo xem dịch vụ nhận diện nhạc (hiện là ACRCloud) bắt được bao nhiêu nhạc trong video của kênh, trước khi quyết định mua.
Công cụ cũng cho biết tỷ lệ video có nhạc, có lời nói trong một mẫu ngẫu nhiên.

Nguyên tắc: **khớp thì tin, không khớp thì chưa biết.** Video chỉ được cho qua khi không có nhạc hoặc có giấy phép.
Kết quả quét không phải bằng chứng về bản quyền và không thay thế giấy phép.

**Trạng thái:** mới kiểm bằng máy chủ giả mô phỏng theo tài liệu API, chưa chạy với tài khoản ACRCloud thật.

Yêu cầu: Python 3.11 trở lên. Cần `ffmpeg` nếu quét file video trên máy. Không cần cài thêm thư viện Python.

## Cách chạy

**1. Tạo khóa.** Đăng ký ACRCloud (dùng thử 14 ngày), tạo Access Token trong console, rồi:

```bash
cp .env.example .env
```

Điền token vào `.env`. Không gửi token qua chat.

**2. Điền danh sách video** vào `data/testset.csv` (mẫu ở `templates/testset.csv`, nhớ xóa các dòng ví dụ).

**3. Lấy mẫu ngẫu nhiên** (cần `YOUTUBE_API_KEY`, có thể bỏ qua nếu chỉ đo độ chính xác). Lệnh này cũng in tổng số video và tổng số giờ
của từng kênh, dùng để ước tính chi phí:

```bash
python3 audit.py list-videos --channel https://www.youtube.com/@kenh-a --channel https://www.youtube.com/@kenh-b
```

```bash
python3 audit.py sample --n 100
```

**4. Tạo nơi quét trên ACRCloud** (hoặc dùng `use-container --id <mã>` nếu đã tạo trong console):

```bash
python3 audit.py create-container
```

**5. Thử 3 video trước** để chắc tài khoản và định dạng trả về đúng:

```bash
python3 audit.py submit --limit 3
```

```bash
python3 audit.py fetch
```

```bash
python3 audit.py report
```

**6. Quét toàn bộ.** Video đã gửi sẽ không bị gửi lại:

```bash
python3 audit.py submit
```

```bash
python3 audit.py fetch
```

```bash
python3 audit.py report
```

Kết quả nằm ở `out/report.md` (báo cáo) và `out/results.csv` (từng video).

## Các cột trong testset.csv

| Cột | Nội dung |
|---|---|
| `source` | Link YouTube công khai, hoặc đường dẫn file trên máy (video hoặc nhạc) |
| `group` | Một trong các nhóm ở bảng dưới |
| `music_origin` | `vn`, `foreign`, `none`, hoặc để trống |
| `has_speech` | Video có lời nói không: `yes` hoặc `no` |
| `expected_title` | Tên bài đội biết chắc có trong video. Bắt buộc với nhóm `licensed` |
| `expected_artist` | Tên nghệ sĩ, nhiều người thì ngăn bằng `,` `;` `&` hoặc `/`. Bắt buộc với nhóm `licensed` |
| `has_source_file` | Còn file dựng gốc không: `yes` hoặc `no` |
| `channel`, `note` | Ghi chú, không dùng để tính |

| Nhóm | Là gì | Số lượng gợi ý |
|---|---|---|
| `strike` | Có bài từng bị yêu cầu gỡ. Video đã bị gỡ thì dùng file video hoặc file bài hát trên máy | Mọi video biết được |
| `commercial` | Chắc chắn có nhạc thương mại, chia đều nhạc Việt và nước ngoài, có và không có lời nói | Khoảng 50 |
| `licensed` | Nhạc có giấy phép | Khoảng 10 |
| `no_music` | Chắc chắn không có nhạc | Khoảng 10 |
| `random` | Do lệnh `sample` tạo, không cần gắn nhãn | Khoảng 100 |

Link phải đang công khai thì ACRCloud mới quét được, nên hãy quét trước khi ẩn video.

## Đọc kết quả

| Kết quả | Nghĩa | Xử lý ở cổng kiểm tra |
|---|---|---|
| Nhận đúng bài | Máy nhận ra đúng bài đội đã ghi | Chặn. Video `licensed` chỉ được qua khi mọi bài máy nhận ra đều trùng cả tên bài và nghệ sĩ đã ghi |
| Nhận ra bài khác | Máy thấy bài khác với đội đã ghi | Chặn, người kiểm tra lại |
| Giữ lại | Có nhạc hoặc không rõ, nhưng không nhận ra bài | Người duyệt hỏi nguồn nhạc |
| **Lọt** | Máy kết luận không có nhạc dù thực tế có | Đây là rủi ro lớn nhất cần đo |

Bài đo chỉ cho biết kết quả trên những bài đội đã biết, không phát hiện được bài chưa ai biết là có vấn đề.

## Bảo mật

`data/` và `out/` không vào git: danh sách video và kết quả quét là dữ liệu nhạy cảm về pháp lý. Hãy hỏi luật sư trước khi gửi cho
bên ngoài. `.env` chứa khóa và cũng không vào git.

## Kiểm thử

```bash
python3 -m unittest discover -s tests
```

Máy chủ giả trong `tests/test_flow.py` mô phỏng API theo tài liệu. Khi API thật khác tài liệu, hãy sửa cả mô phỏng này.

## Cấu trúc

| File | Vai trò |
|---|---|
| `audit.py` | Các lệnh |
| `music_audit/acrcloud.py` | Gọi File Scanning API |
| `music_audit/youtube.py` | Lấy danh sách video qua YouTube Data API |
| `music_audit/evaluate.py` | Đọc kết quả, quyết định của cổng kiểm tra, báo cáo |
| `music_audit/common.py` | Đọc `.env`, CSV và kiểm tra danh sách video |
