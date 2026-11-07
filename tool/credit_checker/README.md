# credit_checker

Web app kiểm tra nhạc trong file hoặc video YouTube. Quy trình có ba bước:

1. Người dùng dán link YouTube hoặc tải file lên.
2. AudD nhận diện các bài trong đó.
3. App tra từng bài trong danh sách YouTube Audio Library.

| Kết quả | Khi nào | Xử lý |
|---|---|---|
| Được dùng | Mọi bài nhận ra đều khớp chắc (cùng tên bài, và trùng một tên nghệ sĩ hoặc album) và AudD nhận ra từ 80% thời lượng | Dùng được. Bài Creative Commons phải ghi nguồn trong mô tả video |
| Không được dùng | Có bài không trùng tên bài nào trong thư viện và có bằng chứng phát thật | Chặn cứng |
| Cần người duyệt | Có bài gần khớp: trùng tên bài nhưng khác nghệ sĩ hoặc khác phiên bản | Nghe đối chiếu trong YouTube Studio |
| Cần người duyệt | Có bài ngoài thư viện không có bằng chứng phát thật | Nghe lại đoạn đó, có thể là AudD nhận nhầm, kể cả nhận nhầm lời nói |
| Cần người duyệt | AudD không nhận ra bài nào | Hỏi nguồn nhạc. AudD không phát hiện "không có nhạc", nên video chỉ có lời nói cũng ở mức này |
| Cần người duyệt | Mọi bài đều có trong danh sách nhưng có bài chưa xác nhận lại | Tra tên bài trong YouTube Studio |
| Cần người duyệt | Mọi bài đều khớp nhưng AudD nhận ra dưới 80% thời lượng, nội dung dài hơn giới hạn quét, hoặc chưa biết độ dài | Nghe kiểm tra phần còn lại |
| Chưa có kết luận | Quét lỗi | Quét lại |

Mỗi đoạn 12 giây AudD có thể trả nhiều bài ứng viên, và có thể nhận nhầm cả lời nói thành bài hát. Vì vậy một bài chỉ có **bằng chứng
phát thật** khi có hai lần khớp liên tiếp mà vị trí trong bài tiến đúng theo thời gian trong video, lệch tối đa 2 giây. Bài ngoài thư
viện không có bằng chứng được bỏ qua nếu mọi đoạn của nó đều có bài trong thư viện có bằng chứng, app hiện nhãn "Có thể nhận nhầm". Vì
thế một đoạn nhạc thương mại chỉ khớp một lần có thể không bị chặn cứng. Luật này mới đo trên 6 lần quét. Độ dài file do trình duyệt đọc, nên không cần
`ffmpeg`. Độ dài video khi quét bằng link lấy ngay lúc tách mp3. Mức 80% là giá trị ban đầu, chưa đo trên dữ liệu thật. App vẫn có tab Quy trình & Pháp lý và Nguồn nhạc để tham khảo.

App không phải tư vấn pháp lý.

## Cách chạy

Cần Node.js 22 trở lên.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

## Triển khai bằng Docker

App chạy trên một máy bật 24/7, có thể là máy công ty hoặc VPS thuê, nhân viên dùng qua trình duyệt. Khóa AudD chỉ nằm trên máy này. Lệnh dưới đây chạy ở thư mục chứa
`compose.yml`, tức thư mục gốc của `music-audit`.

1. Cài Docker, chép `.env.example` thành `.env` và điền `AUDD_API_TOKEN`.
2. Chạy app. Docker tự khởi động lại app khi máy bật lại, nếu Docker được đặt tự chạy cùng máy:

```bash
docker compose up -d --build
```

3. Mở `http://localhost:8080` trên chính máy đó để kiểm tra.

