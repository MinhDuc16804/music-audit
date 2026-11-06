import unittest

from music_audit.common import normalize_yes_no, validate_testset
from music_audit.evaluate import (
    BLOCK,
    CAUGHT_OTHER,
    CAUGHT_RIGHT,
    CAUGHT_UNVERIFIED,
    ERROR,
    ESCAPED,
    HELD,
    HOLD,
    PASS_LICENSED,
    PASS_NO_MUSIC,
    artists_match,
    build_rows,
    commercial_outcome,
    gate_decision,
    parse_scan,
    render_report,
    titles_match,
    wilson_interval,
)
from music_audit.youtube import channel_filter, parse_duration


def raw(state=1, music=None, segments=None, detected=None, duration=100):
    items = [
        {
            "played_duration": played,
            "result": {"title": title, "artists": [{"name": "Ca si"}], "label": "Hang", "score": 90},
        }
        for title, played in (music or [])
    ]
    return {
        "state": state,
        "duration": duration,
        "music_detected": detected,
        "results": {"music": items, "music_speech": segments or []},
    }


def track_item(title, artists, played=30):
    return {
        "played_duration": played,
        "result": {"title": title, "artists": [{"name": name} for name in artists], "score": 90},
    }


def raw_tracks(*items):
    return {"state": 1, "duration": 100, "results": {"music": list(items)}}


class TitleTests(unittest.TestCase):
    def test_vietnamese_title_ignores_marks_and_brackets(self):
        self.assertTrue(titles_match("Hãy Trao Cho Anh", "HAY TRAO CHO ANH (feat. Snoop Dogg)"))

    def test_d_with_stroke(self):
        self.assertTrue(titles_match("Đừng làm trái tim anh đau", "Dung Lam Trai Tim Anh Dau"))

    def test_different_titles(self):
        self.assertFalse(titles_match("Lạc Trôi", "Nơi Này Có Anh"))

    def test_empty_never_matches(self):
        self.assertFalse(titles_match("", ""))
        self.assertFalse(titles_match("Lạc Trôi", ""))

    def test_partial_title_does_not_match(self):
        self.assertFalse(titles_match("Love", "Love Story"))
        self.assertFalse(titles_match("Love Story", "Love"))


class ArtistTests(unittest.TestCase):
    def test_ignores_marks_and_case(self):
        self.assertTrue(artists_match("Sơn Tùng M-TP", ["SON TUNG M-TP"]))

    def test_any_listed_artist_is_enough(self):
        self.assertTrue(artists_match("Ca si A & Ca si B", ["Ca si B", "Ca si C"]))

    def test_different_or_empty_artist_does_not_match(self):
        self.assertFalse(artists_match("Ca si A", ["Ca si B"]))
        self.assertFalse(artists_match("", ["Ca si B"]))
        self.assertFalse(artists_match("Ca si A", []))


class ParseTests(unittest.TestCase):
    def test_speech_share_counts_speech_and_mixed(self):
        scan = parse_scan(
            raw(
                segments=[
                    {"start": 0, "end": 50, "label": "m"},
                    {"start": 50, "end": 80, "label": "ms"},
                    {"start": 80, "end": 100, "label": "s"},
                ]
            )
        )
        self.assertAlmostEqual(scan.speech_share, 0.5)
        self.assertEqual(scan.music, "yes")

    def test_speech_only_means_no_music(self):
        scan = parse_scan(raw(segments=[{"start": 0, "end": 100, "label": "s"}]))
        self.assertEqual(scan.music, "no")

    def test_speech_and_other_labels_mean_no_music(self):
        segments = [{"start": 0, "end": 50, "label": "s"}, {"start": 50, "end": 100, "label": "o"}]
        self.assertEqual(parse_scan(raw(segments=segments, detected=2)).music, "no")

    def test_unknown_or_missing_label_is_not_no_music(self):
        for segment in ({"start": 0, "end": 100, "label": "music"}, {"start": 0, "end": 100}):
            self.assertEqual(parse_scan(raw(segments=[segment])).music, "unknown")

    def test_music_flag_wins_over_speech_segments(self):
        scan = parse_scan(raw(segments=[{"start": 0, "end": 100, "label": "s"}], detected=1))
        self.assertEqual(scan.music, "yes")

    def test_speech_segments_with_unclear_flag_is_unknown(self):
        scan = parse_scan(raw(segments=[{"start": 0, "end": 100, "label": "s"}], detected=0))
        self.assertEqual(scan.music, "unknown")

    def test_zero_length_segments_prove_nothing(self):
        scan = parse_scan(raw(segments=[{"start": 5, "end": 5, "label": "s"}]))
        self.assertEqual(scan.music, "unknown")

    def test_same_title_by_different_artists_is_not_merged(self):
        scan = parse_scan(raw_tracks(track_item("Hello", ["Ca si A"]), track_item("Hello", ["Ca si B"])))
        self.assertEqual(len(scan.tracks), 2)

    def test_music_flag_used_when_no_segments(self):
        self.assertEqual(parse_scan(raw(detected=1)).music, "yes")
        self.assertEqual(parse_scan(raw(detected=2)).music, "no")
        self.assertEqual(parse_scan(raw(detected=0)).music, "unknown")

    def test_same_track_is_merged(self):
        scan = parse_scan(raw(music=[("Bai A", 30), ("BAI A (Remix)", 20), ("Bai B", 10)]))
        self.assertEqual(len(scan.tracks), 2)
        self.assertEqual(scan.tracks[0]["played_duration"], 50)

    def test_missing_results_is_safe(self):
        scan = parse_scan({"state": -1})
        self.assertEqual(scan.tracks, [])
        self.assertEqual(scan.music, "unknown")


