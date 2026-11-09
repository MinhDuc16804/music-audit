"""So kết quả quét với nhãn của đội và viết báo cáo.

Nguyên tắc: khớp thì tin, không khớp thì chưa biết. Video chỉ được cho qua khi không có
nhạc hoặc có giấy phép. Có nhạc mà không nhận ra thì giữ lại, không cho qua.
"""

import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

SPEECH_SHARE_THRESHOLD = 0.20
# Nhãn phân đoạn đã biết. Nhãn lạ thì không được coi là "không có nhạc".
MUSIC_LABELS = {"m", "ms"}
NON_MUSIC_LABELS = {"s", "o"}

# Quyết định của cổng kiểm tra
BLOCK = "block"
HOLD = "hold"
PASS_NO_MUSIC = "pass_no_music"
PASS_LICENSED = "pass_licensed"
ERROR = "error"

# Kết quả với video chắc chắn có nhạc thương mại
CAUGHT_RIGHT = "caught_right"
CAUGHT_OTHER = "caught_other"
CAUGHT_UNVERIFIED = "caught_unverified"
HELD = "held"
ESCAPED = "escaped"

IDENTIFY_NOTES = {
    BLOCK: "Máy nhận ra bài nhạc trong video. Chỉ dùng được khi có giấy phép cho đúng các bài này.",
    HOLD: "Có nhạc hoặc không rõ, nhưng không nhận ra bài. Đây là chưa biết, không phải an toàn: cần hỏi nguồn nhạc.",
    PASS_NO_MUSIC: "Máy kết luận không có nhạc. Kết quả quét không phải bằng chứng về bản quyền.",
    ERROR: "ACRCloud không quét được video này. Chưa có kết luận gì về nhạc trong video.",
}


@dataclass
class Scan:
    state: int = 0
    duration: float = 0.0
    tracks: list = field(default_factory=list)
    music: str = "unknown"  # yes, no, unknown
    speech_share: float | None = None
    segments: list = field(default_factory=list)  # từng đoạn quét và vị trí các bài ứng viên trong tracks
    detects_music: bool = True  # False khi dịch vụ (AudD) không phân biệt được "không có nhạc" với "không nhận ra"


def normalize_title(value):
    """Bỏ dấu tiếng Việt, ký tự đặc biệt và phần trong ngoặc để so tên bài."""
    value = (value or "").lower().replace("đ", "d")
    value = re.sub(r"\(.*?\)|\[.*?\]", " ", value)
    value = unicodedata.normalize("NFD", value)
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def titles_match(expected, actual):
    """Khớp cả tên bài sau khi chuẩn hóa, không khớp một phần: "Love" khác "Love Story"."""
    first = normalize_title(expected)
    return bool(first) and first == normalize_title(actual)


def artists_match(expected, names):
    """Đúng khi có ít nhất một nghệ sĩ đội ghi (ngăn bởi , ; & /) nằm trong danh sách máy trả về."""
    wanted = {normalize_title(part) for part in re.split(r"[,;&/]", expected or "")} - {""}
    return bool(wanted & {normalize_title(name) for name in names})


def is_licensed_track(row, track):
    """Bài máy nhận ra phải trùng cả tên bài lẫn nghệ sĩ đã ghi trong dòng licensed."""
    return titles_match(row.get("expected_title"), track["title"]) and artists_match(
        row.get("expected_artist"), track["artist_names"]
    )


def music_presence(tracks, segments, seconds, flag):
    """Trả về yes, no hoặc unknown. Chỉ kết luận no khi mọi bằng chứng cùng chỉ về không có nhạc."""
    if tracks or any(seconds[label] for label in MUSIC_LABELS) or flag == 1:
        return "yes"
    if segments:
        labels_known = set(seconds) <= NON_MUSIC_LABELS
        return "no" if labels_known and sum(seconds.values()) > 0 and flag in (None, 2) else "unknown"
    return "no" if flag == 2 else "unknown"


