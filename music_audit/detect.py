"""Lọc trước video có nhạc hay không, chạy trên máy bằng mô hình YAMNet của Google (không tốn lượt AudD).

Chỉ có 2 nhóm:
- "khong-nhac": cả video chỉ có tiếng máy và/hoặc tiếng người nói.
- "co-nhac": có nhạc ở bất kỳ mức to nhỏ nào, kể cả vài giây. Phân vân cũng là "co-nhac".

Ngưỡng mặc định nghiêng hẳn về "co-nhac": báo dư chỉ tốn thêm lượt AudD, bỏ sót có thể bị strike.
Phần chấm điểm (classify_frames) không cần mô hình nên kiểm thử được; mô hình chỉ nạp khi chạy thật.
"""

import csv
import subprocess
from dataclasses import dataclass
from pathlib import Path

from music_audit.extract import find_ffmpeg

CO_NHAC = "co-nhac"
KHONG_NHAC = "khong-nhac"

SAMPLE_RATE = 16000
WINDOW = 15600  # 0,975 giây, kích thước đầu vào của YAMNet
HOP = 7800  # trượt nửa cửa sổ: mỗi cửa sổ đại diện 0,4875 giây
HOP_SECONDS = HOP / SAMPLE_RATE

# Nhánh "Music" của AudioSet trong bảng lớp YAMNet: từ "Music" (132) đến "Scary music" (276),
# gồm nhạc cụ, thể loại và tâm trạng nhạc. Kiểm tra lại bằng bảng lớp khi nạp mô hình.
MUSIC_FIRST, MUSIC_LAST = 132, 276

# Ngưỡng mặc định, chỉnh bằng tham số lệnh detect-music sau khi đo trên video đã biết.
# Nhạc thật chạy liền mạch (outro 4 giây vẫn là một đoạn liền); tiếng máy bị nhận nhầm là nhạc thì lẻ tẻ
# từng khoảnh khắc. Vì vậy xét đoạn liền mạch dài nhất, cộng thêm tổng thời gian để bắt nhạc nhỏ chập chờn.
FRAME_THRESHOLD = 0.15  # cửa sổ có điểm nhạc từ mức này là "nghe thấy nhạc"
MIN_RUN_SECONDS = 1.5  # một đoạn nghe thấy nhạc liền mạch dài từ mức này thì video có nhạc
MIN_TOTAL_SECONDS = 5.0  # hoặc tổng thời gian nghe thấy nhạc (kể cả rời rạc) từ mức này
GAP_WINDOWS = 1  # cho phép hụt 1 cửa sổ (khoảng nửa giây) giữa đoạn mà vẫn tính là liền mạch
# Intro và outro của kênh là nhạc của kênh: không tính là có nhạc (anh Dương quyết định 07/11/2026).
# Nhạc trong khoảng này chỉ được ghi lại để xem, không quyết định nhóm. Nhạc chạy cả phần thân vẫn bị bắt.
INTRO_SECONDS = 8.0
OUTRO_SECONDS = 8.0


class DetectError(Exception):
    pass


@dataclass
class Verdict:
    group: str
    music_seconds: float
    max_score: float
    peak_at: float  # giây có điểm nhạc cao nhất, để người nghe mở đúng chỗ
    duration: float
    top_sound: str = ""


def longest_run(hits, gap=GAP_WINDOWS):
    """Số cửa sổ của đoạn nghe thấy nhạc dài nhất, cho phép hụt tối đa `gap` cửa sổ liên tiếp ở giữa."""
    best = run = misses = 0
    for hit in hits:
        if hit:
            run += 1 + (misses if run else 0)
            misses = 0
            best = max(best, run)
        elif run:
            misses += 1
            if misses > gap:
                run = misses = 0
    return best


