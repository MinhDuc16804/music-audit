/** Đọc độ dài file ngay trong trình duyệt, không cần gửi file đi và không cần ffmpeg. */

const READ_TIMEOUT_MS = 10_000;

export interface MediaElementLike {
  preload: string;
  src: string;
  duration: number;
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
}

/** Trả về số giây, hoặc undefined nếu trình duyệt không đọc được định dạng này. */
export function readMediaDuration(
  file: File,
  createElement: () => MediaElementLike = () => document.createElement('video') as unknown as MediaElementLike,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const element = createElement();
    const url = URL.createObjectURL(file);
    const finish = (seconds?: number) => {
      clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(), READ_TIMEOUT_MS);

    element.onloadedmetadata = () => {
      const { duration } = element;
      finish(Number.isFinite(duration) && duration > 0 ? duration : undefined);
    };
    element.onerror = () => finish();
    element.preload = 'metadata';
    element.src = url;
  });
}
