"""Đọc cấu hình và file CSV dùng chung."""

import csv
import os
from pathlib import Path

GROUPS = ("strike", "commercial", "licensed", "no_music", "random")
ORIGINS = ("vn", "foreign", "none", "")
TESTSET_COLUMNS = (
    "source",
    "group",
    "music_origin",
    "has_music",
    "has_speech",
    "expected_title",
    "expected_artist",
    "has_source_file",
    "channel",
    "note",
)
_YES = {"yes", "y", "có", "co", "1", "true"}
_NO = {"no", "n", "không", "khong", "0", "false"}


def load_env(path):
    """Nạp KEY=VALUE từ file .env, không ghi đè biến đã có."""
    path = Path(path)
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def read_csv(path):
    """Đọc CSV từ Excel hoặc Google Sheets: có thể có BOM và dùng dấu , ; hoặc tab."""
    text = Path(path).read_text(encoding="utf-8-sig")
    header = text.splitlines()[0] if text.strip() else ""
    delimiter = max(",;\t", key=header.count)
    rows = []
    for raw in csv.DictReader(text.splitlines(), delimiter=delimiter):
        rows.append({(k or "").strip(): (v or "").strip() for k, v in raw.items()})
    return rows


def write_csv(path, rows, fieldnames):
    """Ghi CSV có BOM để Excel hiển thị đúng tiếng Việt."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def normalize_yes_no(value):
    """Trả về 'yes', 'no' hoặc '' khi chưa điền hoặc không hiểu."""
    value = (value or "").strip().lower()
    if value in _YES:
        return "yes"
    if value in _NO:
        return "no"
    return ""


def is_youtube_url(source):
    lowered = source.lower()
    return lowered.startswith(("http://", "https://")) and (
        "youtube.com/" in lowered or "youtu.be/" in lowered
    )


def validate_testset(rows):
    """Trả về danh sách lỗi theo số dòng trong file (dòng tiêu đề là dòng 1)."""
    errors = []
    seen = set()
    for number, row in enumerate(rows, start=2):
        source = row.get("source", "")
        group = row.get("group", "")
        if not source:
            errors.append(f"Dòng {number}: thiếu source")
            continue
        if "VIDEO_ID" in source or source.startswith("/duong/dan"):
            errors.append(f"Dòng {number}: vẫn là dòng ví dụ, hãy xóa hoặc thay bằng video thật")
            continue
        if source in seen:
            errors.append(f"Dòng {number}: source bị trùng")
        seen.add(source)
        if group not in GROUPS:
            errors.append(f"Dòng {number}: group phải là một trong {', '.join(GROUPS)}")
        if group == "licensed" and not (row.get("expected_title") and row.get("expected_artist")):
            errors.append(f"Dòng {number}: nhóm licensed cần cả expected_title và expected_artist")
        if row.get("music_origin", "") not in ORIGINS:
            errors.append(f"Dòng {number}: music_origin phải là vn, foreign, none hoặc để trống")
        if source.lower().startswith(("http://", "https://")):
            if not is_youtube_url(source):
                errors.append(f"Dòng {number}: chỉ nhận link YouTube")
        elif not Path(source).expanduser().is_file():
            errors.append(f"Dòng {number}: không tìm thấy file {source}")
    return errors
