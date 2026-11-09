"""Kiểm thử bước gom theo bài và chia 3 file, không cần mạng."""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from music_audit.evaluate import Scan, build_rows
from music_audit.grouping import (
    CAN_NGHE_LAI,
    CO_NHAC,
    SACH,
    group_songs,
    library_status,
    load_library_list,
    scan_report,
    song_key,
    report_columns,
)


def track(title, artist, seconds=12, score=90, label=""):
    return {"title": title, "artists": artist, "label": label, "score": score, "played_duration": seconds}


def rows_for(scans):
    testset = [{"source": source, "group": "random", "channel": "Kênh"} for source in scans]
    return build_rows(testset, {s: scan for s, scan in scans.items() if scan is not None})


class SongKeyTests(unittest.TestCase):
    def test_same_song_with_different_marks_has_one_key(self):
        self.assertEqual(song_key("Bài Ca (Official MV)", "Ca Sĩ"), song_key("bai ca", "CA SI"))
        self.assertNotEqual(song_key("Bài ca", "Ca sĩ A"), song_key("Bài ca", "Ca sĩ B"))


class GroupSongsTests(unittest.TestCase):
    def test_songs_are_deduplicated_and_sorted_by_video_count(self):
        rows = rows_for({
            "v1": Scan(state=1, tracks=[track("Bài A", "X", 20), track("Bài B", "Y")], music="yes"),
            "v2": Scan(state=1, tracks=[track("Bài A (Official)", "X", 10, score=100, label="Hãng")], music="yes"),
            "v3": Scan(state=1, music="no"),
        })
        songs = group_songs(rows)
        self.assertEqual([s["title"] for s in songs], ["Bài A", "Bài B"])
        first = songs[0]
        self.assertEqual(first["video_count"], 2)
        self.assertEqual(first["seconds"], "30")
        self.assertEqual(first["best_score"], 100)
        self.assertEqual(first["label"], "Hãng")
        self.assertEqual(first["videos"], "v1 | v2")
        self.assertEqual(first["library"], "chua-tra")

    def test_library_cache_status_is_used(self):
        rows = rows_for({"v1": Scan(state=1, tracks=[track("Bài A", "X")], music="yes")})
        cache = {song_key("Bài A", "X"): {"status": "khop-chac"}}
        self.assertEqual(group_songs(rows, cache)[0]["library"], "khop-chac")

    def test_unknown_cache_status_is_treated_as_unchecked(self):
        rows = rows_for({"v1": Scan(state=1, tracks=[track("Bài A", "X")], music="yes")})
        cache = {song_key("Bài A", "X"): {"status": "chac-la-co"}}
        self.assertEqual(group_songs(rows, cache)[0]["library"], "chua-tra")


class LibraryListTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        path = Path(self.folder.name) / "audio_library.csv"
        rows = ("title,artist", "National Sweetheart,No One Here Gets In Alive", "Bài A,X")
        path.write_text(chr(10).join(rows), encoding="utf-8-sig")
        self.library = load_library_list(path)

    def tearDown(self):
        self.folder.cleanup()

    def test_match_ignores_title_artist_order(self):
        key = song_key("No One Here Gets In Alive (Remastered)", "National Sweetheart")
        self.assertEqual(library_status(key, {}, self.library), "khop-chac")

    def test_not_in_list_is_still_unchecked(self):
        self.assertEqual(library_status(song_key("Bài B", "Y"), {}, self.library), "chua-tra")

    def test_same_title_different_artist_is_not_a_match(self):
        self.assertEqual(library_status(song_key("Bài A", "Z"), {}, self.library), "chua-tra")

    def test_studio_result_wins_over_list(self):
        key = song_key("Bài A", "X")
        self.assertEqual(library_status(key, {key: {"status": "khong-thay"}}, self.library), "khong-thay")

    def test_studio_cache_found_with_swapped_order(self):
        cache = {song_key("Tên", "Nghệ sĩ"): {"status": "khop-chac"}}
        self.assertEqual(library_status(song_key("Nghệ sĩ", "Tên"), cache), "khop-chac")

    def test_missing_file_gives_empty_list(self):
        self.assertEqual(load_library_list(Path(self.folder.name) / "khong-co.csv"), set())


