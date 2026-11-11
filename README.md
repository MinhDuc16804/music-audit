# music-audit

Công cụ kiểm tra nhạc trong video YouTube của kênh. Dịch vụ nhận diện đang dùng là **AudD**: web app (thư mục `web/`) và các lệnh
`identify`, `identify-file`, `submit` đều gọi AudD. ACRCloud vẫn còn trong code cho bài đo ban đầu (phần Cách chạy bên dưới), chỉ dùng
khi `.env` có `ACRCLOUD_ACCESS_TOKEN` và chọn `MUSIC_SERVICE=acrcloud`.
Công cụ cũng cho biết tỷ lệ video có nhạc, có lời nói trong một mẫu ngẫu nhiên.

Nguyên tắc: **khớp thì tin, không khớp thì chưa biết.** Video chỉ được cho qua khi không có nhạc hoặc có giấy phép.
Kết quả quét không phải bằng chứng về bản quyền và không thay thế giấy phép.

**Trạng thái:** kiểm thử tự động dùng máy chủ AudD và ACRCloud giả mô phỏng theo tài liệu API. Đã có một số lần quét AudD thật
(kết quả trong `out/audd/`), nhưng chưa có bài đo nào trên các video đã biết đáp án, nên chưa biết tỷ lệ bỏ sót thật.
Chưa chạy với tài khoản ACRCloud thật.

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

## Nhận diện nhạc trong một video

Dán một link là có kết quả, không cần `testset.csv` hay `create-container`. Chỉ cần khóa trong `.env`: nếu có
`ACRCLOUD_ACCESS_TOKEN` thì lệnh dùng ACRCloud, nếu không thì dùng `AUDD_API_TOKEN`.

```bash
python3 audit.py identify "https://www.youtube.com/watch?v=VIDEO_ID"
```

Với AudD có thể quét trực tiếp một file âm thanh hoặc video. Quét bằng link cần gói AudD trả phí, tải file thì dùng được với gói
miễn phí:

```bash
python3 audit.py identify-file duong/dan/video.mp4
```

Khác biệt khi dùng AudD:

- AudD không phát hiện "không có nhạc", nên không khớp bài nào luôn là `hold`, không bao giờ là `pass_no_music`.
- Mỗi 12 giây âm thanh tính 1 yêu cầu. Mỗi lần quét tối đa 1 giờ đầu, đổi bằng `AUDD_MAX_CHUNKS`.
- Kết quả được lưu ở `out/audd/`, quét lại cùng video hoặc cùng file không tốn thêm, trừ khi dùng `--rescan`.
- AudD chỉ trả hãng phát hành, không trả dữ liệu chủ sở hữu quyền.

