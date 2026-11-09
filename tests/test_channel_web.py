"""Kiểm thử các lệnh web app dùng để quét cả kênh, không gọi YouTube hay AudD."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import audit
from music_audit import extract
from music_audit.common import write_csv
from music_audit.extract import BLOCKED_MESSAGE, ExtractError, ExtractStop, build_download_command, download_audio
from music_audit.grouping import report_json

A, B, C = "a" * 11, "b" * 11, "c" * 11


def url(video_id):
    return f"https://www.youtube.com/watch?v={video_id}"


def video(video_id, seconds=60):
    return {"channel": "Kênh", "video_id": video_id, "url": url(video_id), "title": f"Video {video_id}",
            "published_at": "", "duration_seconds": seconds, "view_count": ""}


class ChannelCommandTestCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.paths = audit.Paths(folder.name)
        write_csv(self.paths.all_videos, [video(A), video(B), video(C)], audit.VIDEO_COLUMNS)
        env = mock.patch.dict(os.environ, {"MUSIC_SERVICE": "audd", "AUDD_MAX_CHUNKS": ""})
        env.start()
        self.addCleanup(env.stop)

    def run_command(self, *argv):
        args = audit.build_parser().parse_args(argv)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            args.handler(args, self.paths)
        return output.getvalue()

    def add_audio(self, video_id):
        self.paths.audio.mkdir(parents=True, exist_ok=True)
        (self.paths.audio / f"{video_id}.m4a").write_bytes(b"am-thanh")

    def mark_scanned(self, video_id):
        audit.write_json(self.paths.submissions, {url(video_id): {"file_id": "x", "service": "audd", "at": ""}})


class DownloadAudioCommandTests(ChannelCommandTestCase):
    def test_skips_downloaded_and_scanned_videos(self):
        self.add_audio(A)
        self.mark_scanned(B)
        with mock.patch("audit.download_audio") as download:
            self.run_command("download-audio", "--delay", "0")
        self.assertEqual([call.args[0] for call in download.call_args_list], [url(C)])

    def test_limit_only_looks_at_first_videos(self):
        with mock.patch("audit.download_audio") as download:
            self.run_command("download-audio", "--limit", "2", "--delay", "0")
        self.assertEqual([call.args[0] for call in download.call_args_list], [url(A), url(B)])

    def test_one_bad_video_does_not_stop_the_rest(self):
        with mock.patch("audit.download_audio", side_effect=[ExtractError("hỏng"), None, None]) as download:
            output = self.run_command("download-audio", "--delay", "0")
        self.assertEqual(download.call_count, 3)
        self.assertIn(f"Lỗi với {url(A)}", output)

    def test_youtube_block_stops_everything(self):
        with mock.patch("audit.download_audio", side_effect=ExtractStop(BLOCKED_MESSAGE)) as download:
            with self.assertRaises(ExtractStop):
                self.run_command("download-audio", "--delay", "0")
        self.assertEqual(download.call_count, 1)


class SubmitOneVideoTests(ChannelCommandTestCase):
    def test_only_the_chosen_video_is_sent(self):
        self.add_audio(A)
        self.add_audio(B)
        client = mock.Mock()
        client.recognize_file.return_value = {"status": "success", "result": []}
        with mock.patch("audit.audd_client", return_value=client):
            self.run_command("submit", "--all-videos", "--video-id", B, "--delay", "0")
        self.assertEqual(client.recognize_file.call_count, 1)
        self.assertEqual(list(audit.read_json(self.paths.submissions, {})), [url(B)])

    def test_scanned_video_is_not_charged_again(self):
        self.mark_scanned(A)
        client = mock.Mock()
        with mock.patch("audit.audd_client", return_value=client):
            self.run_command("submit", "--all-videos", "--video-id", A, "--delay", "0")
        client.recognize_file.assert_not_called()
        client.recognize_url.assert_not_called()


class ChannelReportCommandTests(ChannelCommandTestCase):
    def test_reports_scanned_and_unscanned_videos(self):
        self.add_audio(A)
        client = mock.Mock()
        client.recognize_file.return_value = {
            "status": "success",
            "result": [{"offset": "00:12", "songs": [{"title": "Bài Thử", "artist": "Ca Sĩ", "label": "Hãng", "timecode": "00:30", "score": 100}]}],
        }
        with mock.patch("audit.audd_client", return_value=client):
            self.run_command("submit", "--all-videos", "--video-id", A, "--delay", "0")
        report = json.loads(self.run_command("channel-report"))
        by_id = {line["videoId"]: line for line in report["videos"]}
        self.assertEqual(by_id[A]["group"], "co-nhac")
        self.assertEqual(by_id[A]["tracks"][0]["title"], "Bài Thử")
        self.assertEqual(by_id[A]["title"], f"Video {A}")
        self.assertEqual(by_id[B]["group"], "can-nghe-lai")
        self.assertIn("chưa có kết quả", by_id[B]["reason"])
        self.assertEqual([song["title"] for song in report["songs"]], ["Bài Thử"])


class ChannelStatusTests(ChannelCommandTestCase):
    def test_reports_each_video(self):
        self.add_audio(A)
        self.mark_scanned(B)
        audit.write_json(self.paths.detections, {url(A): {"group": "co-nhac"}})
        status = json.loads(self.run_command("channel-status"))
        self.assertEqual(status["channel"], "Kênh")
        self.assertEqual(status["maxSeconds"], 3600)
        first, second = status["videos"][:2]
        self.assertEqual((first["videoId"], first["group"], first["hasAudio"], first["scanned"], first["requests"]), (A, "co-nhac", True, False, 5))
        self.assertEqual((second["hasAudio"], second["scanned"]), (False, True))

    def test_needs_video_list_first(self):
        self.paths.all_videos.unlink()
        with self.assertRaises(SystemExit):
            self.run_command("channel-status")


class ChannelCheckTests(ChannelCommandTestCase):
    def test_only_says_yes_or_no_never_the_key(self):
        with mock.patch.dict(os.environ, {"AUDD_API_TOKEN": "khoa-bi-mat", "YOUTUBE_API_KEY": ""}):
            output = self.run_command("channel-check")
        self.assertNotIn("khoa-bi-mat", output)
        result = json.loads(output)
        self.assertTrue(all(isinstance(value, bool) for value in result.values()))
        self.assertEqual((result["auddKey"], result["youtubeKey"]), (True, False))


class ReportJsonTests(unittest.TestCase):
    def test_turns_song_cells_into_a_list(self):
        line = {"Mã video": A, "Tiêu đề video": "T", "Link": url(A), "Thời lượng (giây)": "61", "Nhóm": "co-nhac", "Lý do": "",
                "Máy lọc": "co-nhac", "Giây có nhạc (máy lọc)": "12.0", "Policy": "chua-tra",
                "Bài 1": "X", "Tác giả 1": "Y", "Hãng 1": "", "Library 1": "chua-tra", "Vị trí 1": "00:12"}
        song = {"title": "X", "artist": "Y", "label": "", "library": "chua-tra", "video_count": 2, "seconds": "30"}
        result = report_json([line], [song])
        self.assertEqual(result["videos"][0]["seconds"], 61)
        self.assertEqual(result["videos"][0]["tracks"], [{"title": "X", "artist": "Y", "label": "", "library": "chua-tra", "position": "00:12"}])
        self.assertEqual(result["songs"], [{"title": "X", "artist": "Y", "label": "", "library": "chua-tra", "videoCount": 2, "seconds": 30}])

    def test_unknown_duration_is_zero(self):
        line = {"Mã video": A, "Tiêu đề video": "", "Link": "", "Thời lượng (giây)": "", "Nhóm": "can-nghe-lai", "Lý do": "x",
                "Máy lọc": "", "Giây có nhạc (máy lọc)": "", "Policy": ""}
        self.assertEqual(report_json([line], [])["videos"][0]["seconds"], 0)


class DownloadAudioTests(unittest.TestCase):
    def test_command_is_one_public_video_without_cookies(self):
        command = build_download_command(url(A), "thu-muc")
        self.assertIn("--no-playlist", command)
        self.assertIn("--ignore-config", command)
        self.assertFalse([part for part in command if "cookies" in part])
        self.assertEqual(command[-2:], ["--", url(A)])

    def run_download(self, stderr):
        done = mock.Mock(returncode=1, stderr=stderr)
        with mock.patch("importlib.util.find_spec", return_value=object()), mock.patch("subprocess.run", return_value=done):
            download_audio(url(A), "thu-muc")

    def test_bot_check_stops_the_whole_run(self):
        with self.assertRaises(ExtractStop):
            self.run_download("Sign in to confirm you're not a bot")

    def test_other_errors_only_affect_one_video(self):
        with self.assertRaises(ExtractError) as caught:
            self.run_download("ERROR: Video unavailable")
        self.assertNotIsInstance(caught.exception, ExtractStop)

    def test_missing_yt_dlp_stops_the_whole_run(self):
        with mock.patch("importlib.util.find_spec", return_value=None):
            with self.assertRaises(ExtractStop):
                download_audio(url(A), Path("thu-muc"))
        self.assertIn("yt-dlp", extract.MISSING_YT_DLP_MESSAGE)


if __name__ == "__main__":
    unittest.main()
