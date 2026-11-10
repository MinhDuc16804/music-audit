# Web app kiểm tra nhạc

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
`ffmpeg`. Độ dài video khi quét bằng link lấy ngay lúc tách mp3. Mức 80% là giá trị ban đầu, chưa đo trên dữ liệu thật. App vẫn có tab Nguồn nhạc để tham khảo.

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

App không có trang đăng nhập riêng nên `compose.yml` chỉ mở cổng cho chính máy này. Muốn cho nhân viên vào, hãy dùng Cloudflare Tunnel và
Cloudflare Access trỏ tới `http://localhost:8080`, đừng đổi cổng thành mở ra mạng.

Nên điền `CF_ACCESS_TEAM_DOMAIN` (ví dụ `ten-cong-ty.cloudflareaccess.com`) và `CF_ACCESS_AUD` (Application Audience Tag trong trang
ứng dụng của Access) vào `.env`. Khi có đủ hai biến, server kiểm chữ ký token Access của từng yêu cầu và lấy email từ token,
nên không ai giả được email để có thêm lượt. Yêu cầu không có token hợp lệ bị từ chối. Thiếu hai biến này thì app tin header email
như trước, chỉ an toàn khi không ai gọi thẳng được vào cổng 8080. Gói miễn phí của Cloudflare chặn yêu cầu trên 100 MB,
nên app giới hạn file tải lên ở 95 MB. File lớn hơn thì xuất riêng phần âm thanh.

Trên VPS, dữ liệu quét trong `out/` nằm ở nhà cung cấp ngoài công ty, và YouTube dễ chặn IP máy chủ hơn, nên quét bằng link có thể không chạy.

Mỗi người có `MAX_SCANS_PER_USER_PER_DAY` lượt quét mỗi ngày, mặc định 30. Màn hình quét một video tính cả lượt lấy lại kết quả cũ, còn quét hàng loạt thì không. Quét lỗi thì được hoàn lượt. Bộ đếm về 0 lúc nửa đêm giờ Việt Nam và được lưu trong `out/limits/`, nên khởi động lại app không xóa số đã dùng.
Màn hình quét một video chạy nền trên server rồi trình duyệt hỏi lại kết quả mỗi 3 giây, nên không bị Cloudflare cắt khi quét lâu. Bấm Dừng chờ thì server vẫn quét nốt, kết quả xem ở tab Lịch sử quét.

Khi kết quả là kết quả cũ, màn hình Kiểm tra nhạc và tab Lịch sử quét ghi ngày quét và có nút **Quét lại**. Nút này luôn hỏi lại kèm số yêu cầu AudD sẽ tốn, tính 1 lượt quét và được ghi `"rescan": true` trong `out/usage.jsonl`. File tải lên chỉ quét lại được ở màn hình Kiểm tra nhạc, vì server không giữ file.
Mỗi bài nhận ra có thanh vị trí và các mốc thời gian; với link YouTube, bấm mốc để mở video đúng giây đó.
Công tắc "Báo cho tôi khi quét xong" ở tab Quét hàng loạt và Quét cả kênh hiện thông báo trình duyệt khi lô hoặc kênh xong, tạm dừng hoặc chờ xác nhận chi phí, và đổi tiêu đề tab. Chỉ báo được khi app còn mở ở một tab.
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

## Quét hàng loạt

Mục Quét hàng loạt nhận tối đa 20 link video mỗi lô, sửa ở `MAX_BATCH_VIDEOS` trong `src/batchScan.ts`. Mỗi video được kết luận theo đúng luật của màn hình một video.

- Lô chạy nền trên server, đóng tab vẫn tiếp tục. Trạng thái lưu ở `out/batches.json`, app khởi động lại thì quét tiếp.
- Mỗi người chỉ có một lô chưa xong tại một thời điểm. Server quét từng video một, xen kẽ với màn hình một video, nghỉ 5 giây giữa hai video phải tải về.
- Lượt được giữ ngay khi tạo lô, mỗi video một lượt. Video đã có kết quả không tốn lượt. Hủy lô thì hoàn lượt phần chưa quét, quét lại video lỗi không tính thêm.
- Số yêu cầu AudD ước tính lấy độ dài qua YouTube Data API. Thiếu `YOUTUBE_API_KEY` thì app hiện mức tối đa.
- YouTube chặn tải thì lô tạm dừng và giữ các video chưa quét, bấm Chạy tiếp để thử lại.

## Quét cả kênh

Mục Quét cả kênh nhận link kênh có @handle hoặc mã UC…, cần `YOUTUBE_API_KEY` để lấy danh sách video. Các bước: lấy danh sách, tải âm thanh, lọc nhạc nếu chọn, xác nhận chi phí, nhận diện, báo cáo.

