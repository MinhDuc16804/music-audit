"""Lệnh nhận diện một video hoặc một file, in JSON cho web app và skill identify-music. Kết quả được lưu để không tính phí lại."""

import hashlib
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from music_audit.audd import CHUNK_SECONDS, parse_audd
from music_audit.evaluate import ERROR, identify_summary, parse_scan
from music_audit.extract import extract_audio, media_duration
from music_audit.workspace import (
    DEFAULT_CONTAINER_NAME,
    DEFAULT_REGION,
    acr_client,
    audd_client,
    audd_max_chunks,
    read_json,
    uses_audd,
    write_json,
    youtube_duration,
)
from music_audit.youtube import video_url, youtube_video_id, YoutubeClient, YoutubeError

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


def _cache_time(cache):
    """Thời điểm kết quả được lưu, tức lúc AudD quét. Chuỗi rỗng nếu không có file."""
    if cache is None or not cache.is_file():
        return ""
    return datetime.fromtimestamp(cache.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")


def _audd_output(source, source_id, raw, limit, duration=0, cache=None, cached=False):
    """cached cho web app biết đây là kết quả cũ lấy lại, để hiện nút Quét lại."""
    minutes = limit * CHUNK_SECONDS // 60
    return {
        "url": source,
        "video_id": source_id,
        "status": "done",
        "provider": "audd",
        "scan_note": f"AudD chỉ quét tối đa {minutes} phút đầu của mỗi video.",
        **identify_summary(parse_audd(raw)),
        "duration_seconds": duration,
        "max_seconds": limit * CHUNK_SECONDS,
        "cached": cached,
        "scanned_at": _cache_time(cache),
    }


def _print_audd_result(source, source_id, raw, limit, duration=0, cache=None, cached=False):
    print(json.dumps(_audd_output(source, source_id, raw, limit, duration, cache, cached), ensure_ascii=False, indent=2))


HISTORY_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _history_cache(paths, key):
    """File kết quả AudD đã lưu: theo mã video, hoặc theo 11 ký tự đầu mã băm của file tải lên."""
    video_cache = paths.audd / f"{key}.json"
    if video_cache.is_file():
        return video_cache, True
    files = sorted(paths.audd.glob(f"file-{key}*.json")) if re.fullmatch(r"[0-9a-f]{11}", key) else []
    return (files[0], False) if files else (None, False)


def cmd_history(args, paths):
    """In kết quả đã lưu của các lần quét cũ dạng JSON. Chỉ đọc file đã lưu, không gửi gì cho AudD."""
    limit = audd_max_chunks()
    keys = [key for key in dict.fromkeys(args.ids) if HISTORY_ID.match(key)]
    found = {key: _history_cache(paths, key) for key in keys}
    titles_path = paths.out / "video_titles.json"
    titles = read_json(titles_path, {})
    missing = [key for key, (cache, is_video) in found.items() if cache and is_video and key not in titles]
    api_key = os.environ.get("YOUTUBE_API_KEY", "")
    if missing and api_key:
        try:
            titles.update(YoutubeClient(api_key).video_titles(missing))
            write_json(titles_path, titles)
        except YoutubeError:
            pass  # thiếu tên thì tab vẫn hiện link, không được làm hỏng lịch sử
    results = {}
    for key, (cache, is_video) in found.items():
        raw = read_json(cache, None) if cache else None
        if raw is None:
            continue
        source = video_url(key) if is_video else ""
        results[key] = {**_audd_output(source, key, raw, limit, raw.get("duration_seconds") or 0, cache, True), "title": titles.get(key, "")}
    print(json.dumps(results, ensure_ascii=False))


def _identify_with_audd(args, paths, video_id, url):
    cache = paths.audd / f"{video_id}.json"
    limit = audd_max_chunks()
    raw = None if args.rescan else read_json(cache, None)
    cached = raw is not None
    if raw is None:
        raw = audd_client().recognize_url(url, limit)
        write_json(cache, raw)
    _print_audd_result(url, video_id, raw, limit, youtube_duration(video_id), cache, cached)


def _identify_with_extraction(args, paths, video_id, url):
    """Tự tách mp3 rồi gửi file cho AudD. Kết quả được lưu nên video đã quét không bị tải và tính phí lại."""
    cache = paths.audd / f"{video_id}.json"
    limit = audd_max_chunks()
    raw = None if args.rescan else read_json(cache, None)
    cached = raw is not None
    if raw is None:
        client = audd_client()
        with tempfile.TemporaryDirectory() as folder:
            audio = extract_audio(url, folder, limit * CHUNK_SECONDS)
            raw = client.recognize_file(audio.path, limit)
        raw["duration_seconds"] = audio.duration
        write_json(cache, raw)
    _print_audd_result(url, video_id, raw, limit, raw.get("duration_seconds") or youtube_duration(video_id), cache, cached)


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
    cached = raw is not None
    if raw is None:
        raw = audd_client().recognize_file(path, limit)
        write_json(cache, raw)
    # Độ dài thật để web app tính đúng số yêu cầu AudD và độ phủ, thay vì tính trần 60 phút cho mọi file.
    _print_audd_result(args.name or path.name, digest[:11], raw, limit, duration=media_duration(path), cache=cache, cached=cached)


def cmd_identify(args, paths):
    video_id = youtube_video_id(args.url)
    if not video_id:
        sys.exit("Chỉ nhận link của một video YouTube, không nhận link kênh hay playlist.")
    url = video_url(video_id)
    if args.extract:
        _identify_with_extraction(args, paths, video_id, url)
        return
    if args.audd or uses_audd():
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


def cmd_durations(args, _paths):
    """In độ dài các video để ước tính chi phí. Không có khóa hoặc API lỗi thì để trống, web app sẽ tính mức tối đa."""
    api_key = os.environ.get("YOUTUBE_API_KEY", "")
    videos = {}
    if api_key:
        try:
            videos = YoutubeClient(api_key).video_durations(args.video_id)
        except YoutubeError:
            videos = {}
    print(json.dumps({"max_seconds": audd_max_chunks() * CHUNK_SECONDS, "videos": videos}))
