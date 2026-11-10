/**
 * Phần tính toán cho nút Quét lại: kết quả cũ có từ ngày nào và quét lại tốn bao nhiêu yêu cầu AudD.
 */

import { estimateAuddRequests } from './batchScan.ts';
import type { IdentifyResult } from './videoCheck.ts';

const DAY_FORMAT = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Câu cho biết kết quả đang hiện là kết quả cũ. Không đọc được ngày thì không ghi ngày. */
export function savedResultNote(scannedAt = ''): string {
  const time = Date.parse(scannedAt);
  return Number.isNaN(time) ? 'Kết quả đã lưu từ lần quét trước.' : `Kết quả đã lưu từ lần quét ngày ${DAY_FORMAT.format(time)}.`;
}

/** Số yêu cầu AudD nếu quét lại. Chưa biết độ dài thì báo mức tối đa để không báo thiếu chi phí. */
export function getRescanCost({ duration_seconds: duration = 0, max_seconds: maxSeconds = 0 }: Pick<IdentifyResult, 'duration_seconds' | 'max_seconds'>): {
  requests: number;
  isUpperBound: boolean;
} {
  return { requests: estimateAuddRequests(duration, maxSeconds || undefined), isUpperBound: duration <= 0 };
}
