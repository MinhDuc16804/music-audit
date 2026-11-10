/**
 * Lịch sử quét: đọc nhật ký sử dụng rồi ghép với kết quả AudD đã lưu. Chỉ đọc file, không gửi gì cho AudD.
 */

import { parseUsageLog } from '../src/history.ts';
import type { HistoryEntry, HistoryResult } from '../src/history.ts';

export const HISTORY_ROUTE = '/api/history';

export interface HistoryReaderDeps {
  /** Nội dung nhật ký, chuỗi rỗng nếu chưa có. */
  readLog: () => Promise<string>;
  /** Kết quả đã lưu theo mã, mã không còn kết quả thì không có trong kết quả trả về. */
  readResults: (keys: string[]) => Promise<Record<string, HistoryResult>>;
}

export async function readHistory({ readLog, readResults }: HistoryReaderDeps): Promise<HistoryEntry[]> {
  const entries = parseUsageLog(await readLog());
  const keys = [...new Set(entries.flatMap(({ resultKey }) => (resultKey ? [resultKey] : [])))];
  // Không đọc được kết quả cũ thì vẫn hiện lịch sử, chỉ thiếu kết luận.
  const results = keys.length ? await readResults(keys).catch(() => ({}) as Record<string, HistoryResult>) : {};
  return entries.map((entry) => (entry.resultKey && results[entry.resultKey] ? { ...entry, result: results[entry.resultKey] } : entry));
}
