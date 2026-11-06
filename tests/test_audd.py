"""Kiểm tra AudD bằng máy chủ giả mô phỏng theo tài liệu, không gửi gì ra ngoài."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from music_audit.audd import AuddClient, AuddError, parse_audd
from music_audit.evaluate import BLOCK, HOLD, PASS_NO_MUSIC, gate_decision, identify_summary

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "audd-token-khong-duoc-in-ra"
SONG = {"title": "Bài A", "artist": "Ca Sĩ", "label": "Hãng", "score": 100, "isrc": "VNA1"}


class FakeAudd(BaseHTTPRequestHandler):
    bodies = []
    reply = {"status": "success", "result": [{"offset": "00:12", "songs": [SONG]}], "api_token": TOKEN}

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.bodies.append(body)
        payload = json.dumps(self.reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ParseAuddTests(unittest.TestCase):
    def test_match_is_blocked_with_track_details(self):
        scan = parse_audd({"result": [{"offset": "00:00", "songs": [SONG]}]})
        self.assertEqual(gate_decision(scan, {}), BLOCK)
        track = identify_summary(scan)["tracks"][0]
        self.assertEqual(track["title"], "Bài A")
        self.assertEqual(track["artists"], "Ca Sĩ")
        self.assertEqual(track["label"], "Hãng")

    def test_no_match_is_unknown_never_no_music(self):
        for raw in ({"result": []}, {"result": None}, {}, {"result": [{"songs": []}]}):
            scan = parse_audd(raw)
            self.assertEqual(scan.music, "unknown")
            self.assertEqual(gate_decision(scan, {}), HOLD)
            self.assertNotEqual(gate_decision(scan, {}), PASS_NO_MUSIC)

    def test_repeated_song_is_merged_and_duration_added(self):
        other = {**SONG, "title": "BÀI A (Remix)", "score": 80}
        scan = parse_audd({"result": [{"songs": [SONG]}, {"songs": [other]}]})
        self.assertEqual(len(scan.tracks), 1)
        self.assertEqual(scan.tracks[0]["played_duration"], 24)
        self.assertEqual(scan.tracks[0]["score"], 100)

    def test_same_title_different_artist_stays_separate(self):
        other = {**SONG, "artist": "Ca Sĩ Khác"}
        self.assertEqual(len(parse_audd({"result": [{"songs": [SONG, other]}]}).tracks), 2)

    def test_licensed_group_needs_title_and_artist(self):
        scan = parse_audd({"result": [{"songs": [SONG]}]})
        row = {"group": "licensed", "expected_title": "Bài A", "expected_artist": "Ca Sĩ"}
        self.assertEqual(gate_decision(scan, row), "pass_licensed")
        self.assertEqual(gate_decision(scan, {**row, "expected_artist": "Khác"}), BLOCK)


class AuddCommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAudd)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeAudd.bodies = []
        FakeAudd.reply = {"status": "success", "result": [{"songs": [SONG]}], "api_token": TOKEN}
        self.workdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.workdir, ignore_errors=True)

    def _run(self, *args):
        env = {
            **os.environ,
            "ACRCLOUD_ACCESS_TOKEN": "",
            "AUDD_API_TOKEN": TOKEN,
            "AUDD_BASE_OVERRIDE": f"http://127.0.0.1:{self.server.server_port}",
            "AUDD_MAX_CHUNKS": "25",
        }
        command = [sys.executable, str(ROOT / "audit.py"), "--workdir", self.workdir, *args]
        done = subprocess.run(command, capture_output=True, encoding="utf-8", env=env, cwd=ROOT)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        return done

    def _saved_text(self):
        return "".join(path.read_text(encoding="utf-8") for path in Path(self.workdir).rglob("*.json"))

    def test_link_returns_tracks_and_sends_limit(self):
        done = self._run("identify", "https://youtu.be/song1234567?list=PL1")
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual(result["decision"], BLOCK)
        self.assertEqual(result["provider"], "audd")
        self.assertIn("5 phút", result["scan_note"])
        self.assertIn(b"limit=25", FakeAudd.bodies[0])
        self.assertNotIn(b"PL1", FakeAudd.bodies[0])

    def test_same_video_is_not_billed_twice(self):
        self._run("identify", "https://youtu.be/song1234567")
        self._run("identify", "https://www.youtube.com/watch?v=song1234567")
        self.assertEqual(len(FakeAudd.bodies), 1)
        self._run("identify", "https://youtu.be/song1234567", "--rescan")
        self.assertEqual(len(FakeAudd.bodies), 2)

    def test_token_echoed_by_api_is_not_saved(self):
        self._run("identify", "https://youtu.be/song1234567")
        self.assertNotIn(TOKEN, self._saved_text())

    def test_file_is_uploaded_once_and_named(self):
        path = Path(self.workdir) / "upload.mp3"
        path.write_bytes(b"fake audio")
        for _ in range(2):
            done = self._run("identify-file", str(path), "--name=Bài dựng.mp3")
            self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual(result["url"], "Bài dựng.mp3")
        self.assertEqual(result["decision"], BLOCK)
        self.assertEqual(len(FakeAudd.bodies), 1)
        self.assertIn(b'name="file"', FakeAudd.bodies[0])

    def test_paid_only_error_is_friendly_and_not_cached(self):
        FakeAudd.reply = {"status": "error", "error": {"error_code": 904, "error_message": "x"}}
        for _ in range(2):
            done = self._run("identify", "https://youtu.be/song1234567")
            self.assertEqual(done.returncode, 1)
            self.assertIn("gói trả phí", done.stderr)
        self.assertEqual(len(FakeAudd.bodies), 2)

    def test_unknown_error_hides_token(self):
        FakeAudd.reply = {"status": "error", "error": {"error_code": 777, "error_message": f"sai {TOKEN}"}}
        self.assertIn("777", self._run("identify", "https://youtu.be/song1234567").stderr)

    def test_missing_file_is_reported(self):
        self.assertIn("Không tìm thấy", self._run("identify-file", "khong-co.mp3").stderr)
        self.assertEqual(FakeAudd.bodies, [])


class ClientTests(unittest.TestCase):
    def test_missing_token_is_rejected(self):
        with self.assertRaises(AuddError):
            AuddClient("")


if __name__ == "__main__":
    unittest.main()
