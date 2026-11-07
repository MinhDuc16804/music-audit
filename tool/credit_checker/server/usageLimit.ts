/**
 * Giới hạn số lượt quét mỗi ngày của từng người và ghi lại ai đã quét, vì cả công ty dùng chung một khóa AudD.
 * Tên người dùng lấy từ header của Cloudflare Access, nên chỉ tin được khi app nằm sau Access.
 * Bộ đếm nằm trong bộ nhớ: khởi động lại app thì đếm lại từ đầu.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
const UNKNOWN_USER = 'khong-ro';
const DEFAULT_MAX_SCANS_PER_DAY = 30;

export interface UsageEntry {
  time: string;
  user: string;
  kind: 'link' | 'file';
  target: string;
  outcome: 'done' | 'error' | 'limited';
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

export function createDailyLimiter(maxPerDay: number, getToday: () => string = () => new Date().toISOString().slice(0, 10)) {
  let day = '';
  let counts = new Map<string, number>();

  /** Tính một lượt cho người này. Trả về false nếu đã hết lượt trong ngày. */
  return (user: string): boolean => {
    const today = getToday();
    if (today !== day) {
      day = today;
      counts = new Map();
    }
    const used = counts.get(user) ?? 0;
    if (used >= maxPerDay) {
      return false;
    }
    counts.set(user, used + 1);
    return true;
  };
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
