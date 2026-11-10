#!/usr/bin/env python3
"""Bộ đo độ tin cậy của dịch vụ nhận diện nhạc (AudD hoặc ACRCloud) trên video của kênh. Xem README.md."""

import argparse
import hashlib
import importlib.util
import json
import math
import os
import random
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from music_audit import detect
from music_audit.acrcloud import AcrClient, AcrError
from music_audit.audd import ACCOUNT_ERRORS, CHUNK_SECONDS, AuddClient, AuddError, _iter_chunks, parse_audd, parse_saved
from music_audit.extract import ExtractError, ExtractStop, download_audio, extract_audio, find_ffmpeg
from music_audit.common import (
    TESTSET_COLUMNS,
    load_env,
    normalize_yes_no,
    read_csv,
    validate_testset,
    write_csv,
)
from music_audit.evaluate import ERROR, build_rows, identify_summary, parse_scan, render_report
from music_audit.grouping import (
    CAN_NGHE_LAI,
    CO_NHAC,
    SACH,
    SONG_COLUMNS,
    group_songs,
    load_library_list,
    report_columns,
    report_json,
    scan_report,
    song_key,
)
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
    return int(os.environ.get("AUDD_MAX_CHUNKS") or DEFAULT_AUDD_MAX_CHUNKS)


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


def cmd_list_videos(args, paths):
    client = YoutubeClient(os.environ.get("YOUTUBE_API_KEY", ""))
    videos = []
    for channel in args.channel:
        found = client.list_channel_videos(channel, include_shorts=not args.skip_shorts)
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


def cmd_audio_links(args, paths):
    """Ghi data/audio/links.txt cho tai_am_thanh.bat: link YouTube chưa quét và chưa tải âm thanh."""
    sources = [row["source"] for row in video_rows(paths, args.all_videos)]
    if not sources:
        sys.exit("Chưa có video nào. Chạy sample hoặc điền data/testset.csv trước.")
    submissions = read_json(paths.submissions, {})
    durations = known_durations(paths)
    youtube = [s for s in dict.fromkeys(sources) if youtube_video_id(s)]
    downloaded = [s for s in youtube if local_audio(paths, s)]
    scanned = [s for s in youtube if s in submissions and s not in downloaded]
    links = [s for s in youtube if s not in submissions and s not in downloaded]
    paths.audio.mkdir(parents=True, exist_ok=True)
    paths.audio_links.write_text("".join(f"{link}\n" for link in links), encoding="utf-8")
    minutes = sum(float(durations.get(link) or 0) for link in links) / 60
    length = f", khoảng {minutes:.0f} phút âm thanh" if minutes else ""
    print(f"Đã ghi {len(links)} link vào {paths.audio_links}{length}.")
    print(f"Bỏ qua {len(downloaded)} video đã có file âm thanh, {len(scanned)} video đã quét.")
    if links:
        print("Chạy tai_am_thanh.bat để tải, rồi chạy submit: video có file sẽ được gửi file thay cho link.")


def cmd_download_audio(args, paths):
    """Tải âm thanh các video chưa quét và chưa tải. Chạy được trên mọi hệ điều hành, web app dùng lệnh này."""
    sources = [s for s in dict.fromkeys(row["source"] for row in video_rows(paths, True)) if youtube_video_id(s)]
    if args.limit:
        sources = sources[: args.limit]
    submissions = read_json(paths.submissions, {})
    pending = [s for s in sources if s not in submissions and not local_audio(paths, s)]
    paths.audio.mkdir(parents=True, exist_ok=True)
    failed = 0
    for number, source in enumerate(pending, start=1):
        print(f"[{number}/{len(pending)}] Đang tải {source}", flush=True)
        try:
            download_audio(source, paths.audio)
        except ExtractStop:
            raise
        except ExtractError as error:
            failed += 1
            print(f"Lỗi với {source}: {error}", flush=True)
        if number < len(pending):
            time.sleep(args.delay)
    print(f"Đã tải {len(pending) - failed}/{len(pending)} video.", flush=True)