class GateTests(unittest.TestCase):
    def test_no_match_with_music_is_held(self):
        scan = parse_scan(raw(state=-1, detected=1))
        self.assertEqual(gate_decision(scan, {"group": "commercial"}), HOLD)

    def test_unknown_music_is_held_not_passed(self):
        scan = parse_scan(raw(state=-1, detected=0))
        self.assertEqual(gate_decision(scan, {"group": "random"}), HOLD)

    def test_no_music_passes(self):
        scan = parse_scan(raw(state=-1, detected=2))
        self.assertEqual(gate_decision(scan, {"group": "no_music"}), PASS_NO_MUSIC)

    def test_unknown_segment_label_is_held_not_passed(self):
        scan = parse_scan(raw(segments=[{"start": 0, "end": 100, "label": "music"}]))
        self.assertEqual(gate_decision(scan, {"group": "random"}), HOLD)

    def test_music_flag_with_speech_segments_is_held_not_passed(self):
        scan = parse_scan(raw(state=-1, segments=[{"start": 0, "end": 100, "label": "s"}], detected=1))
        self.assertEqual(gate_decision(scan, {"group": "random"}), HOLD)

    def test_licensed_track_passes_but_other_track_blocks(self):
        scan = parse_scan(raw(music=[("Bai Phep", 30)]))
        licensed = {"group": "licensed", "expected_artist": "Ca si"}
        self.assertEqual(gate_decision(scan, {**licensed, "expected_title": "Bai Phep"}), PASS_LICENSED)
        self.assertEqual(gate_decision(scan, {**licensed, "expected_title": "Bai Khac"}), BLOCK)

    def test_licensed_video_with_extra_track_is_blocked(self):
        scan = parse_scan(raw_tracks(track_item("Bai Phep", ["Ca si"]), track_item("Bai Thuong Mai", ["Ca si X"])))
        row = {"group": "licensed", "expected_title": "Bai Phep", "expected_artist": "Ca si"}
        self.assertEqual(gate_decision(scan, row), BLOCK)

    def test_licensed_title_with_other_artist_is_blocked(self):
        scan = parse_scan(raw_tracks(track_item("Hello", ["Ca si X"])))
        row = {"group": "licensed", "expected_title": "Hello", "expected_artist": "Ca si"}
        self.assertEqual(gate_decision(scan, row), BLOCK)

    def test_licensed_partial_title_is_blocked(self):
        scan = parse_scan(raw_tracks(track_item("Love Story", ["Ca si"])))
        row = {"group": "licensed", "expected_title": "Love", "expected_artist": "Ca si"}
        self.assertEqual(gate_decision(scan, row), BLOCK)

    def test_licensed_without_artist_is_blocked(self):
        scan = parse_scan(raw_tracks(track_item("Bai Phep", ["Ca si"])))
        self.assertEqual(gate_decision(scan, {"group": "licensed", "expected_title": "Bai Phep"}), BLOCK)

    def test_processing_and_failed_scans_are_errors(self):
        for state in (0, -2, -3):
            self.assertEqual(gate_decision(parse_scan(raw(state=state)), {}), ERROR)
        self.assertEqual(gate_decision(None, {}), ERROR)


class OutcomeTests(unittest.TestCase):
    def outcome(self, scan_raw, expected="Bai A"):
        return commercial_outcome(parse_scan(scan_raw), {"group": "commercial", "expected_title": expected})

    def test_outcomes(self):
        self.assertEqual(self.outcome(raw(music=[("Bai A", 30)])), CAUGHT_RIGHT)
        self.assertEqual(self.outcome(raw(music=[("Bai B", 30)])), CAUGHT_OTHER)
        self.assertEqual(self.outcome(raw(music=[("Bai B", 30)]), expected=""), CAUGHT_UNVERIFIED)
        self.assertEqual(self.outcome(raw(state=-1, detected=1)), HELD)
        self.assertEqual(self.outcome(raw(state=-1, detected=2)), ESCAPED)


