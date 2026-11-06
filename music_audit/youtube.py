"""Lấy danh sách video công khai của kênh qua YouTube Data API, quyền chỉ đọc."""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://www.googleapis.com/youtube/v3"
_DURATION = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


class YoutubeError(Exception):
    """Lỗi từ API. Không bao giờ chứa API key."""


def parse_duration(value):
    """Đổi độ dài ISO 8601 (PT1H2M3S) thành số giây."""
    match = _DURATION.match(value or "")
    if not match:
        return 0
    days, hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def channel_filter(channel):
    """Nhận link kênh, @handle hoặc mã UC… và trả về tham số truy vấn tương ứng."""
    channel = channel.strip().rstrip("/")
    tail = channel.rsplit("/", 1)[-1]
    if tail.startswith("UC") and len(tail) == 24:
        return {"id": tail}
    if tail.startswith("@"):
        return {"forHandle": tail}
    raise YoutubeError(f"Không hiểu kênh '{channel}'. Hãy dùng link có @handle hoặc mã UC…")


class YoutubeClient:
    def __init__(self, api_key, base_url=API_BASE):
        if not api_key:
            raise YoutubeError("Chưa có YOUTUBE_API_KEY trong file .env")
        self._key = api_key
        self._base = base_url

    def _get(self, path, params):
        query = urllib.parse.urlencode({**params, "key": self._key})
        try:
            with urllib.request.urlopen(f"{self._base}/{path}?{query}", timeout=60) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise YoutubeError(f"YouTube API trả lỗi {error.code} ở {path}") from None
        except urllib.error.URLError as error:
            raise YoutubeError(f"Không kết nối được YouTube API: {error.reason}") from None

    def list_channel_videos(self, channel):
        """Trả về danh sách video của kênh kèm độ dài và lượt xem."""
        found = self._get("channels", {"part": "snippet,contentDetails", **channel_filter(channel)})
        items = found.get("items") or []
        if not items:
            raise YoutubeError(f"Không tìm thấy kênh '{channel}'")
        title = items[0]["snippet"]["title"]
        uploads = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

        video_ids = []
        token = None
        while True:
            params = {"part": "contentDetails", "playlistId": uploads, "maxResults": 50}
            if token:
                params["pageToken"] = token
            page = self._get("playlistItems", params)
            video_ids += [item["contentDetails"]["videoId"] for item in page.get("items", [])]
            token = page.get("nextPageToken")
            if not token:
                break

        videos = []
        for start in range(0, len(video_ids), 50):
            batch = ",".join(video_ids[start : start + 50])
            page = self._get("videos", {"part": "snippet,contentDetails,statistics", "id": batch})
            for item in page.get("items", []):
                videos.append(
                    {
                        "channel": title,
                        "video_id": item["id"],
                        "url": f"https://www.youtube.com/watch?v={item['id']}",
                        "title": item["snippet"]["title"],
                        "published_at": item["snippet"]["publishedAt"],
                        "duration_seconds": parse_duration(item["contentDetails"].get("duration")),
                        "view_count": item.get("statistics", {}).get("viewCount", ""),
                    }
                )
        return videos
