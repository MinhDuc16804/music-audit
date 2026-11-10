"""Lệnh gửi video đi nhận diện (submit, fetch), gửi đoạn cắt và so sánh đoạn cắt với quét cả video."""

import argparse
import hashlib
import math
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from music_audit import detect
from music_audit.acrcloud import AcrError
from music_audit.audd import _iter_chunks, ACCOUNT_ERRORS, AuddError, CHUNK_SECONDS, parse_saved
from music_audit.common import validate_testset, write_csv
from music_audit.extract import find_ffmpeg
from music_audit.grouping import song_key
from music_audit.workspace import (
    acr_client,
    audd_client,
    audd_max_chunks,
    AUDIO_SUFFIXES,
    known_durations,
    local_audio,
    music_service,
    read_json,
    video_rows,
    videos_by_url,
    write_json,
)
from music_audit.youtube import youtube_video_id

FETCH_BATCH = 20


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


def full_requests(seconds, limit):
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


def _clip_cache(paths, audio, start):
    """Kết quả AudD của một đoạn, lưu ngay khi có để lỗi giữa chừng không làm mất và không trả tiền lại đoạn đã gửi."""
    return paths.out / "clips" / audio.stem / f"{start:.2f}.json"


def _recognize_clips(client, paths, source, max_clips):
    """Gửi AudD các đoạn ~12 giây rải đều ở chỗ có nhạc (mỗi đoạn 1 lượt) thay vì cả video.

    Ghép kết quả thành một phản hồi AudD bình thường; offset của từng đoạn đổi về giây trong video.
    Đoạn đã có kết quả từ lần chạy trước được dùng lại, chỉ gửi các đoạn chưa có.
    """
    audio, cached = _detect_cache(paths, source)
    starts = detect.clip_starts(cached["music"], max_clips=max_clips)
    result = []
    with tempfile.TemporaryDirectory() as folder:
        for number, start in enumerate(starts):
            saved = _clip_cache(paths, audio, start)
            response = read_json(saved, None)
            if response is None:
                clip = detect.cut_clip(audio, start, Path(folder) / f"clip{number}.mp3")
                response = client.recognize_file(clip, 1, full_scan=True)
                write_json(saved, response)
            for offset, songs in _iter_chunks(response):
                result.append({"offset": _shift_offset(offset or "00:00", start), "songs": songs})
    return {"status": "success", "result": result}, starts


def clip_requests(paths, source, max_clips):
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
        requests = sum(clip_requests(paths, row["source"], args.clips) for row in todo)
        how = "đoạn 12 giây rải đều mỗi 45 giây ở chỗ có nhạc, mỗi đoạn 1 lượt"
    else:
        requests = sum(full_requests(durations.get(row["source"]), limit) for row in todo)
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
    by_url = videos_by_url(paths)
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
    requests = sum(clip_requests(paths, source, args.clips) for source, _, _ in to_send)
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
            "video_title": by_url.get(source, {}).get("title", ""),
            "requests_full": full_requests(durations.get(source), limit),
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


def clip_count(value):
    """Số đoạn mỗi video có trần, để gõ nhầm một số lớn không thành hóa đơn lớn."""
    try:
        count = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("phải là số nguyên") from None
    if not 0 <= count <= detect.MAX_CLIPS:
        raise argparse.ArgumentTypeError(f"phải từ 0 tới {detect.MAX_CLIPS}")
    return count