App **chưa có đăng nhập** nên `compose.yml` chỉ mở cổng cho chính máy này. Muốn cho nhân viên vào, hãy dùng Cloudflare Tunnel và
Cloudflare Access trỏ tới `http://localhost:8080`, đừng đổi cổng thành mở ra mạng. Gói miễn phí của Cloudflare chặn yêu cầu trên 100 MB,
nên app giới hạn file tải lên ở 95 MB. File lớn hơn thì xuất riêng phần âm thanh.

Trên VPS, dữ liệu quét trong `out/` nằm ở nhà cung cấp ngoài công ty, và YouTube dễ chặn IP máy chủ hơn, nên quét bằng link có thể không chạy.

Mỗi người có `MAX_SCANS_PER_USER_PER_DAY` lượt quét mỗi ngày, mặc định 30, tính cả lượt lấy lại kết quả cũ. Bộ đếm về 0 khi khởi động lại app.
Mỗi lượt được ghi vào `out/usage.jsonl` gồm thời gian, email, video hoặc tên file và kết quả. Email lấy từ header của Cloudflare Access,
nên không có Access thì mọi người dùng chung một bộ đếm, tên là `khong-ro`.

Các việc thường gặp:

| Việc | Lệnh |
|---|---|
| Xem nhật ký | `docker compose logs -f` |
| Cập nhật app | `docker compose up -d --build` |
| Cập nhật `yt-dlp` khi link không tách được | `docker compose build --no-cache`, rồi `docker compose up -d` |
| Dừng app | `docker compose down` |

Kết quả quét nằm trong volume `music-audit-data`, cập nhật app không làm mất. Thêm `-v` vào lệnh `down` sẽ **xóa** volume này, và các video
đã quét sẽ tốn lượt AudD nếu quét lại. Danh sách `public/audio-library.json` được đóng cùng image, nên sau khi cập nhật danh sách cần
build lại.

## Kiểm tra nhạc

Khóa AudD nằm trong `.env` của `music-audit`, trình duyệt không thấy được, nên việc quét chỉ chạy qua `npm run dev` hoặc
`npm run preview` hoặc `npm start` sau khi build, không chạy khi đưa `dist/` lên trang tĩnh. App luôn dùng AudD, kể cả khi `.env` có khóa ACRCloud.

Khi dán link, server dùng `yt-dlp` và `ffmpeg` tách mp3 của tối đa 60 phút đầu, gửi file đó cho AudD rồi xóa file tạm, nên không cần
gói quét link của AudD. Cần cài:

```bash
python -m pip install --user "yt-dlp[default]"
```

Nếu `ffmpeg` chưa có trong PATH, điền đường dẫn vào `FFMPEG_LOCATION` trong `.env`. App nhận mọi video công khai, không nhận video
riêng tư, giới hạn độ tuổi hay đang phát trực tiếp. **Tải âm thanh từ YouTube có thể vi phạm Điều khoản dịch vụ của YouTube, rủi ro
thuộc về công ty và máy chạy app.** YouTube cũng có thể chặn địa chỉ IP của máy chủ, nhất là máy thuê. Khi đó hãy tải file lên.

File và âm thanh tách ra được gửi tới AudD để quét, nên hãy cân nhắc với nội dung chưa phát hành.

AudD tính 1 yêu cầu cho mỗi 12 giây âm thanh, nên video 10 phút tốn khoảng 50 yêu cầu. Để tránh hóa đơn bất ngờ, mỗi lần quét tối đa
60 phút đầu, đổi bằng biến `AUDD_MAX_CHUNKS` trong `.env`. Kiểm tra lại cùng video hoặc cùng file chỉ lấy kết quả cũ, không tốn thêm.
Nếu không tìm thấy Python, đặt biến môi trường `MUSIC_AUDIT_PYTHON`.

## Danh sách YouTube Audio Library

