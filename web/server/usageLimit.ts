/**
 * Ai đang dùng app và nhật ký từng lượt quét, vì cả công ty dùng chung một khóa AudD.
 * Tên người dùng lấy từ header của Cloudflare Access, nên chỉ tin được khi app nằm sau Access.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
const UNKNOWN_USER = 'khong-ro';

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

/** Lỗi ghi nhật ký không được làm hỏng lượt quét đã xong. */
export async function appendUsage(logPath: string, entry: UsageEntry): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error(`Không ghi được nhật ký sử dụng: ${error instanceof Error ? error.message : String(error)}`);
  }
}
