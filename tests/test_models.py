"""Tải mô hình YAMNet: chỉ nhận đúng bản đã kiểm mã băm."""

import hashlib
import tempfile
import unittest
from pathlib import Path

from music_audit.models import download_models, ModelError


def sha(data):
    return hashlib.sha256(data).hexdigest()


class DownloadModelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.source = self.tmp / "nguon.bin"
        self.source.write_bytes(b"mo hinh that")
        self.target = self.tmp / "models"

    def files(self, expected):
        return {"yamnet.tflite": (self.source.as_uri(), expected)}

    def test_downloads_file_with_matching_hash(self):
        self.assertEqual(download_models(self.target, self.files(sha(b"mo hinh that"))), ["yamnet.tflite"])
        self.assertEqual((self.target / "yamnet.tflite").read_bytes(), b"mo hinh that")

    def test_skips_file_that_already_matches(self):
        download_models(self.target, self.files(sha(b"mo hinh that")))
        self.assertEqual(download_models(self.target, self.files(sha(b"mo hinh that"))), [])

    def test_wrong_hash_is_refused_and_removed(self):
        self.target.mkdir()
        (self.target / "yamnet.tflite").write_bytes(b"ban cu sai")
        with self.assertRaises(ModelError):
            download_models(self.target, self.files(sha(b"ban khac")))
        self.assertEqual(list(self.target.iterdir()), [], "không để lại file sai hay file tải dở")

    def test_unreachable_source_reports_error(self):
        missing = {"yamnet.tflite": ((self.tmp / "khong-co.bin").as_uri(), sha(b""))}
        with self.assertRaises(ModelError):
            download_models(self.target, missing)


if __name__ == "__main__":
    unittest.main()