YouTube không có API hay chức năng xuất cho thư viện này. `public/audio-library.json` gồm danh sách lấy từ YouTube Studio
bằng công cụ [music-crawler](https://github.com/BaeDoge/python-youtube-audio-library-crawler), gộp với danh sách cộng đồng
[youtube-audio-library-download-all](https://github.com/operator-name/youtube-audio-library-download-all) từ tháng 4/2020:

- File xuất có thể thiếu bài: đã có bài còn trong thư viện nhưng không có trong file. Vì vậy bài thật sự trong thư viện vẫn có thể bị chặn nhầm.
- Bài có ở danh sách cũ mà không thấy ở lần xuất mới được giữ lại với trạng thái `unconfirmed`. App báo "Chưa xác nhận lại" và chuyển người duyệt.
- Danh sách chỉ đúng tại thời điểm xuất. YouTube thêm bài mới hai lần mỗi tháng.
- Đây không phải dữ liệu YouTube cung cấp. Lấy tự động từ Studio trái Điều khoản dịch vụ YouTube, rủi ro thuộc về tài khoản dùng để lấy.
  Chưa đọc được điều khoản riêng của Thư viện âm thanh, nên chưa đăng công khai file này. Với bài quan trọng, hãy xem lại trong Studio.
- App lưu tên bài, nghệ sĩ, yêu cầu ghi nguồn, trạng thái chưa xác nhận và dấu bài thêm tay. Không nạp được danh sách thì app không quét.

Muốn cập nhật, xuất file JSON từ music-crawler rồi chạy lệnh sau. Lệnh này gộp vào danh sách đang có và không xóa bài nào:

```bash
npm run library:studio -- <đường dẫn>/youtube-tracks.json
```

Muốn tạo lại từ đầu từ danh sách cộng đồng, tải `music/music-1000.json` của repo trên vào `data/` rồi chạy
`npm run library:import -- data/music-1000.json`. Lệnh này ghi đè toàn bộ danh sách, trừ các bài trong file bổ sung bên dưới.

### Bổ sung bài bằng tay

Bài chưa khớp chắc có nút "Tra trong Studio": nút chép tên bài và mở Thư viện âm thanh của tài khoản đang đăng nhập. App không tự tra Studio.

Bài có trong Studio mà danh sách còn thiếu thì thêm một dòng vào `library-additions.csv`, không cần chạy crawler:

```csv
title,artist,attribution,checkedBy,checkedOn
Tên bài,Tên nghệ sĩ,false,Đức,2026-11-07
```

Rồi chạy lệnh sau. Bản Docker cần build lại image để nhận danh sách mới:

```bash
npm run library:additions
```

- **Phải nghe đối chiếu trong Studio trước khi thêm.** Dòng đã thêm sẽ cho bài đó qua thẳng, không còn qua người duyệt. Thêm nhầm một bài khác cùng tên là có thể lọt bài có bản quyền.
- `title`, `artist`: ghi đúng tên app đang hiện, vì app so với tên AudD trả về. Tên này có thể khác tên trong Studio.
- `attribution`: `true` nếu Studio yêu cầu ghi nguồn, `false` nếu không. Không được bỏ trống.
- `checkedBy`, `checkedOn`: ai đã kiểm tra và ngày kiểm tra, dạng YYYY-MM-DD.
- Thêm nhầm thì xóa dòng đó rồi chạy lại lệnh, bài sẽ rời danh sách.
- `library:studio` và `library:import` luôn áp lại file này. Bài thêm tay sau này có trong lần xuất Studio thì được tính là bài Studio.
- Có dòng sai thì lệnh báo số dòng và không ghi gì.

## Dữ liệu giấy phép cũ

App không còn dùng các lệnh và dữ liệu trong phần này. Chúng được giữ lại phòng khi cần quay về đối chiếu với giấy phép của đội.


Trong PowerShell, thay `npm` bằng `npm.cmd` nếu máy chặn script.

1. Chép `templates/catalog.csv` thành `data/catalog.csv` rồi điền dữ liệu. Trong Excel, lưu dạng **CSV UTF-8**.
2. Chạy lệnh nhập. Nếu có dòng lỗi, lệnh sẽ liệt kê số dòng và không nhập gì:

```bash
npm run catalog:import -- data/catalog.csv
```

| Cột | Nội dung |
|---|---|
| `title`, `artist` | Bắt buộc. Tên khác của cùng bài hoặc nghệ sĩ thì ngăn bằng `\|` |
| `status` | `LICENSED` (đội đã có giấy phép), `SAFE` (Public Domain), `WARNING` (dùng có điều kiện), `RESTRICTED` |
| `license_type` | Bắt buộc. Loại giấy phép hoặc số hợp đồng |
| `allowed_use` | `all`, hoặc `youtube`, `ads`, `film`, `podcast` ngăn bằng `\|`. Bắt buộc với `LICENSED` |
| `expires_on` | Ngày hết hạn dạng `YYYY-MM-DD`. Sau ngày này app coi là rủi ro cao |
| `source`, `verified_by` | Bắt buộc. Nguồn xác minh và người kiểm tra |
| `attribution` | Đoạn ghi nguồn. Dùng `\n` để xuống dòng |

`data/` và `public/catalog.json` không vào git vì có thể chứa thông tin hợp đồng. App web không có đăng nhập: ai mở được app
thì đọc được toàn bộ `catalog.json`, nên đừng đưa dữ liệu hợp đồng lên trang công khai.

### Nhập kết quả ACRCloud

Lệnh dưới đây đọc kết quả do `music-audit` lưu ở `out/raw` (có thể truyền thư mục khác) và tạo `data/catalog.acrcloud.csv`:

```bash
npm run catalog:acr
```

Rồi nhập chung với file hợp đồng. **Đặt file hợp đồng lên trước**, vì khi trùng bài thì file đứng trước được ưu tiên:

```bash
npm run catalog:import -- data/catalog.csv data/catalog.acrcloud.csv
```

Mọi bài ACRCloud nhận ra đều được ghi là `RESTRICTED`, kể cả chính sách `Allow`, vì ACRCloud cho biết ai giữ quyền chứ không cho biết
công ty có được dùng hay không. Video không nhận ra bài nào thì không được ghi vào dữ liệu và không được coi là an toàn. Định dạng
được viết theo tài liệu API, chưa đối chiếu với tài khoản thật.

Muốn xem thử khi chưa có tài khoản ACRCloud, lệnh sau dùng kết quả giả trong `templates/acr-sample` rồi nhập chung với 5.000 bài demo.
Sau đó nhập "Bài Mẫu Thương Mại" và "Ca Sĩ Mẫu" trong app:

```bash
npm run demo:acr
```

### Dữ liệu demo

Muốn thử khối lượng lớn, lệnh sau tạo 5.000 bài giả và app sẽ hiện cảnh báo dữ liệu demo. Khi có dữ liệu thật, chỉ cần chạy lại
lệnh nhập ở trên là dữ liệu demo được thay thế.

```bash
npm run catalog:demo
```

## Cấu trúc

| File | Vai trò |
|---|---|
| `src/App.tsx` | Giao diện và các tab |
| `src/audioLibrary.ts` | Đọc và tra cứu danh sách YouTube Audio Library |
| `src/videoCheck.ts` | Kết luận từ kết quả AudD và danh sách thư viện |
| `public/audio-library.json` | Danh sách bài do `library:import` và `library:studio` tạo |
| `src/catalog.ts` | Danh sách nguồn nhạc, dữ liệu mẫu cũ |
| `src/analyzer.ts` | Luật phân loại cũ, app không còn dùng |
| `src/catalogImport.ts` | Đọc, kiểm tra và gộp CSV |
| `src/acrConvert.ts` | Chuyển kết quả ACRCloud thành CSV |
| `scripts/` | Lệnh nhập dữ liệu và tạo dữ liệu demo |
| `templates/catalog.csv` | File mẫu |
