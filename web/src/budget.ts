/**
 * Ngân sách AudD theo tháng cho cả app: kiểu dữ liệu server trả về và các phép tính dùng chung giữa server và giao diện.
 * AudD tính tiền theo số yêu cầu, mỗi yêu cầu là 12 giây âm thanh.
 */

import { SCAN_SEGMENT_SECONDS } from './videoCheck.ts';

/** Trần quét mặc định mỗi video, 300 đoạn 12 giây, khớp DEFAULT_AUDD_MAX_CHUNKS bên Python. */
const DEFAULT_CAP_SECONDS = 3600;

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
  /** Phí gói mỗi tháng, trả cả khi chưa quét gì. */
  planFee: number;
  /** Số yêu cầu đã gồm trong phí gói. */
  planRequests: number;
  /** Giá cho 1.000 yêu cầu vượt gói. */
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
  /** Sổ chi tháng này hỏng: app chặn mọi lượt quét tới khi sửa file. */
  isBroken?: boolean;
}

export type BudgetState = 'ok' | 'warn' | 'full';

/** Số yêu cầu AudD cho từng ấy giây âm thanh, không vượt trần mỗi lần quét. Chưa biết độ dài thì tính trần. */
export function requestsForSeconds(seconds: number, maxSeconds: number): number {
  // Trần sai (0 hay âm) thì không tin, tính theo mặc định 60 phút để không ghi thiếu tiền.
  const cap = maxSeconds > 0 ? maxSeconds : DEFAULT_CAP_SECONDS;
  const length = seconds > 0 ? Math.min(seconds, cap) : cap;
  return Math.max(1, Math.ceil(length / SCAN_SEGMENT_SECONDS));
}

/** Tiền phải trả trong tháng khi đã dùng từng ấy yêu cầu: phí gói cộng phần vượt gói. */
export function monthCost(requests: number, view: Pick<BudgetView, 'planFee' | 'planRequests' | 'pricePer1000'>): number {
  return view.planFee + (Math.max(0, requests - view.planRequests) * view.pricePer1000) / 1000;
}

/** Tiền thêm nếu gửi thêm từng ấy yêu cầu, tính từ số đã dùng trong tháng. Còn trong gói thì không tốn thêm. */
export function extraCost(requests: number, view: BudgetView): number {
  return monthCost(view.chargedRequests + requests, view) - monthCost(view.chargedRequests, view);
}

/** Tiền còn được tiêu trong tháng, đã trừ phần đang giữ chỗ. */
export function remainingMoney(view: BudgetView): number {
  return Math.max(0, view.amount - monthCost(view.chargedRequests, view));
}

/** Số yêu cầu còn lại trong gói, chưa phải trả thêm. */
export function includedLeft(view: BudgetView): number {
  return Math.max(0, view.planRequests - view.chargedRequests);
}

/** Số yêu cầu còn được gửi trong tháng. */
export function remainingBudgetRequests(view: BudgetView): number {
  return view.isBroken ? 0 : Math.max(0, view.budgetRequests - view.chargedRequests);
}

/** Đã chi thật, chưa tính phần đang giữ chỗ. */
export function spentRequests(view: BudgetView): number {
  return Math.max(0, view.chargedRequests - view.heldRequests);
}

export function budgetState(view: BudgetView): BudgetState {
  if (view.isBroken || remainingBudgetRequests(view) === 0) {
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
  const money = (amount: number) => formatMoney(amount, view.currency);
  return `Lượt quét cần tối đa ${needed} yêu cầu AudD (${money(extraCost(needed, view))}), nhưng ${BUDGET_REFUSAL_TEXT} ${left} yêu cầu (${money(remainingMoney(view))}). Hãy quét ít hơn, hoặc nhờ người quản trị tăng AUDD_MONTHLY_BUDGET.`;
}