class StatsTests(unittest.TestCase):
    def test_wilson_known_value(self):
        low, high = wilson_interval(50, 100)
        self.assertAlmostEqual(low, 0.404, places=2)
        self.assertAlmostEqual(high, 0.596, places=2)

    def test_wilson_stays_in_bounds(self):
        self.assertEqual(wilson_interval(0, 0), (0.0, 0.0))
        self.assertEqual(wilson_interval(0, 10)[0], 0.0)
        self.assertLessEqual(wilson_interval(10, 10)[1], 1.0)


class ReportTests(unittest.TestCase):
    def test_report_counts_each_group(self):
        testset = [
            {"source": "a", "group": "strike", "music_origin": "vn", "has_speech": "no", "expected_title": "Bai A"},
            {"source": "b", "group": "commercial", "music_origin": "foreign", "has_speech": "yes", "expected_title": "Bai B"},
            {"source": "c", "group": "commercial", "music_origin": "vn", "has_speech": "yes", "expected_title": "Bai C"},
            {"source": "d", "group": "no_music", "expected_title": ""},
            {"source": "e", "group": "random", "has_source_file": "no"},
            {"source": "f", "group": "commercial", "expected_title": "Bai F"},
        ]
        scans = {
            "a": parse_scan(raw(music=[("Bai A", 60)])),
            "b": parse_scan(raw(state=-1, detected=1)),
            "c": parse_scan(raw(state=-1, detected=2)),
            "d": parse_scan(raw(state=-1, segments=[{"start": 0, "end": 100, "label": "s"}])),
            "e": parse_scan(raw(music=[("Bai Moi", 40)], segments=[{"start": 0, "end": 100, "label": "ms"}])),
        }
        report = render_report(build_rows(testset, scans))
        self.assertIn("Đã có kết quả 5/6", report)
        self.assertIn("**Nhận ra có bài nhạc:** 1/3", report)
        self.assertIn("**Lọt (máy kết luận không có nhạc):** 1/3", report)
        self.assertIn("Bai Moi: 1 video", report)
        self.assertIn("Video chưa có kết quả", report)

    def test_report_with_nothing_scanned(self):
        report = render_report(build_rows([{"source": "a", "group": "commercial"}], {}))
        self.assertIn("Đã có kết quả 0/1", report)


class ValidationTests(unittest.TestCase):
    def test_example_rows_are_rejected(self):
        rows = [{"source": "https://www.youtube.com/watch?v=VIDEO_ID_1", "group": "strike"}]
        self.assertIn("dòng ví dụ", validate_testset(rows)[0])

    def test_bad_group_duplicate_and_missing_file(self):
        rows = [
            {"source": "https://youtu.be/abc", "group": "sai"},
            {"source": "https://youtu.be/abc", "group": "strike"},
            {"source": "/khong/co/file.mp3", "group": "strike"},
            {"source": "https://example.com/video", "group": "strike"},
        ]
        text = " ".join(validate_testset(rows))
        for part in ("group phải", "trùng", "không tìm thấy", "chỉ nhận link YouTube"):
            self.assertIn(part, text)

    def test_licensed_row_needs_title_and_artist(self):
        for extra in ({"expected_title": "Bai"}, {"expected_artist": "Ca si"}, {}):
            row = {"source": "https://youtu.be/abc", "group": "licensed", **extra}
            self.assertIn("nhóm licensed", " ".join(validate_testset([row])))
        full = {"expected_title": "Bai", "expected_artist": "Ca si"}
        self.assertEqual(validate_testset([{"source": "https://youtu.be/abc", "group": "licensed", **full}]), [])

    def test_valid_row(self):
        self.assertEqual(validate_testset([{"source": "https://youtu.be/abc", "group": "random"}]), [])

    def test_yes_no(self):
        self.assertEqual(normalize_yes_no("Có"), "yes")
        self.assertEqual(normalize_yes_no("KHÔNG"), "no")
        self.assertEqual(normalize_yes_no("?"), "")


class YoutubeHelpersTests(unittest.TestCase):
    def test_duration(self):
        self.assertEqual(parse_duration("PT1H2M3S"), 3723)
        self.assertEqual(parse_duration("PT45S"), 45)
        self.assertEqual(parse_duration("P1DT1S"), 86401)
        self.assertEqual(parse_duration("P0D"), 0)

    def test_channel_filter(self):
        self.assertEqual(channel_filter("https://www.youtube.com/@kenh/"), {"forHandle": "@kenh"})
        self.assertEqual(channel_filter("UC" + "a" * 22), {"id": "UC" + "a" * 22})


if __name__ == "__main__":
    unittest.main()
