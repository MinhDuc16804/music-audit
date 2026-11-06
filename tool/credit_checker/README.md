# credit_checker

Web app tra cứu nhanh tình trạng bản quyền của một bài nhạc theo tên bài, tác giả và mục đích sử dụng. Yêu cầu gốc nằm ở
`prompt_claude_code_music_copyright_checker.md`.

Nguyên tắc: **không chắc thì coi là rủi ro cao.** Nhãn xanh hoặc vàng chỉ xuất hiện khi khớp chính xác cả tên bài lẫn tác giả
trong dữ liệu mẫu. Bản remix, cover và mọi bài chưa có dữ liệu đều là rủi ro cao.

App không dùng AI, không tra cứu dữ liệu bản quyền thật và không phải tư vấn pháp lý.

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

## Kiểm tra một video YouTube

Tab **Kiểm tra video** nhận một link video hoặc một file, gọi lệnh `identify` của `music-audit` qua server của Vite rồi đối chiếu
từng bài với dữ liệu giấy phép. Khóa AudD nằm trong `.env` của `music-audit`, trình duyệt không thấy được, nên tab này chỉ chạy qua
`npm run dev` hoặc `npm run preview`, không chạy khi đưa `dist/` lên trang tĩnh.

Quét bằng link cần gói AudD trả phí, và tài liệu AudD chưa xác nhận có nhận link YouTube. Tải file lên thì dùng được với gói miễn
phí. File được gửi tới AudD để quét, nên hãy cân nhắc với nội dung chưa phát hành.

| Kết quả | Nghĩa |
|---|---|
| Mọi bài nhận ra đều có giấy phép | Mọi bài đều `LICENSED`, đúng mục đích và còn hạn. Máy vẫn có thể bỏ sót nhạc khác |
| Có nhạc cần giấy phép | Có ít nhất một bài chưa có giấy phép phù hợp |
| Chưa biết, cần hỏi nguồn nhạc | Không nhận ra bài. AudD không phát hiện "không có nhạc", nên video không khớp bài nào luôn ở mức này |
| Máy không thấy nhạc | Chỉ có với ACRCloud. Không phải bằng chứng về bản quyền |

AudD tính 1 yêu cầu cho mỗi 12 giây âm thanh, nên video 10 phút tốn khoảng 50 yêu cầu. Để tránh hóa đơn bất ngờ, mỗi lần quét tối đa
60 phút đầu, đổi bằng biến `AUDD_MAX_CHUNKS` trong `.env`. Kiểm tra lại cùng video hoặc cùng file chỉ lấy kết quả cũ, không tốn thêm.
Nếu không tìm thấy Python, đặt biến môi trường `MUSIC_AUDIT_PYTHON`.

## Nhập dữ liệu bài hát

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
| `src/analyzer.ts` | Luật phân loại |
| `src/analyzer.test.ts` | Unit test cho luật phân loại |
| `src/catalog.ts` | Dữ liệu mẫu kèm theo app và danh sách nguồn nhạc |
| `src/catalogImport.ts` | Đọc, kiểm tra và gộp CSV |
| `src/acrConvert.ts` | Chuyển kết quả ACRCloud thành CSV |
| `scripts/` | Lệnh nhập dữ liệu và tạo dữ liệu demo |
| `templates/catalog.csv` | File mẫu |
