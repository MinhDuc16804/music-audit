#!/usr/bin/env python3
"""Bộ đo độ tin cậy của ACRCloud trên video của kênh. Xem README.md."""

import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from music_audit.acrcloud import AcrClient, AcrError
from music_audit.common import (
    TESTSET_COLUMNS,
    load_env,
    normalize_yes_no,
    read_csv,
    validate_testset,
    write_csv,
)
from music_audit.evaluate import build_rows, parse_scan, render_report
from music_audit.youtube import YoutubeClient, YoutubeError

ROOT = Path(__file__).resolve().parent
AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg"}
VIDEO_COLUMNS = ("channel", "video_id", "url", "title", "published_at", "duration_seconds", "view_count")
RESULT_COLUMNS = TESTSET_COLUMNS + ("decision", "outcome", "music_detected", "speech_share", "duration_seconds", "tracks")
FETCH_BATCH = 20


class Paths:
    def __init__(self, workdir):
        self.data = Path(workdir) / "data"
        self.out = Path(workdir) / "out"
        self.all_videos = self.data / "all_videos.csv"
        self.testset = self.data / "testset.csv"
        self.sample = self.data / "random_sample.csv"
        self.container = self.out / "container.json"
        self.submissions = self.out / "submissions.json"
        self.raw = self.out / "raw"
        self.report = self.out / "report.md"
        self.results = self.out / "results.csv"


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


def load_testset(paths):
    rows = []
    for path in (paths.testset, paths.sample):
        if path.exists():
            rows += read_csv(path)
    for row in rows:
        row["has_speech"] = normalize_yes_no(row.get("has_speech"))
        row["has_source_file"] = normalize_yes_no(row.get("has_source_file"))
    return rows


def cmd_list_videos(args, paths):
    client = YoutubeClient(os.environ.get("YOUTUBE_API_KEY", ""))
    videos = []
    for channel in args.channel:
        found = client.list_channel_videos(channel)
        hours = sum(v["duration_seconds"] for v in found) / 3600
        print(f"{found[0]['channel'] if found else channel}: {len(found)} video, {hours:.1f} giờ")
        videos += found
    write_csv(paths.all_videos, videos, VIDEO_COLUMNS)
    total_hours = sum(v["duration_seconds"] for v in videos) / 3600
    print(f"Tổng: {len(videos)} video, {total_hours:.1f} giờ. Đã ghi {paths.all_videos}")


def cmd_sample(args, paths):
    videos = read_csv(paths.all_videos)
    labeled = {row.get("source") for row in read_csv(paths.testset)} if paths.testset.exists() else set()
    pool = [video for video in videos if video["url"] not in labeled]
    size = min(args.n, len(pool))
    picked = random.Random(args.seed).sample(pool, size)
    rows = [{"source": v["url"], "group": "random", "channel": v["channel"]} for v in picked]
    write_csv(paths.sample, rows, TESTSET_COLUMNS)
    print(f"Đã chọn ngẫu nhiên {size}/{len(pool)} video vào {paths.sample}")


def cmd_create_container(args, paths):
    data = acr_client().create_container(args.name, args.region, args.audio_type, args.engine)
    write_json(paths.container, {"id": data["id"], "region": data.get("region", args.region)})
    print(f"Đã tạo container {data['id']} ở {args.region}")


def cmd_use_container(args, paths):
    data = acr_client().get_container(args.id)
    write_json(paths.container, {"id": data["id"], "region": data["region"]})
    print(f"Sẽ dùng container {data['id']} ở {data['region']}")


def _extract_audio(source, folder):
    target = Path(folder) / "audio.mp3"
    command = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vn", "-ac", "2", "-b:a", "128k", str(target)]
    subprocess.run(command, check=True)
    return target


def _submit_one(client, container, source):
    if source.lower().startswith(("http://", "https://")):
        return client.submit_url(container["region"], container["id"], source)
    path = Path(source).expanduser()
    if path.suffix.lower() in AUDIO_SUFFIXES:
        return client.submit_audio(container["region"], container["id"], path)
    with tempfile.TemporaryDirectory() as folder:
        return client.submit_audio(container["region"], container["id"], _extract_audio(path, folder))