def _expected_music(row):
    """Nhãn đội đã ghi trong testset.csv: has_music yes/no; nếu trống thì xem music_origin
    (vn/foreign là có nhạc, none là không nhạc)."""
    has_music = normalize_yes_no(row.get("has_music"))
    if has_music:
        return detect.CO_NHAC if has_music == "yes" else detect.KHONG_NHAC
    origin = (row.get("music_origin") or "").strip().lower()
    if origin in ("vn", "foreign"):
        return detect.CO_NHAC
    if origin == "none":
        return detect.KHONG_NHAC
    return ""


def cmd_detect_music(args, paths):
    """Lọc trước có nhạc hay không trên file âm thanh đã tải, không tốn lượt AudD."""
    rows = video_rows(paths, args.all_videos)  # cả kênh vẫn giữ nhãn has_music để đếm bỏ sót
    if not rows:
        sys.exit("Chưa có video nào. Chạy sample hoặc điền data/testset.csv trước.")
    thresholds = {"threshold": args.threshold, "min_run": args.min_run, "min_total": args.min_total,
                  "intro": args.intro, "outro": args.outro}
    videos_by_url = {v["url"]: v for v in read_csv(paths.all_videos)} if paths.all_videos.exists() else {}
    detector = None
    detections = read_json(paths.detections, {})
    lines, missing, failed = [], 0, 0
    unique_rows = {row["source"]: row for row in rows}
    for number, row in enumerate(unique_rows.values(), start=1):
        print(f"[{number}/{len(unique_rows)}] Đang lọc", flush=True)
        source = row["source"]
        info = videos_by_url.get(source, {})
        line = {"video_id": youtube_video_id(source) or source, "video_title": info.get("title", ""), "url": source,
                "expected": _expected_music(row)}
        audio = local_audio(paths, source)
        if audio is None:
            missing += 1
            lines.append({**line, "detect": "chua-tai"})
            continue
        cache_file = paths.detect_cache / f"{audio.stem}.json"
        cached = read_json(cache_file, None)
        if cached is None or cached.get("size") != audio.stat().st_size:
            detector = detector or detect.YamnetDetector(paths.models)  # thiếu mô hình thì dừng hẳn
            try:
                wave = detect.read_waveform(audio)
                music, top = detector.frame_scores(wave)
            except detect.DetectError as error:
                failed += 1
                print(f"Lỗi với {source}: {error}")
                lines.append({**line, "detect": "loi"})
                continue
            common = max(set(top), key=top.count) if top else None
            cached = {"size": audio.stat().st_size, "duration": len(wave) / detect.SAMPLE_RATE,
                      "music": [round(score, 4) for score in music],
                      "top_sound": detector.names[common] if common is not None else ""}
            write_json(cache_file, cached)
        frames = detect.classify_frames(cached["music"], **thresholds)
        group = frames.group
        result = {"group": group, "music_seconds": f"{frames.music_seconds:.1f}",
                  "longest_run": f"{frames.longest_run:.1f}", "intro_outro_seconds": f"{frames.edge_seconds:.1f}",
                  "max_score": f"{frames.max_score:.2f}", "peak_at": detect.mmss(frames.peak_at)}
        detections[source] = result
        check = ""
        if line["expected"]:
            check = "dung" if line["expected"] == group else ("bo-sot" if group == detect.KHONG_NHAC else "bao-du")
        lines.append({**line, **{k: v for k, v in result.items() if k != "group"}, "detect": group,
                      "duration_seconds": f"{cached['duration']:.0f}", "top_sound": cached["top_sound"],
                      "check": check})
    write_json(paths.detections, detections)

    counts = {name: sum(line["detect"] == name for line in lines) for name in (detect.CO_NHAC, detect.KHONG_NHAC)}
    print(f"Có nhạc: {counts[detect.CO_NHAC]}  Không nhạc: {counts[detect.KHONG_NHAC]}  "
          f"Chưa tải âm thanh: {missing}  Lỗi: {failed}. Đã ghi {paths.detections}")
    print(f"Ngưỡng: điểm nhạc ≥ {args.threshold}, liền mạch ≥ {args.min_run} giây hoặc tổng ≥ {args.min_total} giây; "
          f"bỏ qua {args.intro} giây đầu (intro) và {args.outro} giây cuối (outro).")
    labeled = [line for line in lines if line.get("check")]
    if labeled:
        missed = [line["video_id"] for line in labeled if line["check"] == "bo-sot"]
        extra = sum(line["check"] == "bao-du" for line in labeled)
        print(f"So với nhãn trong testset.csv ({len(labeled)} video): bỏ sót {len(missed)}, báo dư {extra}.")
        if missed:
            print("BỎ SÓT video có nhạc: " + ", ".join(missed) + ". Hạ ngưỡng trước khi dùng --music-only.")
    if missing:
        print("Video chưa tải âm thanh: chạy audio-links rồi tai_am_thanh.bat.")


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
    command = [find_ffmpeg() or "ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vn", "-ac", "2", "-b:a", "128k", str(target)]
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


