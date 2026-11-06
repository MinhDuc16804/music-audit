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

## Cấu trúc

| File | Vai trò |
|---|---|
| `src/App.tsx` | Giao diện và các tab |
| `src/analyzer.ts` | Luật phân loại |
| `src/analyzer.test.ts` | Unit test cho luật phân loại |
| `src/catalog.ts` | Dữ liệu mẫu và danh sách nguồn nhạc |

Muốn thêm bài có nhãn xanh hoặc vàng, hãy thêm vào `src/catalog.ts` kèm nguồn xác minh trong `sourceNote`.
