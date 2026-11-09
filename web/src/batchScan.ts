/**
 * Phần dùng chung giữa trình duyệt và server cho tính năng quét hàng loạt.
 * Server nạp thẳng file này khi chạy thật, nên import tương đối phải ghi đuôi .ts.
 */

import type { IdentifyResult } from './videoCheck.ts';
import { getVideoUrl, parseYoutubeVideoId } from './youtubeLink.ts';

export const MAX_BATCH_VIDEOS = 20;
/** Giới hạn quét mặc định của audit.py, dùng khi server chưa báo giới hạn thật. */
export const DEFAULT_MAX_SCAN_SECONDS = 3600;
const SCAN_SEGMENT_SECONDS = 12;

export type BatchItemStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type BatchStatus = 'running' | 'paused' | 'done';

export interface BatchItem {
  videoId: string;
  url: string;
  status: BatchItemStatus;
  /** Video đã có kết quả từ trước, không tốn lượt và không gọi AudD. */
  cached: boolean;
  error?: string;
  result?: IdentifyResult;
}

export interface Batch {
  id: string;
  user: string;
  createdAt: string;
  status: BatchStatus;
  pauseReason?: string;
  items: BatchItem[];
}

export interface BatchCurrentResponse {
  batch: Batch | null;
  remainingScans: number;
  dailyLimit: number;
}

export interface BatchEstimateVideo {
  videoId: string;
  cached: boolean;
  /** Bằng 0 nghĩa là chưa biết độ dài. */
  seconds: number;
}

export interface BatchEstimateResponse {
  videos: BatchEstimateVideo[];
  maxSeconds: number;
}

export interface ParsedBatchLinks {
  videoIds: string[];
  invalid: number;
  duplicates: number;
}

/** Đọc danh sách dán vào, mỗi dòng một link. Giữ thứ tự, bỏ link trùng và đếm dòng sai để báo lại. */
export function parseBatchLinks(text: string): ParsedBatchLinks {
  const videoIds: string[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const line of text.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const videoId = parseYoutubeVideoId(line);
    if (!videoId) {
      invalid += 1;
    } else if (videoIds.includes(videoId)) {
      duplicates += 1;
    } else {
      videoIds.push(videoId);
    }
  }
  return { videoIds, invalid, duplicates };
}

/** Số yêu cầu AudD cho một video. Chưa biết độ dài thì tính mức tối đa để không báo thiếu chi phí. */
export function estimateAuddRequests(seconds: number, maxSeconds = DEFAULT_MAX_SCAN_SECONDS): number {
  const scanned = seconds > 0 ? Math.min(seconds, maxSeconds) : maxSeconds;
  return Math.ceil(scanned / SCAN_SEGMENT_SECONDS);
}

export function isValidVideoId(videoId: unknown): videoId is string {
  return typeof videoId === 'string' && parseYoutubeVideoId(getVideoUrl(videoId)) === videoId;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

export interface BatchCsvRow {
  url: string;
  verdict: string;
  detail: string;
  durationSeconds: number;
  tracks: string[];
}

/** Tên bài do AudD trả về, nên chặn ô bắt đầu bằng ký tự công thức để Excel không chạy nó. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildBatchCsv(rows: BatchCsvRow[]): string {
  const header = ['Link', 'Kết luận', 'Chi tiết', 'Độ dài', 'Bài nhận ra'];
  const lines = rows.map((row) =>
    [row.url, row.verdict, row.detail, row.durationSeconds > 0 ? formatDuration(row.durationSeconds) : '', row.tracks.join('; ')],
  );
  return [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n');
}
