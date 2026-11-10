/**
 * Phần dùng chung giữa trình duyệt và server cho tính năng quét cả kênh.
 * Server nạp thẳng file này khi chạy thật, nên import tương đối phải ghi đuôi .ts.
 */

import { csvCell, formatDuration } from './batchScan.ts';
import { foldText } from './textNormalize.ts';
import type { BudgetView } from './budget.ts';

const CLIP_EVERY_SECONDS = 45;
export const MIN_CLIPS = 2;
export const MAX_CLIPS = 20;

const CHANNEL_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const HANDLE_PATTERN = /^@[\p{L}\p{N}_.-]*[\p{L}\p{N}_-]$/u;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export interface ChannelOptions {
  filter: boolean;
  musicOnly: boolean;
  /** Số đoạn tối đa mỗi video, 0 là gửi cả video. */
  clips: number;
  /** Chỉ xét N video đầu, 0 là cả kênh. */
  limit: number;
}

export interface ChannelVideo {
  videoId: string;
  title: string;
  seconds: number;
  group: string;
  hasAudio: boolean;
  scanned: boolean;
  requests: number;
  clipRequests: number;
}

export type ChannelStatus = 'ready' | 'downloading' | 'filtering' | 'awaiting' | 'identifying' | 'paused' | 'done';

export interface ChannelGate {
  videos: number;
  requests: number;
  withMusic: number;
  noMusic: number;
  noAudio: number;
}

export interface ChannelScan {
  id: string;
  user: string;
  channelUrl: string;
  channelKey: string;
  channelTitle: string;
  createdAt: string;
  status: ChannelStatus;
  pausedFrom?: ChannelStatus;
  pauseReason?: string;
  options?: ChannelOptions;
  maxSeconds: number;
  totalVideos: number;
  totalSeconds: number;
  progress: { done: number; total: number };
  gate?: ChannelGate;
  failed: number;
  stoppedEarly: boolean;
  /** Số video và số yêu cầu AudD đã được xác nhận gửi, để xem lại trong danh sách các lần quét trước. */
  sent?: { videos: number; requests: number };
  /** Video vừa làm lệnh gửi lỗi. Lỗi lần nữa khi chạy tiếp thì bỏ qua video này. */
  lastFailedId?: string;
  videos: ChannelVideo[];
  pendingIds: string[];
}

/** Một lần quét đã kết thúc, đủ để liệt kê và mở lại báo cáo. */
export interface ChannelHistoryItem {
  id: string;
  user: string;
  channelUrl: string;
  channelTitle: string;
  createdAt: string;
  stoppedEarly: boolean;
  failed: number;
  sent?: { videos: number; requests: number };
}

export interface ChannelHistoryResponse {
  scans: ChannelHistoryItem[];
}

/** Bản gửi cho trình duyệt: danh sách video chỉ cần khi đang chọn cách quét. */
export type ChannelScanView = Omit<ChannelScan, 'videos' | 'pendingIds'> & { videos?: ChannelVideo[] };

export interface ChannelCurrentResponse {
  scan: ChannelScanView | null;
  maxRequests: number;
  /** Số yêu cầu AudD người này còn dùng được cho quét cả kênh hôm nay. */
  remainingRequests: number;
  /** Ngân sách AudD tháng này của cả app, null hoặc thiếu nếu chưa bật. */
  budget?: BudgetView | null;
}

export interface ChannelRequirements {
  ytDlp: boolean;
  ffmpeg: boolean;
  yamnet: boolean;
  youtubeKey: boolean;
  auddKey: boolean;
}

export interface ChannelReportTrack {
  title: string;
  artist: string;
  label: string;
  library: string;
  position: string;
}

export interface ChannelReportVideo {
  videoId: string;
  title: string;
  url: string;
  seconds: number;
  group: string;
  reason: string;
  detection: string;
  musicSeconds: string;
  policy: string;
  tracks: ChannelReportTrack[];
}

export interface ChannelReportSong {
  title: string;
  artist: string;
  label: string;
  library: string;
  videoCount: number;
  seconds: number;
}

export interface ChannelReport {
  videos: ChannelReportVideo[];
  songs: ChannelReportSong[];
}

export const CHANNEL_GROUP_LABELS: Record<string, string> = {
  'co-nhac': 'Có nhạc',
  'can-nghe-lai': 'Cần nghe lại',
  sach: 'Sạch',
};

export const LIBRARY_LABELS: Record<string, string> = {
  'khop-chac': 'Có trong Library',
  'gan-giong': 'Gần giống',
  'khong-thay': 'Không thấy',
  'chua-tra': 'Chưa tra',
};

export const DETECTION_LABELS: Record<string, string> = {
  'co-nhac': 'Có nhạc',
  'khong-nhac': 'Không nhạc',
};

/** Nhận link kênh có @handle hoặc mã UC…, hay chính @handle, mã UC…. Trả về null nếu không phải kênh. */
export function parseChannelInput(text: string): { url: string; key: string } | null {
  const value = text.trim().replace(/\/+$/, '');
  let name = value;
  if (/^(https?:\/\/|www\.|m\.|youtube\.com)/i.test(value)) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (!CHANNEL_HOSTS.has(parsed.hostname.toLowerCase())) {
        return null;
      }
      const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      name = parts[0] === 'channel' ? (parts[1] ?? '') : (parts[0] ?? '');
    } catch {
      return null;
    }
  }
  if (CHANNEL_ID_PATTERN.test(name)) {
    return { url: `https://www.youtube.com/channel/${name}`, key: name };
  }
  if (HANDLE_PATTERN.test(name)) {
    return { url: `https://www.youtube.com/${name}`, key: name.toLowerCase() };
  }
  return null;
}