def _recognize_audd(client, source, limit):
    if source.lower().startswith(("http://", "https://")):
        return client.recognize_url(source, limit, full_scan=True)
    path = Path(source).expanduser()
    if path.suffix.lower() in AUDIO_SUFFIXES:
        return client.recognize_file(path, limit, full_scan=True)
    with tempfile.TemporaryDirectory() as folder:
        return client.recognize_file(_extract_audio(path, folder), limit, full_scan=True)


def _full_requests(seconds, limit):
    """Số lượt AudD khi quét cả video: mỗi 12 giây 1 lượt, không quá giới hạn AUDD_MAX_CHUNKS."""
    return min(math.ceil(float(seconds or 0) / CHUNK_SECONDS), limit)


def _detect_cache(paths, source):
    audio = local_audio(paths, source)
    cached = read_json(paths.detect_cache / f"{audio.stem}.json", None) if audio else None
    if not cached:
        raise detect.DetectError("chưa tải âm thanh hoặc chưa chạy detect-music cho video này")
    return audio, cached


def _shift_offset(offset, seconds):
    try:
        minutes, secs = (int(part) for part in str(offset).split(":")[-2:])
    except ValueError:
        return offset
    return detect.mmss(minutes * 60 + secs + seconds)


def _recognize_clips(client, paths, source, max_clips):
    """Gửi AudD các đoạn ~12 giây rải đều ở chỗ có nhạc (mỗi đoạn 1 lượt) thay vì cả video.

    Ghép kết quả thành một phản hồi AudD bình thường; offset của từng đoạn đổi về giây trong video.
    """
    audio, cached = _detect_cache(paths, source)
    starts = detect.clip_starts(cached["music"], max_clips=max_clips)
    result = []
    with tempfile.TemporaryDirectory() as folder:
        for number, start in enumerate(starts):
            clip = detect.cut_clip(audio, start, Path(folder) / f"clip{number}.mp3")
            for offset, songs in _iter_chunks(client.recognize_file(clip, 1, full_scan=True)):
                result.append({"offset": _shift_offset(offset or "00:00", start), "songs": songs})
    return {"status": "success", "result": result}, starts


def _clip_requests(paths, source, max_clips):
    try:
        return len(detect.clip_starts(_detect_cache(paths, source)[1]["music"], max_clips=max_clips))
    except detect.DetectError:
        return 0


