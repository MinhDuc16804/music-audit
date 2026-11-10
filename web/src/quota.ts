/** Phần dùng chung giữa trình duyệt và server cho tab Theo dõi hạn mức. */

import type { BudgetView } from './budget.ts';

const SECONDS_PER_REQUEST = 12;
const DAY_MS = 86_400_000;
export const QUOTA_LOW_PERCENT = 90;
/** 100 yêu cầu là 20 phút âm thanh, gói nhỏ chưa tới 90% vẫn có thể gần hết. */
export const QUOTA_LOW_REMAINING = 100;

/** ok: có số liệu. login: chưa đăng nhập AudD trên máy chủ. missing: máy chủ chưa có công cụ audd. error: không đọc được. */
export type QuotaStatus = 'ok' | 'login' | 'missing' | 'error';

export interface QuotaAccount {
  planName: string;
  total: number;
  used: number;
  remaining: number;
  cycleStart: string;
  cycleEnd: string;
}

export interface QuotaReading {
  status: QuotaStatus;
  account?: QuotaAccount;
  fetchedAt: string;
}

export interface QuotaResponse extends QuotaReading {
  remainingScans: number;
  dailyLimit: number;
  maxChannelRequests: number;
  /** Số yêu cầu AudD người này còn dùng được cho quét cả kênh hôm nay. */
  remainingChannelRequests: number;
  dailyChannelRequests: number;
  /** Ngân sách AudD tháng này của cả app, null nếu chưa bật. */
  budget: BudgetView | null;
}

export function percentUsed(account: QuotaAccount): number {
  return account.total > 0 ? Math.min(100, Math.round((account.used / account.total) * 100)) : 0;
}

export function isQuotaLow(account: QuotaAccount): boolean {
  return account.total > 0 && ((account.used / account.total) * 100 >= QUOTA_LOW_PERCENT || account.remaining < QUOTA_LOW_REMAINING);
}

/** Lượng âm thanh còn quét được, dưới một giờ thì tính theo phút cho dễ hình dung. */
export function audioLeftText(remaining: number): string {
  const minutes = (remaining * SECONDS_PER_REQUEST) / 60;
  if (minutes < 60) {
    return `khoảng ${Math.round(minutes).toLocaleString('vi-VN')} phút âm thanh`;
  }
  return `khoảng ${(Math.round(minutes / 6) / 10).toLocaleString('vi-VN')} giờ âm thanh`;
}

/** Ngày chưa đọc được thì trả về chuỗi rỗng. */
export function formatQuotaDate(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** Số ngày còn lại của chu kỳ, null nếu chưa biết ngày kết thúc. */
export function daysLeft(cycleEnd: string, now: Date): number | null {
  const end = new Date(cycleEnd).getTime();
  return !cycleEnd || Number.isNaN(end) ? null : Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}