Lệnh in JSON gồm `status`, `decision`, `note` và danh sách bài trong `tracks`. Ý nghĩa của `decision` giống bảng ở phần
[Đọc kết quả](#đọc-kết-quả); `pass_licensed` không xuất hiện vì lệnh này không biết video có giấy phép hay không.

- Chỉ nhận link của một video. Link kênh và playlist bị từ chối, `list=` trong link bị bỏ đi, để không quét nhầm cả danh sách.
- Quét chưa xong sau 100 giây thì trả về `status: processing`. Chạy lại đúng lệnh đó để lấy tiếp, video không bị gửi lại.
- Lần đầu chạy, lệnh tự tạo container ở `ap-southeast-1` nếu chưa có. Muốn đổi thì chạy `create-container` trước.
- `--rescan` gửi quét lại video đã quét và tốn thêm lượt quét.

Agent trong Claude Code tự dùng lệnh này qua skill `identify-music` khi mở repo ở folder này.

## Quét cả kênh

Chọn dịch vụ cho `submit` bằng `MUSIC_SERVICE` trong `.env` (`audd` hoặc `acrcloud`). Để trống thì theo khóa đang có, giống lệnh `identify`.
Với AudD, `submit` quét và lưu kết quả ngay, không cần `create-container` hay `fetch`.

**1. Lấy danh sách video** (cần `YOUTUBE_API_KEY`). Mặc định lấy cả Shorts, thêm `--skip-shorts` để bỏ qua:

```bash
python audit.py list-videos --channel https://www.youtube.com/@kenh-a --skip-shorts
```

**2. Tải âm thanh về máy** (tùy chọn nhưng cần cho bước 3). AudD chỉ cho quét bằng link khi có gói trả phí (lỗi 904), gửi file thì dùng được
với tài khoản dùng thử. Việc tải từ YouTube có thể vi phạm Điều khoản dịch vụ của YouTube. Cần yt-dlp (`winget install yt-dlp.yt-dlp`):

```bash
python audit.py audio-links --all-videos
```

Rồi chạy `tai_am_thanh.bat`, file nằm ở `data/audio/<video_id>.m4a`. Công cụ không dùng cookie tài khoản kênh: nếu YouTube báo "not a bot" thì dừng lại và chạy tiếp sau vài giờ.

**3. Lọc trước có nhạc hay không** trên máy bằng mô hình YAMNet của Google, không tốn lượt AudD. Cần ffmpeg (trong PATH hoặc `FFMPEG_LOCATION`). Cài một lần:

```bash
python -m pip install -r requirements-detect.txt
```

```bash
python audit.py download-models
```

Lệnh tải mô hình YAMNet vào `models/` và kiểm mã băm. Google đổi mô hình thì lệnh báo lỗi và không dùng bản lạ, vì ngưỡng lọc được chỉnh theo bản cũ.

```bash
python audit.py detect-music --all-videos
```

Chỉ có 2 nhóm: `khong-nhac` và `co-nhac` (phân vân cũng là `co-nhac`). Video có nhạc khi có đoạn liền mạch từ 1,5 giây (điểm nhạc ≥ 0,15) hoặc tổng từ 5 giây.
8 giây đầu và 8 giây cuối là intro, outro của kênh nên không tính (`--intro`, `--outro`; `0` để tính lại). Video ngắn hơn
khoảng 46 giây (intro, outro và 30 giây thân) được nghe cả video, để Short ngắn toàn nhạc không bị xếp không nhạc. Đổi ngưỡng bằng `--threshold`, `--min-run`, `--min-total`.

**Đo trước khi tin:** ghi cột `has_music` trong `data/testset.csv` cho các video đã nghe chắc, lệnh sẽ in số video **bỏ sót**.

**4. Gửi đi nhận diện.** Thử 1 video trước. Lệnh in số lượt AudD ước tính trước khi gửi:

```bash
python audit.py submit --all-videos --music-only --limit 1
```

```bash
python audit.py submit --all-videos --music-only
```

- `--music-only` bỏ cả video `khong-nhac` lẫn video chưa lọc. Video bị bỏ qua vẫn có trong báo cáo và không bao giờ được xếp `sach`.
- Không tự gửi lại khi lỗi, vì mỗi lần gửi đều tính phí. Chạy lại lệnh để gửi tiếp, video đã quét không bị quét lại. Gặp lỗi tài khoản AudD (900, 901, 904) thì dừng ngay.
- Vẫn áp dụng giới hạn `AUDD_MAX_CHUNKS` (mặc định 1 giờ đầu mỗi video). Lệnh cảnh báo khi có video dài hơn; tăng giá trị này nếu cần quét hết.
- `--clips N` gửi đoạn 12 giây rải đều mỗi 45 giây ở chỗ có nhạc, tối đa N đoạn mỗi video, mỗi đoạn 1 lượt. Nhạc lọt giữa hai đoạn có thể bị sót. Chạy `compare-clips` để so với kết quả quét cả video.

**5. Xuất báo cáo:**

```bash
python audit.py export --all-videos
```

| File | Nội dung |
|---|---|
| `out/bao-cao-quet.csv` | Mỗi video một dòng: nhóm (`sach`, `co-nhac`, `can-nghe-lai`), lý do, kết quả máy lọc, Policy; mỗi bài một nhóm ô (Bài, Tác giả, Hãng, Library, Vị trí) |
| `out/songs.csv` | Mỗi bài đã nhận ra một dòng (bỏ trùng), số video có bài, cột `library` |

Với AudD, nhóm `sach` luôn rỗng vì AudD không báo "không có nhạc". `resources/audio_library.csv` chỉ xác nhận bài có trong Library: không thấy thì vẫn là `chua-tra`.
Cột `library`, `policy` còn đọc từ `out/library_cache.json`, `out/studio_policy.json` nếu có; phần tra Studio tạo ra hai file này chưa được làm.

**Trạng thái:** luồng này mới kiểm bằng máy chủ AudD giả. Chưa chạy với tài khoản thật, mô hình YAMNet thật, ffmpeg hay yt-dlp thật.

## Các cột trong testset.csv

| Cột | Nội dung |
|---|---|
| `source` | Link YouTube công khai, hoặc đường dẫn file trên máy (video hoặc nhạc) |
| `group` | Một trong các nhóm ở bảng dưới |
| `music_origin` | `vn`, `foreign`, `none`, hoặc để trống |
| `has_music` | Video có nhạc không, dùng để đo máy lọc: `yes`, `no`, hoặc để trống |
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

Khi cần gửi app cho người khác, gửi file zip tạo từ git, đừng nén hay chép cả thư mục làm việc vì thư mục đó có `.env` chứa khóa thật,
cùng `data/`, `out/` và `models/`. Lệnh dưới chỉ lấy file đã commit, nên không bao giờ có các thư mục đó:

```bash
git archive --format=zip --prefix=music-audit/ -o music-audit.zip HEAD
```

Người nhận chép `.env.example` thành `.env` và tự điền khóa của họ.

## Kiểm thử

```bash
python3 -m unittest discover -s tests
```

Máy chủ giả trong `tests/test_flow.py` mô phỏng API theo tài liệu. Khi API thật khác tài liệu, hãy sửa cả mô phỏng này.

## Cấu trúc

| File | Vai trò |
|---|---|
| `audit.py` | Khai báo các lệnh |
| `music_audit/commands/` | Phần làm việc của các lệnh, chia theo nhóm: video, gửi quét, nhận diện, báo cáo |
| `music_audit/workspace.py` | Thư mục dữ liệu, đọc ghi JSON, chọn dịch vụ và khóa |
| `.claude/skills/identify-music/` | Skill để agent gọi lệnh `identify` |
| `music_audit/acrcloud.py` | Gọi File Scanning API |
| `music_audit/audd.py` | Gọi Enterprise API của AudD và đọc kết quả |
| `music_audit/youtube.py` | Lấy danh sách video qua YouTube Data API |
| `music_audit/detect.py` | Lọc trước có nhạc hay không bằng YAMNet, chọn đoạn cắt |
| `music_audit/grouping.py` | Gom theo bài, báo cáo mỗi video một dòng |
| `tai_am_thanh.bat` | Tải âm thanh từ `data/audio/links.txt` bằng yt-dlp |
| `resources/audio_library.csv` | Danh sách bài đã biết có trong Audio Library |
| `music_audit/evaluate.py` | Đọc kết quả, quyết định của cổng kiểm tra, báo cáo |
| `music_audit/common.py` | Đọc `.env`, CSV và kiểm tra danh sách video |