@dataclass
class FrameResult:
    group: str
    music_seconds: float  # tổng giây nghe thấy nhạc ở phần thân video (ngoài intro, outro)
    longest_run: float  # đoạn nhạc liền mạch dài nhất ở phần thân, tính bằng giây
    max_score: float
    peak_at: float  # giây có điểm nhạc cao nhất ở phần thân
    edge_seconds: float  # giây nghe thấy nhạc trong intro và outro (không tính)


def classify_frames(scores, threshold=FRAME_THRESHOLD, min_run=MIN_RUN_SECONDS, min_total=MIN_TOTAL_SECONDS,
                    intro=INTRO_SECONDS, outro=OUTRO_SECONDS):
    """scores: điểm nhạc của từng cửa sổ (0-1). Bỏ qua `intro` giây đầu và `outro` giây cuối khi quyết định."""
    if not scores:
        # Không đọc được âm thanh thì không được kết luận "không nhạc".
        return FrameResult(CO_NHAC, 0.0, 0.0, 0.0, 0.0, 0.0)
    hits = [score >= threshold for score in scores]
    first = min(len(scores), int(round(intro / HOP_SECONDS)))
    last = max(first, len(scores) - int(round(outro / HOP_SECONDS)))
    body = hits[first:last]
    heard = sum(body) * HOP_SECONDS
    run = longest_run(body) * HOP_SECONDS
    edge = (sum(hits) - sum(body)) * HOP_SECONDS
    if body:
        peak_index = max(range(first, last), key=scores.__getitem__)
        max_score, peak_at = scores[peak_index], peak_index * HOP_SECONDS
    else:
        max_score = peak_at = 0.0
    group = CO_NHAC if run >= min_run or heard >= min_total else KHONG_NHAC
    return FrameResult(group, heard, run, max_score, peak_at, edge)


CLIP_SECONDS = 11.9  # dưới 12 giây một chút để AudD tính đúng 1 lượt cho mỗi đoạn
MAX_CLIPS = 30
STEP_SECONDS = 45  # cứ 45 giây xét một đoạn (quản lý dự án quyết định 09/11/2026)


def clip_starts(scores, max_clips=MAX_CLIPS, step_seconds=STEP_SECONDS, clip_seconds=CLIP_SECONDS,
                threshold=FRAME_THRESHOLD, min_music=MIN_RUN_SECONDS, intro=INTRO_SECONDS, outro=OUTRO_SECONDS):
    """Giây bắt đầu của các đoạn gửi AudD: rải đều mỗi 45 giây, chỉ giữ đoạn có nhạc.

    Lưới bắt đầu ngay sau intro và không chạm outro. Không ô nào có nhạc (nhạc nằm lọt giữa hai ô)
    thì lấy một đoạn ở chỗ điểm nhạc cao nhất, vì video đã được máy lọc xếp là có nhạc.
    """
    if not scores:
        return []
    width = max(1, int(clip_seconds / HOP_SECONDS))
    first = min(len(scores), int(round(intro / HOP_SECONDS)))
    last = max(first, len(scores) - int(round(outro / HOP_SECONDS)))
    if last - first < width:  # video quá ngắn: một đoạn duy nhất
        span = range(min(first, max(0, len(scores) - width)), min(first, max(0, len(scores) - width)) + 1)
    else:
        span = range(first, last - width + 1)
    step = max(1, int(round(step_seconds / HOP_SECONDS)))
    kept = [i for i in span[::step]
            if sum(score >= threshold for score in scores[i : i + width]) * HOP_SECONDS >= min_music]
    if not kept:
        kept = [max(span, key=lambda i: sum(scores[i : i + width]))]
    if len(kept) > max_clips:  # quá giới hạn thì lấy rải đều trong các đoạn đã chọn
        last_index = len(kept) - 1
        kept = [kept[round(n * last_index / max(1, max_clips - 1))] for n in range(max_clips)]
    return [round(i * HOP_SECONDS, 2) for i in kept]


