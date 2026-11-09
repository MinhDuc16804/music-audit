"""Kiểm tra lệnh identify: dán một link YouTube, nhận lại danh sách bài nhạc."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

from music_audit.evaluate import BLOCK, ERROR, HOLD, PASS_NO_MUSIC, identify_summary, parse_scan
from unittest import mock

from music_audit.youtube import YoutubeClient, video_url, youtube_video_id
from test_flow import ROOT, TOKEN, FakeAcr

VIDEO_ID = "dQw4w9WgXcQ"


class VideoDurationsTests(unittest.TestCase):
    @staticmethod
    def _page(_path, params):
        ids = params["id"].split(",")
        return {"items": [{"id": video_id, "contentDetails": {"duration": "PT1M5S"}} for video_id in ids[:-1]]}

    def test_reads_every_page_and_skips_missing_videos(self):
        client = YoutubeClient("khoa")
        ids = [f"video{number:06d}" for number in range(60)]
        with mock.patch.object(client, "_get", side_effect=self._page) as get:
            durations = client.video_durations(ids)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(len(durations), 58)
        self.assertEqual(durations["video000000"], 65)
        self.assertNotIn("video000049", durations)


class YoutubeVideoIdTests(unittest.TestCase):
    def test_accepts_single_video_links(self):
        links = (
            f"https://www.youtube.com/watch?v={VIDEO_ID}",
            f"https://www.youtube.com/watch?v={VIDEO_ID}&t=42s",
            f"http://m.youtube.com/watch?feature=share&v={VIDEO_ID}",
            f"https://music.youtube.com/watch?v={VIDEO_ID}",
            f"https://youtu.be/{VIDEO_ID}?si=abc",
            f"https://www.youtube.com/shorts/{VIDEO_ID}",
            f"https://www.youtube.com/live/{VIDEO_ID}?feature=share",
            f"https://www.youtube.com/embed/{VIDEO_ID}",
            f"  youtube.com/watch?v={VIDEO_ID}  ",
        )
        for link in links:
            self.assertEqual(youtube_video_id(link), VIDEO_ID, link)

    def test_link_in_playlist_keeps_only_the_video(self):
        link = f"https://www.youtube.com/watch?v={VIDEO_ID}&list=PL123&index=2"
        self.assertEqual(video_url(youtube_video_id(link)), f"https://www.youtube.com/watch?v={VIDEO_ID}")

    def test_rejects_everything_else(self):
        links = (
            "",
            "khong-phai-link",
            "https://www.youtube.com/playlist?list=PL123",
            "https://www.youtube.com/@kenh-a",
            "https://www.youtube.com/channel/UC1234567890123456789012",
            "https://www.youtube.com/embed/videoseries?list=PL123",
            "https://www.youtube.com/watch?v=ngan",
            f"https://www.youtube.com/watch?list=PL123&x={VIDEO_ID}",
            f"https://evil.example/youtube.com/watch?v={VIDEO_ID}",
            f"https://youtube.com.evil.example/watch?v={VIDEO_ID}",
            f"ftp://www.youtube.com/watch?v={VIDEO_ID}",
            "http://[khong-hop-le",
        )
        for link in links:
            self.assertEqual(youtube_video_id(link), "", link)


class IdentifySummaryTests(unittest.TestCase):
    def test_recognized_track_is_blocked_and_listed(self):
        raw = {
            "state": 1,
            "duration": 200,
            "music_detected": 1,
            "results": {
                "music": [
                    {
                        "played_duration": 30,
                        "result": {"title": "Bài A", "artists": [{"name": "Ca Sĩ"}], "label": "Hãng", "score": 90},
                    }
                ]
            },
        }
        summary = identify_summary(parse_scan(raw))
        self.assertEqual(summary["decision"], BLOCK)
        self.assertEqual(summary["tracks"][0]["title"], "Bài A")
        self.assertEqual(summary["tracks"][0]["artists"], "Ca Sĩ")
        self.assertNotIn("artist_names", summary["tracks"][0])

    def test_no_match_with_music_is_unknown_not_safe(self):
        summary = identify_summary(parse_scan({"state": -1, "music_detected": 1, "results": {}}))
        self.assertEqual(summary["decision"], HOLD)
        self.assertEqual(summary["tracks"], [])
        self.assertIn("không phải an toàn", summary["note"])

    def test_missing_music_flag_is_held(self):
        self.assertEqual(identify_summary(parse_scan({"state": -1, "results": {}}))["decision"], HOLD)

    def test_scan_error_gives_no_conclusion(self):
        self.assertEqual(identify_summary(parse_scan({"state": -2, "results": None}))["decision"], ERROR)


class IdentifyCommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAcr)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeAcr.files = {}
        FakeAcr.polls = {}
        FakeAcr.uploads = []
        FakeAcr.throttled = [False]
        self.workdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.workdir, ignore_errors=True)

    def _run(self, *args):
        env = {
            **os.environ,
            "ACRCLOUD_ACCESS_TOKEN": TOKEN,
            "ACRCLOUD_BASE_OVERRIDE": f"http://127.0.0.1:{self.server.server_port}",
        }
        command = [sys.executable, str(ROOT / "audit.py"), "--workdir", self.workdir, "identify", *args]
        done = subprocess.run(command, capture_output=True, encoding="utf-8", env=env, cwd=ROOT)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        return done

    def _identify(self, *args):
        done = self._run(*args, "--interval", "0")
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_paste_link_returns_tracks_and_creates_container(self):
        result = self._identify("https://youtu.be/song1234567?si=abc")
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["decision"], BLOCK)
        self.assertEqual(result["tracks"][0]["title"], "Bài Gây Strike (Official)")
        self.assertTrue(os.path.exists(os.path.join(self.workdir, "out", "container.json")))

    def test_playlist_param_never_reaches_acrcloud(self):
        self._identify("https://www.youtube.com/watch?v=song1234567&list=PL123")
        self.assertEqual(FakeAcr.uploads, ["https://www.youtube.com/watch?v=song1234567"])

    def test_same_video_is_not_submitted_twice(self):
        first = self._identify("https://youtu.be/song1234567")
        second = self._identify("https://www.youtube.com/watch?v=song1234567&t=5s")
        self.assertEqual(first["tracks"], second["tracks"])
        self.assertEqual(len(FakeAcr.uploads), 1)

    def test_rescan_submits_again(self):
        self._identify("https://youtu.be/song1234567")
        self._identify("https://youtu.be/song1234567", "--rescan")
        self.assertEqual(len(FakeAcr.uploads), 2)

    def test_timeout_reports_processing_then_resumes(self):
        pending = self._identify("https://youtu.be/song1234567", "--timeout", "0")
        self.assertEqual(pending["status"], "processing")
        self.assertNotIn("decision", pending)
        finished = self._identify("https://youtu.be/song1234567")
        self.assertEqual(finished["status"], "done")
        self.assertEqual(len(FakeAcr.uploads), 1)

    def test_no_match_is_held(self):
        result = self._identify("https://youtu.be/unknown1234")
        self.assertEqual(result["decision"], HOLD)
        self.assertEqual(result["tracks"], [])

    def test_no_music(self):
        self.assertEqual(self._identify("https://youtu.be/clean123456")["decision"], PASS_NO_MUSIC)

    def test_channel_link_is_refused_before_any_upload(self):
        done = self._run("https://www.youtube.com/@kenh-a")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("một video", done.stderr)
        self.assertEqual(FakeAcr.uploads, [])


if __name__ == "__main__":
    unittest.main()
