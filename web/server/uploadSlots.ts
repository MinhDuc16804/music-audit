/**
 * Giới hạn số file tải lên đang nằm trên máy chủ cùng lúc, tính từ lúc nhận tới khi quét xong.
 * Mỗi file tới 95 MB nằm trong thư mục tạm, nên không chặn thì nhiều người tải cùng lúc có thể làm đầy đĩa.
 */

export const DEFAULT_MAX_ACTIVE_UPLOADS = 3;

/** Biến môi trường trống hoặc sai thì dùng mức mặc định. */
export function parseMaxUploads(value: string | undefined): number {
  const limit = value?.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_ACTIVE_UPLOADS;
}

export function createUploadSlots(max: number) {
  let active = 0;
  return {
    /** Giữ một chỗ. Hết chỗ thì trả về null. Hàm trả về chỉ nhả chỗ một lần dù gọi nhiều lần. */
    take(): (() => void) | null {
      if (active >= max) {
        return null;
      }
      active += 1;
      let isReleased = false;
      return () => {
        if (!isReleased) {
          isReleased = true;
          active -= 1;
        }
      };
    },
    active: () => active,
  };
}
