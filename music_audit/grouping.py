"""Gom kết quả theo bài (songs.csv) và viết báo cáo mỗi video một dòng (bao-cao-quet.csv).

Không gọi mạng. Thông tin từ Studio (bài có trong Library không, Policy) là phần bổ sung:
thiếu thì ghi chua-tra, báo cáo vẫn được ghi. Thông tin Studio không bao giờ đưa video vào nhóm "sạch".
"""

from datetime import datetime
from pathlib import Path

from music_audit.common import read_csv
from music_audit.evaluate import ERROR, PASS_NO_MUSIC, normalize_title
from music_audit.youtube import youtube_video_id

SACH = "sach"
CO_NHAC = "co-nhac"
CAN_NGHE_LAI = "can-nghe-lai"

# Kết quả tra Library (bước 5). Chỉ "khop-chac" mới được coi là có trong Library.
LIBRARY_STATUSES = ("khop-chac", "gan-giong", "khong-thay")

SONG_COLUMNS = ("song_key", "title", "artist", "label", "video_count", "seconds", "best_score", "library", "videos")
REPORT_COLUMNS = (
    "Mã video", "Tiêu đề video", "Link", "Thời lượng (giây)", "Nhóm", "Lý do", "Máy lọc", "Giây có nhạc (máy lọc)",
    "Đoạn nhạc liền dài nhất (giây)", "Giây cần nghe", "Lúc quét", "Quét từ", "Policy",
)
SONG_CELLS = ("Bài", "Tác giả", "Hãng", "Library", "Vị trí")  # mỗi bài một nhóm ô: Bài 1, Tác giả 1...


def song_key(title, artist):
    """Khóa của một bài: tên bài và nghệ sĩ đã bỏ dấu, chữ thường. Dùng để bỏ trùng và tra cache."""
    return f"{normalize_title(title)}|{normalize_title(artist)}"


def load_library_list(path):
    """Danh sách bài đã biết có trong Audio Library (cột title, artist), bỏ qua thứ tự hai cột."""
    if not Path(path).exists():
        return set()
    return {frozenset({normalize_title(row.get("title")), normalize_title(row.get("artist"))}) for row in read_csv(path)}


def library_status(key, library_cache, library_list=None):
    """Kết quả tra Studio được ưu tiên. Danh sách có sẵn chỉ xác nhận "có": không thấy thì vẫn là chưa tra.

    YouTube hay ghi đảo tên bài và nghệ sĩ so với AudD, nên so khớp cả hai chiều.
    """
    first, _, second = key.partition("|")
    for candidate in (key, f"{second}|{first}"):
        entry = (library_cache or {}).get(candidate)
        status = entry.get("status") if isinstance(entry, dict) else None
        if status in LIBRARY_STATUSES:
            return status
    if library_list and frozenset({first, second}) in library_list:
        return "khop-chac"
    return "chua-tra"


def group_songs(rows, library_cache=None, library_list=None):
    """Gom các bài đã nhận ra trên mọi video, mỗi bài một dòng, bài xuất hiện nhiều nhất lên đầu."""
    songs = {}
    for row in rows:
        scan = row.get("_scan")
        if scan is None or row.get("decision") == ERROR:
            continue
        for track in scan.tracks:
            key = song_key(track["title"], track["artists"])
            song = songs.setdefault(
                key,
                {
                    "song_key": key,
                    "title": track["title"],
                    "artist": track["artists"],
                    "label": track.get("label") or "",
                    "seconds": 0.0,
                    "best_score": 0,
                    "_videos": [],
                },
            )
            song["seconds"] += float(track.get("played_duration") or 0)
            song["best_score"] = max(song["best_score"], track.get("score") or 0)
            if not song["label"] and track.get("label"):
                song["label"] = track["label"]
            if row["source"] not in song["_videos"]:
                song["_videos"].append(row["source"])
    result = []
    for song in songs.values():
        videos = song.pop("_videos")
        result.append(
            {
                **song,
                "seconds": f"{song['seconds']:.0f}",
                # AudD không trả điểm tin cậy: để trống thay vì 0, kẻo đọc nhầm là độ tin cậy bằng 0.
                "best_score": song["best_score"] or "",
                "video_count": len(videos),
                "library": library_status(song["song_key"], library_cache, library_list),
                "videos": " | ".join(videos),
            }
        )
    return sorted(result, key=lambda s: (-s["video_count"], s["title"].lower()))


def local_time(value):
    """Thời điểm quét (lưu theo UTC) đổi sang giờ của máy, dạng "2026-11-06 16:53"."""
    if not value:
        return ""
    try:
        return datetime.fromisoformat(value).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return value


def _position(offsets):
    """Đoạn trong video có bài, theo các đoạn 12 giây của AudD: "00:00", "00:24 → 01:12"."""
    if not offsets:
        return ""
    return offsets[0] if len(offsets) == 1 else f"{offsets[0]} → {offsets[-1]}"


