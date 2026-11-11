/**
 * Hàng đợi quét hàng loạt chạy nền. Trạng thái lưu vào file để app khởi động lại vẫn chạy tiếp.
 * Mỗi lần chỉ quét một video, và mỗi video đi qua cùng hàng đợi với màn hình quét lẻ, nên hai bên xen kẽ nhau.
 */

import { randomUUID } from 'node:crypto';
import { isValidVideoId, MAX_BATCH_VIDEOS } from '../src/batchScan.ts';
import { BUDGET_REFUSAL_TEXT } from '../src/budget.ts';
import type { Batch, BatchItem } from '../src/batchScan.ts';
import type { IdentifyResult } from '../src/videoCheck.ts';
import { getVideoUrl } from '../src/youtubeLink.ts';
import { createStateFile } from './stateFile.ts';

export const BATCH_ROUTE = '/api/batches';
/** Nghỉ giữa hai video phải tải về, để YouTube đỡ chặn địa chỉ máy chủ. */
const DEFAULT_DELAY_MS = 5000;
const MAX_STORED_BATCHES = 200;
/** Khớp câu báo trong music_audit/extract.py. */
/** Lỗi gặp lại ở mọi video sau, nên tạm dừng cả lô thay vì quét tiếp từng video cho lỗi. */
const PAUSE_TEXTS = ['YouTube đang chặn', BUDGET_REFUSAL_TEXT];

export type BatchRoute =
  | { action: 'current' }
  | { action: 'create' }
  | { action: 'estimate' }
  | { action: 'cancel' | 'resume'; batchId: string }
  | { action: 'retry'; batchId: string; videoId: string };

export function matchBatchRoute(method: string | undefined, pathname: string): BatchRoute | null {
  if (pathname !== BATCH_ROUTE && !pathname.startsWith(`${BATCH_ROUTE}/`)) {
    return null;
  }
  const parts = pathname.slice(BATCH_ROUTE.length).split('/').filter(Boolean);
  if (method === 'GET') {
    return parts.length === 1 && parts[0] === 'current' ? { action: 'current' } : null;
  }
  if (method !== 'POST') {
    return null;
  }
  if (parts.length === 0) {
    return { action: 'create' };
  }
  if (parts.length === 1 && parts[0] === 'estimate') {
    return { action: 'estimate' };
  }
  if (parts.length === 2 && (parts[1] === 'cancel' || parts[1] === 'resume')) {
    return { action: parts[1], batchId: parts[0] };
  }
  if (parts.length === 4 && parts[1] === 'items' && parts[3] === 'retry') {
    return { action: 'retry', batchId: parts[0], videoId: parts[2] };
  }
  return null;
}

/** Trả về danh sách mã video không trùng, hoặc null nếu yêu cầu sai hay quá giới hạn một lô. */
export function parseBatchVideoIds(body: string): string[] | null {
  try {
    const { videoIds } = JSON.parse(body) as { videoIds?: unknown };
    if (!Array.isArray(videoIds) || videoIds.length === 0 || videoIds.length > MAX_BATCH_VIDEOS || !videoIds.every(isValidVideoId)) {
      return null;
    }
    return [...new Set(videoIds as string[])];
  } catch {
    return null;
  }
}

export class BatchError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BatchRunnerDeps {
  getFilePath: () => string;
  isCached: (videoId: string) => boolean;
  /** user là người tạo lô, để tính ngân sách đúng người. */
  scan: (url: string, user: string) => Promise<IdentifyResult>;
  logResult: (user: string, target: string, outcome: 'done' | 'error') => Promise<void>;
  delayMs?: number;
}

const isActive = (item: BatchItem) => item.status === 'queued' || item.status === 'running';

function settle(batch: Batch) {
  if (!batch.items.some(isActive)) {
    batch.status = 'done';
    delete batch.pauseReason;
  }
}

