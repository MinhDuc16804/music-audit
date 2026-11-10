"""Kiểm tra luồng quét cả kênh bằng AudD với máy chủ giả, không gửi gì ra ngoài và không cần ffmpeg.

Tài liệu không mô tả thân lỗi; máy chủ giả dùng dạng {"status": "error", "error": {...}}.
Khi chạy với tài khoản thật mà khác, hãy sửa cả mô phỏng này.
"""

import contextlib
import email
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import audit
from music_audit import workspace
from music_audit.commands.report import parse_stored
from music_audit.commands.scan import _recognize_clips, _shift_offset, full_requests
from music_audit import detect
from music_audit.audd import parse_saved
from music_audit.evaluate import HOLD, identify_summary
from music_audit.youtube import YoutubeClient, YoutubeError

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "audd-token-khong-duoc-in-ra"
SONG = {
    "score": 100,
    "artist": "Ca Sĩ",
    "title": "Bài Gây Strike (Official)",
    "album": "Album",
    "label": "Hãng A",
    "timecode": "00:11",
    "start_offset": 1000,
    "end_offset": 11000,
}


class FakeAudd(BaseHTTPRequestHandler):
    requests = []
    fields = []

    def log_message(self, *_args):
        pass

    def _send(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/"):
            message = email.message_from_bytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
            fields = {}
            for part in message.get_payload():
                name = part.get_param("name", header="content-disposition")
                fields[name] = "local" if name == "file" else part.get_payload(decode=True).decode()
            source = "local"
        else:
            fields = {k: v[0] for k, v in urllib.parse.parse_qs(body.decode()).items()}
            source = fields.get("url", "")
        if fields.get("api_token") != TOKEN:
            self._send({"status": "error", "error": {"error_code": 900, "error_message": "Wrong API token"}})
            return
        self.requests.append(source)
        self.fields.append(fields)
        if "paidonly" in source:
            self._send({"status": "error", "error": {"error_code": 904, "error_message": "only available to paid users"}})
        elif "broken" in source:
            self._send({"status": "error", "error": {"error_code": 600, "error_message": "Incorrect URL"}})
        elif "song" in source or source == "local":
            chunks = [{"songs": [SONG], "offset": "00:00"}, {"songs": [SONG, SONG], "offset": "00:12"}]
            self._send({"status": "success", "result": chunks, "api_token": TOKEN})
        else:
            # "other" (có nhạc thật nhưng AudD không nhận ra) và "clean" đều trả kết quả rỗng.
            self._send({"status": "success", "result": []})


class ServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAudd)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.workdir = Path(self.folder.name)
        (self.workdir / "data").mkdir()
        FakeAudd.requests.clear()
        FakeAudd.fields.clear()

    def env(self, token=TOKEN):
        return {
            "MUSIC_SERVICE": "audd",
            "ACRCLOUD_ACCESS_TOKEN": "",
            "AUDD_API_TOKEN": token,
            "AUDD_BASE_OVERRIDE": f"http://127.0.0.1:{self.server.server_port}/",
            "AUDD_MAX_CHUNKS": "300",
        }


