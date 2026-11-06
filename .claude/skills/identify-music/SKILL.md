---
name: identify-music
description: Nhận diện nhạc trong một video YouTube từ link. Dùng khi người dùng dán link YouTube và hỏi video có nhạc gì, bài gì, của ai, hoặc muốn kiểm tra nhạc trong video.
---

# Nhận diện nhạc trong video YouTube

Chạy từ thư mục chứa `audit.py`, nhớ để link trong dấu nháy:

```bash
python audit.py identify "<link YouTube>"
```

Lệnh gửi link cho dịch vụ nhận diện rồi in JSON: ACRCloud nếu có `ACRCLOUD_ACCESS_TOKEN`, nếu không thì AudD. Chỉ nhận link của một video; link kênh hoặc playlist bị từ chối, hãy hỏi người dùng video cụ thể.

Với file trên máy, AudD quét trực tiếp, không cần gói trả phí như khi quét bằng link. File được gửi ra ngoài và tốn 1 yêu cầu cho mỗi 12 giây âm thanh, nên hãy hỏi người dùng trước:

```bash
python audit.py identify-file "<đường dẫn file>"
```

## Đọc kết quả

Theo `status`:

- `processing`: dịch vụ chưa quét xong (chỉ có với ACRCloud). Video dài có thể mất vài phút. Chạy lại đúng lệnh trên sau khoảng một phút; video không bị gửi lại và không tốn thêm lượt quét.
- `done`: đọc `decision` ở bảng dưới.
- `error`: không quét được, chưa có kết luận gì. Nói rõ với người dùng và hỏi có muốn quét lại không. Chỉ khi họ đồng ý mới thêm `--rescan`, vì lệnh này tốn thêm lượt quét.

Nếu lệnh dừng với lỗi AudD 904, gói hiện tại chưa cho quét bằng link: báo người dùng và đề nghị tải file lên hoặc nâng gói.

| `decision` | Nghĩa | Nói với người dùng |
|---|---|---|
| `block` | Máy nhận ra bài nhạc | Liệt kê `tracks`: tên bài, nghệ sĩ, hãng, số giây phát (`played_duration`). Chỉ dùng được khi có giấy phép cho đúng các bài này |
| `hold` | Có nhạc hoặc không rõ, nhưng không nhận ra bài. Với AudD, mọi video không khớp bài nào đều ở mức này | Chưa biết, không phải an toàn. Cần hỏi nguồn nhạc |
| `pass_no_music` | Máy kết luận không có nhạc (chỉ có với ACRCloud) | Báo đúng như vậy, kèm lưu ý đây chỉ là kết quả của máy |

## Quy tắc khi trả lời

- Không nhận ra bài không có nghĩa là video an toàn. Không bao giờ nói video "không vi phạm" hay "được phép dùng".
- Kết quả quét không phải bằng chứng về bản quyền và không thay thế giấy phép.
- Nếu lỗi báo chưa có khóa (`AUDD_API_TOKEN` hoặc `ACRCLOUD_ACCESS_TOKEN`), hãy nhờ người dùng tự điền vào file `.env`. Không xin token qua chat, không đọc hay in nội dung `.env`.
- Kết quả được lưu trong `out/`, nhạy cảm về pháp lý: không gửi ra ngoài nếu người dùng chưa yêu cầu.