def scan_report(rows, videos_by_url=None, library_cache=None, policies=None, scan_info=None, detections=None,
                library_list=None):
    """Báo cáo mỗi video một dòng, đủ mọi video trong danh sách; mỗi bài nhận ra là một nhóm ô.

    scan_info: {source: {"scanned_at", "scanned_from"}} lấy từ submissions.json và raw/.
    detections: {source: {"group", "music_seconds", ...}} lấy từ out/music_detect.json.
    """
    videos_by_url = videos_by_url or {}
    policies = policies or {}
    scan_info = scan_info or {}
    detections = detections or {}
    report = []
    for row in rows:
        source = row["source"]
        detected = detections.get(source) or {}
        info = videos_by_url.get(source, {})
        meta = scan_info.get(source, {})
        group, reason = classify(row, detected.get("group", ""))
        line = {
            "Mã video": info.get("video_id") or youtube_video_id(source) or source,
            "Tiêu đề video": info.get("title", ""),
            "Link": source,
            "Thời lượng (giây)": info.get("duration_seconds") or row.get("duration_seconds", ""),
            "Nhóm": group,
            "Lý do": reason,
            "Máy lọc": detected.get("group", ""),
            "Giây có nhạc (máy lọc)": detected.get("music_seconds", ""),
            "Đoạn nhạc liền dài nhất (giây)": detected.get("longest_run", ""),
            "Giây cần nghe": detected.get("peak_at", ""),
            "Lúc quét": local_time(meta.get("scanned_at")),
            "Quét từ": meta.get("scanned_from", ""),
            "Policy": policies.get(source, "chua-tra") if group == CO_NHAC else "",
        }
        tracks = row["_scan"].tracks if group == CO_NHAC else []
        for number, track in enumerate(tracks, start=1):
            key = song_key(track["title"], track["artists"])
            values = (track["title"], track["artists"], track.get("label") or "",
                      library_status(key, library_cache, library_list), _position(track.get("offsets")))
            line.update({f"{cell} {number}": value for cell, value in zip(SONG_CELLS, values)})
        report.append(line)
    return report


def report_columns(report):
    """Các cột của báo cáo; số nhóm ô bài nhạc theo video có nhiều bài nhất."""
    songs = 0
    for line in report:
        while f"Bài {songs + 1}" in line:
            songs += 1
    return list(REPORT_COLUMNS) + [f"{cell} {n}" for n in range(1, songs + 1) for cell in SONG_CELLS]


def report_json(report, songs):
    """Báo cáo cho web app, cùng nội dung với hai file CSV nhưng mỗi bài là một phần tử thay vì một nhóm ô."""
    videos = []
    for line in report:
        tracks = []
        while f"Bài {len(tracks) + 1}" in line:
            number = len(tracks) + 1
            tracks.append({
                "title": line[f"Bài {number}"],
                "artist": line[f"Tác giả {number}"],
                "label": line[f"Hãng {number}"],
                "library": line[f"Library {number}"],
                "position": line[f"Vị trí {number}"],
            })
        videos.append({
            "videoId": line["Mã video"],
            "title": line["Tiêu đề video"],
            "url": line["Link"],
            "seconds": int(float(line["Thời lượng (giây)"] or 0)),
            "group": line["Nhóm"],
            "reason": line["Lý do"],
            "detection": line["Máy lọc"],
            "musicSeconds": line["Giây có nhạc (máy lọc)"],
            "policy": line["Policy"],
            "tracks": tracks,
        })
    return {
        "videos": videos,
        "songs": [
            {
                "title": song["title"],
                "artist": song["artist"],
                "label": song["label"],
                "library": song["library"],
                "videoCount": song["video_count"],
                "seconds": int(float(song["seconds"] or 0)),
            }
            for song in songs
        ],
    }


def classify(row, detection=""):
    """Nhóm của một video. Chỉ "không có nhạc" chắc chắn mới là sạch; lỗi hay chưa quét đều phải xem lại.

    detection: kết quả máy lọc trên máy ("co-nhac", "khong-nhac" hoặc ""). Máy lọc chỉ thêm lý do để
    người nghe biết nên ưu tiên video nào, không đưa video nào vào nhóm sạch.
    """
    scan = row.get("_scan")
    if scan is None or row.get("decision") == ERROR:
        if detection == "khong-nhac":
            return CAN_NGHE_LAI, "máy lọc: không nhạc, chưa quét AudD: nghe kiểm tra"
        return CAN_NGHE_LAI, "chưa có kết quả quét hoặc quét lỗi: cần quét lại"
    if scan.tracks:
        return CO_NHAC, ""
    if row.get("decision") == PASS_NO_MUSIC:
        return SACH, ""
    if scan.music == "yes" or detection == "co-nhac":
        return CAN_NGHE_LAI, "có nhạc nhưng không nhận ra bài"
    if detection == "khong-nhac":
        return CAN_NGHE_LAI, "không nhận ra bài; máy lọc: không nhạc"
    return CAN_NGHE_LAI, "không nhận ra bài, chưa biết có nhạc hay không"
