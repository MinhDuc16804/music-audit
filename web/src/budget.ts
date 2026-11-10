/**
 * Ngân sách AudD theo tháng cho cả app: kiểu dữ liệu server trả về và các phép tính dùng chung giữa server và giao diện.
 * AudD tính tiền theo số yêu cầu, mỗi yêu cầu là 12 giây âm thanh.
 */

import { SCAN_SEGMENT_SECONDS } from './videoCheck.ts';

export type BudgetKind = 'link' | 'file' | 'batch' | 'channel';

export const BUDGET_KIND_LABELS: Record<BudgetKind, string> = {
  link: 'Quét 1 video',
  file: 'Quét file tải lên',
  batch: 'Quét hàng loạt',
  channel: 'Quét cả kênh',
};

export interface BudgetView {
  /** Tháng tính theo giờ Việt Nam, dạng YYYY-MM. */
  month: string;
  /** Ngày cuối tháng, dạng YYYY-MM-DD. */
  monthEnd: string;
  currency: string;
  /** Trần chi phí mỗi tháng. */
  amount: number;
  pricePer1000: number;
  warnPercent: number;
  /** Số yêu cầu mà trần chi phí mua được. */
  budgetRequests: number;
  /** Yêu cầu đã tính, gồm cả phần đang giữ chỗ. */
  chargedRequests: number;
  /** Yêu cầu đang giữ chỗ cho các lượt quét chưa xong. */
  heldRequests: number;
  byUser: { user: string; requests: number }[];
  byKind: { kind: BudgetKind; requests: number }[];
}

export type BudgetState = 'ok' | 'warn' | 'full';

/** Số yêu cầu AudD cho từng ấy giây âm thanh, không vượt trần mỗi lần quét. Chưa biết độ dài thì tính trần. */
export function requestsForSeconds(seconds: number, maxSeconds: number): number {
  const length = seconds > 0 ? Math.min(seconds, maxSeconds) : maxSeconds;
  return Math.max(1, Math.ceil(length / SCAN_SEGMENT_SECONDS));
}

export function costOfRequests(requests: number, pricePer1000: number): number {
  return (requests * pricePer1000) / 1000;
}

/** Số yêu cầu còn được gửi trong tháng. */
export function remainingBudgetRequests(view: BudgetView): number {
  return Math.max(0, view.budgetRequests - view.chargedRequests);
}

/** Đã chi thật, chưa tính phần đang giữ chỗ. */
export function spentRequests(view: BudgetView): number {
  return Math.max(0, view.chargedRequests - view.heldRequests);
}

export function budgetState(view: BudgetView): BudgetState {
  if (remainingBudgetRequests(view) === 0) {
    return 'full';
  }
  return view.budgetRequests > 0 && (view.chargedRequests / view.budgetRequests) * 100 >= view.warnPercent ? 'warn' : 'ok';
}

/** Phần trăm ngân sách, giới hạn trong 0 đến 100. */
export function budgetPercent(requests: number, view: BudgetView): number {
  return view.budgetRequests > 0 ? Math.min(100, Math.max(0, (requests / view.budgetRequests) * 100)) : 100;
}

/** Tiền có hai chữ số lẻ theo kiểu Việt Nam, như "42,50 USD". */
export function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** Khoảng ngày của tháng ngân sách, như "01/11 đến 30/11/2026". */
export function formatBudgetRange(view: BudgetView): string {
  const [year, month, lastDay] = view.monthEnd.split('-');
  return `01/${month} đến ${lastDay}/${month}/${year}`;
}

/** Số ngày còn lại tới hết tháng theo giờ Việt Nam, tính cả hôm nay. */
export function budgetDaysLeft(view: BudgetView, now: Date): number {
  const end = new Date(`${view.monthEnd}T23:59:59.999+07:00`).getTime();
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}

/** Ngày đầu tháng sau, lúc ngân sách được làm mới, như "01/12". */
export function budgetResetDay(view: BudgetView): string {
  const [year, month] = view.month.split('-').map(Number);
  return `01/${String((month % 12) + 1).padStart(2, '0')}${month === 12 ? `/${year + 1}` : ''}`;
}

/** Có trong mọi câu báo hết ngân sách, để quét hàng loạt nhận ra mà tạm dừng cả lô. */
export const BUDGET_REFUSAL_TEXT = 'ngân sách tháng chỉ còn';

/** Câu báo khi ngân sách không đủ cho một lượt quét. */
export function budgetRefusal(needed: number, view: BudgetView): string {
  const left = remainingBudgetRequests(view);
  const money = (requests: number) => formatMoney(costOfRequests(requests, view.pricePer1000), view.currency);
  return `Lượt quét cần tối đa ${needed} yêu cầu AudD (${money(needed)}), nhưng ${BUDGET_REFUSAL_TEXT} ${left} yêu cầu (${money(left)}). Hãy quét ít hơn, hoặc nhờ người quản trị tăng AUDD_MONTHLY_BUDGET.`;
}