def _submit_audd(args, paths, rows):
    """AudD trả kết quả ngay, nên gửi và lưu kết quả cùng lúc; không cần container hay fetch."""
    client = audd_client()
    limit = audd_max_chunks()
    durations = known_durations(paths)
    submissions = read_json(paths.submissions, {})
    pending = [row["source"] for row in rows if row["source"] not in submissions]
    if args.limit:
        pending = pending[: args.limit]
    failed = 0
    for number, source in enumerate(pending, start=1):
        audio = local_audio(paths, source)
        note = f" (từ file {audio.name})" if audio else ""
        print(f"[{number}/{len(pending)}] Đang quét {source}{note}", flush=True)
        starts = None
        try:
            if args.clips:
                response, starts = _recognize_clips(client, paths, source, args.clips)
            else:
                response = _recognize_audd(client, str(audio) if audio else source, limit)
        except (AuddError, detect.DetectError, subprocess.CalledProcessError, OSError) as error:
            failed += 1
            print(f"Lỗi với {source}: {error}")
            if getattr(error, "code", None) in ACCOUNT_ERRORS:
                print("Đây là lỗi tài khoản AudD, các video sau cũng sẽ lỗi. Dừng lại, chưa gửi thêm.")
                break
            continue
        file_id = "audd-" + hashlib.sha1(source.encode("utf-8")).hexdigest()[:16]
        raw = {
            "provider": "audd",
            "source": source,
            "scanned_from": "file" if audio else "url",
            "duration_seconds": durations.get(source, 0),
            "response": response,
        }
        if starts is not None:
            raw.update(mode="clips", clip_starts=starts)
        write_json(paths.raw / f"{file_id}.json", raw)
        submissions[source] = {"file_id": file_id, "service": "audd", "at": datetime.now(timezone.utc).isoformat()}
        write_json(paths.submissions, submissions)
        time.sleep(args.delay)
    print(f"Đã quét {number - failed if pending else 0}/{len(pending)} video. Tổng đã quét: {len(submissions)}/{len(rows)}.")
    if failed:
        print("Chạy lại lệnh này để quét tiếp các video lỗi; video đã quét sẽ không bị quét lại.")
    print("AudD trả kết quả ngay, không cần chạy fetch. Chạy report để xem báo cáo.")


def _print_audd_estimate(args, paths, rows):
    durations = known_durations(paths)
    submissions = read_json(paths.submissions, {})
    limit = audd_max_chunks()
    todo = [row for row in rows if row["source"] not in submissions][: args.limit or None]
    if args.clips:
        requests = sum(_clip_requests(paths, row["source"], args.clips) for row in todo)
        how = "đoạn 12 giây rải đều mỗi 45 giây ở chỗ có nhạc, mỗi đoạn 1 lượt"
    else:
        requests = sum(_full_requests(durations.get(row["source"]), limit) for row in todo)
        how = "cả video, 1 lượt mỗi 12 giây âm thanh"
        too_long = sum(float(durations.get(row["source"]) or 0) > limit * CHUNK_SECONDS for row in todo)
        if too_long:
            print(f"CHÚ Ý: {too_long} video dài hơn giới hạn, chỉ quét {limit * CHUNK_SECONDS // 60} phút đầu. "
                  "Tăng AUDD_MAX_CHUNKS trong .env nếu cần quét hết.")
    if requests:
        print(f"Sẽ quét {len(todo)} video, ước khoảng {requests} lượt AudD ({how}).")


COMPARE_COLUMNS = (
    "Mã video", "Tiêu đề video", "Số đoạn gửi", "Lượt (quét cả video)", "Lượt (đoạn cắt)",
    "Kết luận giống nhau", "Tìm thấy bài chính",
)


SONG_LABELS = {  # nhóm bài: (tên cột bài, tên cột tác giả)
    "found": ("Bài", "Tác giả"),
    "missed": ("Bài bị sót", "Tác giả bài bị sót"),
    "extra": ("Bài chỉ đoạn cắt thấy", "Tác giả bài chỉ đoạn cắt thấy"),
}


def _song_columns(kind, count):
    """Mỗi bài một ô, tác giả ở ô bên cạnh: "Bài 1", "Tác giả 1", "Bài 2", "Tác giả 2"..."""
    song, artist = SONG_LABELS[kind]
    return [name for number in range(1, count + 1) for name in (f"{song} {number}", f"{artist} {number}")]


def _song_cells(kind, tracks):
    return dict(zip(_song_columns(kind, len(tracks)), (v for t in tracks for v in (t["title"], t["artists"]))))


