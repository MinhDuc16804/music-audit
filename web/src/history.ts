/**
 * Phần dùng chung giữa trình duyệt và server cho tab Lịch sử quét.
 * Server nạp thẳng file này khi chạy thật, nên import tương đối phải ghi đuôi .ts.
 */

import { csvCell } from './batchScan.ts';
import type { IdentifyResult } from './videoCheck.ts';
import { foldText } from './textNormalize.ts';
import { parseYoutubeVideoId } from './youtubeLink.ts';

export type HistoryKind = 'link' | 'file' | 'batch' | 'channel';
export const HISTORY_KINDS: HistoryKind[] = ['link', 'file', 'batch', 'channel'];
/** Người dùng khi app chưa đặt sau Cloudflare Access, khớp với usageLimit.ts. */
export const UNKNOWN_USER = 'khong-ro';
const MAX_ENTRIES = 1000;
const RESULT_KEY = /^[A-Za-z0-9_-]{11}$/;
const SCAN_ID = /^[0-9a-f-]{36}$/;

export type HistoryResult = IdentifyResult & { title?: string };

export interface HistoryEntry {
  id: string;
  time: string;
  user: string;
  kind: HistoryKind;
  target: string;
  outcome: 'done' | 'error';
  /** Mã để tìm kết quả đã lưu: mã video, hoặc 11 ký tự đầu mã băm của file. */
  resultKey?: string;
  channel?: { url: string; videos: number; requests: number };
  /** Mã lần quét kênh, để mở lại báo cáo. Các lần quét cũ không có. */
  scanId?: string;
  /** Lượt này là bấm Quét lại. */
  rescan?: boolean;
  result?: HistoryResult;
}

export interface HistoryResponse {
  entries: HistoryEntry[];
  user: string;
}

function parseChannelTarget(target: string): HistoryEntry['channel'] {
  const match = /^(\S+) \((\d+) video, (\d+) yêu cầu\)$/.exec(target);
  return match ? { url: match[1], videos: Number(match[2]), requests: Number(match[3]) } : { url: target, videos: 0, requests: 0 };
}

/** Đọc nhật ký sử dụng, mới nhất trước. Dòng lỗi hoặc lượt bị từ chối vì hết lượt thì bỏ qua. */
export function parseUsageLog(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  text.split('\n').forEach((line, position) => {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const { time, user, kind, target, outcome, resultId, rescan } = row;
    if (typeof time !== 'string' || typeof target !== 'string' || !HISTORY_KINDS.includes(kind as HistoryKind) || (outcome !== 'done' && outcome !== 'error')) {
      return;
    }
    const entry: HistoryEntry = { id: String(position), time, user: typeof user === 'string' && user ? user : UNKNOWN_USER, kind: kind as HistoryKind, target, outcome };
    if (rescan === true) {
      entry.rescan = true;
    }
    if (entry.kind === 'channel') {
      entry.channel = parseChannelTarget(target);
      if (typeof resultId === 'string' && SCAN_ID.test(resultId)) {
        entry.scanId = resultId;
      }
    } else {
      const key = entry.kind === 'file' ? resultId : parseYoutubeVideoId(target);
      if (typeof key === 'string' && RESULT_KEY.test(key)) {
        entry.resultKey = key;
      }
    }
    entries.push(entry);
  });
  return entries.reverse().slice(0, MAX_ENTRIES);
}

export function historyTitle(entry: HistoryEntry): string {
  return entry.result?.title || entry.channel?.url || entry.target;
}

export function filterHistory(entries: HistoryEntry[], filter: { kind: HistoryKind | 'all'; query: string; onlyUser?: string }): HistoryEntry[] {
  const needle = foldText(filter.query.trim());
  return entries.filter(
    (entry) =>
      (filter.kind === 'all' || entry.kind === filter.kind) &&
      (!filter.onlyUser || entry.user === filter.onlyUser) &&
      (!needle || foldText(`${historyTitle(entry)} ${entry.target} ${entry.user}`).includes(needle)),
  );
}

export interface HistoryCsvRow {
  time: string;
  user: string;
  kind: string;
  title: string;
  target: string;
  verdict: string;
  tracks: string[];
}

export function buildHistoryCsv(rows: HistoryCsvRow[]): string {
  const header = ['Thời gian', 'Người quét', 'Loại', 'Tên', 'Link hoặc file', 'Kết luận', 'Bài nhận ra'];
  return [header, ...rows.map((row) => [row.time, row.user, row.kind, row.title, row.target, row.verdict, row.tracks.join('; ')])]
    .map((line) => line.map(csvCell).join(','))
    .join('\r\n');
}
