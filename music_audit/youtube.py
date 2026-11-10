"""Lấy danh sách video công khai của kênh qua YouTube Data API, quyền chỉ đọc."""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://www.googleapis.com/youtube/v3"
_DURATION = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_VIDEO_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
_VIDEO_PATHS = {"shorts", "embed", "live", "v"}


class YoutubeError(Exception):
    """Lỗi từ API. Không bao giờ chứa API key."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def parse_duration(value):
    """Đổi độ dài ISO 8601 (PT1H2M3S) thành số giây."""
    match = _DURATION.match(value or "")
    if not match:
        return 0
    days, hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def youtube_video_id(url):
    """Trả về mã của đúng một video, hoặc chuỗi rỗng nếu là link kênh, playlist hay trang khác."""
    url = (url or "").strip()
    try:
        parsed = urllib.parse.urlsplit(url if "://" in url else f"https://{url}")
        host = (parsed.hostname or "").lower()
    except ValueError:
        return ""
    if parsed.scheme not in ("http", "https"):
        return ""
    parts = [part for part in parsed.path.split("/") if part]
    candidate = ""
    if host == "youtu.be":
        candidate = parts[0] if parts else ""
    elif host in _VIDEO_HOSTS:
        if parts == ["watch"]:
            candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
        elif len(parts) >= 2 and parts[0] in _VIDEO_PATHS:
            candidate = parts[1]
    # "videoseries" dài đúng 11 ký tự nhưng là trình phát playlist, không phải video.
    return candidate if _VIDEO_ID.match(candidate) and candidate != "videoseries" else ""


def video_url(video_id):
    """Link chuẩn của video. Bỏ list= để ACRCloud không quét cả playlist."""
    return f"https://www.youtube.com/watch?v={video_id}"


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
            raise YoutubeError(f"YouTube API trả lỗi {error.code} ở {path}", status=error.code) from None
        except urllib.error.URLError as error:
            raise YoutubeError(f"Không kết nối được YouTube API: {error.reason}") from None

    def video_duration(self, video_id):
        """Trả về độ dài của một video tính bằng giây, 0 nếu không tìm thấy."""
        items = self._get("videos", {"part": "contentDetails", "id": video_id}).get("items") or []
        return parse_duration(items[0]["contentDetails"].get("duration")) if items else 0

    def video_durations(self, video_ids):
        """Trả về độ dài của nhiều video, video không tìm thấy thì không có trong kết quả."""
        durations = {}
        for start in range(0, len(video_ids), 50):
            batch = ",".join(video_ids[start : start + 50])
            for item in self._get("videos", {"part": "contentDetails", "id": batch}).get("items") or []:
                durations[item["id"]] = parse_duration(item["contentDetails"].get("duration"))
        return durations

    def video_titles(self, video_ids):
        """Trả về tên của nhiều video, video không tìm thấy thì không có trong kết quả."""
        titles = {}
        for start in range(0, len(video_ids), 50):
            batch = ",".join(video_ids[start : start + 50])
            for item in self._get("videos", {"part": "snippet", "id": batch}).get("items") or []:
                titles[item["id"]] = item["snippet"]["title"]
        return titles

    def _playlist_video_ids(self, playlist_id):
        video_ids = []
        token = None
        while True:
            params = {"part": "contentDetails", "playlistId": playlist_id, "maxResults": 50}
            if token:
                params["pageToken"] = token
            page = self._get("playlistItems", params)
            video_ids += [item["contentDetails"]["videoId"] for item in page.get("items", [])]
            token = page.get("nextPageToken")
            if not token:
                return video_ids

    def _shorts_ids(self, uploads):
        """Mã các video Shorts của kênh. Danh sách Shorts có mã giống danh sách tải lên, đổi UU thành UUSH."""
        try:
            return set(self._playlist_video_ids("UUSH" + uploads[2:]))
        except YoutubeError as error:
            if error.status == 404:  # kênh không có Shorts nào
                return set()
            raise

    def list_channel_videos(self, channel, include_shorts=True):
        """Trả về danh sách video của kênh kèm độ dài và lượt xem."""
        found = self._get("channels", {"part": "snippet,contentDetails", **channel_filter(channel)})
        items = found.get("items") or []
        if not items:
            raise YoutubeError(f"Không tìm thấy kênh '{channel}'")
        title = items[0]["snippet"]["title"]
        uploads = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

        video_ids = self._playlist_video_ids(uploads)
        if not include_shorts:
            shorts = self._shorts_ids(uploads)
            video_ids = [video_id for video_id in video_ids if video_id not in shorts]

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