def cmd_compare_clips(args, paths):
    """Kiểm chứng cách gửi đoạn ngắn: gửi đoạn cắt cho video đã quét cả video rồi so hai kết quả.

    Kết quả đoạn cắt lưu riêng ở out/raw-clips/, không đụng tới kết quả quét chính. Chạy lại không gửi lại.
    """
    submissions = read_json(paths.submissions, {})
    detections = read_json(paths.detections, {})
    durations = known_durations(paths)
    limit = audd_max_chunks()
    videos_by_url = {v["url"]: v for v in read_csv(paths.all_videos)} if paths.all_videos.exists() else {}
    folder = paths.out / "raw-clips"
    candidates = []
    for source, entry in submissions.items():
        full = read_json(paths.raw / f"{entry['file_id']}.json", None)
        if full and full.get("provider") == "audd" and full.get("mode") != "clips" \
                and (detections.get(source) or {}).get("group") == detect.CO_NHAC:
            candidates.append((source, entry["file_id"], full))
    candidates = candidates[: args.limit or None]

    def saved_clips(source, file_id):
        """Kết quả đoạn cắt đã lưu, chỉ dùng lại khi các đoạn đúng với cách chọn đoạn hiện tại."""
        saved = read_json(folder / f"{file_id}.json", None)
        plan = detect.clip_starts(_detect_cache(paths, source)[1]["music"], max_clips=args.clips)
        return saved if saved and saved.get("clip_starts") == plan else None

    to_send = [c for c in candidates if saved_clips(c[0], c[1]) is None]
    requests = sum(_clip_requests(paths, source, args.clips) for source, _, _ in to_send)
    print(f"So sánh {len(candidates)} video đã quét cả video. Cần gửi {len(to_send)} video, ước khoảng {requests} lượt AudD.")
    client = audd_client() if to_send else None
    lines = []
    for source, file_id, full in candidates:
        clip_raw = saved_clips(source, file_id)
        if clip_raw is None:
            print(f"Đang gửi đoạn cắt của {source}", flush=True)
            try:
                response, starts = _recognize_clips(client, paths, source, args.clips)
            except (AuddError, detect.DetectError, subprocess.CalledProcessError, OSError) as error:
                print(f"Lỗi với {source}: {error}")
                if getattr(error, "code", None) in ACCOUNT_ERRORS:
                    print("Đây là lỗi tài khoản AudD. Dừng lại, chưa gửi thêm.")
                    break
                continue
            clip_raw = {**full, "response": response, "mode": "clips", "clip_starts": starts}
            write_json(folder / f"{file_id}.json", clip_raw)
            time.sleep(args.delay)
        full_tracks = parse_saved(full).tracks
        clip_tracks = parse_saved(clip_raw).tracks
        full_keys = {song_key(t["title"], t["artists"]) for t in full_tracks}
        clip_keys = {song_key(t["title"], t["artists"]) for t in clip_tracks}
        main = song_key(full_tracks[0]["title"], full_tracks[0]["artists"]) if full_tracks else ""
        lines.append({
            "video_id": youtube_video_id(source) or source,
            "video_title": videos_by_url.get(source, {}).get("title", ""),
            "requests_full": _full_requests(durations.get(source), limit),
            "requests_clips": len(clip_raw.get("clip_starts") or []),
            "same_verdict": bool(full_tracks) == bool(clip_tracks),
            "main_found": (main in clip_keys) if main else None,
            "found": clip_tracks,
            "missed": [t for t in full_tracks if song_key(t["title"], t["artists"]) not in clip_keys],
            "extra": [t for t in clip_tracks if song_key(t["title"], t["artists"]) not in full_keys],
        })
    report = paths.out / "so-sanh-cat-doan.csv"
    yes_no = {True: "Có", False: "Không", None: ""}
    widths = {kind: max([len(line[kind]) for line in lines] or [0]) for kind in SONG_LABELS}
    columns = list(COMPARE_COLUMNS) + [c for kind in SONG_LABELS for c in _song_columns(kind, widths[kind])]
    rows = []
    for line in lines:
        row = {
            "Mã video": line["video_id"],
            "Tiêu đề video": line["video_title"],
            "Số đoạn gửi": line["requests_clips"],
            "Lượt (quét cả video)": line["requests_full"],
            "Lượt (đoạn cắt)": line["requests_clips"],
            "Kết luận giống nhau": yes_no[line["same_verdict"]],
            "Tìm thấy bài chính": yes_no[line["main_found"]],
        }
        for kind in SONG_LABELS:
            row.update(_song_cells(kind, line[kind]))
        rows.append(row)
    write_csv(report, rows, columns)
    if not lines:
        return
    with_songs = [line for line in lines if line["main_found"] is not None]
    print(f"Kết luận có bài / không có bài giống nhau: {sum(l['same_verdict'] for l in lines)}/{len(lines)} video.")
    print(f"Bài chính vẫn được nhận ra: {sum(l['main_found'] for l in with_songs)}/{len(with_songs)} video.")
    missed = [f"{l['video_id']}: {', '.join(t['title'] for t in l['missed'])}" for l in lines if l["missed"]]
    print(f"Bài bị sót ({len(missed)} video): " + ("; ".join(missed) if missed else "không có"))
    full_total = sum(l["requests_full"] for l in lines)
    clip_total = sum(l["requests_clips"] for l in lines)
    print(f"Lượt AudD: cả video {full_total}, đoạn cắt {clip_total}. Đã ghi {report}")


