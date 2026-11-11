"""Tách âm thanh của một video YouTube thành file mp3 bằng yt-dlp và ffmpeg.

Chỉ nhận link chuẩn của một video. Việc tải từ YouTube có thể vi phạm Điều khoản dịch vụ của YouTube, xem README.
"""

import importlib.util
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

TIMEOUT_SECONDS = 600
MAX_FILESIZE = "500M"
MP3_QUALITY = "5"
BOT_CHECK_TEXT = "not a bot"
BLOCKED_MESSAGE = "YouTube đang chặn máy này tải video. Hãy thử lại sau hoặc tải file lên."
MISSING_YT_DLP_MESSAGE = "Chưa cài yt-dlp. Hãy chạy: python -m pip install --user \"yt-dlp[default]\""
MESSAGES = (
    ("private video", "Video đang ở chế độ riêng tư, không tách được âm thanh."),
    ("unavailable", "Video không tồn tại hoặc đã bị gỡ."),
    ("confirm your age", "Video giới hạn độ tuổi, không tách được âm thanh."),
    (BOT_CHECK_TEXT, BLOCKED_MESSAGE),
)
DEFAULT_MESSAGE = "Không tách được âm thanh từ video này. Video phải đang công khai và không phát trực tiếp."


class ExtractError(Exception):
    """Lỗi khi tách âm thanh, đã là câu dễ hiểu cho người dùng."""


class ExtractStop(ExtractError):
    """Lỗi làm mọi video sau cũng hỏng theo (YouTube chặn, thiếu yt-dlp), nên phải dừng cả lượt tải."""


@dataclass
class ExtractedAudio:
    path: Path
    duration: float


def find_ffmpeg():
    return os.environ.get("FFMPEG_LOCATION") or shutil.which("ffmpeg") or ""


DURATION_PATTERN = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
DURATION_TIMEOUT_SECONDS = 60


def parse_ffmpeg_duration(output):
    """Đọc dòng "Duration: 00:03:12.34" mà ffmpeg in khi mở file. Không đọc được thì trả về 0."""
    match = DURATION_PATTERN.search(output or "")
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def media_duration(path):
    """Độ dài file âm thanh hoặc video theo ffmpeg, để tính đúng số yêu cầu AudD. Thiếu ffmpeg hay lỗi thì trả về 0 (tính theo trần)."""
    ffmpeg = find_ffmpeg()
    if ffmpeg and Path(ffmpeg).is_dir():
        ffmpeg = str(Path(ffmpeg) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
    if not ffmpeg:
        return 0.0
    try:
        done = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path)],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=DURATION_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0.0
    return parse_ffmpeg_duration(done.stderr)


def build_command(url, folder, max_seconds, ffmpeg):
    """Tạo lệnh yt-dlp. Không đọc cấu hình của máy, không cookie, chỉ tải đoạn đầu trong giới hạn quét."""
    return [
        sys.executable, "-m", "yt_dlp",
        "--ignore-config",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--js-runtimes", "node",
        "--format", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", MP3_QUALITY,
        "--ffmpeg-location", ffmpeg,
        "--max-filesize", MAX_FILESIZE,
        "--download-sections", f"*0-{max_seconds}",
        "--match-filters", "!is_live",
        "--no-simulate",
        "--print", "%(duration)s",
        "--print", "after_move:filepath",
        "--output", str(Path(folder) / "audio.%(ext)s"),
        "--",
        url,
    ]


def parse_output(stdout):
    """Dòng đầu là độ dài, dòng cuối là đường dẫn file. Độ dài lạ thì coi là chưa biết."""
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if len(lines) < 2:
        raise ExtractError(DEFAULT_MESSAGE)
    try:
        duration = float(lines[0])
    except ValueError:
        duration = 0.0
    path = Path(lines[-1])
    if not path.is_file():
        raise ExtractError(DEFAULT_MESSAGE)
    return ExtractedAudio(path=path, duration=duration)


def friendly_message(stderr):
    """Không đưa nguyên văn lỗi của yt-dlp ra ngoài, vì có thể chứa đường dẫn trên máy."""
    text = stderr.lower()
    return next((message for key, message in MESSAGES if key in text), DEFAULT_MESSAGE)


def build_download_command(url, folder):
    """Tải âm thanh m4a về thư mục, đặt tên theo mã video, giống tai_am_thanh.bat. Không đọc cấu hình của máy, không cookie."""
    return [
        sys.executable, "-m", "yt_dlp",
        "--ignore-config",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--js-runtimes", "node",
        "--format", "bestaudio[ext=m4a]",
        "--max-filesize", MAX_FILESIZE,
        "--match-filters", "!is_live",
        "--no-overwrites",
        "--output", str(Path(folder) / "%(id)s.%(ext)s"),
        "--",
        url,
    ]


def download_audio(url, folder):
    """Tải âm thanh một video vào thư mục để lọc nhạc và gửi file cho AudD."""
    if importlib.util.find_spec("yt_dlp") is None:
        raise ExtractStop(MISSING_YT_DLP_MESSAGE)
    try:
        done = subprocess.run(
            build_download_command(url, folder),
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ExtractError("Tải âm thanh quá lâu nên đã bỏ qua video này.") from None
    if done.returncode != 0:
        message = friendly_message(done.stderr)
        raise (ExtractStop if message == BLOCKED_MESSAGE else ExtractError)(message)


def extract_audio(url, folder, max_seconds):
    if importlib.util.find_spec("yt_dlp") is None:
        raise ExtractError(MISSING_YT_DLP_MESSAGE)
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise ExtractError("Chưa có ffmpeg. Hãy cài ffmpeg hoặc điền FFMPEG_LOCATION trong file .env.")
    try:
        done = subprocess.run(
            build_command(url, folder, max_seconds, ffmpeg),
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ExtractError("Tách âm thanh quá lâu nên đã dừng. Hãy thử lại hoặc tải file lên.") from None
    if done.returncode != 0:
        raise ExtractError(friendly_message(done.stderr))
    return parse_output(done.stdout)
