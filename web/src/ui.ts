/**
 * Hằng giao diện và hàm nhỏ dùng chung giữa các tab, để các tab trông và hoạt động giống nhau.
 */

import type { VideoVerdictKind } from './videoCheck';

export const SMALL_BUTTON =
  'rounded-xl border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-50 disabled:opacity-60';
export const PRIMARY_BUTTON =
  'flex items-center justify-center gap-2 rounded-xl bg-linear-to-r from-brand-800 to-brand-700 px-3 py-2.5 text-sm font-semibold text-white shadow-card transition hover:from-brand-900 hover:to-brand-800 disabled:opacity-60';
export const PILL = 'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset';
export const PILL_GREY = 'bg-slate-100 text-slate-600 ring-slate-200';
export const PILL_GREEN = 'bg-emerald-50 text-emerald-800 ring-emerald-200';
export const PILL_AMBER = 'bg-amber-50 text-amber-800 ring-amber-200';
export const PILL_RED = 'bg-rose-50 text-rose-800 ring-rose-200';
export const PILL_BRAND = 'bg-brand-50 text-brand-800 ring-brand-200';

/** Tên và màu của từng kết luận, dùng ở mọi tab hiện kết luận. */
export const VERDICT_LOOKS: Record<VideoVerdictKind, { label: string; pill: string }> = {
  allowed: { label: 'Được dùng', pill: PILL_GREEN },
  review: { label: 'Cần người duyệt', pill: PILL_AMBER },
  blocked: { label: 'Không được dùng', pill: PILL_RED },
  error: { label: 'Chưa có kết luận', pill: PILL_GREY },
};

export const formatNumber = (value: number) => value.toLocaleString('vi-VN');

/** Tải nội dung CSV về máy. Thêm BOM để Excel đọc đúng tiếng Việt. */
export function downloadCsv(content: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** Đọc phản hồi JSON của máy chủ. Máy chủ báo lỗi thì ném lỗi với câu báo của máy chủ. */
export async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || payload === null) {
    throw new Error((payload as { error?: string } | null)?.error ?? 'Không gọi được máy chủ.');
  }
  return payload as T;
}

export function postJson<T>(url: string, body: unknown = {}): Promise<T> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) =>
    readJsonResponse<T>(response),
  );
}