def cmd_submit(args, paths):
    service = music_service()
    if args.clips and service != "audd":
        sys.exit("--clips chỉ dùng được với AudD.")
    rows = video_rows(paths, args.all_videos)
    if not rows:
        sys.exit(f"Chưa có video nào. Hãy điền {paths.testset}")
    errors = validate_testset(rows)
    if errors:
        print("Danh sách video có lỗi, chưa gửi gì:")
        print("\n".join(f"- {error}" for error in errors))
        sys.exit(1)
    if args.music_only:
        detections = read_json(paths.detections, {})
        if not detections:
            sys.exit("Chưa có kết quả lọc. Chạy detect-music trước, hoặc bỏ --music-only.")
        groups = [(detections.get(row["source"]) or {}).get("group") for row in rows]
        no_music = groups.count(detect.KHONG_NHAC)
        unfiltered = sum(group not in (detect.CO_NHAC, detect.KHONG_NHAC) for group in groups)
        rows = [row for row, group in zip(rows, groups) if group == detect.CO_NHAC]
        print(f"Chỉ gửi video có nhạc: {len(rows)} video. Bỏ qua {no_music} không nhạc, "
              f"{unfiltered} chưa lọc (chưa tải âm thanh).")
    if args.video_id:
        rows = [row for row in rows if youtube_video_id(row["source"]) == args.video_id]
    if service == "audd":
        _print_audd_estimate(args, paths, rows)
        _submit_audd(args, paths, rows)
        return
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
        audio = local_audio(paths, source)
        try:
            file_id = _submit_one(client, container, str(audio) if audio else source)
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
    if music_service() == "audd":
        print("AudD trả kết quả ngay khi submit, không cần fetch. Chạy report để xem báo cáo.")
        return
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


def youtube_duration(video_id):
    """Độ dài video, 0 nếu chưa có khóa hoặc không lấy được. Thiếu độ dài thì không kết luận được độ phủ."""
    api_key = os.environ.get("YOUTUBE_API_KEY", "")
    if not api_key:
        return 0
    try:
        return YoutubeClient(api_key).video_duration(video_id)
    except YoutubeError:
        return 0


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
    _print_audd_result(args.name or path.name, digest[:11], raw, limit, cache=cache, cached=cached)


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
    videos_by_url = {}
    if paths.all_videos.exists():
        videos_by_url = {video["url"]: video for video in read_csv(paths.all_videos)}

    library_list = load_library_list(paths.library_list)
    songs = group_songs(rows, library_cache, library_list)
    report = scan_report(rows, videos_by_url, library_cache, policies, scan_info, detections, library_list)
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
            "requests": _full_requests(seconds, limit),
            "clipRequests": _clip_requests(paths, source, args.clips) if args.clips else 0,
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
    command.add_argument("--clips", type=int, default=0, help="Tính thêm số đoạn sẽ gửi nếu dùng submit --clips N")
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
    command.add_argument("--clips", type=int, default=0,
                         help="Chỉ AudD: gửi đoạn 12 giây rải đều mỗi 45 giây ở chỗ có nhạc, tối đa N đoạn mỗi video; 0 là gửi cả video")
    command.add_argument("--video-id", default="", help="Chỉ gửi đúng video này, web app dùng để dừng được giữa hai video")
    command.set_defaults(handler=cmd_submit)

    command = commands.add_parser("compare-clips", help="Kiểm chứng gửi đoạn 12 giây: so với kết quả quét cả video")
    command.add_argument("--clips", type=int, default=detect.MAX_CLIPS, help="Tối đa N đoạn mỗi video")
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