def parse_scan(raw):
    """Đọc một bản ghi file do ACRCloud trả về."""
    results = raw.get("results") or {}
    best = {}
    for kind in ("music", "cover_songs"):
        for item in results.get(kind) or []:
            result = item.get("result") or {}
            title = result.get("title") or ""
            artist_names = [a.get("name", "") for a in result.get("artists") or []]
            key = (
                normalize_title(title) or title,
                tuple(sorted(normalize_title(name) or name for name in artist_names)),
            )
            score = result.get("score") or 0
            played = item.get("played_duration") or 0
            current = best.get(key)
            if current is None:
                best[key] = {
                    "title": title,
                    "artists": ", ".join(artist_names),
                    "artist_names": artist_names,
                    "label": result.get("label") or "",
                    "score": score,
                    "played_duration": played,
                    "kind": kind,
                }
            else:
                current["score"] = max(current["score"], score)
                current["played_duration"] += played
    tracks = sorted(best.values(), key=lambda t: -t["played_duration"])

    segments = results.get("music_speech") or []
    seconds = Counter()
    for segment in segments:
        length = max(0.0, float(segment.get("end", 0)) - float(segment.get("start", 0)))
        seconds[segment.get("label")] += length
    total = sum(seconds.values())
    speech_share = (seconds["s"] + seconds["ms"]) / total if total else None

    return Scan(
        state=int(raw.get("state", 0)),
        duration=float(raw.get("duration") or 0),
        tracks=tracks,
        music=music_presence(tracks, segments, seconds, raw.get("music_detected")),
        speech_share=speech_share,
    )


def gate_decision(scan, row):
    """Quyết định của cổng kiểm tra. Không rõ có nhạc hay không thì giữ lại."""
    if scan is None or scan.state in (0, -2, -3):
        return ERROR
    if scan.tracks:
        if row.get("group") == "licensed" and all(is_licensed_track(row, track) for track in scan.tracks):
            return PASS_LICENSED
        return BLOCK
    return PASS_NO_MUSIC if scan.music == "no" else HOLD


def identify_summary(scan):
    """Tóm tắt kết quả quét một video. Không có dòng nhãn nên không video nào được qua vì có giấy phép."""
    decision = gate_decision(scan, {})
    hidden = ("artist_names", "offsets")  # vị trí từng đoạn đã có trong segments
    tracks = [{key: value for key, value in track.items() if key not in hidden} for track in scan.tracks]
    return {
        "decision": decision,
        "note": IDENTIFY_NOTES[decision],
        "music": scan.music,
        "duration_seconds": scan.duration,
        "tracks": tracks,
        "segments": scan.segments,
    }


def commercial_outcome(scan, row):
    """Xếp kết quả của một video chắc chắn có nhạc thương mại."""
    decision = gate_decision(scan, row)
    if decision == ERROR:
        return ERROR
    if decision == BLOCK:
        expected = row.get("expected_title")
        if not expected:
            return CAUGHT_UNVERIFIED
        if any(titles_match(expected, track["title"]) for track in scan.tracks):
            return CAUGHT_RIGHT
        return CAUGHT_OTHER
    return HELD if decision == HOLD else ESCAPED


def wilson_interval(hits, total, z=1.96):
    """Khoảng tin cậy 95% của một tỷ lệ, dùng được với mẫu nhỏ."""
    if total == 0:
        return (0.0, 0.0)
    rate = hits / total
    denominator = 1 + z * z / total
    center = rate + z * z / (2 * total)
    margin = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
    return (max(0.0, (center - margin) / denominator), min(1.0, (center + margin) / denominator))


def format_rate(hits, total):
    if total == 0:
        return "chưa có dữ liệu"
    low, high = wilson_interval(hits, total)
    return f"{hits}/{total} = {hits / total:.0%} (khoảng {low:.0%}–{high:.0%})"


def describe_tracks(scan):
    if scan is None or not scan.tracks:
        return ""
    return " | ".join(
        f"{t['title']} - {t['artists']} [{t['label']}] điểm {t['score']}" for t in scan.tracks
    )


def build_rows(testset, scans_by_source):
    """Ghép nhãn với kết quả quét thành từng dòng chi tiết."""
    rows = []
    for row in testset:
        scan = scans_by_source.get(row["source"])
        group = row.get("group")
        outcome = commercial_outcome(scan, row) if group in ("strike", "commercial") else ""
        rows.append(
            {
                **row,
                "decision": gate_decision(scan, row),
                "outcome": outcome,
                "music_detected": scan.music if scan else "",
                "speech_share": ""
                if scan is None or scan.speech_share is None
                else f"{scan.speech_share:.2f}",
                "duration_seconds": f"{scan.duration:.0f}" if scan else "",
                "tracks": describe_tracks(scan),
                "_scan": scan,
            }
        )
    return rows


