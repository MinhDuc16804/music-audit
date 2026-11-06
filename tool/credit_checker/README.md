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
| `src/catalogImport.ts` | Đọc và kiểm tra CSV |
| `scripts/` | Lệnh nhập dữ liệu và tạo dữ liệu demo |
| `templates/catalog.csv` | File mẫu |
