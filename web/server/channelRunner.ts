/**
 * Quét cả kênh chạy nền: lấy danh sách, tải âm thanh, lọc nhạc, chờ xác nhận chi phí rồi mới gửi AudD.
 * Mỗi kênh có thư mục riêng và dùng lại giữa các lần quét, nên video đã quét không tốn lượt lần nữa.
 * Việc tải và lọc không tốn tiền, được chạy một tiến trình dài và có thể ngắt. Việc gửi AudD đi từng video,
 * để tạm dừng chỉ xảy ra giữa hai video và không mất phần đã trả phí.
 */

import { randomUUID } from 'node:crypto';
import { buildChannelGate, parseProgress, pickToSend, unsentRequests } from '../src/channelScan.ts';
import type {
  ChannelCurrentResponse,
  ChannelHistoryItem,
  ChannelOptions,
  ChannelReport,
  ChannelScan,
  ChannelScanView,
  ChannelStatus,
  ChannelVideo,
} from '../src/channelScan.ts';
import { createStateFile } from './stateFile.ts';

export const CHANNEL_ROUTE = '/api/channel-scans';
const DEFAULT_MAX_REQUESTS = 5000;
/** Số lần quét đã xong được giữ lại để mở lại báo cáo. Vượt thì bỏ lần cũ nhất. */
const MAX_STORED_DONE = 100;
/** Khớp câu báo trong audit.py. */
const ACCOUNT_ERROR_TEXT = 'lỗi tài khoản AudD';
const VIDEO_ERROR_PREFIX = 'Lỗi với ';
const RESTART_REASON = 'App vừa khởi động lại nên lần quét đã tạm dừng. Bấm Chạy tiếp nếu vẫn muốn quét.';
const ACCOUNT_REASON = 'AudD báo lỗi tài khoản nên app đã dừng và không gửi thêm. Kiểm tra tài khoản AudD rồi bấm Chạy tiếp.';

const RUNNING_STATUSES = new Set<ChannelStatus>(['downloading', 'filtering', 'identifying']);

export type ChannelRoute =
  | { action: 'current' }
  | { action: 'requirements' }
  | { action: 'history' }
  | { action: 'create' }
  | { action: 'report'; scanId: string }
  | { action: 'start'; scanId: string }
  | { action: 'send'; scanId: string }
  | { action: 'pause'; scanId: string }
  | { action: 'resume'; scanId: string }
  | { action: 'stop'; scanId: string };

const POST_ACTIONS = new Set(['start', 'send', 'pause', 'resume', 'stop']);

export function matchChannelRoute(method: string | undefined, pathname: string): ChannelRoute | null {
  if (pathname !== CHANNEL_ROUTE && !pathname.startsWith(`${CHANNEL_ROUTE}/`)) {
    return null;
  }
  const parts = pathname.slice(CHANNEL_ROUTE.length).split('/').filter(Boolean);
  if (method === 'GET') {
    if (parts.length === 1 && (parts[0] === 'current' || parts[0] === 'requirements' || parts[0] === 'history')) {
      return { action: parts[0] };
    }
    return parts.length === 2 && parts[1] === 'report' ? { action: 'report', scanId: parts[0] } : null;
  }
  if (method !== 'POST') {
    return null;
  }
  if (parts.length === 0) {
    return { action: 'create' };
  }
  return parts.length === 2 && POST_ACTIONS.has(parts[1])
    ? { action: parts[1] as 'start' | 'send' | 'pause' | 'resume' | 'stop', scanId: parts[0] }
    : null;
}

/** Biến môi trường trống hoặc sai thì dùng mức mặc định, để lỗi cấu hình không thành không giới hạn. */
export function parseMaxRequests(value: string | undefined): number {
  const limit = value?.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_MAX_REQUESTS;
}

export class ChannelError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ChannelStatusResult {
  channel: string;
  maxSeconds: number;
  videos: ChannelVideo[];
}

