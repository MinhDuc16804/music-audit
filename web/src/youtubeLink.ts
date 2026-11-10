const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const VIDEO_PATHS = new Set(['shorts', 'embed', 'live', 'v']);

/** Trả về mã của đúng một video, hoặc chuỗi rỗng nếu là link kênh, playlist hay trang khác. */
export function parseYoutubeVideoId(link: string): string {
  const text = link.trim();
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '';
  }

  const parts = url.pathname.split('/').filter(Boolean);
  let candidate = '';
  if (url.hostname === 'youtu.be') {
    candidate = parts[0] ?? '';
  } else if (VIDEO_HOSTS.has(url.hostname)) {
    if (parts.length === 1 && parts[0] === 'watch') {
      candidate = url.searchParams.get('v') ?? '';
    } else if (parts.length >= 2 && VIDEO_PATHS.has(parts[0])) {
      candidate = parts[1];
    }
  }
  // "videoseries" dài đúng 11 ký tự nhưng là trình phát playlist, không phải video.
  return VIDEO_ID.test(candidate) && candidate !== 'videoseries' ? candidate : '';
}

/** Link chuẩn của video, bỏ list= để không quét nhầm cả playlist. */
export function getVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Link mở video đúng giây đó. Trả về chuỗi rỗng nếu không phải link video, ví dụ tên file tải lên. */
export function getVideoTimeUrl(link: string, seconds: number): string {
  const videoId = parseYoutubeVideoId(link);
  return videoId ? `${getVideoUrl(videoId)}&t=${Math.max(0, Math.floor(seconds))}s` : '';
}
