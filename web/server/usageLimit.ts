/**
 * Giới hạn số lượt quét mỗi ngày của từng người và ghi lại ai đã quét, vì cả công ty dùng chung một khóa AudD.
 * Tên người dùng lấy từ header của Cloudflare Access, nên chỉ tin được khi app nằm sau Access.
 * Bộ đếm được lưu ra file nếu có truyền nơi lưu, nên khởi động lại app trong ngày vẫn giữ số đã dùng.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
const UNKNOWN_USER = 'khong-ro';
const DEFAULT_MAX_SCANS_PER_DAY = 30;

export interface UsageEntry {
  time: string;
  user: string;
  kind: 'link' | 'file' | 'batch' | 'channel';
  target: string;
  outcome: 'done' | 'error' | 'limited';
  /** Mã tìm lại kết quả đã lưu: mã băm của file tải lên, hoặc mã lần quét kênh. */
  resultId?: string;
  /** Người dùng bấm Quét lại, nên lượt này gửi AudD dù đã có kết quả cũ. */
  rescan?: true;
}

export function getUserEmail(headers: Record<string, string | string[] | undefined>): string {
  const value = headers[ACCESS_EMAIL_HEADER];
  const email = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return email || UNKNOWN_USER;
}

/** Biến môi trường trống hoặc sai thì dùng mức mặc định, để lỗi cấu hình không thành không giới hạn. */
export function parseDailyLimit(value: string | undefined): number {
  const limit = value?.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_MAX_SCANS_PER_DAY;
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Ngày theo giờ Việt Nam, dạng YYYY-MM-DD, để bộ đếm về 0 lúc nửa đêm ở Việt Nam chứ không phải 7 giờ sáng. */
export function getLimitDay(now: Date = new Date()): string {
  return DAY_FORMAT.format(now);
}

/** Số đã dùng trong ngày, lưu ra file để khởi động lại app không đếm lại từ đầu. */
export interface DailyCounts {
  day: string;
  counts: Record<string, number>;
}

export interface DailyStore {
  readSync(): DailyCounts | null;
  write(value: DailyCounts): unknown;
}

export function createDailyLimiter(maxPerDay: number, getToday: () => string = getLimitDay, store?: DailyStore) {
  let day = '';
  let counts = new Map<string, number>();
  let isLoaded = false;

  const startNewDayIfNeeded = () => {
    const today = getToday();
    if (!isLoaded) {
      isLoaded = true;
      const saved = store?.readSync();
      if (saved?.day === today && saved.counts && typeof saved.counts === 'object') {
        day = today;
        counts = new Map(Object.entries(saved.counts).filter(([, count]) => Number.isFinite(count) && count > 0));
        return;
      }
    }
    if (today !== day) {
      day = today;
      counts = new Map();
    }
  };

  const save = () => {
    void store?.write({ day, counts: Object.fromEntries(counts) });
  };

  /** Tính từng ấy lượt cho người này, đủ thì tính hết, không đủ thì trả về false và không tính lượt nào. */
  const take = (user: string, count = 1): boolean => {
    startNewDayIfNeeded();
    const used = counts.get(user) ?? 0;
    if (used + count > maxPerDay) {
      return false;
    }
    counts.set(user, used + count);
    save();
    return true;
  };

  const remaining = (user: string): number => {
    startNewDayIfNeeded();
    return Math.max(0, maxPerDay - (counts.get(user) ?? 0));
  };

  /** Hoàn lại lượt đã giữ nhưng không dùng đến. */
  const release = (user: string, count: number): void => {
    startNewDayIfNeeded();
    counts.set(user, Math.max(0, (counts.get(user) ?? 0) - count));
    save();
  };

  return Object.assign(take, { remaining, release, maxPerDay });
}

/** Lỗi ghi nhật ký không được làm hỏng lượt quét đã xong. */
export async function appendUsage(logPath: string, entry: UsageEntry): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error(`Không ghi được nhật ký sử dụng: ${error instanceof Error ? error.message : String(error)}`);
  }
}
