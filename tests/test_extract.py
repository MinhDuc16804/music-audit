"""Kiểm thử việc tách âm thanh, không gọi YouTube."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from music_audit import extract
from music_audit.extract import ExtractError, build_command, extract_audio, friendly_message, parse_output

URL = "https://www.youtube.com/watch?v=abcdefghijk"


class BuildCommandTests(unittest.TestCase):
    def test_only_one_video_without_local_config(self):
        command = build_command(URL, "thu-muc", 3600, "ffmpeg.exe")
        self.assertIn("--no-playlist", command)
        self.assertIn("--ignore-config", command)
        self.assertNotIn("--cookies", command)

    def test_url_cannot_be_read_as_an_option(self):
        command = build_command(URL, "thu-muc", 3600, "ffmpeg.exe")
        self.assertEqual(command[-2:], ["--", URL])

    def test_download_stops_at_scan_limit(self):
        command = build_command(URL, "thu-muc", 1200, "ffmpeg.exe")
        self.assertEqual(command[command.index("--download-sections") + 1], "*0-1200")


class ParseOutputTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.audio = Path(folder.name) / "audio.mp3"
        self.audio.write_bytes(b"mp3")

    def test_reads_duration_and_path(self):
        result = parse_output(f"125\n{self.audio}\n")
        self.assertEqual((result.duration, result.path), (125.0, self.audio))

    def test_unknown_duration_is_zero(self):
        self.assertEqual(parse_output(f"NA\n{self.audio}\n").duration, 0.0)

    def test_missing_file_or_empty_output_is_an_error(self):
        with self.assertRaises(ExtractError):
            parse_output("125\nkhong-co-file.mp3\n")
        with self.assertRaises(ExtractError):
            parse_output("")


class FriendlyMessageTests(unittest.TestCase):
    def test_known_errors(self):
        self.assertIn("riêng tư", friendly_message("ERROR: [youtube] abc: Private video. Sign in"))
        self.assertIn("đã bị gỡ", friendly_message("ERROR: Video unavailable"))
        self.assertIn("đã bị gỡ", friendly_message("ERROR: [youtube] abc: This video is unavailable"))
        self.assertIn("chặn", friendly_message("Sign in to confirm you're not a bot"))

    def test_unknown_error_hides_original_text(self):
        message = friendly_message(r"ERROR: C:\Users\PC\bi-mat\audio.mp3 bị lỗi")
        self.assertEqual(message, extract.DEFAULT_MESSAGE)


class ExtractAudioTests(unittest.TestCase):
    def test_missing_yt_dlp_is_reported(self):
        with mock.patch("importlib.util.find_spec", return_value=None):
            with self.assertRaisesRegex(ExtractError, "yt-dlp"):
                extract_audio(URL, "thu-muc", 3600)

    def test_missing_ffmpeg_is_reported(self):
        with mock.patch.dict(os.environ, {"FFMPEG_LOCATION": ""}), mock.patch("shutil.which", return_value=None):
            with mock.patch("importlib.util.find_spec", return_value=object()):
                with self.assertRaisesRegex(ExtractError, "ffmpeg"):
                    extract_audio(URL, "thu-muc", 3600)

    def test_timeout_is_reported(self):
        with mock.patch.dict(os.environ, {"FFMPEG_LOCATION": "ffmpeg.exe"}):
            with mock.patch("importlib.util.find_spec", return_value=object()):
                error = subprocess.TimeoutExpired("yt-dlp", 1)
                with mock.patch("subprocess.run", side_effect=error):
                    with self.assertRaisesRegex(ExtractError, "quá lâu"):
                        extract_audio(URL, "thu-muc", 3600)


if __name__ == "__main__":
    unittest.main()
