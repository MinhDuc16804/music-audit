"""Nơi lưu dữ liệu và kết quả của một lần chạy, cách đọc ghi file, và các dịch vụ dùng chung giữa các lệnh."""

import json
import os
import sys
from pathlib import Path

from music_audit.acrcloud import AcrClient
from music_audit.audd import AuddClient
from music_audit.common import normalize_yes_no, read_csv
from music_audit.youtube import youtube_video_id, YoutubeClient, YoutubeError

ROOT = Path(__file__).resolve().parent.parent


AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg"}


DEFAULT_CONTAINER_NAME = "music-audit-test"
DEFAULT_REGION = "ap-southeast-1"
DEFAULT_AUDD_MAX_CHUNKS = 300  # 1 giờ âm thanh, chặn hóa đơn bất ngờ với file dài

NO_VIDEOS = "Chưa có video nào. Chạy sample hoặc điền data/testset.csv trước."

class Paths:
    def __init__(self, workdir):
        self.models = Path(os.environ.get("MUSIC_AUDIT_MODELS") or ROOT / "models")
        self.data = Path(workdir) / "data"
        self.out = Path(workdir) / "out"
        self.all_videos = self.data / "all_videos.csv"
        self.testset = self.data / "testset.csv"
        self.sample = self.data / "random_sample.csv"
        self.audio = self.data / "audio"
        self.audio_links = self.audio / "links.txt"
        self.container = self.out / "container.json"
        self.submissions = self.out / "submissions.json"
        self.raw = self.out / "raw"
        self.audd = self.out / "audd"
        self.report = self.out / "report.md"
        self.results = self.out / "results.csv"
        self.songs = self.out / "songs.csv"
        self.scan_report = self.out / "bao-cao-quet.csv"
        self.detections = self.out / "music_detect.json"
        self.detect_cache = self.out / "detect"
        self.library_cache = self.out / "library_cache.json"
        self.library_list = ROOT / "resources" / "audio_library.csv"
        self.policies = self.out / "studio_policy.json"


def read_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def acr_client():
    return AcrClient(
        os.environ.get("ACRCLOUD_ACCESS_TOKEN", ""),
        base_override=os.environ.get("ACRCLOUD_BASE_OVERRIDE") or None,
    )


def uses_audd():
    """Dùng AudD khi có khóa AudD và chưa điền token ACRCloud."""
    return bool(os.environ.get("AUDD_API_TOKEN")) and not os.environ.get("ACRCLOUD_ACCESS_TOKEN")


SERVICES = ("audd", "acrcloud")


def music_service():
    """Dịch vụ cho submit và fetch. MUSIC_SERVICE thắng; để trống thì theo khóa đang có, giống lệnh identify."""
    service = (os.environ.get("MUSIC_SERVICE") or "").strip().lower()
    if not service:
        return "audd" if uses_audd() else "acrcloud"
    if service not in SERVICES:
        sys.exit(f"MUSIC_SERVICE phải là một trong {', '.join(SERVICES)}")
    return service


def audd_client():
    return AuddClient(
        os.environ.get("AUDD_API_TOKEN", ""),
        base_override=os.environ.get("AUDD_BASE_OVERRIDE") or None,
    )


def audd_max_chunks():
    """Trần số đoạn 12 giây gửi AudD mỗi video. Sai hoặc không dương thì dừng hẳn: 0 hay số âm làm ước tính chi phí
    ra 0, cả kênh sẽ được gửi mà không trừ ngân sách, và AudD có thể hiểu 0 là không giới hạn."""
    value = (os.environ.get("AUDD_MAX_CHUNKS") or "").strip()
    if not value:
        return DEFAULT_AUDD_MAX_CHUNKS
    try:
        limit = int(value)
    except ValueError:
        limit = 0
    if limit <= 0:
        sys.exit("AUDD_MAX_CHUNKS trong .env phải là số nguyên dương, ví dụ 300 (60 phút đầu). Hãy sửa rồi chạy lại.")
    return limit


def known_durations(paths):
    """Độ dài video lấy từ list-videos, vì AudD không trả độ dài file."""
    if not paths.all_videos.exists():
        return {}
    return {row["url"]: row.get("duration_seconds") or 0 for row in read_csv(paths.all_videos)}


def local_audio(paths, source):
    """File âm thanh đã tải về cho link YouTube này (data/audio/<video_id>.m4a…), hoặc None.

    Danh sách video và kết quả vẫn giữ link làm khóa; file chỉ thay link lúc gửi đi quét.
    """
    video_id = youtube_video_id(source)
    if not video_id:
        return None
    for suffix in sorted(AUDIO_SUFFIXES):
        path = paths.audio / f"{video_id}{suffix}"
        if path.is_file() and path.stat().st_size > 0:
            return path
    return None


def videos_by_url(paths):
    """Thông tin từng video trong all_videos.csv theo link, rỗng nếu chưa chạy list-videos."""
    return {video["url"]: video for video in read_csv(paths.all_videos)} if paths.all_videos.exists() else {}


def load_testset(paths):
    rows = read_csv(paths.testset) if paths.testset.exists() else []
    # Video có ở cả testset.csv lẫn random_sample.csv: giữ dòng có nhãn. Trùng ngay trong testset vẫn để validate_testset báo lỗi.
    labeled = {row.get("source") for row in rows}
    if paths.sample.exists():
        rows += [row for row in read_csv(paths.sample) if row.get("source") not in labeled]
    for row in rows:
        row["has_speech"] = normalize_yes_no(row.get("has_speech"))
        row["has_source_file"] = normalize_yes_no(row.get("has_source_file"))
    return rows


def video_rows(paths, all_videos=False):
    """Danh sách video để xử lý: testset + mẫu, hoặc cả kênh (all_videos.csv) có ghép nhãn từ testset."""
    labeled = load_testset(paths)
    if not all_videos:
        return labeled
    if not paths.all_videos.exists():
        sys.exit("Chưa có data/all_videos.csv. Chạy list-videos trước.")
    by_source = {row["source"]: row for row in labeled}
    rows = [by_source.get(video["url"]) or {"source": video["url"], "group": "random", "channel": video["channel"]}
            for video in read_csv(paths.all_videos)]
    known = {row["source"] for row in rows}
    return rows + [row for row in labeled if row["source"] not in known]


def youtube_duration(video_id):
    """Độ dài video, 0 nếu chưa có khóa hoặc không lấy được. Thiếu độ dài thì không kết luận được độ phủ."""
    api_key = os.environ.get("YOUTUBE_API_KEY", "")
    if not api_key:
        return 0
    try:
        return YoutubeClient(api_key).video_duration(video_id)
    except YoutubeError:
        return 0
