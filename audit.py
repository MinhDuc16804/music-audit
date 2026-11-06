#!/usr/bin/env python3
"""Bộ đo độ tin cậy của ACRCloud trên video của kênh. Xem README.md."""

import argparse
import hashlib
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
from music_audit.audd import CHUNK_SECONDS, AuddClient, AuddError, parse_audd
from music_audit.common import (
    TESTSET_COLUMNS,
    load_env,
    normalize_yes_no,
    read_csv,
    validate_testset,
    write_csv,
)
from music_audit.evaluate import ERROR, build_rows, identify_summary, parse_scan, render_report
from music_audit.youtube import YoutubeClient, YoutubeError, video_url, youtube_video_id

ROOT = Path(__file__).resolve().parent
AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg"}
VIDEO_COLUMNS = ("channel", "video_id", "url", "title", "published_at", "duration_seconds", "view_count")
RESULT_COLUMNS = TESTSET_COLUMNS + ("decision", "outcome", "music_detected", "speech_share", "duration_seconds", "tracks")
FETCH_BATCH = 20
DEFAULT_CONTAINER_NAME = "music-audit-test"
DEFAULT_REGION = "ap-southeast-1"
DEFAULT_AUDD_MAX_CHUNKS = 300  # 1 giờ âm thanh, chặn hóa đơn bất ngờ với file dài


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
        self.audd = self.out / "audd"
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


def uses_audd():
    """Dùng AudD khi có khóa AudD và chưa điền token ACRCloud."""
    return bool(os.environ.get("AUDD_API_TOKEN")) and not os.environ.get("ACRCLOUD_ACCESS_TOKEN")


def audd_client():
    return AuddClient(
        os.environ.get("AUDD_API_TOKEN", ""),
        base_override=os.environ.get("AUDD_BASE_OVERRIDE") or None,
    )


def audd_max_chunks():
    return int(os.environ.get("AUDD_MAX_CHUNKS") or DEFAULT_AUDD_MAX_CHUNKS)


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


def _ensure_container(client, paths):
    container = read_json(paths.container, None)
    if not container:
        data = client.create_container(DEFAULT_CONTAINER_NAME, DEFAULT_REGION)
        container = {"id": data["id"], "region": data.get("region", DEFAULT_REGION)}
        write_json(paths.container, container)
    return container


def _wait_for_scan(client, container, file_id, paths, timeout, interval):
    """Đợi đến khi quét xong hoặc hết giờ, trả về bản ghi mới nhất (có thể vẫn đang xử lý)."""
    raw_path = paths.raw / f"{file_id}.json"
    deadline = time.monotonic() + timeout
    while True:
        saved = read_json(raw_path, None)
        if saved is None or saved.get("state", 0) == 0:
            items = client.get_files(container["region"], container["id"], [file_id])
            if items:
                saved = items[0]
                write_json(raw_path, saved)
        if (saved and saved.get("state", 0) != 0) or time.monotonic() >= deadline:
            return saved
        time.sleep(interval)


def _print_audd_result(source, source_id, raw, limit):
    minutes = limit * CHUNK_SECONDS // 60
    output = {
        "url": source,
        "video_id": source_id,
        "status": "done",
        "provider": "audd",
        "scan_note": f"AudD chỉ quét tối đa {minutes} phút đầu của mỗi video.",
        **identify_summary(parse_audd(raw)),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def _identify_with_audd(args, paths, video_id, url):
    cache = paths.audd / f"{video_id}.json"
    limit = audd_max_chunks()
    raw = None if args.rescan else read_json(cache, None)
    if raw is None:
        raw = audd_client().recognize_url(url, limit)
        write_json(cache, raw)
    _print_audd_result(url, video_id, raw, limit)


def _file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cmd_identify_file(args, paths):
    path = Path(args.path)
    if not path.is_file():
        sys.exit(f"Không tìm thấy file {path.name}")
    digest = _file_digest(path)
    cache = paths.audd / f"file-{digest}.json"
    limit = audd_max_chunks()
    raw = None if args.rescan else read_json(cache, None)
    if raw is None:
        raw = audd_client().recognize_file(path, limit)
        write_json(cache, raw)
    _print_audd_result(args.name or path.name, digest[:11], raw, limit)


def cmd_identify(args, paths):
    video_id = youtube_video_id(args.url)
    if not video_id:
        sys.exit("Chỉ nhận link của một video YouTube, không nhận link kênh hay playlist.")
    url = video_url(video_id)
    if uses_audd():
        _identify_with_audd(args, paths, video_id, url)
        return
    client = acr_client()
    container = _ensure_container(client, paths)
    submissions = read_json(paths.submissions, {})
    if args.rescan or url not in submissions:
        file_id = client.submit_url(container["region"], container["id"], url)
        submissions[url] = {"file_id": file_id, "at": datetime.now(timezone.utc).isoformat()}
        write_json(paths.submissions, submissions)

    raw = _wait_for_scan(client, container, submissions[url]["file_id"], paths, args.timeout, args.interval)
    output = {"url": url, "video_id": video_id}
    if raw is None or raw.get("state", 0) == 0:
        output |= {"status": "processing", "note": "ACRCloud đang quét. Chạy lại lệnh sau ít phút, video không bị gửi lại."}
    else:
        summary = identify_summary(parse_scan(raw))
        output |= {"status": "error" if summary["decision"] == ERROR else "done", **summary}
    print(json.dumps(output, ensure_ascii=False, indent=2))


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
    command.set_defaults(handler=cmd_submit)

    command = commands.add_parser("fetch", help="Lấy kết quả quét")
    command.add_argument("--timeout", type=int, default=1800)
    command.add_argument("--interval", type=int, default=30)
    command.set_defaults(handler=cmd_fetch)

    command = commands.add_parser("report", help="Viết báo cáo")
    command.set_defaults(handler=cmd_report)

    command = commands.add_parser("identify", help="Nhận diện nhạc trong một video YouTube, in kết quả dạng JSON")
    command.add_argument("url", help="Link của một video, không nhận kênh hay playlist")
    command.add_argument("--timeout", type=float, default=100, help="Số giây chờ kết quả trước khi trả về processing")
    command.add_argument("--interval", type=float, default=10)
    command.add_argument("--rescan", action="store_true", help="Gửi quét lại dù video đã quét, tốn thêm lượt quét")
    command.set_defaults(handler=cmd_identify)

    command = commands.add_parser("identify-file", help="Nhận diện nhạc trong một file bằng AudD, in kết quả dạng JSON")
    command.add_argument("path", help="File âm thanh hoặc video")
    command.add_argument("--name", default="", help="Tên hiển thị trong kết quả")
    command.add_argument("--rescan", action="store_true", help="Gửi quét lại dù file đã quét, tốn thêm lượt quét")
    command.set_defaults(handler=cmd_identify_file)
    return parser


def main():
    # Console Windows mặc định không phải UTF-8, tên bài tiếng Việt sẽ làm lệnh lỗi khi in ra.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    load_env(ROOT / ".env")
    args = build_parser().parse_args()
    paths = Paths(args.workdir)
    try:
        args.handler(args, paths)
    except (AcrError, AuddError, YoutubeError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
