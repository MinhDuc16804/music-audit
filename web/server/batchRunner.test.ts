import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Batch } from '../src/batchScan';
import { BUDGET_REFUSAL_TEXT } from '../src/budget';
import type { IdentifyResult } from '../src/videoCheck';
import { BatchError, createBatchRunner, matchBatchRoute, parseBatchVideoIds } from './batchRunner';
import type { BatchRunnerDeps } from './batchRunner';

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';
const USER = 'nv@example.com';
const BLOCKED = 'YouTube đang chặn máy này tải video. Hãy thử lại sau hoặc tải file lên.';

const resultFor = (url: string): IdentifyResult => ({ url, video_id: 'x', status: 'done', note: '' });

let folder = '';
let filePath = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'batch-runner-'));
  filePath = join(folder, 'out', 'batches.json');
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function setup(overrides: Partial<BatchRunnerDeps> = {}) {
  const deps = {
    getFilePath: () => filePath,
    isCached: vi.fn((_videoId: string) => false),
    scan: vi.fn(async (url: string) => resultFor(url)),
    logResult: vi.fn(async () => undefined),
    delayMs: 0,
    ...overrides,
  };
  return { deps, runner: createBatchRunner(deps) };
}

async function waitFor(runner: ReturnType<typeof createBatchRunner>, check: (batch: Batch) => boolean) {
  await vi.waitFor(async () => {
    const batch = await runner.current(USER);
    expect(batch && check(batch)).toBe(true);
  });
  return (await runner.current(USER)) as Batch;
}

describe('matchBatchRoute', () => {
  it('nhận đúng các đường dẫn', () => {
    expect(matchBatchRoute('GET', '/api/batches/current')).toEqual({ action: 'current' });
    expect(matchBatchRoute('POST', '/api/batches')).toEqual({ action: 'create' });
    expect(matchBatchRoute('POST', '/api/batches/estimate')).toEqual({ action: 'estimate' });
    expect(matchBatchRoute('POST', '/api/batches/x/cancel')).toEqual({ action: 'cancel', batchId: 'x' });
    expect(matchBatchRoute('POST', `/api/batches/x/items/${A}/retry`)).toEqual({ action: 'retry', batchId: 'x', videoId: A });
  });

  it('từ chối đường dẫn và phương thức lạ', () => {
    expect(matchBatchRoute('GET', '/api/batchesx')).toBeNull();
    expect(matchBatchRoute('DELETE', '/api/batches')).toBeNull();
    expect(matchBatchRoute('POST', '/api/batches/x/khac')).toBeNull();
  });
});

describe('parseBatchVideoIds', () => {
  it('bỏ mã trùng', () => {
    expect(parseBatchVideoIds(JSON.stringify({ videoIds: [A, A, B] }))).toEqual([A, B]);
  });

  it('từ chối mã sai, danh sách rỗng và lô quá lớn', () => {
    expect(parseBatchVideoIds('khong phai json')).toBeNull();
    expect(parseBatchVideoIds(JSON.stringify({ videoIds: [] }))).toBeNull();
    expect(parseBatchVideoIds(JSON.stringify({ videoIds: ['../../x'] }))).toBeNull();
    expect(parseBatchVideoIds(JSON.stringify({ videoIds: Array(21).fill(A) }))).toBeNull();
  });
});

