"""Kiểm thử máy lọc có nhạc hay không. Không cần mô hình: dùng điểm nhạc giả hoặc file cache đã chấm sẵn."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from music_audit.detect import CO_NHAC, HOP_SECONDS, KHONG_NHAC, classify_frames, clip_starts, mmss
from music_audit.evaluate import Scan, build_rows
from music_audit.grouping import CAN_NGHE_LAI, classify, scan_report

ROOT = Path(__file__).resolve().parent.parent


def windows(seconds):
    return int(round(seconds / HOP_SECONDS))


class ClassifyFramesTests(unittest.TestCase):
    def test_speech_and_machine_only_is_no_music(self):
        scores = [0.0] * 100 + [0.08, 0.1] + [0.0] * 50
        self.assertEqual(classify_frames(scores).group, KHONG_NHAC)

    def test_loud_music_is_music(self):
        result = classify_frames([0.95] * windows(60))
        self.assertEqual(result.group, CO_NHAC)
        self.assertGreater(result.music_seconds, 43, "60 giây trừ 8 giây intro và 8 giây outro")
        self.assertGreater(result.longest_run, 43)
        self.assertEqual(result.max_score, 0.95)

    def test_quiet_background_music_is_music(self):
        # Nhạc nền nhỏ dưới tiếng nói: điểm thấp nhưng kéo dài.
        scores = [0.0] * 40 + [0.2] * windows(3) + [0.0] * 40
        self.assertEqual(classify_frames(scores).group, CO_NHAC)

    def test_channel_outro_is_not_music(self):
        # PQN5DqtaOH0: chỉ có khoảng 4 giây outro của kênh ở cuối video.
        result = classify_frames([0.0] * 190 + [0.9] * 8 + [0.0] * 2)
        self.assertEqual(result.group, KHONG_NHAC)
        self.assertEqual(result.edge_seconds, 8 * HOP_SECONDS, "nhạc outro vẫn được ghi lại để xem")

    def test_channel_intro_is_not_music(self):
        self.assertEqual(classify_frames([0.9] * windows(6) + [0.0] * 150).group, KHONG_NHAC)

    def test_music_running_past_the_intro_is_music(self):
        # Nhạc bắt đầu từ intro rồi chạy tiếp vào thân video vẫn là có nhạc.
        self.assertEqual(classify_frames([0.9] * windows(12) + [0.0] * 150).group, CO_NHAC)

    def test_intro_and_outro_can_be_counted_again(self):
        scores = [0.0] * 190 + [0.9] * 8 + [0.0] * 2
        self.assertEqual(classify_frames(scores, outro=0).group, CO_NHAC)

    def test_music_with_short_dropouts_is_one_run(self):
        # Nhạc nhỏ chập chờn dưới tiếng nói: hụt nửa giây vẫn là một đoạn liền.
        scores = [0.0] * 20 + [0.2, 0.1] * 3 + [0.2] + [0.0] * 20
        self.assertEqual(classify_frames(scores).longest_run, 7 * HOP_SECONDS)
        self.assertEqual(classify_frames(scores).group, CO_NHAC)

    def test_scattered_machine_blips_are_not_music(self):
        # gadTFpBHFHA: tiếng máy cắt, vài khoảnh khắc lẻ tẻ (kể cả một lần 0,59), không đoạn nào liền.
        scores = [0.0] * 150
        for index, score in ((57, 0.2), (67, 0.41), (68, 0.26), (78, 0.2), (111, 0.59), (134, 0.26), (143, 0.33)):
            scores[index] = score
        self.assertEqual(classify_frames(scores).group, KHONG_NHAC)

    def test_many_scattered_hits_add_up_to_music(self):
        scores = ([0.3] + [0.0] * 3) * windows(10)
        self.assertEqual(classify_frames(scores).group, CO_NHAC)

    def test_unreadable_audio_is_never_no_music(self):
        self.assertEqual(classify_frames([]).group, CO_NHAC)

    def test_peak_position(self):
        scores = [0.0] * windows(65) + [0.9] + [0.0] * 30
        self.assertEqual(mmss(classify_frames(scores).peak_at), "01:05")


class ClipStartsTests(unittest.TestCase):
    def test_music_throughout_gets_a_clip_every_45_seconds(self):
        starts = clip_starts([0.9] * windows(200))
        self.assertEqual(len(starts), 4)
        for earlier, later in zip(starts, starts[1:]):
            self.assertAlmostEqual(later - earlier, 45, delta=0.5)

    def test_only_cells_with_music_are_kept(self):
        scores = [0.0] * windows(70) + [0.9] * windows(30) + [0.0] * windows(100)
        starts = clip_starts(scores)
        self.assertEqual(len(starts), 1)
        self.assertAlmostEqual(starts[0], 97.5, delta=0.5)

    def test_clips_stay_out_of_intro_and_outro(self):
        starts = clip_starts([0.9] * windows(60))
        self.assertGreaterEqual(starts[0], 7.5)
        self.assertLessEqual(starts[-1] + 11.9, 52.5)

    def test_music_between_cells_falls_back_to_strongest_part(self):
        scores = [0.0] * windows(20) + [0.9] * windows(10) + [0.0] * windows(70)
        starts = clip_starts(scores)
        self.assertEqual(len(starts), 1)
        self.assertLess(starts[0], 30)
        self.assertGreater(starts[0] + 11.9, 20)

    def test_max_clips_keeps_first_and_last(self):
        everything = clip_starts([0.9] * windows(1800))
        limited = clip_starts([0.9] * windows(1800), max_clips=5)
        self.assertEqual(len(limited), 5)
        self.assertEqual((limited[0], limited[-1]), (everything[0], everything[-1]))

    def test_very_short_video_gets_one_clip(self):
        self.assertEqual(len(clip_starts([0.9] * windows(20))), 1)

    def test_no_audio_no_clip(self):
        self.assertEqual(clip_starts([]), [])


class DetectionInGroupingTests(unittest.TestCase):
    def rows(self, scan):
        return build_rows([{"source": "v", "group": "random"}], {"v": scan} if scan else {})

    def test_no_music_detection_never_makes_video_clean(self):
        for scan in (None, Scan(state=1, music="unknown", detects_music=False)):
            group, reason = classify(self.rows(scan)[0], KHONG_NHAC)
            self.assertEqual(group, CAN_NGHE_LAI)
            self.assertIn("máy lọc: không nhạc", reason)

    def test_music_detection_marks_unmatched_as_music(self):
        row = self.rows(Scan(state=1, music="unknown", detects_music=False))[0]
        self.assertEqual(classify(row, CO_NHAC), (CAN_NGHE_LAI, "có nhạc nhưng không nhận ra bài"))

    def test_detect_column_is_written(self):
        line = scan_report(self.rows(None), detections={"v": {"group": KHONG_NHAC, "peak_at": "00:41"}})[0]
        self.assertEqual((line["Nhóm"], line["Máy lọc"], line["Giây cần nghe"]), (CAN_NGHE_LAI, KHONG_NHAC, "00:41"))


class DetectCommandTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.workdir = Path(self.folder.name)
        audio = self.workdir / "data/audio"
        audio.mkdir(parents=True)
        cache = self.workdir / "out/detect"
        cache.mkdir(parents=True)
        rows = ["source,group,music_origin,has_music"]
        # Điểm đã chấm sẵn trong cache, nên lệnh chạy mà không cần mô hình hay ffmpeg.
        # Nhãn ghi bằng has_music, hoặc music_origin cho testset cũ.
        for video_id, labels, scores in (
            ("nhaclon0000", "vn,", [0.95] * 100),
            ("nhacnho0000", ",yes", [0.0] * 50 + [0.25] * 8 + [0.0] * 50),
            ("review00000", "none,", [0.0] * 150),
            ("tiengmay000", ",no", [0.02, 0.1] * 60),
            ("khongnhan00", ",", [0.0] * 40),
        ):
            (audio / f"{video_id}.m4a").write_bytes(b"fake audio")
            (cache / f"{video_id}.json").write_text(
                json.dumps({"size": 10, "duration": len(scores) * HOP_SECONDS, "music": scores, "top_sound": "Speech"}),
                encoding="utf-8")
            rows.append(f"https://youtu.be/{video_id},random,{labels}")
        rows.append("https://youtu.be/chuatai0000,random,,yes")
        (self.workdir / "data/testset.csv").write_text("\n".join(rows), encoding="utf-8")

    def tearDown(self):
        self.folder.cleanup()

    def run_cli(self, *args, check=True):
        env = {**os.environ, "PYTHONPATH": str(ROOT), "MUSIC_AUDIT_MODELS": str(self.workdir / "khong-co-mo-hinh")}
        result = subprocess.run(
            [sys.executable, str(ROOT / "audit.py"), "--workdir", str(self.workdir), *args],
            env=env, capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_detect_music_from_cache_and_compare_with_labels(self):
        result = self.run_cli("detect-music")
        self.assertIn("Có nhạc: 2  Không nhạc: 3  Chưa tải âm thanh: 1", result.stdout)
        self.assertIn("bỏ sót 0, báo dư 0", result.stdout)
        detections = json.loads((self.workdir / "out/music_detect.json").read_text(encoding="utf-8"))
        self.assertEqual(detections["https://youtu.be/nhacnho0000"]["group"], CO_NHAC)
        self.assertEqual(detections["https://youtu.be/review00000"]["group"], KHONG_NHAC)
        self.assertNotIn("https://youtu.be/chuatai0000", detections, "chưa tải thì không được có kết luận")

    def test_labels_survive_duplicate_in_random_sample(self):
        # Video vừa có nhãn trong testset vừa nằm trong mẫu ngẫu nhiên: nhãn không được mất.
        (self.workdir / "data/random_sample.csv").write_text(
            "source,group\nhttps://youtu.be/review00000,random\nhttps://youtu.be/moi,random", encoding="utf-8")
        result = self.run_cli("detect-music")
        self.assertIn("So với nhãn trong testset.csv (4 video)", result.stdout)

    def test_missed_music_is_reported_loudly(self):
        result = self.run_cli("detect-music", "--threshold", "0.3")
        self.assertIn("bỏ sót 1", result.stdout)
        self.assertIn("BỎ SÓT video có nhạc: nhacnho0000", result.stdout)

    def test_missing_model_stops_with_hint(self):
        (self.workdir / "out/detect/review00000.json").unlink()
        result = self.run_cli("detect-music", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Thiếu mô hình", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