def cut_clip(source, start, target, seconds=CLIP_SECONDS):
    """Cắt một đoạn âm thanh thành mp3 mono (cần ffmpeg)."""
    command = [find_ffmpeg() or "ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", str(source), "-t", f"{seconds}",
               "-vn", "-ac", "1", "-b:a", "128k", str(target)]
    try:
        subprocess.run(command, capture_output=True, check=True)
    except FileNotFoundError as error:
        raise DetectError("Chưa có ffmpeg trong PATH (ffmpeg được cài kèm yt-dlp; mở terminal mới rồi chạy lại).") from error
    except subprocess.CalledProcessError as error:
        raise DetectError(f"ffmpeg không cắt được {Path(source).name}: {error.stderr.decode(errors='replace').strip()}")
    return target


def mmss(seconds):
    seconds = int(round(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def read_waveform(path):
    """Giải mã file âm thanh thành mono 16 kHz, số thực -1..1 (cần ffmpeg)."""
    import numpy as np

    command = [find_ffmpeg() or "ffmpeg", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    try:
        pcm = subprocess.run(command, capture_output=True, check=True).stdout
    except FileNotFoundError as error:
        raise DetectError("Chưa có ffmpeg trong PATH (ffmpeg được cài kèm yt-dlp; mở terminal mới rồi chạy lại).") from error
    except subprocess.CalledProcessError as error:
        raise DetectError(f"ffmpeg không đọc được {Path(path).name}: {error.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(pcm, dtype=np.float32)


class YamnetDetector:
    def __init__(self, models_dir):
        models_dir = Path(models_dir)
        model, class_map = models_dir / "yamnet.tflite", models_dir / "yamnet_class_map.csv"
        if not model.exists() or not class_map.exists():
            raise DetectError(f"Thiếu mô hình trong {models_dir}. Xem README phần Lọc trước có nhạc hay không.")
        try:
            from ai_edge_litert.interpreter import Interpreter
        except ImportError as error:
            raise DetectError("Chưa cài thư viện: python -m pip install -r requirements-detect.txt") from error
        with class_map.open(encoding="utf-8") as handle:
            self.names = [row["display_name"] for row in csv.DictReader(handle)]
        if self.names[MUSIC_FIRST] != "Music" or self.names[MUSIC_LAST] != "Scary music":
            raise DetectError("Bảng lớp YAMNet khác bản đã kiểm tra: nhánh Music không còn ở vị trí 132-276.")
        self.interpreter = Interpreter(model_path=str(model))
        self.interpreter.allocate_tensors()
        self.input = self.interpreter.get_input_details()[0]["index"]
        self.output = self.interpreter.get_output_details()[0]["index"]

    def frame_scores(self, wave):
        """Điểm nhạc (lớp nhạc cao nhất) và tên âm thanh nổi bật nhất của từng cửa sổ."""
        import numpy as np

        music, top = [], []
        last_start = max(0, len(wave) - WINDOW)
        for start in range(0, last_start + 1, HOP):
            chunk = wave[start : start + WINDOW]
            if len(chunk) < WINDOW:
                chunk = np.pad(chunk, (0, WINDOW - len(chunk)))
            self.interpreter.set_tensor(self.input, np.ascontiguousarray(chunk, dtype=np.float32))
            self.interpreter.invoke()
            scores = self.interpreter.get_tensor(self.output)[0]
            music.append(float(scores[MUSIC_FIRST : MUSIC_LAST + 1].max()))
            top.append(int(scores.argmax()))
        return music, top

    def detect(self, path, **thresholds):
        wave = read_waveform(path)
        if len(wave) == 0:
            raise DetectError(f"{Path(path).name} không có âm thanh đọc được")
        music, top = self.frame_scores(wave)
        result = classify_frames(music, **thresholds)
        common = max(set(top), key=top.count) if top else None
        return Verdict(result.group, result.music_seconds, result.max_score, result.peak_at, len(wave) / SAMPLE_RATE,
                       self.names[common] if common is not None else "")
