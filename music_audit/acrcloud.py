"""Gọi File Scanning API của ACRCloud. Chỉ dùng thư viện chuẩn của Python."""

import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

CONSOLE_BASE = "https://api-v2.acrcloud.com/api"
MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024
RETRY_STATUSES = {429, 500, 502, 503, 504}


class AcrError(Exception):
    """Lỗi từ API. Không bao giờ chứa token."""


class AcrClient:
    def __init__(self, token, base_override=None, retries=3, backoff_seconds=2.0):
        if not token:
            raise AcrError("Chưa có ACRCLOUD_ACCESS_TOKEN trong file .env")
        self._token = token
        self._base_override = base_override
        self._retries = retries
        self._backoff = backoff_seconds

    def _console_base(self):
        return self._base_override or CONSOLE_BASE

    def _regional_base(self, region):
        return self._base_override or f"https://api-{region}.acrcloud.com/api"

    def _request(self, method, url, body=None, content_type=None):
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        for attempt in range(self._retries + 1):
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    raw = response.read()
                return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as error:
                if error.code in RETRY_STATUSES and attempt < self._retries:
                    time.sleep(self._backoff * (2**attempt))
                    continue
                detail = error.read().decode("utf-8", "replace")[:300]
                raise AcrError(f"ACRCloud trả lỗi {error.code}: {detail}") from None
            except urllib.error.URLError as error:
                if attempt < self._retries:
                    time.sleep(self._backoff * (2**attempt))
                    continue
                raise AcrError(f"Không kết nối được ACRCloud: {error.reason}") from None
        raise AcrError("Hết số lần thử")

    def create_container(self, name, region, audio_type="linein", engine=1):
        payload = {
            "name": name,
            "region": region,
            "audio_type": audio_type,
            "buckets": ["ACRCloud Music"],
            "engine": engine,
            "music_detection": 1,
            "policy": {"type": "traverse", "interval": 0, "rec_length": 10},
        }
        response = self._request(
            "POST",
            f"{self._console_base()}/fs-containers",
            body=json.dumps(payload).encode("utf-8"),
            content_type="application/json",
        )
        return response["data"]

    def get_container(self, container_id):
        response = self._request("GET", f"{self._console_base()}/fs-containers/{container_id}")
        return response["data"]

    def submit_url(self, region, container_id, url):
        body = json.dumps({"data_type": "platforms", "url": url}).encode("utf-8")
        response = self._request(
            "POST",
            f"{self._regional_base(region)}/fs-containers/{container_id}/files",
            body=body,
            content_type="application/json",
        )
        return _file_id(response)

    def submit_audio(self, region, container_id, path):
        path = Path(path)
        if path.stat().st_size > MAX_DIRECT_UPLOAD_BYTES:
            raise AcrError(f"File {path.name} lớn hơn 100 MB, chưa hỗ trợ tải trực tiếp")
        boundary = uuid.uuid4().hex
        body = _multipart(boundary, {"data_type": "audio"}, "file", path.name, path.read_bytes())
        response = self._request(
            "POST",
            f"{self._regional_base(region)}/fs-containers/{container_id}/files",
            body=body,
            content_type=f"multipart/form-data; boundary={boundary}",
        )
        return _file_id(response)

    def get_files(self, region, container_id, file_ids):
        joined = ",".join(file_ids)
        response = self._request(
            "GET", f"{self._regional_base(region)}/fs-containers/{container_id}/files/{joined}"
        )
        data = response.get("data") or []
        return data if isinstance(data, list) else [data]


def _file_id(response):
    data = response.get("data") or {}
    file_id = data.get("id") or data.get("file_id")
    if not file_id:
        raise AcrError("ACRCloud không trả về mã file")
    return file_id


def _multipart(boundary, fields, file_field, filename, content):
    parts = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    safe_name = filename.replace('"', "_")
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
    )
    parts.append(content)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts)