def cmd_submit(args, paths):
    rows = load_testset(paths)
    if not rows:
        sys.exit(f"Chưa có video nào. Hãy điền {paths.testset}")
    errors = validate_testset(rows)
    if errors:
        print("Danh sách video có lỗi, chưa gửi gì:")
        print("\n".join(f"- {error}" for error in errors))
        sys.exit(1)
    container = read_json(paths.container, None)
    if not container:
        sys.exit("Chưa có container. Chạy create-container hoặc use-container trước.")

    client = acr_client()
    submissions = read_json(paths.submissions, {})
    pending = [row["source"] for row in rows if row["source"] not in submissions]
    if args.limit:
        pending = pending[: args.limit]
    failed = 0
    for source in pending:
        try:
            file_id = _submit_one(client, container, source)
        except (AcrError, subprocess.CalledProcessError, OSError) as error:
            failed += 1
            print(f"Lỗi với {source}: {error}")
            continue
        submissions[source] = {"file_id": file_id, "at": datetime.now(timezone.utc).isoformat()}
        write_json(paths.submissions, submissions)
        time.sleep(args.delay)
    print(f"Đã gửi {len(pending) - failed}/{len(pending)} video. Tổng đã gửi: {len(submissions)}/{len(rows)}.")
    if failed:
        print("Chạy lại lệnh này để gửi tiếp các video lỗi; video đã gửi sẽ không bị gửi lại.")


def cmd_fetch(args, paths):
    container = read_json(paths.container, None)
    submissions = read_json(paths.submissions, {})
    if not container or not submissions:
        sys.exit("Chưa có video nào được gửi.")
    client = acr_client()
    paths.raw.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.timeout
    while True:
        waiting = []
        for entry in submissions.values():
            saved = read_json(paths.raw / f"{entry['file_id']}.json", None)
            if saved is None or saved.get("state") == 0:
                waiting.append(entry["file_id"])
        for start in range(0, len(waiting), FETCH_BATCH):
            for item in client.get_files(container["region"], container["id"], waiting[start : start + FETCH_BATCH]):
                write_json(paths.raw / f"{item['id']}.json", item)
        remaining = sum(
            read_json(paths.raw / f"{entry['file_id']}.json", {"state": 0}).get("state") == 0
            for entry in submissions.values()
        )
        print(f"Còn {remaining}/{len(submissions)} video đang xử lý")
        if remaining == 0 or time.monotonic() >= deadline:
            break
        time.sleep(args.interval)
    if remaining:
        print("Hết thời gian chờ. Chạy lại lệnh này sau để lấy tiếp.")


def cmd_report(_args, paths):
    rows = load_testset(paths)
    submissions = read_json(paths.submissions, {})
    scans = {}
    for source, entry in submissions.items():
        raw = read_json(paths.raw / f"{entry['file_id']}.json", None)
        if raw is not None:
            scans[source] = parse_scan(raw)
    detailed = build_rows(rows, scans)
    write_csv(paths.results, detailed, RESULT_COLUMNS)
    paths.report.parent.mkdir(parents=True, exist_ok=True)
    paths.report.write_text(render_report(detailed), encoding="utf-8")
    print(f"Đã ghi {paths.report} và {paths.results}")


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", default=str(ROOT), help="Thư mục chứa data/ và out/")
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("list-videos", help="Lấy danh sách video của kênh")
    command.add_argument("--channel", action="append", required=True, help="Link có @handle hoặc mã UC…; lặp lại cho nhiều kênh")
    command.set_defaults(handler=cmd_list_videos)

    command = commands.add_parser("sample", help="Chọn mẫu ngẫu nhiên từ danh sách video")
    command.add_argument("--n", type=int, default=100)
    command.add_argument("--seed", type=int, default=20261105)
    command.set_defaults(handler=cmd_sample)

    command = commands.add_parser("create-container", help="Tạo container quét trên ACRCloud")
    command.add_argument("--name", default="music-audit-test")
    command.add_argument("--region", default="ap-southeast-1", choices=["ap-southeast-1", "eu-west-1", "us-west-2"])
    command.add_argument("--audio-type", default="linein", choices=["linein", "recorded"])
    command.add_argument("--engine", type=int, default=1, choices=[1, 3], help="1: bản gốc; 3: thêm nhận diện cover")
    command.set_defaults(handler=cmd_create_container)

    command = commands.add_parser("use-container", help="Dùng container đã tạo trong console")
    command.add_argument("--id", type=int, required=True)
    command.set_defaults(handler=cmd_use_container)

    command = commands.add_parser("submit", help="Gửi video đi quét")
    command.add_argument("--limit", type=int, default=0, help="Chỉ gửi N video, dùng để thử trước")
    command.add_argument("--delay", type=float, default=0.5)
    command.set_defaults(handler=cmd_submit)

    command = commands.add_parser("fetch", help="Lấy kết quả quét")
    command.add_argument("--timeout", type=int, default=1800)
    command.add_argument("--interval", type=int, default=30)
    command.set_defaults(handler=cmd_fetch)

    command = commands.add_parser("report", help="Viết báo cáo")
    command.set_defaults(handler=cmd_report)
    return parser


def main():
    load_env(ROOT / ".env")
    args = build_parser().parse_args()
    paths = Paths(args.workdir)
    try:
        args.handler(args, paths)
    except (AcrError, YoutubeError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