export interface ChannelRunnerDeps {
  getFilePath: () => string;
  getWorkdir: (channelKey: string) => string;
  /** Tiến trình dài, không qua hàng đợi quét vì không gọi AudD. */
  runStep: (workdir: string, args: string[], onLine: (line: string) => void) => { done: Promise<void>; stop: () => void };
  /** Gửi một video, đi chung hàng đợi với các màn hình quét khác. Trả về chữ lệnh in ra. */
  runQueued: (workdir: string, args: string[]) => Promise<string>;
  readJson: (workdir: string, args: string[]) => Promise<unknown>;
  removeAudio: (workdir: string) => Promise<void>;
  /** scanId được ghi kèm để tab Lịch sử quét mở lại đúng báo cáo. */
  logUsage: (user: string, target: string, outcome: 'done' | 'error', scanId: string) => Promise<void>;
  maxRequests: number;
  /** Giữ chỗ từng ấy yêu cầu AudD trong hạn mức quét kênh mỗi ngày của người này, trả về false nếu không đủ. */
  reserveRequests: (user: string, count: number) => boolean;
  releaseRequests: (user: string, count: number) => void;
  remainingRequests: (user: string) => number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Không chạy được bước này.');

function toView({ videos, pendingIds: _pendingIds, ...scan }: ChannelScan): ChannelScanView {
  return scan.status === 'ready' ? { ...scan, videos } : scan;
}

export function createChannelRunner(deps: ChannelRunnerDeps) {
  let scans: ChannelScan[] = [];
  let loading: Promise<void> | null = null;
  const stateFile = createStateFile<ChannelScan[]>(deps.getFilePath, 'trạng thái quét kênh');
  let stopStep: (() => void) | null = null;
  let isListing = false;

  const persist = () => stateFile.write(scans);

  /** Không tự chạy tiếp sau khi khởi động lại, vì việc gửi AudD tính phí nên phải có người bấm. */
  const load = async () => {
    const saved = await stateFile.read();
    if (!saved) {
      return;
    }
    scans = saved;
    for (const scan of scans.filter(({ status }) => RUNNING_STATUSES.has(status))) {
      scan.pausedFrom = scan.status;
      scan.status = 'paused';
      scan.pauseReason = RESTART_REASON;
    }
  };

  const ready = () => {
    loading ??= load();
    return loading;
  };

  const findOwn = (user: string, scanId: string) => {
    const scan = scans.find(({ id, user: owner }) => id === scanId && owner === user);
    if (!scan) {
      throw new ChannelError(404, 'Không tìm thấy lần quét này.');
    }
    return scan;
  };

  const requireIdle = () => {
    if (scans.some(({ status }) => RUNNING_STATUSES.has(status))) {
      throw new ChannelError(409, 'Máy chủ đang quét một kênh khác. Hãy thử lại khi lần đó xong.');
    }
  };

  const pause = async (scan: ChannelScan, reason: string) => {
    scan.pausedFrom = scan.status;
    scan.status = 'paused';
    if (reason) {
      scan.pauseReason = reason;
    }
    await persist();
  };

  const finish = async (scan: ChannelScan, stoppedEarly: boolean) => {
    // Dừng giữa lúc gửi thì hoàn lại hạn mức của các video chưa gửi. Dừng trước khi gửi thì chưa giữ gì.
    if (stoppedEarly && scan.sent && scan.options) {
      deps.releaseRequests(scan.user, unsentRequests(scan.videos, scan.pendingIds, scan.options));
    }
    scan.status = 'done';
    scan.stoppedEarly = stoppedEarly;
    scan.pendingIds = [];
    // Báo cáo đọc từ thư mục của kênh, nên không cần giữ danh sách video trong file trạng thái.
    scan.videos = [];
    delete scan.pauseReason;
    delete scan.pausedFrom;
    delete scan.gate;
    await persist();
    await deps.removeAudio(deps.getWorkdir(scan.channelKey)).catch(() => undefined);
  };

  const runStage = async (scan: ChannelScan, args: string[]) => {
    scan.progress = { done: 0, total: 0 };
    const step = deps.runStep(deps.getWorkdir(scan.channelKey), args, (line) => {
      scan.progress = parseProgress(line) ?? scan.progress;
    });
    stopStep = step.stop;
    try {
      await step.done;
    } finally {
      stopStep = null;
    }
  };

  const readStatus = (scan: ChannelScan, clips: number) =>
    deps.readJson(deps.getWorkdir(scan.channelKey), ['channel-status', ...(clips ? ['--clips', String(clips)] : [])]) as Promise<ChannelStatusResult>;

  const openGate = async (scan: ChannelScan, options: ChannelOptions) => {
    scan.videos = (await readStatus(scan, options.clips)).videos;
    scan.pendingIds = pickToSend(scan.videos, options).map(({ videoId }) => videoId);
    scan.gate = buildChannelGate(scan.videos, options);
    scan.status = 'awaiting';
    await persist();
  };

  const prepare = async (scan: ChannelScan) => {
    const options = scan.options as ChannelOptions;
    try {
      if (scan.status === 'downloading') {
        await runStage(scan, ['download-audio', ...(options.limit ? ['--limit', String(options.limit)] : [])]);
        if (scan.status !== 'downloading') {
          return;
        }
        if (options.filter) {
          scan.status = 'filtering';
          await persist();
        }
      }
      if (scan.status === 'filtering') {
        await runStage(scan, ['detect-music', '--all-videos']);
        if (scan.status !== 'filtering') {
          return;
        }
      }
      await openGate(scan, options);
    } catch (error) {
      if (RUNNING_STATUSES.has(scan.status)) {
        await pause(scan, errorText(error));
      }
    }
  };

  const identify = async (scan: ChannelScan) => {
    const options = scan.options as ChannelOptions;
    const workdir = deps.getWorkdir(scan.channelKey);
    while (scan.status === 'identifying' && scan.pendingIds.length > 0) {
      const videoId = scan.pendingIds[0];
      let output: string;
      try {
        // Ghi liền với dấu = vì mã video có thể bắt đầu bằng "-", Python sẽ hiểu nhầm là một tùy chọn.
        output = await deps.runQueued(workdir, [
          'submit', '--all-videos', `--video-id=${videoId}`, '--delay', '0',
          ...(options.clips ? ['--clips', String(options.clips)] : []),
        ]);
      } catch (error) {
        if (scan.status !== 'identifying') {
          return;
        }
        // Lỗi lần đầu thì dừng để người dùng xem. Chạy tiếp mà vẫn lỗi đúng video đó thì bỏ qua nó,
        // để một video hỏng không làm kẹt cả lần quét. Video bỏ qua nằm ở nhóm Cần nghe lại.
        if (scan.lastFailedId !== videoId) {
          scan.lastFailedId = videoId;
          await pause(scan, `${errorText(error)} Bấm Chạy tiếp để thử lại, nếu vẫn lỗi app sẽ bỏ qua video này.`);
          return;
        }
        delete scan.lastFailedId;
        scan.failed += 1;
        scan.pendingIds.shift();
        scan.progress = { ...scan.progress, done: scan.progress.done + 1 };
        await persist();
        continue;
      }
      delete scan.lastFailedId;
      // Lỗi tài khoản thì video này chưa được quét, giữ lại để lần chạy tiếp gửi đúng nó.
      if (output.includes(ACCOUNT_ERROR_TEXT)) {
        if (scan.status === 'identifying') {
          await pause(scan, ACCOUNT_REASON);
        }
        return;
      }
      if (output.includes(VIDEO_ERROR_PREFIX)) {
        scan.failed += 1;
      }
      scan.pendingIds.shift();
      scan.progress = { ...scan.progress, done: scan.progress.done + 1 };
      await persist();
    }
    if (scan.status === 'identifying') {
      await finish(scan, false);
    }
  };

  return {
    async current(user: string, ): Promise<ChannelCurrentResponse> {
      await ready();
      const scan = scans.filter((candidate) => candidate.user === user).at(-1);
      return { scan: scan ? toView(scan) : null, maxRequests: deps.maxRequests, remainingRequests: deps.remainingRequests(user) };
    },

    async create(user: string, channel: { url: string; key: string }, skipShorts: boolean): Promise<void> {
      await ready();
      if (isListing) {
        throw new ChannelError(409, 'Máy chủ đang lấy danh sách một kênh khác. Hãy thử lại sau ít phút.');
      }
      if (scans.some((scan) => scan.user === user && scan.status !== 'ready' && scan.status !== 'done')) {
        throw new ChannelError(409, 'Lần quét trước chưa xong. Hãy chờ hoặc dừng lần đó rồi quét kênh mới.');
      }
      isListing = true;
      try {
        const workdir = deps.getWorkdir(channel.key);
        await deps.runStep(workdir, ['list-videos', '--channel', channel.url, ...(skipShorts ? ['--skip-shorts'] : [])], () => undefined).done;
        const status = (await deps.readJson(workdir, ['channel-status'])) as ChannelStatusResult;
        if (status.videos.length === 0) {
          throw new ChannelError(404, 'Kênh này không có video công khai nào.');
        }
        // Giữ các lần đã xong để mở lại báo cáo, chỉ bỏ lần mới lấy danh sách mà chưa quét của người này.
        scans = scans.filter((scan) => scan.user !== user || scan.status === 'done');
        let extra = scans.filter(({ status }) => status === 'done').length - MAX_STORED_DONE;
        scans = scans.filter(({ status }) => status !== 'done' || extra-- <= 0);
        scans.push({
          id: randomUUID(),
          user,
          channelUrl: channel.url,
          channelKey: channel.key,
          channelTitle: status.channel,
          createdAt: new Date().toISOString(),
          status: 'ready',
          maxSeconds: status.maxSeconds,
          totalVideos: status.videos.length,
          totalSeconds: status.videos.reduce((sum, { seconds }) => sum + seconds, 0),
          progress: { done: 0, total: 0 },
          failed: 0,
          stoppedEarly: false,
          videos: status.videos,
          pendingIds: [],
        });
        await persist();
      } finally {
        isListing = false;
      }
    },

    async start(user: string, scanId: string, options: ChannelOptions): Promise<void> {
      await ready();
      const scan = findOwn(user, scanId);
      if (scan.status !== 'ready') {
        throw new ChannelError(409, 'Lần quét này đã bắt đầu.');
      }
      requireIdle();
      scan.options = options;
      scan.status = 'downloading';
      await persist();
      void prepare(scan);
    },

    /** Bước duy nhất làm tốn lượt AudD, nên chỉ chạy khi có người bấm xác nhận và không vượt trần. */
    async send(user: string, scanId: string): Promise<void> {
      await ready();
      const scan = findOwn(user, scanId);
      if (scan.status !== 'awaiting' || !scan.gate) {
        throw new ChannelError(409, 'Lần quét này không chờ xác nhận.');
      }
      if (scan.gate.requests > deps.maxRequests) {
        throw new ChannelError(409, `Lần quét cần ${scan.gate.requests} yêu cầu AudD, vượt trần ${deps.maxRequests}.`);
      }
      requireIdle();
      if (!deps.reserveRequests(user, scan.gate.requests)) {
        throw new ChannelError(
          429,
          `Lần quét cần ${scan.gate.requests} yêu cầu AudD, nhưng hạn mức quét kênh hôm nay của bạn chỉ còn ${deps.remainingRequests(user)}. Hãy quét ít video hơn hoặc thử lại vào ngày mai.`,
        );
      }
      // Đổi trạng thái ngay, trước mọi lệnh await, để lần bấm thứ hai gặp lỗi 409 thay vì chạy song song.
      scan.status = 'identifying';
      scan.sent = { videos: scan.gate.videos, requests: scan.gate.requests };
      await deps.logUsage(user, `${scan.channelUrl} (${scan.gate.videos} video, ${scan.gate.requests} yêu cầu)`, 'done', scan.id);
      scan.progress = { done: 0, total: scan.pendingIds.length };
      await persist();
      void identify(scan);
    },

    async pause(user: string, scanId: string): Promise<void> {
      await ready();
      const scan = findOwn(user, scanId);
      if (!RUNNING_STATUSES.has(scan.status)) {
        throw new ChannelError(409, 'Lần quét này không chạy.');
      }
      delete scan.pauseReason;
      await pause(scan, '');
      stopStep?.();
    },

    async resume(user: string, scanId: string): Promise<void> {
      await ready();
      const scan = findOwn(user, scanId);
      if (scan.status !== 'paused' || !scan.pausedFrom) {
        throw new ChannelError(409, 'Lần quét này không tạm dừng.');
      }
      requireIdle();
      scan.status = scan.pausedFrom;
      delete scan.pausedFrom;
      delete scan.pauseReason;
      await persist();
      void (scan.status === 'identifying' ? identify(scan) : prepare(scan));
    },

    async stop(user: string, scanId: string): Promise<void> {
      await ready();
      const scan = findOwn(user, scanId);
      if (scan.status === 'done' || scan.status === 'ready') {
        throw new ChannelError(409, 'Lần quét này không chạy.');
      }
      if (RUNNING_STATUSES.has(scan.status)) {
        stopStep?.();
      }
      await finish(scan, true);
    },

    /** Các lần quét đã kết thúc của mọi người, mới nhất trước. */
    async history(): Promise<ChannelHistoryItem[]> {
      await ready();
      return scans
        .filter(({ status }) => status === 'done')
        .map(({ id, user, channelUrl, channelTitle, createdAt, stoppedEarly, failed, sent }) => ({ id, user, channelUrl, channelTitle, createdAt, stoppedEarly, failed, ...(sent ? { sent } : {}) }))
        .reverse();
    },

    /** Mọi người đều xem được báo cáo của nhau, giống tab Lịch sử quét. Báo cáo đọc từ kết quả đã lưu, không gửi gì cho AudD. */
    async report(scanId: string): Promise<ChannelReport> {
      await ready();
      const scan = scans.find(({ id }) => id === scanId);
      if (!scan) {
        throw new ChannelError(404, 'Không còn thấy lần quét này nên không mở được báo cáo.');
      }
      if (scan.status !== 'done') {
        throw new ChannelError(409, 'Lần quét chưa xong.');
      }
      return deps.readJson(deps.getWorkdir(scan.channelKey), ['channel-report']) as Promise<ChannelReport>;
    },
  };
}
