"""Gọi Enterprise API của AudD và đổi kết quả sang dạng Scan chung của công cụ.

AudD chỉ trả về các đoạn khớp bài hát, không có tín hiệu "không có nhạc". Vì vậy không khớp bài nào
là chưa biết, không bao giờ được hiểu là không có nhạc.
Chỉ dùng thư viện chuẩn của Python.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from music_audit.acrcloud import _multipart
from music_audit.evaluate import Scan, normalize_title

ENTERPRISE_URL = "https://enterprise.audd.io/"
CHUNK_SECONDS = 12
REQUEST_TIMEOUT_SECONDS = 900
FRIENDLY_ERRORS = {
    900: "Khóa AudD không hợp lệ. Hãy kiểm tra AUDD_API_TOKEN trong file .env.",
    901: "Đã hết lượt miễn phí của AudD hoặc thiếu khóa.",
    904: "Gói AudD hiện tại chưa cho quét bằng link. Hãy tải file lên, hoặc nâng lên gói trả phí.",
    600: "AudD không đọc được âm thanh từ link này.",
    500: "AudD không đọc được file âm thanh này.",
    300: "File quá ngắn hoặc không đọc được âm thanh.",
}


class AuddError(Exception):
    """Lỗi từ API. Không bao giờ chứa khóa."""


class AuddClient:
    def __init__(self, token, base_override=None):
        if not token:
            raise AuddError("Chưa có AUDD_API_TOKEN trong file .env")
        self._token = token
        self._url = base_override or ENTERPRISE_URL

    def _post(self, body, content_type):
        # Không tự thử lại: mỗi lần gửi đều bị tính phí theo thời lượng âm thanh.
        request = urllib.request.Request(self._url, data=body, headers={"Content-Type": content_type}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raise AuddError(f"AudD trả lỗi HTTP {error.code}") from None
        except urllib.error.URLError as error:
            raise AuddError(f"Không kết nối được AudD: {error.reason}") from None
        except TimeoutError:
            raise AuddError("AudD không trả lời kịp. Video quá dài thì hãy giảm AUDD_MAX_CHUNKS.") from None
        try:
            data = json.loads(raw)
        except ValueError:
            raise AuddError("AudD trả về dữ liệu không đọc được") from None
        if data.get("status") != "success":
            raise AuddError(self._error_message(data))
        # Chỉ giữ kết quả. Phản hồi của AudD có thể chép lại tham số đã gửi, gồm cả khóa.
        return {"status": "success", "result": data.get("result") or []}

    def _error_message(self, data):
        error = data.get("error") or {}
        code = error.get("error_code")
        message = FRIENDLY_ERRORS.get(code) or str(error.get("error_message") or "Lỗi không xác định")
        return f"AudD báo lỗi {code}: {message.replace(self._token, '[KHÓA]')[:300]}"

    def recognize_url(self, url, limit):
        body = urllib.parse.urlencode({"api_token": self._token, "url": url, "limit": limit}).encode("utf-8")
        return self._post(body, "application/x-www-form-urlencoded")

    def recognize_file(self, path, limit):
        path = Path(path)
        boundary = uuid.uuid4().hex
        fields = {"api_token": self._token, "limit": limit}
        body = _multipart(boundary, fields, "file", path.name, path.read_bytes())
        return self._post(body, f"multipart/form-data; boundary={boundary}")


def _split_artists(artist):
    """AudD gộp nghệ sĩ vào một chuỗi. Giữ cả chuỗi gốc vì có tên chứa dấu &, như Simon & Garfunkel."""
    parts = re.split(r",|&|\bfeat\.?\s|\bft\.?\s", artist, flags=re.IGNORECASE)
    return list(dict.fromkeys([artist, *(part.strip() for part in parts if part.strip())]))


def parse_audd(raw):
    """Đổi kết quả AudD thành Scan. Gộp các đoạn của cùng một bài, tính theo tên bài và nghệ sĩ."""
    best = {}
    for chunk in raw.get("result") or []:
        for song in chunk.get("songs") or []:
            title = song.get("title") or ""
            artist = song.get("artist") or ""
            if not title and not artist:
                continue
            key = (normalize_title(title) or title, normalize_title(artist) or artist)
            score = song.get("score") or 0
            current = best.get(key)
            if current is None:
                best[key] = {
                    "title": title,
                    "artists": artist,
                    "artist_names": _split_artists(artist),
                    "label": song.get("label") or "",
                    "score": score,
                    "played_duration": CHUNK_SECONDS,
                    "kind": "music",
                    "isrc": song.get("isrc") or "",
                }
            else:
                current["score"] = max(current["score"], score)
                current["played_duration"] += CHUNK_SECONDS

    tracks = sorted(best.values(), key=lambda track: -track["played_duration"])
    return Scan(state=1, tracks=tracks, music="yes" if tracks else "unknown")