/** Trả về null nếu tùy chọn sai. Chỉ gửi video có nhạc và gửi đoạn ngắn đều cần kết quả của máy lọc. */
export function parseChannelOptions(value: unknown): ChannelOptions | null {
  const { filter, musicOnly, clips, limit } = (value ?? {}) as Partial<ChannelOptions>;
  if (typeof filter !== 'boolean' || typeof musicOnly !== 'boolean' || !Number.isInteger(clips) || !Number.isInteger(limit)) {
    return null;
  }
  const clipCount = clips as number;
  const validClips = clipCount === 0 || (clipCount >= MIN_CLIPS && clipCount <= MAX_CLIPS);
  if (!validClips || (limit as number) < 0 || ((musicOnly || clipCount > 0) && !filter)) {
    return null;
  }
  return { filter, musicOnly, clips: clipCount, limit: limit as number };
}

export function parseProgress(line: string): { done: number; total: number } | null {
  const match = /^\[(\d+)\/(\d+)\]/.exec(line.trim());
  return match ? { done: Number(match[1]), total: Number(match[2]) } : null;
}

export function pickPrepared(videos: ChannelVideo[], options: ChannelOptions): ChannelVideo[] {
  return options.limit > 0 ? videos.slice(0, options.limit) : videos;
}

/** Video sẽ gửi AudD. Thiếu file âm thanh thì không gửi, vì gửi link sẽ lỗi với tài khoản dùng thử. */
export function pickToSend(videos: ChannelVideo[], options: ChannelOptions): ChannelVideo[] {
  return pickPrepared(videos, options).filter(
    (video) => !video.scanned && video.hasAudio && (!(options.filter && options.musicOnly) || video.group === 'co-nhac'),
  );
}

/** Số yêu cầu đã giữ cho các video chưa gửi, để hoàn lại khi dừng giữa chừng. */
export function unsentRequests(videos: ChannelVideo[], pendingIds: string[], options: ChannelOptions): number {
  const pending = new Set(pendingIds);
  return videos.filter(({ videoId }) => pending.has(videoId)).reduce((sum, video) => sum + requestsFor(video, options), 0);
}

export function requestsFor(video: ChannelVideo, options: ChannelOptions): number {
  return options.clips > 0 ? video.clipRequests : video.requests;
}

/** Mức tối đa trước khi lọc, khi chưa biết video nào có nhạc. */
export function worstCaseRequests(videos: ChannelVideo[], options: ChannelOptions, maxSeconds: number): number {
  return pickPrepared(videos, options)
    .filter((video) => !video.scanned)
    .reduce((sum, video) => {
      const scanned = Math.min(video.seconds, maxSeconds);
      return sum + (options.clips > 0 ? Math.min(options.clips, Math.ceil(scanned / CLIP_EVERY_SECONDS)) : video.requests);
    }, 0);
}

export function searchChannelVideos(videos: ChannelVideo[], query: string): ChannelVideo[] {
  const needle = foldText(query.trim());
  return needle ? videos.filter((video) => foldText(video.title).includes(needle)) : videos;
}

export function buildChannelGate(videos: ChannelVideo[], options: ChannelOptions): ChannelGate {
  const prepared = pickPrepared(videos, options).filter((video) => !video.scanned);
  const send = pickToSend(videos, options);
  return {
    videos: send.length,
    requests: send.reduce((sum, video) => sum + requestsFor(video, options), 0),
    withMusic: prepared.filter((video) => video.group === 'co-nhac').length,
    noMusic: prepared.filter((video) => video.group === 'khong-nhac').length,
    noAudio: prepared.filter((video) => !video.hasAudio).length,
  };
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function buildChannelVideosCsv(videos: ChannelReportVideo[]): string {
  return toCsv([
    ['Mã video', 'Tiêu đề video', 'Link', 'Độ dài', 'Nhóm', 'Lý do', 'Máy lọc', 'Giây có nhạc', 'Policy', 'Bài nhận ra'],
    ...videos.map((video) => [
      video.videoId,
      video.title,
      video.url,
      video.seconds > 0 ? formatDuration(video.seconds) : '',
      CHANNEL_GROUP_LABELS[video.group] ?? video.group,
      video.reason,
      DETECTION_LABELS[video.detection] ?? '',
      video.musicSeconds,
      LIBRARY_LABELS[video.policy] ?? video.policy,
      video.tracks.map((track) => `${track.title} - ${track.artist} (${LIBRARY_LABELS[track.library] ?? track.library})`).join('; '),
    ]),
  ]);
}

export function buildChannelSongsCsv(songs: ChannelReportSong[]): string {
  return toCsv([
    ['Bài', 'Tác giả', 'Hãng', 'Library', 'Số video', 'Tổng thời lượng'],
    ...songs.map((song) => [
      song.title,
      song.artist,
      song.label,
      LIBRARY_LABELS[song.library] ?? song.library,
      String(song.videoCount),
      song.seconds > 0 ? formatDuration(song.seconds) : '',
    ]),
  ]);
}
