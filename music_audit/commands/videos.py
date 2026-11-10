"""Lệnh lấy danh sách video, chọn mẫu, tải âm thanh và lọc trước có nhạc hay không. Không tốn lượt nhận diện."""

import os
import random
import sys
import time

from music_audit import detect
from music_audit.common import normalize_yes_no, read_csv, TESTSET_COLUMNS, write_csv
from music_audit.extract import download_audio, ExtractError, ExtractStop
from music_audit.workspace import NO_VIDEOS, known_durations, local_audio, read_json, video_rows, videos_by_url, write_json
from music_audit.youtube import youtube_video_id, YoutubeClient

VIDEO_COLUMNS = ("channel", "video_id", "url", "title", "published_at", "duration_seconds", "view_count")


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
        sys.exit(NO_VIDEOS)
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
        sys.exit(NO_VIDEOS)
    thresholds = {"threshold": args.threshold, "min_run": args.min_run, "min_total": args.min_total,
                  "intro": args.intro, "outro": args.outro}
    by_url = videos_by_url(paths)
    detector = None
    detections = read_json(paths.detections, {})
    lines, missing, failed = [], 0, 0
    unique_rows = {row["source"]: row for row in rows}
    for number, row in enumerate(unique_rows.values(), start=1):
        print(f"[{number}/{len(unique_rows)}] Đang lọc", flush=True)
        source = row["source"]
        info = by_url.get(source, {})
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