- App luôn dừng hỏi trước khi gửi AudD, kèm số video và số yêu cầu chính xác. Tải âm thanh và lọc nhạc không tốn lượt.
- Mỗi lần quét không dùng `MAX_SCANS_PER_USER_PER_DAY` mà dùng trần `MAX_CHANNEL_SCAN_REQUESTS`, mặc định 5000 yêu cầu. Vượt trần thì không gửi được. Người bấm xác nhận và số yêu cầu được ghi vào `out/usage.jsonl`.
- Mỗi người còn có hạn mức `MAX_CHANNEL_REQUESTS_PER_USER_PER_DAY` yêu cầu AudD cho quét kênh mỗi ngày, mặc định 5000. Số yêu cầu được giữ khi bấm Gửi nhận diện, dừng giữa chừng thì hoàn lại phần chưa gửi. Bộ đếm về 0 lúc nửa đêm.
- Một video làm lệnh gửi lỗi thì lần quét tạm dừng. Bấm Chạy tiếp mà vẫn lỗi đúng video đó thì app bỏ qua nó, video nằm ở nhóm Cần nghe lại.
- Chọn gửi đoạn ngắn thì kết quả từng đoạn được lưu ngay ở `out/clips/`, nên lỗi giữa chừng rồi chạy lại không trả tiền lại các đoạn đã gửi. Mỗi video tối đa 30 đoạn.
- Toàn máy chủ chỉ chạy một kênh một lúc, mỗi người chỉ có một lần quét dở. Đóng tab vẫn tiếp tục. App khởi động lại thì lần quét tạm dừng, phải bấm Chạy tiếp vì việc gửi AudD có tính phí.
- Các lần quét đã xong nằm ở mục Các lần quét trước, giữ tối đa 100 lần, ai cũng mở lại được báo cáo mà không tốn lượt. Báo cáo đọc từ thư mục của kênh, nên gồm cả video quét sau đó. Lần quét có từ trước bản này không mở lại được.
- Mỗi kênh có thư mục riêng `out/channels/<kênh>/`, dùng lại giữa các lần quét nên video đã quét không tốn lượt. Tùy chọn của lần sau không áp dụng cho video đã quét ở lần trước. File âm thanh bị xóa khi lần quét kết thúc.
- YouTube chặn tải hoặc AudD báo lỗi tài khoản thì lần quét tạm dừng. Video lỗi riêng lẻ được bỏ qua và nằm ở nhóm Cần nghe lại.
- Lọc nhạc cần `requirements-detect.txt` và mô hình trong `models/`, xem README của `music-audit`. Thư viện này chưa có bản cho Python 3.15 và cần Windows cho phép nạp file DLL của nó. Thiếu công cụ thì tab báo tên thứ còn thiếu và khóa nút quét. Quét link cần `yt-dlp`.
- Với AudD, nhóm Sạch luôn trống. Kết quả máy lọc không bao giờ đưa video vào nhóm này.

**Trạng thái:** luồng này mới kiểm bằng lệnh giả, chưa chạy với YouTube, AudD, yt-dlp hay YAMNet thật. Hãy thử 1 video trước.

## Theo dõi hạn mức

Tab này hiện gói AudD, tổng số yêu cầu, số đã dùng và số còn lại. API của AudD không trả các số này, nên server đọc qua công cụ `audd` có sẵn trong image Docker. Cần đăng nhập tài khoản AudD một lần:

```bash
docker compose exec music-audit /opt/venv/bin/audd login --device
```

Mở trang và nhập mã mà lệnh in ra, chỉ cần giữ quyền đọc tài khoản và số liệu sử dụng. Phiên đăng nhập nằm trong volume `music-audit-data`, cập nhật app không làm mất. Số liệu được lưu tạm một phút. Công cụ lỗi hoặc chưa đăng nhập thì tab báo không có số liệu, việc quét không bị ảnh hưởng.

### Ngân sách tháng

Điền `AUDD_MONTHLY_BUDGET` và `AUDD_PRICE_PER_1000` trong `.env` để đặt trần chi phí AudD mỗi tháng cho cả app, xem `.env.example`. Tháng tính theo lịch, giờ Việt Nam.

- Trước mỗi lần gửi AudD, server giữ chỗ số yêu cầu ước tính: video YouTube theo độ dài, file tải lên theo trần 60 phút, quét cả kênh theo số ở bước xác nhận. Không đủ thì từ chối và không gửi gì.
- Quét xong thì tính theo số yêu cầu thật và trả lại phần thừa. Kết quả đã lưu không tính tiền. Lượt quét lỗi giữ nguyên phần đã tính, vì không biết AudD đã nhận bao nhiêu.
- Hết ngân sách giữa lúc quét hàng loạt thì lô tạm dừng, các video chưa quét được giữ lại.
- Sổ chi nằm ở `out/budget/<năm-tháng>.json`. Tab này hiện số đã chi, phần đang giữ chỗ, chia theo người dùng và kiểu quét, và cảnh báo khi qua `AUDD_BUDGET_WARN_PERCENT`.
- Số trong app là ước tính theo giá đã điền. Hóa đơn của AudD mới là số chính thức.

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

## Cấu trúc

| File | Vai trò |
|---|---|
| `src/App.tsx` | Giao diện và các tab |
| `src/audioLibrary.ts` | Đọc và tra cứu danh sách YouTube Audio Library |
| `src/videoCheck.ts` | Kết luận từ kết quả AudD và danh sách thư viện |
| `public/audio-library.json` | Danh sách bài do `library:import` và `library:studio` tạo |
| `src/catalog.ts` | Danh sách nguồn nhạc |
| `src/csv.ts` | Đọc file CSV |
| `scripts/` | Lệnh cập nhật danh sách YouTube Audio Library |
| `src/budget.ts`, `src/BudgetPanel.tsx` | Phép tính và ô hiển thị ngân sách AudD tháng |
| `server/monthlyBudget.ts` | Giữ chỗ, tính và lưu sổ chi ngân sách tháng |