class BulkFlowTests(ServerTestCase):
    def run_cli(self, *args, token=TOKEN, check=True, extra_env=None):
        result = subprocess.run(
            [sys.executable, str(ROOT / "audit.py"), "--workdir", str(self.workdir), *args],
            env={**os.environ, **self.env(token), **(extra_env or {})},
            capture_output=True,
            encoding="utf-8",
            timeout=60,
            cwd=ROOT,
        )
        self.assertNotIn(token, result.stdout + result.stderr)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def write_testset(self, extra_rows=()):
        song = self.workdir / "song.mp3"
        song.write_bytes(b"fake audio")
        rows = [
            "source,group,music_origin,has_speech,expected_title",
            "https://youtu.be/song1,commercial,vn,no,Bài gây strike",
            f"{song},strike,vn,,Bài gây strike",
            "https://youtu.be/other,commercial,foreign,yes,Bài khác",
            "https://youtu.be/clean,no_music,none,yes,",
            *extra_rows,
        ]
        (self.workdir / "data/testset.csv").write_text("\n".join(rows), encoding="utf-8")

    def write_all_videos(self, ids_and_seconds):
        lines = ["channel,video_id,url,title,published_at,duration_seconds,view_count"]
        urls = []
        for video_id, seconds in ids_and_seconds:
            urls.append(f"https://www.youtube.com/watch?v={video_id}")
            lines.append(f"Kênh,{video_id},{urls[-1]},Video {video_id},,{seconds},0")
        (self.workdir / "data/all_videos.csv").write_text("\n".join(lines), encoding="utf-8")
        return urls

    def write_detections(self, detections):
        (self.workdir / "out").mkdir(exist_ok=True)
        (self.workdir / "out/music_detect.json").write_text(json.dumps(detections), encoding="utf-8")

    def test_full_flow_without_container_or_fetch(self):
        self.write_testset()
        self.assertIn("Đã quét 2/2", self.run_cli("submit", "--delay", "0", "--limit", "2").stdout)
        self.assertIn("Tổng đã quét: 4/4", self.run_cli("submit", "--delay", "0").stdout)
        self.assertEqual(len(FakeAudd.requests), 4, "video đã quét không được quét lại")
        self.assertIn("không cần fetch", self.run_cli("fetch").stdout)
        self.assertTrue(all(f["skip"] == "0" and f["every"] == "1" for f in FakeAudd.fields), "phải quét mọi đoạn 12 giây")

        self.run_cli("report")
        report = (self.workdir / "out/report.md").read_text(encoding="utf-8")
        self.assertIn("Đã có kết quả 4/4", report)
        self.assertIn("Lưu ý về AudD", report)

        export = self.run_cli("export")
        self.assertIn("Sạch: 0  Có nhạc: 2  Cần nghe lại: 2", export.stdout)
        songs = (self.workdir / "out/songs.csv").read_text(encoding="utf-8-sig").splitlines()
        self.assertEqual(len(songs), 2, "một dòng tiêu đề và một bài")
        scan_report = (self.workdir / "out/bao-cao-quet.csv").read_text(encoding="utf-8-sig")
        self.assertIn("Bài Gây Strike (Official),Ca Sĩ,Hãng A,chua-tra,00:00 → 00:12", scan_report)
        clean_line = next(line for line in scan_report.splitlines() if "youtu.be/clean" in line)
        self.assertNotIn(",sach,", clean_line, "AudD không được đưa video nào vào nhóm sạch")

        results = {row.split(",")[0]: row for row in
                   (self.workdir / "out/results.csv").read_text(encoding="utf-8-sig").splitlines()}
        self.assertIn(HOLD, results["https://youtu.be/clean"])
        self.assertNotIn("pass_no_music", results["https://youtu.be/clean"])

    def test_token_echoed_by_api_is_not_saved(self):
        self.write_testset()
        self.run_cli("submit", "--delay", "0", "--limit", "1")
        saved = "".join(path.read_text(encoding="utf-8") for path in (self.workdir / "out").rglob("*.json"))
        self.assertNotIn(TOKEN, saved)

    def test_wrong_token_is_reported_without_secret(self):
        self.write_testset()
        result = self.run_cli("submit", "--delay", "0", "--limit", "1", token="sai-token-bi-mat")
        self.assertIn("900", result.stdout)
        self.assertFalse((self.workdir / "out/submissions.json").exists())

    def test_failed_url_is_retried_next_run_not_automatically(self):
        self.write_testset(["https://youtu.be/broken,commercial,vn,no,Bài lỗi"])
        result = self.run_cli("submit", "--delay", "0")
        self.assertIn("Đã quét 4/5", result.stdout)
        self.assertEqual(FakeAudd.requests.count("https://youtu.be/broken"), 1, "không tự gửi lại vì mỗi lần đều tính phí")
        submissions = json.loads((self.workdir / "out/submissions.json").read_text(encoding="utf-8"))
        self.assertNotIn("https://youtu.be/broken", submissions)

    def test_account_error_stops_the_run(self):
        rows = "source,group\n" + "\n".join(f"https://youtu.be/paidonly{i},random" for i in range(5))
        (self.workdir / "data/testset.csv").write_text(rows, encoding="utf-8")
        result = self.run_cli("submit", "--delay", "0")
        self.assertIn("gói trả phí", result.stdout)
        self.assertIn("Dừng lại", result.stdout)
        self.assertEqual(result.stdout.count("Đang quét"), 1, "phải dừng sau lỗi tài khoản đầu tiên")

    def test_downloaded_audio_is_sent_instead_of_url(self):
        urls = [f"https://www.youtube.com/watch?v=paidonly00{i}" for i in (1, 2)]
        (self.workdir / "data/testset.csv").write_text(
            "source,group\n" + "\n".join(f"{u},random" for u in urls), encoding="utf-8")
        audio = self.workdir / "data/audio"
        audio.mkdir()
        (audio / "paidonly001.m4a").write_bytes(b"fake audio")

        result = self.run_cli("submit", "--delay", "0")
        self.assertIn("từ file paidonly001.m4a", result.stdout)
        self.assertEqual(FakeAudd.requests, ["local", urls[1]])
        submissions = json.loads((self.workdir / "out/submissions.json").read_text(encoding="utf-8"))
        self.assertEqual(list(submissions), [urls[0]], "kết quả phải lưu theo link, không theo đường dẫn file")
        raw = json.loads((self.workdir / "out/raw" / f"{submissions[urls[0]]['file_id']}.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["scanned_from"], "file")

    def test_music_only_sends_only_music_videos(self):
        urls = [f"https://youtu.be/song{i}" for i in (1, 2, 3)]
        (self.workdir / "data/testset.csv").write_text(
            "source,group\n" + "\n".join(f"{u},random" for u in urls), encoding="utf-8")
        refused = self.run_cli("submit", "--delay", "0", "--music-only", check=False)
        self.assertIn("Chạy detect-music trước", refused.stdout + refused.stderr)

        self.write_detections({urls[0]: {"group": "co-nhac"}, urls[1]: {"group": "khong-nhac"}})
        result = self.run_cli("submit", "--delay", "0", "--music-only")
        self.assertIn("Chỉ gửi video có nhạc: 1 video. Bỏ qua 1 không nhạc, 1 chưa lọc", result.stdout)
        self.assertEqual(FakeAudd.requests, [urls[0]])

        export = self.run_cli("export")
        self.assertIn("Báo cáo 3 video", export.stdout, "video bị bỏ qua vẫn có trong báo cáo")
        self.assertIn("máy lọc: không nhạc, chưa quét AudD",
                      (self.workdir / "out/bao-cao-quet.csv").read_text(encoding="utf-8-sig"))

    def test_whole_channel_music_only(self):
        urls = self.write_all_videos([("song0000001", 30), ("song0000002", 30)])
        self.write_detections({urls[0]: {"group": "khong-nhac"}, urls[1]: {"group": "co-nhac"}})
        result = self.run_cli("submit", "--delay", "0", "--all-videos", "--music-only")
        self.assertIn("ước khoảng 3 lượt AudD", result.stdout)
        self.assertEqual(FakeAudd.requests, [urls[1]])
        export = self.run_cli("export", "--all-videos")
        self.assertIn("Sạch: 0  Có nhạc: 1  Cần nghe lại: 1 (tổng 2 video)", export.stdout)

    def test_long_video_keeps_cost_limit_and_warns(self):
        self.write_all_videos([("song0000001", 3600)])
        result = self.run_cli("submit", "--delay", "0", "--all-videos", extra_env={"AUDD_MAX_CHUNKS": "25"})
        self.assertIn("1 video dài hơn giới hạn, chỉ quét 5 phút đầu", result.stdout)
        self.assertIn("ước khoảng 25 lượt AudD", result.stdout)
        self.assertEqual(FakeAudd.fields[0]["limit"], "25")

    def test_audio_links_lists_only_videos_still_needed(self):
        urls = [f"https://www.youtube.com/watch?v=song000000{i}" for i in (1, 2, 3)]
        (self.workdir / "data/testset.csv").write_text(
            "source,group\n" + "\n".join(f"{u},random" for u in urls), encoding="utf-8")
        self.run_cli("submit", "--delay", "0", "--limit", "1")
        audio = self.workdir / "data/audio"
        audio.mkdir()
        (audio / "song0000002.m4a").write_bytes(b"fake audio")
        (audio / "song0000003.m4a.part").write_bytes(b"dang tai do")

        self.assertIn("Đã ghi 1 link", self.run_cli("audio-links").stdout)
        links = (audio / "links.txt").read_text(encoding="utf-8").split()
        self.assertEqual(links, [urls[2]], "bỏ video đã quét, video đã có file; file tải dở không tính")


class ClipFlowTests(ServerTestCase):
    """Chạy lệnh trong tiến trình và thay phần cắt file, nên không cần ffmpeg. Việc cắt thật của ffmpeg không được kiểm ở đây."""

    def setUp(self):
        super().setUp()
        self.url = "https://www.youtube.com/watch?v=clipvid0000"
        audio = self.workdir / "data/audio"
        audio.mkdir()
        (audio / "clipvid0000.m4a").write_bytes(b"fake audio")
        (self.workdir / "out/detect").mkdir(parents=True)
        # Nhạc ở giây 10-30 và 40-52; lưới 45 giây chỉ có một ô vừa trong thân video 60 giây.
        music = [0.0] * 20 + [0.9] * 41 + [0.0] * 21 + [0.9] * 25 + [0.0] * 16
        (self.workdir / "out/detect/clipvid0000.json").write_text(
            json.dumps({"size": 1, "duration": 60, "music": music, "top_sound": "Music"}), encoding="utf-8")
        (self.workdir / "out/music_detect.json").write_text(json.dumps({self.url: {"group": "co-nhac"}}), encoding="utf-8")
        (self.workdir / "data/all_videos.csv").write_text(
            "channel,video_id,url,title,published_at,duration_seconds,view_count\n"
            f"Kênh,clipvid0000,{self.url},Video cắt,,60,0", encoding="utf-8")

    def run_command(self, *args):
        def fake_cut(_source, _start, target, **_kwargs):
            Path(target).write_bytes(b"clip")
            return target

        output = io.StringIO()
        parsed = audit.build_parser().parse_args(["--workdir", str(self.workdir), *args])
        with mock.patch.dict(os.environ, self.env()), mock.patch.object(detect, "cut_clip", fake_cut), \
                contextlib.redirect_stdout(output):
            parsed.handler(parsed, workspace.Paths(parsed.workdir))
        return output.getvalue()

    def test_submit_with_clips_sends_grid_clips_outside_intro(self):
        output = self.run_command("submit", "--delay", "0", "--all-videos", "--music-only", "--clips", "30")
        self.assertIn("ước khoảng 1 lượt AudD", output)
        self.assertEqual(FakeAudd.requests, ["local"])
        self.assertEqual(FakeAudd.fields[0]["limit"], "1", "mỗi đoạn tối đa 1 lượt")
        submissions = json.loads((self.workdir / "out/submissions.json").read_text(encoding="utf-8"))
        raw = json.loads((self.workdir / "out/raw" / f"{submissions[self.url]['file_id']}.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["mode"], "clips")
        self.assertGreaterEqual(raw["clip_starts"][0], 7.5, "đoạn cắt không nằm trong intro")
        self.assertTrue(all(chunk["offset"] >= "00:08" for chunk in raw["response"]["result"]), "offset tính theo giây trong video")

    def test_clip_results_are_kept_so_a_retry_does_not_pay_again(self):
        self.run_command("submit", "--delay", "0", "--all-videos", "--music-only", "--clips", "8")
        self.assertEqual(len(FakeAudd.requests), 1)
        self.assertTrue(list((self.workdir / "out/clips/clipvid0000").glob("*.json")), "kết quả từng đoạn được lưu ngay")
        # Giả lập lần trước lỗi giữa chừng: video chưa được ghi là đã quét, nhưng đoạn đã gửi vẫn còn.
        (self.workdir / "out/submissions.json").unlink()
        self.run_command("submit", "--delay", "0", "--all-videos", "--music-only", "--clips", "8")
        self.assertEqual(len(FakeAudd.requests), 1, "đoạn đã có kết quả không bị gửi lại")

    def test_clip_count_has_a_cap(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            audit.build_parser().parse_args(["submit", "--clips", "999"])
        self.assertEqual(audit.build_parser().parse_args(["submit", "--clips", "20"]).clips, 20)

    def test_compare_clips_against_full_scan(self):
        self.run_command("submit", "--delay", "0", "--all-videos", "--music-only")
        FakeAudd.requests.clear()
        output = self.run_command("compare-clips", "--delay", "0")
        self.assertIn("Cần gửi 1 video, ước khoảng 1 lượt AudD", output)
        self.assertIn("Bài chính vẫn được nhận ra: 1/1", output)
        self.assertIn("Lượt AudD: cả video 5, đoạn cắt 1", output)
        compare = (self.workdir / "out/so-sanh-cat-doan.csv").read_text(encoding="utf-8-sig").splitlines()
        self.assertTrue(compare[0].endswith("Bài 1,Tác giả 1"), "mỗi bài một ô, tác giả ở ô bên cạnh")
        self.assertIn("Cần gửi 0 video", self.run_command("compare-clips", "--delay", "0"), "chạy lại không gửi lại")
        self.assertEqual(len(FakeAudd.requests), 1)


class HelperTests(unittest.TestCase):
    def test_video_id_starting_with_dash_is_not_read_as_an_option(self):
        # Cách web app truyền mã: liền với dấu =, hoặc sau "--" với các lệnh nhận nhiều mã.
        parser = audit.build_parser()
        self.assertEqual(parser.parse_args(["submit", "--video-id=-abcdefghij"]).video_id, "-abcdefghij")
        self.assertEqual(parser.parse_args(["history", "--", "-abcdefghij", "dQw4w9WgXcQ"]).ids, ["-abcdefghij", "dQw4w9WgXcQ"])
        self.assertEqual(parser.parse_args(["durations", "--", "-abcdefghij"]).video_id, ["-abcdefghij"])

    def test_saved_record_counts_song_once_per_chunk(self):
        raw = {"provider": "audd", "duration_seconds": 30, "response": {"status": "success", "result": [
            {"songs": [SONG], "offset": "00:00"}, {"songs": [SONG, SONG], "offset": "00:12"}]}}
        scan = parse_saved(raw)
        self.assertEqual(len(scan.tracks), 1)
        self.assertEqual(scan.tracks[0]["played_duration"], 20)
        self.assertEqual(scan.tracks[0]["offsets"], ["00:00", "00:12"])
        self.assertEqual(scan.duration, 30)
        self.assertFalse(scan.detects_music)

    def test_identify_output_shape_is_unchanged_for_web_app(self):
        scan = parse_saved({"response": {"result": [{"songs": [SONG], "offset": "00:00"}]}})
        track = identify_summary(scan)["tracks"][0]
        self.assertNotIn("offsets", track)
        self.assertNotIn("artist_names", track)

    def test_no_match_is_unknown_not_clean(self):
        for result in ([], None):
            scan = parse_stored({"provider": "audd", "response": {"status": "success", "result": result}})
            self.assertEqual((scan.music, scan.state), ("unknown", 1))

    def test_music_service_choice(self):
        cases = [
            ({"MUSIC_SERVICE": "acrcloud", "AUDD_API_TOKEN": "a", "ACRCLOUD_ACCESS_TOKEN": ""}, "acrcloud"),
            ({"MUSIC_SERVICE": "", "AUDD_API_TOKEN": "a", "ACRCLOUD_ACCESS_TOKEN": ""}, "audd"),
            ({"MUSIC_SERVICE": "", "AUDD_API_TOKEN": "a", "ACRCLOUD_ACCESS_TOKEN": "b"}, "acrcloud"),
        ]
        for env, expected in cases:
            with mock.patch.dict(os.environ, env):
                self.assertEqual(workspace.music_service(), expected)
        with mock.patch.dict(os.environ, {"MUSIC_SERVICE": "khac"}), self.assertRaises(SystemExit):
            workspace.music_service()

    def test_shift_offset(self):
        self.assertEqual(_shift_offset("00:12", 30.4), "00:42")
        self.assertEqual(_shift_offset("khong-ro", 30), "khong-ro")

    def test_full_requests_rounds_up_and_respects_limit(self):
        self.assertEqual(full_requests("13", 300), 2)
        self.assertEqual(full_requests(3600, 25), 25)
        self.assertEqual(full_requests("", 300), 0)

    def test_clip_result_as_single_object_is_kept(self):
        """Phản hồi dạng một bài (result là object) không được làm mất bài đó."""
        with tempfile.TemporaryDirectory() as folder:
            paths = workspace.Paths(folder)
            paths.audio.mkdir(parents=True)
            (paths.audio / "clipvid0000.m4a").write_bytes(b"x")
            workspace.write_json(paths.detect_cache / "clipvid0000.json", {"music": [0.9] * 100})
            client = mock.Mock()
            client.recognize_file.return_value = {"status": "success", "result": {"title": "A", "artist": "B"}}
            with mock.patch.object(detect, "cut_clip", lambda _s, _a, target, **_k: target):
                response, _ = _recognize_clips(client, paths, "https://youtu.be/clipvid0000", 1)
        self.assertEqual(response["result"][0]["songs"], [{"title": "A", "artist": "B"}])

    def test_labelled_row_wins_over_random_sample_but_real_duplicates_stay(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = workspace.Paths(folder)
            paths.data.mkdir()
            paths.testset.write_text("source,group,has_music\nA,commercial,yes\nB,commercial,no\nB,commercial,no", encoding="utf-8")
            paths.sample.write_text("source,group\nA,random\nC,random", encoding="utf-8")
            rows = workspace.load_testset(paths)
        self.assertEqual([row["source"] for row in rows], ["A", "B", "B", "C"])
        self.assertEqual(rows[0]["group"], "commercial")

    def test_local_audio_needs_real_id_and_non_empty_file(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = workspace.Paths(folder)
            paths.audio.mkdir(parents=True)
            (paths.audio / "emptyfile00.m4a").write_bytes(b"")
            (paths.audio / "goodfile000.mp3").write_bytes(b"x")
            self.assertIsNone(workspace.local_audio(paths, "https://youtu.be/emptyfile00"))
            self.assertEqual(workspace.local_audio(paths, "https://youtu.be/goodfile000").name, "goodfile000.mp3")
            self.assertIsNone(workspace.local_audio(paths, str(Path(folder) / "bai.mp3")))

    def test_ffmpeg_location_from_env_is_used(self):
        with mock.patch.dict(os.environ, {"FFMPEG_LOCATION": "ffmpeg-rieng.exe"}), \
                mock.patch.object(detect.subprocess, "run") as run:
            detect.cut_clip("a.m4a", 1.0, "b.mp3")
        self.assertEqual(run.call_args.args[0][0], "ffmpeg-rieng.exe")


class ShortsTests(unittest.TestCase):
    def client(self, shorts_error=None):
        client = YoutubeClient("khoa-gia")

        def fake_get(path, params):
            if path == "channels":
                return {"items": [{"snippet": {"title": "Kênh"}, "contentDetails": {"relatedPlaylists": {"uploads": "UUabc"}}}]}
            if path == "playlistItems":
                if params["playlistId"] == "UUSHabc":
                    if shorts_error:
                        raise shorts_error
                    return {"items": [{"contentDetails": {"videoId": "short000001"}}]}
                return {"items": [{"contentDetails": {"videoId": "long0000001"}}, {"contentDetails": {"videoId": "short000001"}}]}
            return {"items": [{"id": video_id, "snippet": {"title": "T", "publishedAt": ""}, "contentDetails": {"duration": "PT1M"}}
                              for video_id in params["id"].split(",")]}

        client._get = fake_get
        return client

    def ids(self, client, **kwargs):
        return [video["video_id"] for video in client.list_channel_videos("https://www.youtube.com/@kenh", **kwargs)]

    def test_shorts_are_kept_by_default(self):
        self.assertEqual(self.ids(self.client()), ["long0000001", "short000001"])

    def test_shorts_can_be_skipped(self):
        self.assertEqual(self.ids(self.client(), include_shorts=False), ["long0000001"])

    def test_channel_without_shorts_is_fine(self):
        client = self.client(YoutubeError("khong co", status=404))
        self.assertEqual(self.ids(client, include_shorts=False), ["long0000001", "short000001"])

    def test_other_youtube_error_is_not_hidden(self):
        with self.assertRaises(YoutubeError):
            self.ids(self.client(YoutubeError("het quota", status=403)), include_shorts=False)


if __name__ == "__main__":
    unittest.main()
