#!/usr/bin/env python3
"""Bộ đo độ tin cậy của dịch vụ nhận diện nhạc (AudD hoặc ACRCloud) trên video của kênh. Xem README.md."""

# File này chỉ khai báo các lệnh. Phần làm việc nằm trong music_audit/commands/, nơi lưu dữ liệu và dịch vụ dùng chung
# nằm trong music_audit/workspace.py.

import argparse
import sys
from pathlib import Path

from music_audit import detect
from music_audit.acrcloud import AcrError
from music_audit.audd import AuddError
from music_audit.commands.identify import cmd_durations, cmd_history, cmd_identify, cmd_identify_file
from music_audit.commands.report import (
    cmd_channel_check,
    cmd_channel_report,
    cmd_channel_status,
    cmd_export,
    cmd_report,
)
from music_audit.commands.scan import (
    clip_count,
    cmd_compare_clips,
    cmd_create_container,
    cmd_fetch,
    cmd_submit,
    cmd_use_container,
)
from music_audit.commands.videos import (
    cmd_audio_links,
    cmd_detect_music,
    cmd_download_audio,
    cmd_download_models,
    cmd_list_videos,
    cmd_sample,
)
from music_audit.common import load_env
from music_audit.extract import ExtractError
from music_audit.workspace import DEFAULT_CONTAINER_NAME, DEFAULT_REGION, Paths, ROOT
from music_audit.youtube import YoutubeError


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", default=str(ROOT), help="Thư mục chứa data/ và out/")
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("list-videos", help="Lấy danh sách video của kênh")
    command.add_argument("--channel", action="append", required=True, help="Link có @handle hoặc mã UC…; lặp lại cho nhiều kênh")
    command.add_argument("--skip-shorts", action="store_true", help="Bỏ qua video Shorts (mặc định lấy cả Shorts)")
    command.set_defaults(handler=cmd_list_videos)

    command = commands.add_parser("sample", help="Chọn mẫu ngẫu nhiên từ danh sách video")
    command.add_argument("--n", type=int, default=100)
    command.add_argument("--seed", type=int, default=20261105)
    command.set_defaults(handler=cmd_sample)

    all_videos_help = "Lấy cả kênh từ all_videos.csv thay vì danh sách quét"
    command = commands.add_parser("audio-links", help="Ghi data/audio/links.txt để tai_am_thanh.bat tải âm thanh")
    command.add_argument("--all-videos", action="store_true", help=all_videos_help)
    command.set_defaults(handler=cmd_audio_links)

    command = commands.add_parser("download-audio", help="Tải âm thanh cả kênh vào data/audio, không cần tai_am_thanh.bat")
    command.add_argument("--limit", type=int, default=0, help="Chỉ xét N video đầu danh sách")
    command.add_argument("--delay", type=float, default=5, help="Số giây nghỉ giữa hai video để YouTube đỡ chặn")
    command.set_defaults(handler=cmd_download_audio)

    command = commands.add_parser("channel-check", help="In công cụ máy chủ đã có dạng JSON, không in giá trị khóa")
    command.set_defaults(handler=cmd_channel_check)

    command = commands.add_parser("channel-status", help="In tình trạng từng video của kênh dạng JSON")
    command.add_argument("--clips", type=clip_count, default=0, help="Tính thêm số đoạn sẽ gửi nếu dùng submit --clips N")
    command.set_defaults(handler=cmd_channel_status)

    command = commands.add_parser("channel-report", help="In báo cáo cả kênh dạng JSON")
    command.set_defaults(handler=cmd_channel_report)

    command = commands.add_parser("history", help="In kết quả đã lưu của các lần quét cũ dạng JSON, không tốn lượt AudD")
    command.add_argument("ids", nargs="*", help="Mã video, hoặc 11 ký tự đầu mã băm của file tải lên")
    command.set_defaults(handler=cmd_history)

    command = commands.add_parser("detect-music", help="Lọc trước có nhạc hay không trên file đã tải (không tốn lượt AudD)")
    command.add_argument("--all-videos", action="store_true", help=all_videos_help)
    command.add_argument("--threshold", type=float, default=detect.FRAME_THRESHOLD, help="Điểm nhạc của một cửa sổ để tính là nghe thấy nhạc")
    command.add_argument("--min-run", type=float, default=detect.MIN_RUN_SECONDS, help="Đoạn nghe thấy nhạc liền mạch (giây) để kết luận có nhạc")
    command.add_argument("--min-total", type=float, default=detect.MIN_TOTAL_SECONDS, help="Hoặc tổng số giây nghe thấy nhạc, kể cả rời rạc")
    command.add_argument("--intro", type=float, default=detect.INTRO_SECONDS, help="Số giây đầu video là intro của kênh, không tính")
    command.add_argument("--outro", type=float, default=detect.OUTRO_SECONDS, help="Số giây cuối video là outro của kênh, không tính")
    command.set_defaults(handler=cmd_detect_music)

    command = commands.add_parser("download-models", help="Tải mô hình YAMNet cho detect-music vào models/ và kiểm mã băm")
    command.set_defaults(handler=cmd_download_models)

    command = commands.add_parser("create-container", help="Tạo container quét trên ACRCloud")
    command.add_argument("--name", default=DEFAULT_CONTAINER_NAME)
    command.add_argument("--region", default=DEFAULT_REGION, choices=["ap-southeast-1", "eu-west-1", "us-west-2"])
    command.add_argument("--audio-type", default="linein", choices=["linein", "recorded"])
    command.add_argument("--engine", type=int, default=1, choices=[1, 3], help="1: bản gốc; 3: thêm nhận diện cover")
    command.set_defaults(handler=cmd_create_container)

    command = commands.add_parser("use-container", help="Dùng container đã tạo trong console")
    command.add_argument("--id", type=int, required=True)
    command.set_defaults(handler=cmd_use_container)

    command = commands.add_parser("submit", help="Gửi video đi quét")
    command.add_argument("--limit", type=int, default=0, help="Chỉ gửi N video, dùng để thử trước")
    command.add_argument("--delay", type=float, default=0.5)
    command.add_argument("--all-videos", action="store_true", help=all_videos_help)
    command.add_argument("--music-only", "--skip-no-music", dest="music_only", action="store_true",
                         help="Chỉ gửi video detect-music xếp là có nhạc (bỏ video không nhạc và video chưa lọc)")
    command.add_argument("--clips", type=clip_count, default=0,
                         help=f"Chỉ AudD: gửi đoạn 12 giây rải đều mỗi 45 giây ở chỗ có nhạc, tối đa N đoạn mỗi video (N từ 1 tới {detect.MAX_CLIPS}); 0 là gửi cả video")
    command.add_argument("--video-id", default="", help="Chỉ gửi đúng video này, web app dùng để dừng được giữa hai video")
    command.set_defaults(handler=cmd_submit)

    command = commands.add_parser("compare-clips", help="Kiểm chứng gửi đoạn 12 giây: so với kết quả quét cả video")
    command.add_argument("--clips", type=clip_count, default=detect.MAX_CLIPS, help="Tối đa N đoạn mỗi video")
    command.add_argument("--limit", type=int, default=0)
    command.add_argument("--delay", type=float, default=0.5)
    command.set_defaults(handler=cmd_compare_clips)

    command = commands.add_parser("fetch", help="Lấy kết quả quét")
    command.add_argument("--timeout", type=int, default=1800)
    command.add_argument("--interval", type=int, default=30)
    command.set_defaults(handler=cmd_fetch)

    command = commands.add_parser("report", help="Viết báo cáo")
    command.add_argument("--all-videos", action="store_true", help=all_videos_help)
    command.set_defaults(handler=cmd_report)

    command = commands.add_parser("export", help="Gom theo bài (songs.csv) và viết báo cáo mỗi video một dòng")
    command.add_argument("--all-videos", action="store_true", help=all_videos_help)
    command.set_defaults(handler=cmd_export)

    command = commands.add_parser("identify", help="Nhận diện nhạc trong một video YouTube, in kết quả dạng JSON")
    command.add_argument("url", help="Link của một video, không nhận kênh hay playlist")
    command.add_argument("--timeout", type=float, default=100, help="Số giây chờ kết quả trước khi trả về processing")
    command.add_argument("--interval", type=float, default=10)
    command.add_argument("--rescan", action="store_true", help="Gửi quét lại dù video đã quét, tốn thêm lượt quét")
    command.add_argument("--audd", action="store_true", help="Luôn dùng AudD, kể cả khi có khóa ACRCloud")
    command.add_argument("--extract", action="store_true", help="Tự tách mp3 từ video rồi gửi file cho AudD, cần yt-dlp và ffmpeg")
    command.set_defaults(handler=cmd_identify)

    command = commands.add_parser("identify-file", help="Nhận diện nhạc trong một file bằng AudD, in kết quả dạng JSON")
    command.add_argument("path", help="File âm thanh hoặc video")
    command.add_argument("--name", default="", help="Tên hiển thị trong kết quả")
    command.add_argument("--rescan", action="store_true", help="Gửi quét lại dù file đã quét, tốn thêm lượt quét")
    command.set_defaults(handler=cmd_identify_file)

    command = commands.add_parser("durations", help="In độ dài các video YouTube dạng JSON, không tốn lượt quét")
    command.add_argument("video_id", nargs="+", help="Mã video")
    command.set_defaults(handler=cmd_durations)
    return parser


def main():
    # Console Windows mặc định không phải UTF-8: ép UTF-8 và không để lỗi mã hóa làm dừng lệnh.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    load_env(ROOT / ".env")
    args = build_parser().parse_args()
    paths = Paths(args.workdir)
    try:
        args.handler(args, paths)
    except (AcrError, AuddError, ExtractError, YoutubeError, detect.DetectError) as error:
        sys.exit(str(error))
    except PermissionError as error:
        name = Path(error.filename).name if error.filename else "file kết quả"
        sys.exit(f"Không ghi được {name}: file đang mở (thường là trong Excel). Đóng file rồi chạy lại.")


if __name__ == "__main__":
    main()
