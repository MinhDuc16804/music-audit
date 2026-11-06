"""Chạy toàn bộ lệnh với một máy chủ giả mô phỏng API theo tài liệu ACRCloud."""

import email
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

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "test-token-khong-duoc-in-ra"


class FakeAcr(BaseHTTPRequestHandler):
    files = {}
    polls = {}
    uploads = []
    throttled = [True]

    def log_message(self, *_args):
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._send(401, {"message": "Unauthorized"})
            return False
        return True

    def do_POST(self):
        if not self._authorized():
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/fs-containers":
            payload = json.loads(body)
            assert payload["music_detection"] == 1 and payload["buckets"] == ["ACRCloud Music"]
            self._send(201, {"data": {"id": 77, "region": payload["region"]}})
            return
        if self.path == "/fs-containers/77/files":
            if self.throttled[0]:
                self.throttled[0] = False
                self._send(429, {"message": "slow down"})
                return
            content_type = self.headers.get("Content-Type", "")
            if content_type.startswith("multipart/"):
                message = email.message_from_bytes(
                    b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body
                )
                names = [part.get_param("name", header="content-disposition") for part in message.get_payload()]
                assert names == ["data_type", "file"]
                source = "local"
            else:
                payload = json.loads(body)
                assert payload["data_type"] == "platforms"
                source = payload["url"]
            file_id = f"file-{len(self.files) + 1}"
            self.files[file_id] = source
            self.uploads.append(source)
            self._send(200, {"data": {"id": file_id, "state": 0}})
            return
        self._send(404, {"message": "not found"})

    def do_GET(self):
        if not self._authorized():
            return
        prefix = "/fs-containers/77/files/"
        if not self.path.startswith(prefix):
            self._send(404, {"message": "not found"})
            return
        items = []
        for file_id in self.path[len(prefix) :].split(","):
            self.polls[file_id] = self.polls.get(file_id, 0) + 1
            items.append(self._result(file_id))
        self._send(200, {"data": items})

    def _result(self, file_id):
        source = self.files[file_id]
        if self.polls[file_id] == 1:
            return {"id": file_id, "state": 0, "results": None}
        if "song" in source or source == "local":
            return {
                "id": file_id,
                "state": 1,
                "duration": 200,
                "music_detected": 1,
                "results": {
                    "music_speech": [{"start": 0, "end": 200, "label": "m"}],
                    "music": [
                        {
                            "played_duration": 180,
                            "result": {
                                "title": "Bài Gây Strike (Official)",
                                "artists": [{"name": "Ca Sĩ"}],
                                "label": "Hãng A",
                                "score": 95,
                            },
                        }
                    ],
                },
            }
        if "clean" in source:
            return {
                "id": file_id,
                "state": -1,
                "duration": 100,
                "music_detected": 2,
                "results": {"music_speech": [{"start": 0, "end": 100, "label": "s"}]},
            }
        return {
            "id": file_id,
            "state": -1,
            "duration": 100,
            "music_detected": 1,
            "results": {"music_speech": [{"start": 0, "end": 100, "label": "ms"}]},
        }


class FlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAcr)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.workdir = Path(self.folder.name)
        (self.workdir / "data").mkdir()
        FakeAcr.files.clear()
        FakeAcr.polls.clear()
        FakeAcr.uploads.clear()
        FakeAcr.throttled[0] = True

    def tearDown(self):
        self.folder.cleanup()

    def run_cli(self, *args, check=True):
        env = {
            **os.environ,
            "ACRCLOUD_ACCESS_TOKEN": TOKEN,
            "ACRCLOUD_BASE_OVERRIDE": f"http://127.0.0.1:{self.server.server_port}",
            "PYTHONPATH": str(ROOT),
        }
        result = subprocess.run(
            [sys.executable, str(ROOT / "audit.py"), "--workdir", str(self.workdir), *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def write_testset(self, song_file):
        rows = [
            "source;group;music_origin;has_speech;expected_title;expected_artist;has_source_file;channel;note",
            "https://youtu.be/song1;commercial;vn;Không;Bài gây strike;;Có;Kênh A;",
            f"{song_file};strike;vn;;Bài gây strike;;;;",
            "https://youtu.be/other;commercial;foreign;Có;Bài khác;;Không;Kênh B;",
            "https://youtu.be/clean;no_music;none;Có;;;Có;Kênh C;",
        ]
        (self.workdir / "data" / "testset.csv").write_bytes(("﻿" + "\n".join(rows)).encode("utf-8"))

    def test_full_flow(self):
        song = self.workdir / "song.mp3"
        song.write_bytes(b"fake audio")
        self.write_testset(song)

        self.run_cli("create-container")
        self.assertEqual(json.loads((self.workdir / "out/container.json").read_text())["id"], 77)

        first = self.run_cli("submit", "--delay", "0", "--limit", "2")
        self.assertIn("Đã gửi 2/2", first.stdout)
        second = self.run_cli("submit", "--delay", "0")
        self.assertIn("Tổng đã gửi: 4/4", second.stdout)
        self.assertEqual(len(FakeAcr.uploads), 4, "video đã gửi không được gửi lại")

        self.run_cli("fetch", "--interval", "0", "--timeout", "30")
        self.run_cli("report")

        report = (self.workdir / "out/report.md").read_text(encoding="utf-8")
        self.assertIn("Đã có kết quả 4/4", report)
        self.assertIn("**Nhận đúng bài đội đã ghi:** 2/3", report)
        self.assertIn("**Không có nhạc, báo nhầm có bài:** 0/1", report)
        results = (self.workdir / "out/results.csv").read_text(encoding="utf-8-sig")
        self.assertIn("Bài Gây Strike (Official)", results)

    @unittest.skipUnless(shutil.which("ffmpeg"), "cần ffmpeg")
    def test_local_video_is_uploaded_as_audio(self):
        video = self.workdir / "clip.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
             "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-shortest", str(video)],
            check=True,
        )
        rows = "source,group,expected_title\n" + f"{video},strike,Bài gây strike\n"
        (self.workdir / "data/testset.csv").write_text(rows, encoding="utf-8")
        self.run_cli("create-container")
        FakeAcr.throttled[0] = False
        result = self.run_cli("submit", "--delay", "0")
        self.assertIn("Đã gửi 1/1", result.stdout)
        self.assertEqual(FakeAcr.uploads, ["local"])

    def test_example_rows_block_submission(self):
        template = (ROOT / "templates/testset.csv").read_bytes()
        (self.workdir / "data/testset.csv").write_bytes(template)
        self.run_cli("create-container")
        result = self.run_cli("submit", "--delay", "0", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("dòng ví dụ", result.stdout)
        self.assertEqual(FakeAcr.uploads, [])

    def test_wrong_token_message_has_no_secret(self):
        env = {
            **os.environ,
            "ACRCLOUD_ACCESS_TOKEN": "sai-token-bi-mat",
            "ACRCLOUD_BASE_OVERRIDE": f"http://127.0.0.1:{self.server.server_port}",
            "PYTHONPATH": str(ROOT),
        }
        result = subprocess.run(
            [sys.executable, str(ROOT / "audit.py"), "--workdir", str(self.workdir), "create-container"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("401", result.stderr)
        self.assertNotIn("sai-token-bi-mat", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