def _commercial_table(rows, title):
    lines = [f"**{title}**", ""]
    lines.append("| Nhóm | Số video | Nhận đúng bài | Nhận ra bài khác | Chưa đối chiếu tên | Giữ lại | Lọt | Lỗi |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for name, subset in rows:
        counts = Counter(row["outcome"] for row in subset)
        lines.append(
            f"| {name} | {len(subset)} | {counts[CAUGHT_RIGHT]} | {counts[CAUGHT_OTHER]} "
            f"| {counts[CAUGHT_UNVERIFIED]} | {counts[HELD]} | {counts[ESCAPED]} | {counts[ERROR]} |"
        )
    lines.append("")
    return lines


def _detected(rows):
    return sum(row["outcome"] in (CAUGHT_RIGHT, CAUGHT_OTHER, CAUGHT_UNVERIFIED) for row in rows)


def render_report(rows):
    """Viết báo cáo tiếng Việt dạng Markdown."""
    scanned = [row for row in rows if row["decision"] != ERROR]
    commercial = [row for row in rows if row.get("group") in ("strike", "commercial")]
    valid = [row for row in commercial if row["outcome"] != ERROR]

    out = ["# Kết quả đo thử nhận diện nhạc", ""]
    out += [
        f"Đã có kết quả {len(scanned)}/{len(rows)} video. "
        "Mỗi tỷ lệ có khoảng tin cậy 95%: mẫu càng nhỏ, khoảng càng rộng.",
        "",
    ]

    out += ["## 1. Video chắc chắn có nhạc thương mại", ""]
    if valid:
        escaped = sum(row["outcome"] == ESCAPED for row in valid)
        right = sum(row["outcome"] == CAUGHT_RIGHT for row in valid)
        out += [
            f"- **Nhận ra có bài nhạc:** {format_rate(_detected(valid), len(valid))}",
            f"- **Nhận đúng bài đội đã ghi:** {format_rate(right, len(valid))}",
            f"- **Lọt (máy kết luận không có nhạc):** {format_rate(escaped, len(valid))}",
            "",
        ]
        groups = [
            (label, [row for row in commercial if row["group"] == key])
            for key, label in (("strike", "Bài gây strike"), ("commercial", "Nhạc thương mại khác"))
        ]
        out += _commercial_table(groups, "Theo nhóm")
        origins = [
            (label, [row for row in commercial if row.get("music_origin") == key])
            for key, label in (("vn", "Nhạc Việt"), ("foreign", "Nhạc nước ngoài"))
        ]
        out += _commercial_table(origins, "Theo nguồn nhạc")
        speech = [
            (label, [row for row in commercial if row.get("has_speech") == key])
            for key, label in (("yes", "Có lời nói"), ("no", "Không có lời nói"))
        ]
        out += _commercial_table(speech, "Theo lời nói")
    else:
        out += ["Chưa có dữ liệu.", ""]

    out += ["## 2. Video không có nhạc hoặc nhạc có giấy phép", ""]
    no_music = [r for r in rows if r.get("group") == "no_music" and r["decision"] != ERROR]
    licensed = [r for r in rows if r.get("group") == "licensed" and r["decision"] != ERROR]
    out += [
        f"- **Không có nhạc, báo nhầm có bài:** {format_rate(sum(r['decision'] == BLOCK for r in no_music), len(no_music))}",
        f"- **Không có nhạc, bị giữ lại nhầm:** {format_rate(sum(r['decision'] == HOLD for r in no_music), len(no_music))}",
        f"- **Có giấy phép, nhận đúng bài:** {format_rate(sum(r['decision'] == PASS_LICENSED for r in licensed), len(licensed))}",
        f"- **Có giấy phép, báo ra bài khác:** {format_rate(sum(r['decision'] == BLOCK for r in licensed), len(licensed))}",
        "",
    ]

    out += ["## 3. Mẫu ngẫu nhiên từ các kênh", ""]
    sample = [r for r in rows if r.get("group") == "random" and r["decision"] != ERROR]
    if sample:
        scans = [r["_scan"] for r in sample]
        has_share = [s for s in scans if s.speech_share is not None]
        spoken = [s for s in has_share if s.speech_share >= SPEECH_SHARE_THRESHOLD]
        detecting = [s for s in scans if s.detects_music]
        if detecting:
            out.append(f"- **Có nhạc:** {format_rate(sum(s.music == 'yes' for s in detecting), len(detecting))}")
        out.append(f"- **Nhận ra được bài cụ thể:** {format_rate(sum(bool(s.tracks) for s in scans), len(scans))}")
        if len(detecting) < len(scans):
            unknown = sum(not s.detects_music and not s.tracks for s in scans)
            out.append(f"- **Không nhận ra bài, chưa biết có nhạc hay không (AudD):** {format_rate(unknown, len(scans))}")
        if has_share:
            out.append(
                f"- **Có lời nói (từ {SPEECH_SHARE_THRESHOLD:.0%} thời lượng trở lên):** {format_rate(len(spoken), len(has_share))}"
            )
        out += [f"- **Tổng thời lượng đã quét:** {sum(s.duration for s in scans) / 3600:.1f} giờ", ""]
        out += _cross_tab(sample)
        out += _top_list("Bài xuất hiện nhiều nhất", Counter(t["title"] for s in scans for t in s.tracks))
        out += _top_list(
            "Hãng xuất hiện nhiều nhất",
            Counter(t["label"] for s in scans for t in s.tracks if t["label"]),
        )
    else:
        out += ["Chưa có dữ liệu.", ""]

    out += ["## 4. Video cần người nghe kiểm tra", ""]
    review = [row for row in commercial if row["outcome"] in (ESCAPED, CAUGHT_OTHER)]
    review += [r for r in no_music + licensed if r["decision"] == BLOCK]
    if review:
        out += [
            f"- {row['source']} ({row.get('group')}): ghi `{row.get('expected_title') or 'không có'}`, "
            f"máy thấy `{row['tracks'] or 'không có bài nào'}`"
            for row in review
        ]
        out.append("")
    else:
        out += ["Không có.", ""]

    errors = [row for row in rows if row["decision"] == ERROR]
    if errors:
        out += ["## 5. Video chưa có kết quả hoặc bị lỗi", ""]
        out += [f"- {row['source']}" for row in errors]
        out.append("")

    if any(not row["_scan"].detects_music for row in rows if row.get("_scan")):
        out += [
            "> **Lưu ý về AudD:** AudD chỉ báo đoạn nào khớp bài nào, không báo có nhạc hay không. "
            "Mọi video không khớp bài đều bị giữ lại để người nghe, kể cả video thật sự không có nhạc. "
            "Vì vậy dòng \"Không có nhạc, bị giữ lại nhầm\" sẽ cao, và không video nào tự được cho qua là \"sạch\".",
            "",
        ]

    out += [
        "## Giới hạn của bài đo",
        "",
        "- Chỉ đo trên những bài đội đã biết, không phát hiện được bài chưa ai biết là có vấn đề.",
        "- Không có bài khớp không có nghĩa là an toàn; kết quả quét không thay thế giấy phép.",
        "- Mẫu có nhãn do đội tự chọn nên không đại diện cho toàn kênh; chỉ phần 3 là mẫu ngẫu nhiên.",
        "",
    ]
    return "\n".join(out)


def _cross_tab(sample):
    filled = [r for r in sample if r.get("has_source_file") and r["_scan"].speech_share is not None]
    if not filled:
        return []
    def count(spoken, has_file):
        return sum(
            (r["_scan"].speech_share >= SPEECH_SHARE_THRESHOLD) == spoken
            and r.get("has_source_file") == has_file
            for r in filled
        )
    return [
        "| | Còn file gốc | Mất file gốc |",
        "|---|---:|---:|",
        f"| Có lời nói | {count(True, 'yes')} | {count(True, 'no')} |",
        f"| Không có lời nói | {count(False, 'yes')} | {count(False, 'no')} |",
        "",
    ]


def _top_list(title, counter, limit=10):
    if not counter:
        return []
    lines = [f"**{title}**", ""]
    lines += [f"- {name}: {count} video" for name, count in counter.most_common(limit)]
    lines.append("")
    return lines