export function createBatchRunner(deps: BatchRunnerDeps) {
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  let batches: Batch[] = [];
  let loading: Promise<void> | null = null;
  let isPumping = false;
  const stateFile = createStateFile<Batch[]>(deps.getFilePath, 'hàng đợi quét');
  const persist = () => stateFile.write(batches);

  const load = async () => {
    const saved = await stateFile.read();
    if (!saved) {
      return;
    }
    batches = saved;
    // App dừng giữa chừng thì video đang quét chưa có kết quả, xếp lại để quét tiếp.
    for (const item of batches.flatMap((batch) => batch.items)) {
      if (item.status === 'running') {
        item.status = 'queued';
      }
    }
  };

  const ready = () => {
    loading ??= load();
    return loading;
  };

  const findNext = () => {
    for (const batch of batches) {
      const item = batch.status === 'running' ? batch.items.find(({ status }) => status === 'queued') : undefined;
      if (item) {
        return { batch, item };
      }
    }
    return null;
  };

  const runItem = async (batch: Batch, item: BatchItem) => {
    item.status = 'running';
    await persist();
    try {
      item.result = await deps.scan(item.url, batch.user);
      item.status = 'done';
      await deps.logResult(batch.user, item.url, 'done');
    } catch (error) {
      item.status = 'error';
      item.error = error instanceof Error ? error.message : 'Không quét được.';
      if (PAUSE_TEXTS.some((text) => item.error?.includes(text))) {
        batch.status = 'paused';
        batch.pauseReason = item.error;
      }
      await deps.logResult(batch.user, item.url, 'error');
    }
    settle(batch);
    await persist();
  };

  const pump = async () => {
    if (isPumping) {
      return;
    }
    isPumping = true;
    try {
      for (let next = findNext(); next; next = findNext()) {
        await runItem(next.batch, next.item);
        if (!next.item.cached && findNext()) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        }
      }
    } finally {
      isPumping = false;
    }
  };

  const findOwn = (user: string, batchId: string) => {
    const batch = batches.find(({ id, user: owner }) => id === batchId && owner === user);
    if (!batch) {
      throw new BatchError(404, 'Không tìm thấy lô quét này.');
    }
    return batch;
  };

  const prune = () => {
    let extra = batches.length - MAX_STORED_BATCHES;
    batches = batches.filter((batch) => batch.status !== 'done' || extra-- <= 0);
  };

  return {
    async start() {
      await ready();
      void pump();
    },

    async current(user: string): Promise<Batch | null> {
      await ready();
      return batches.filter((batch) => batch.user === user).at(-1) ?? null;
    },

    async create(user: string, videoIds: string[]): Promise<Batch> {
      await ready();
      if (batches.some((batch) => batch.user === user && batch.status !== 'done')) {
        throw new BatchError(409, 'Lô trước chưa xong. Hãy chờ hoặc hủy phần chưa quét rồi tạo lô mới.');
      }
      const items = videoIds.map((videoId): BatchItem => ({
        videoId,
        url: getVideoUrl(videoId),
        status: 'queued',
        cached: deps.isCached(videoId),
      }));
      const batch: Batch = { id: randomUUID(), user, createdAt: new Date().toISOString(), status: 'running', items };
      batches.push(batch);
      prune();
      await persist();
      void pump();
      return batch;
    },

    /** Video đang quét dở vẫn chạy nốt, các video còn chờ bị hủy. */
    async cancel(user: string, batchId: string): Promise<Batch> {
      await ready();
      const batch = findOwn(user, batchId);
      const queued = batch.items.filter(({ status }) => status === 'queued');
      queued.forEach((item) => {
        item.status = 'cancelled';
      });
      settle(batch);
      await persist();
      return batch;
    },

    async resume(user: string, batchId: string): Promise<Batch> {
      await ready();
      const batch = findOwn(user, batchId);
      if (batch.status === 'paused') {
        batch.status = 'running';
        delete batch.pauseReason;
        await persist();
        void pump();
      }
      return batch;
    },

    /** Lượt đã giữ khi tạo lô, nên quét lại video lỗi không tính thêm. */
    async retry(user: string, batchId: string, videoId: string): Promise<Batch> {
      await ready();
      const batch = findOwn(user, batchId);
      const item = batch.items.find((candidate) => candidate.videoId === videoId);
      if (item?.status !== 'error') {
        throw new BatchError(409, 'Chỉ quét lại được video bị lỗi.');
      }
      item.status = 'queued';
      delete item.error;
      batch.status = 'running';
      delete batch.pauseReason;
      await persist();
      void pump();
      return batch;
    },
  };
}
