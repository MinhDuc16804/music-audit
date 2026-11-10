"""Lệnh viết báo cáo từ kết quả đã lưu, và các lệnh JSON mà tab Quét cả kênh của web app gọi."""

import importlib.util
import json
import os
import sys
from collections import Counter

from music_audit.audd import CHUNK_SECONDS, parse_saved
from music_audit.commands.scan import clip_requests, full_requests
from music_audit.common import read_csv, TESTSET_COLUMNS, write_csv
from music_audit.evaluate import build_rows, parse_scan, render_report
from music_audit.extract import find_ffmpeg
from music_audit.grouping import (
    CAN_NGHE_LAI,
    CO_NHAC,
    group_songs,
    load_library_list,
    report_columns,
    report_json,
    SACH,
    scan_report,
    SONG_COLUMNS,
)
from music_audit.workspace import audd_max_chunks, local_audio, read_json, video_rows, videos_by_url

RESULT_COLUMNS = TESTSET_COLUMNS + ("decision", "outcome", "music_detected", "speech_share", "duration_seconds", "tracks")


def parse_stored(raw):
    """Đọc bản ghi trong out/raw, của AudD (do submit lưu) hoặc của ACRCloud."""
    return parse_saved(raw) if raw.get("provider") == "audd" else parse_scan(raw)


def scanned_rows(paths, scan_info=None, all_videos=False):
    """Danh sách video kèm kết quả quét đã lưu (video chưa quét có _scan là None).

    Nếu truyền scan_info (dict), ghi thêm thời điểm quét và quét từ file hay link cho từng video.
    """
    rows = video_rows(paths, all_videos)
    submissions = read_json(paths.submissions, {})
    scans = {}
    for source, entry in submissions.items():
        raw = read_json(paths.raw / f"{entry['file_id']}.json", None)
        if raw is not None:
            scans[source] = parse_stored(raw)
            if scan_info is not None:
                scan_info[source] = {"scanned_at": entry.get("at", ""), "scanned_from": raw.get("scanned_from", "")}
    return build_rows(rows, scans)


def cmd_report(args, paths):
    detailed = scanned_rows(paths, all_videos=args.all_videos)
    write_csv(paths.results, detailed, RESULT_COLUMNS)
    paths.report.parent.mkdir(parents=True, exist_ok=True)
    paths.report.write_text(render_report(detailed), encoding="utf-8")
    print(f"Đã ghi {paths.report} và {paths.results}")


def _build_report(paths, all_videos):
    """Danh sách video đã quét, danh sách bài và báo cáo mỗi video một dòng."""
    scan_info = {}
    rows = scanned_rows(paths, scan_info, all_videos=all_videos)
    if not rows:
        sys.exit("Chưa có video nào. Hãy chạy sample hoặc điền data/testset.csv rồi submit trước.")
    library_cache = read_json(paths.library_cache, {})
    policies = read_json(paths.policies, {})
    detections = read_json(paths.detections, {})

    library_list = load_library_list(paths.library_list)
    songs = group_songs(rows, library_cache, library_list)
    report = scan_report(rows, videos_by_url(paths), library_cache, policies, scan_info, detections, library_list)
    return rows, songs, report


def cmd_channel_check(_args, paths):
    """In công cụ nào máy chủ đã có, chỉ đúng sai, không in giá trị khóa."""
    has_module = lambda name: importlib.util.find_spec(name) is not None
    print(json.dumps({
        "ytDlp": has_module("yt_dlp"),
        "ffmpeg": bool(find_ffmpeg()),
        "yamnet": has_module("ai_edge_litert") and has_module("numpy")
        and (paths.models / "yamnet.tflite").is_file() and (paths.models / "yamnet_class_map.csv").is_file(),
        "youtubeKey": bool(os.environ.get("YOUTUBE_API_KEY")),
        "auddKey": bool(os.environ.get("AUDD_API_TOKEN")),
    }))


def cmd_channel_status(args, paths):
    """In tình trạng từng video của kênh dạng JSON để web app tính chi phí và chọn video cần gửi."""
    if not paths.all_videos.exists():
        sys.exit("Chưa có data/all_videos.csv. Chạy list-videos trước.")
    limit = audd_max_chunks()
    submissions = read_json(paths.submissions, {})
    detections = read_json(paths.detections, {})
    videos, title = [], ""
    for video in read_csv(paths.all_videos):
        source = video["url"]
        title = title or video.get("channel", "")
        seconds = int(float(video.get("duration_seconds") or 0))
        videos.append({
            "videoId": video["video_id"],
            "title": video.get("title", ""),
            "seconds": seconds,
            "group": (detections.get(source) or {}).get("group", ""),
            "hasAudio": local_audio(paths, source) is not None,
            "scanned": source in submissions,
            "requests": full_requests(seconds, limit),
            "clipRequests": clip_requests(paths, source, args.clips) if args.clips else 0,
        })
    print(json.dumps({"channel": title, "maxSeconds": limit * CHUNK_SECONDS, "videos": videos}, ensure_ascii=False))


def cmd_channel_report(_args, paths):
    """In báo cáo cả kênh dạng JSON cho web app."""
    _, songs, report = _build_report(paths, True)
    print(json.dumps(report_json(report, songs), ensure_ascii=False))


def cmd_export(args, paths):
    rows, songs, report = _build_report(paths, args.all_videos)
    write_csv(paths.songs, songs, SONG_COLUMNS)
    write_csv(paths.scan_report, report, report_columns(report))
    print(f"Báo cáo {len(report)} video, mỗi video một dòng. Đã ghi {paths.scan_report}")
    groups = Counter(line["Nhóm"] for line in report)

    unchecked = sum(song["library"] == "chua-tra" for song in songs)
    print(f"{len(songs)} bài khác nhau, {unchecked} bài chưa tra Library. Đã ghi {paths.songs}")
    print(
        f"Sạch: {groups[SACH]}  Có nhạc: {groups[CO_NHAC]}  Cần nghe lại: {groups[CAN_NGHE_LAI]} "
        f"(tổng {len(rows)} video)."
    )
