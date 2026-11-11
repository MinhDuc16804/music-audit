"""Tải mô hình YAMNet cho máy lọc nhạc và kiểm mã băm, để Docker và máy dev luôn dùng đúng một bản đã thử.

Đường dẫn của Google trỏ tới bản mới nhất, nên có thể đổi bất cứ lúc nào. Khác mã băm thì không dùng:
file bị xóa và lệnh báo lỗi, máy lọc sẽ báo thiếu mô hình thay vì chạy với một mô hình chưa kiểm.
"""

import hashlib
import shutil
import urllib.request
from pathlib import Path

# Bản đã dùng khi chỉnh ngưỡng trong detect.py. Đổi bản thì phải chỉnh và thử lại ngưỡng rồi mới đổi mã băm ở đây.
MODEL_FILES = {
    "yamnet.tflite": (
        "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/latest/yamnet.tflite",
        "4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf",
    ),
    "yamnet_class_map.csv": (
        "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv",
        "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2",
    ),
}
DOWNLOAD_TIMEOUT_SECONDS = 120


class ModelError(Exception):
    pass


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download_models(folder, files=MODEL_FILES):
    """Tải từng file chưa có hoặc sai mã băm. Trả về danh sách file đã tải. Sai mã băm thì xóa file và báo lỗi."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    fetched = []
    for name, (url, expected) in files.items():
        target = folder / name
        if target.is_file() and sha256_of(target) == expected:
            continue
        partial = target.with_suffix(target.suffix + ".tai")
        try:
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response, open(partial, "wb") as out:
                shutil.copyfileobj(response, out)
        except OSError as error:
            partial.unlink(missing_ok=True)
            raise ModelError(f"Không tải được {name}: {error}") from None
        actual = sha256_of(partial)
        if actual != expected:
            partial.unlink(missing_ok=True)
            target.unlink(missing_ok=True)
            raise ModelError(f"{name} tải về khác bản đã kiểm (mã băm {actual[:12]}…), không dùng. Google có thể đã đổi mô hình.")
        partial.replace(target)
        fetched.append(name)
    return fetched