describe('createBatchRunner', () => {
  it('quét lần lượt từng video rồi kết thúc lô', async () => {
    const scan = vi.fn(async (url: string) => resultFor(url));
    const { deps, runner } = setup({ scan });
    await runner.create(USER, [A, B]);
    const batch = await waitFor(runner, ({ status }) => status === 'done');
    expect(batch.items.map(({ status }) => status)).toEqual(['done', 'done']);
    expect(scan.mock.calls.map(([url]) => url)).toEqual([
      `https://www.youtube.com/watch?v=${A}`,
      `https://www.youtube.com/watch?v=${B}`,
    ]);
    expect(deps.logResult).toHaveBeenCalledTimes(2);
  });

  it('gửi kèm người tạo lô cho bước quét, để tính ngân sách đúng người', async () => {
    const { deps, runner } = setup();
    await runner.create(USER, [A]);
    await waitFor(runner, ({ status }) => status === 'done');
    expect(deps.scan).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${A}`, USER);
  });

  it('không cho tạo lô mới khi lô trước chưa xong', async () => {
    let finish: (value: IdentifyResult) => void = () => undefined;
    const { deps, runner } = setup({ scan: vi.fn(() => new Promise<IdentifyResult>((resolveScan) => { finish = resolveScan; })) });
    await runner.create(USER, [A]);
    await expect(runner.create(USER, [B])).rejects.toBeInstanceOf(BatchError);
    await vi.waitFor(() => expect(deps.scan).toHaveBeenCalled());
    finish(resultFor(A));
    await waitFor(runner, ({ status }) => status === 'done');
  });

  it('một video lỗi không làm dừng cả lô', async () => {
    const scan = vi.fn(async (url: string) => {
      if (url.includes(A)) {
        throw new Error('Video đang ở chế độ riêng tư, không tách được âm thanh.');
      }
      return resultFor(url);
    });
    const { runner } = setup({ scan });
    await runner.create(USER, [A, B]);
    const batch = await waitFor(runner, ({ status }) => status === 'done');
    expect(batch.items.map(({ status }) => status)).toEqual(['error', 'done']);
    expect(batch.items[0].error).toContain('riêng tư');
  });

  it('YouTube chặn thì tạm dừng, giữ video chưa quét và chạy tiếp được', async () => {
    let isBlocked = true;
    const scan = vi.fn(async (url: string) => {
      if (isBlocked) {
        throw new Error(BLOCKED);
      }
      return resultFor(url);
    });
    const { deps, runner } = setup({ scan });
    const { id } = await runner.create(USER, [A, B, C]);
    const paused = await waitFor(runner, ({ status }) => status === 'paused');
    expect(paused.items.map(({ status }) => status)).toEqual(['error', 'queued', 'queued']);
    expect(deps.scan).toHaveBeenCalledTimes(1);

    isBlocked = false;
    await runner.resume(USER, id);
    const done = await waitFor(runner, ({ status }) => status === 'done');
    expect(done.items.map(({ status }) => status)).toEqual(['error', 'done', 'done']);
  });

  it('hết ngân sách tháng thì tạm dừng cả lô', async () => {
    const scan = vi.fn(async () => {
      throw new Error(`Lượt quét cần tối đa 90 yêu cầu AudD, nhưng ${BUDGET_REFUSAL_TEXT} 5 yêu cầu.`);
    });
    const { runner } = setup({ scan });
    await runner.create(USER, [A, B]);
    const paused = await waitFor(runner, ({ status }) => status === 'paused');
    expect(paused.items.map(({ status }) => status)).toEqual(['error', 'queued']);
    expect(paused.pauseReason).toContain(BUDGET_REFUSAL_TEXT);
  });

  it('quét lại được video bị lỗi', async () => {
    let shouldFail = true;
    const scan = vi.fn(async (url: string) => {
      if (shouldFail) {
        throw new Error('Lỗi tạm thời');
      }
      return resultFor(url);
    });
    const { deps, runner } = setup({ scan });
    const { id } = await runner.create(USER, [A]);
    await waitFor(runner, ({ status }) => status === 'done');
    shouldFail = false;
    await runner.retry(USER, id, A);
    const batch = await waitFor(runner, ({ items }) => items[0].status === 'done');
    expect(batch.items[0].error).toBeUndefined();
    expect(deps.scan).toHaveBeenCalledTimes(2);
  });

  it('chỉ quét lại được video bị lỗi', async () => {
    const { runner } = setup();
    const { id } = await runner.create(USER, [A]);
    await waitFor(runner, ({ status }) => status === 'done');
    await expect(runner.retry(USER, id, A)).rejects.toMatchObject({ status: 409 });
  });

  it('hủy lô thì các video còn chờ không được quét', async () => {
    let finish: (value: IdentifyResult) => void = () => undefined;
    const { deps, runner } = setup({
      isCached: vi.fn((videoId: string) => videoId === C),
      scan: vi.fn(() => new Promise<IdentifyResult>((resolveScan) => { finish = resolveScan; })),
    });
    const { id } = await runner.create(USER, [A, B, C]);
    await vi.waitFor(() => expect(deps.scan).toHaveBeenCalled());
    await runner.cancel(USER, id);
    finish(resultFor(A));
    const batch = await waitFor(runner, ({ status }) => status === 'done');
    expect(batch.items.map(({ status }) => status)).toEqual(['done', 'cancelled', 'cancelled']);
  });

  it('người khác không thao tác được trên lô của mình', async () => {
    const { runner } = setup();
    const { id } = await runner.create(USER, [A]);
    await expect(runner.cancel('khac@example.com', id)).rejects.toMatchObject({ status: 404 });
    expect(await runner.current('khac@example.com')).toBeNull();
    await waitFor(runner, ({ status }) => status === 'done');
  });

  const writeSaved = async (items: Batch['items']) => {
    const saved: Batch[] = [{ id: 'cu', user: USER, createdAt: '2026-11-09T00:00:00.000Z', status: 'running', items }];
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(folder, 'out'), { recursive: true });
    await writeFile(filePath, JSON.stringify(saved), 'utf8');
  };
  const item = (videoId: string, status: Batch['items'][number]['status']) => ({
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    status,
    cached: false,
  });

  it('khởi động lại giữa lúc quét thì không tự gửi lại video đang dở, video đó thành lỗi để người dùng quyết', async () => {
    await writeSaved([item(A, 'running'), item(B, 'done')]);
    const { deps, runner } = setup();
    await runner.start();
    const batch = (await runner.current(USER)) as Batch;
    expect(deps.scan).not.toHaveBeenCalled();
    expect(batch.items.map(({ status }) => status)).toEqual(['error', 'done']);
    expect(batch.items[0].error).toContain('Quét lại');
    expect(batch.status).toBe('done');
  });

  it('khởi động lại khi lô còn video chờ thì tạm dừng, chỉ chạy tiếp khi có người bấm', async () => {
    await writeSaved([item(A, 'running'), item(B, 'queued')]);
    const { deps, runner } = setup();
    await runner.start();
    const paused = (await runner.current(USER)) as Batch;
    expect(paused.status).toBe('paused');
    expect(deps.scan).not.toHaveBeenCalled();
    await runner.resume(USER, 'cu');
    const done = await waitFor(runner, ({ status }) => status === 'done');
    expect(deps.scan).toHaveBeenCalledTimes(1);
    expect(done.items.map(({ status }) => status)).toEqual(['error', 'done']);
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as Batch[];
    expect(stored[0].status).toBe('done');
  });
});