class ScanReportTests(unittest.TestCase):
    def setUp(self):
        self.rows = rows_for({
            "co-bai": Scan(state=1, tracks=[track("Bài A", "X")], music="yes"),
            "khong-nhac": Scan(state=1, music="no"),
            "nhac-la": Scan(state=1, music="yes"),
            "audd-rong": Scan(state=1, music="unknown", detects_music=False),
            "loi": Scan(state=-2),
            "chua-quet": None,
        })

    def groups(self, **kwargs):
        return {line["Mã video"]: line for line in scan_report(self.rows, **kwargs)}

    def test_each_video_is_one_line_in_one_group(self):
        lines = self.groups()
        self.assertEqual(sorted(lines), sorted(row["source"] for row in self.rows), "kể cả video chưa quét")
        self.assertEqual({k: v["Nhóm"] for k, v in lines.items()}, {
            "co-bai": CO_NHAC, "khong-nhac": SACH, "nhac-la": CAN_NGHE_LAI,
            "audd-rong": CAN_NGHE_LAI, "loi": CAN_NGHE_LAI, "chua-quet": CAN_NGHE_LAI,
        })

    def test_each_song_has_its_own_cells(self):
        a = {**track("Bài A", "X", label="Hãng"), "offsets": ["00:12", "00:36"]}
        b = {**track("Bài B", "Y"), "offsets": ["00:00"]}
        url = "https://www.youtube.com/watch?v=abc123"
        report = scan_report(rows_for({url: Scan(state=1, tracks=[a, b], music="yes")}),
                             library_cache={song_key("Bài A", "X"): {"status": "khop-chac"}},
                             policies={url: "Chặn ở mọi nơi"})
        self.assertEqual(len(report), 1)
        line = report[0]
        self.assertEqual((line["Bài 1"], line["Tác giả 1"], line["Hãng 1"], line["Library 1"], line["Vị trí 1"]),
                         ("Bài A", "X", "Hãng", "khop-chac", "00:12 → 00:36"))
        self.assertEqual((line["Bài 2"], line["Tác giả 2"], line["Library 2"], line["Vị trí 2"]),
                         ("Bài B", "Y", "chua-tra", "00:00"))
        self.assertEqual(line["Policy"], "Chặn ở mọi nơi")
        self.assertEqual(report_columns(report)[-5:], ["Bài 2", "Tác giả 2", "Hãng 2", "Library 2", "Vị trí 2"])

    def test_library_match_does_not_make_video_clean(self):
        cache = {song_key("Bài A", "X"): {"status": "khop-chac"}}
        self.assertEqual(self.groups(library_cache=cache)["co-bai"]["Nhóm"], CO_NHAC)

    def test_detection_and_scan_info_are_merged(self):
        lines = self.groups(
            videos_by_url={"co-bai": {"title": "Máy cắt", "duration_seconds": "88"}},
            detections={"co-bai": {"group": "co-nhac", "music_seconds": "76.5", "longest_run": "70.0", "peak_at": "00:14"}},
            scan_info={"co-bai": {"scanned_at": "2026-11-06T09:30:12+00:00", "scanned_from": "file"}},
        )
        line = lines["co-bai"]
        self.assertEqual((line["Tiêu đề video"], line["Thời lượng (giây)"]), ("Máy cắt", "88"))
        self.assertEqual((line["Máy lọc"], line["Giây có nhạc (máy lọc)"]), ("co-nhac", "76.5"))
        self.assertEqual((line["Đoạn nhạc liền dài nhất (giây)"], line["Giây cần nghe"]), ("70.0", "00:14"))
        expected = datetime(2026, 11, 6, 9, 30, tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
        self.assertEqual((line["Lúc quét"], line["Quét từ"]), (expected, "file"))

    def test_reasons_explain_why_video_needs_listening(self):
        lines = self.groups()
        self.assertIn("không nhận ra bài", lines["nhac-la"]["Lý do"])
        self.assertIn("chưa biết", lines["audd-rong"]["Lý do"])
        self.assertIn("quét lại", lines["chua-quet"]["Lý do"])


if __name__ == "__main__":
    unittest.main()
