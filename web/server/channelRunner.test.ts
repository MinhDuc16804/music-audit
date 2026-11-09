import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelOptions, ChannelScan, ChannelStatus, ChannelVideo } from '../src/channelScan';
import { ChannelError, createChannelRunner, matchChannelRoute, parseMaxRequests } from './channelRunner';
import type { ChannelRunnerDeps } from './channelRunner';

const USER = 'nv@example.com';
const CHANNEL = { url: 'https://www.youtube.com/@kenh', key: '@kenh' };
const MUSIC_ONLY: ChannelOptions = { filter: true, musicOnly: true, clips: 0, limit: 0 };
const NO_FILTER: ChannelOptions = { filter: false, musicOnly: false, clips: 0, limit: 0 };
const BLOCKED = 'YouTube đang chặn máy này tải video.';

function video(videoId: string, overrides: Partial<ChannelVideo> = {}): ChannelVideo {
  return { videoId, title: `Video ${videoId}`, seconds: 60, group: 'co-nhac', hasAudio: true, scanned: false, requests: 5, clipRequests: 2, ...overrides };
}

const VIDEOS = [video('a'), video('b'), video('c', { group: 'khong-nhac' })];

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'channel-runner-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function setup(overrides: Partial<ChannelRunnerDeps> = {}) {
  const fakes = {
    getFilePath: () => join(folder, 'out', 'channel-scans.json'),
    getWorkdir: (key: string) => join(folder, key),
    runStep: vi.fn((_workdir: string, _args: string[], _onLine: (line: string) => void) => ({ done: Promise.resolve(), stop: vi.fn() })),
    runQueued: vi.fn(async (_workdir: string, _args: string[]) => 'Đã quét 1/1 video.'),
    readJson: vi.fn(async (_workdir: string, _args: string[]): Promise<unknown> => ({ channel: 'Kênh', maxSeconds: 3600, videos: VIDEOS })),
    removeAudio: vi.fn(async () => undefined),
    logUsage: vi.fn(async () => undefined),
    maxRequests: 5000,
  };
  const deps = { ...fakes, ...overrides } as typeof fakes;
  return { deps, runner: createChannelRunner(deps) };
}

type Runner = ReturnType<typeof createChannelRunner>;

async function waitForStatus(runner: Runner, status: ChannelStatus, user = USER) {
  await vi.waitFor(async () => expect((await runner.current(user)).scan?.status).toBe(status));
  return (await runner.current(user)).scan as NonNullable<Awaited<ReturnType<Runner['current']>>['scan']>;
}

async function startedAtGate(runner: Runner, options = MUSIC_ONLY) {
  await runner.create(USER, CHANNEL, false);
  const scan = await waitForStatus(runner, 'ready');
  await runner.start(USER, scan.id, options);
  return waitForStatus(runner, 'awaiting');
}

const stepNames = (deps: ReturnType<typeof setup>['deps']) => deps.runStep.mock.calls.map(([, args]) => args[0]);

describe('matchChannelRoute', () => {
  it('nhận đúng các đường dẫn', () => {
    expect(matchChannelRoute('GET', '/api/channel-scans/current')).toEqual({ action: 'current' });
    expect(matchChannelRoute('GET', '/api/channel-scans/x/report')).toEqual({ action: 'report', scanId: 'x' });
    expect(matchChannelRoute('POST', '/api/channel-scans')).toEqual({ action: 'create' });
    expect(matchChannelRoute('POST', '/api/channel-scans/x/send')).toEqual({ action: 'send', scanId: 'x' });
  });

  it('từ chối đường dẫn và phương thức lạ', () => {
    expect(matchChannelRoute('GET', '/api/channel-scansx')).toBeNull();
    expect(matchChannelRoute('GET', '/api/channel-scans/x/send')).toBeNull();
    expect(matchChannelRoute('POST', '/api/channel-scans/x/khac')).toBeNull();
    expect(matchChannelRoute('DELETE', '/api/channel-scans')).toBeNull();
  });
});

describe('parseMaxRequests', () => {
  it('giá trị trống hoặc sai thì dùng mặc định', () => {
    expect(parseMaxRequests('')).toBe(5000);
    expect(parseMaxRequests('abc')).toBe(5000);
    expect(parseMaxRequests('-1')).toBe(5000);
    expect(parseMaxRequests('200')).toBe(200);
  });
});

describe('createChannelRunner', () => {
  it('lấy danh sách rồi chờ người chọn cách quét', async () => {
    const { deps, runner } = setup();
    await runner.create(USER, CHANNEL, true);
    const scan = await waitForStatus(runner, 'ready');
    expect(deps.runStep.mock.calls[0][1]).toEqual(['list-videos', '--channel', CHANNEL.url, '--skip-shorts']);
    expect(scan.totalVideos).toBe(3);
    expect(scan.videos).toHaveLength(3);
  });

  it('báo lỗi khi kênh không có video', async () => {
    const { runner } = setup({ readJson: vi.fn(async () => ({ channel: '', maxSeconds: 3600, videos: [] })) });
    await expect(runner.create(USER, CHANNEL, false)).rejects.toBeInstanceOf(ChannelError);
    expect((await runner.current(USER)).scan).toBeNull();
  });

  it('dừng hỏi với số chính xác và chưa gửi AudD lần nào', async () => {
    const { deps, runner } = setup();
    const scan = await startedAtGate(runner);
    expect(stepNames(deps)).toEqual(['list-videos', 'download-audio', 'detect-music']);
    expect(scan.gate).toEqual({ videos: 2, requests: 10, withMusic: 2, noMusic: 1, noAudio: 0 });
    expect(deps.runQueued).not.toHaveBeenCalled();
    expect(deps.logUsage).not.toHaveBeenCalled();
  });

  it('không lọc thì bỏ qua bước lọc nhưng vẫn dừng hỏi', async () => {
    const { deps, runner } = setup();
    const scan = await startedAtGate(runner, NO_FILTER);
    expect(stepNames(deps)).toEqual(['list-videos', 'download-audio']);
    expect(scan.gate?.videos).toBe(3);
    expect(deps.runQueued).not.toHaveBeenCalled();
  });

  it('truyền số video giới hạn cho bước tải', async () => {
    const { deps, runner } = setup();
    await startedAtGate(runner, { ...NO_FILTER, limit: 1 });
    expect(deps.runStep.mock.calls[1][1]).toEqual(['download-audio', '--limit', '1']);
  });

  it('gửi từng video, ghi nhật ký người xác nhận và xóa âm thanh khi xong', async () => {
    const { deps, runner } = setup();
    const scan = await startedAtGate(runner);
    await runner.send(USER, scan.id);
    const done = await waitForStatus(runner, 'done');
    expect(deps.runQueued.mock.calls.map(([, args]) => args[3])).toEqual(['a', 'b']);
    expect(deps.runQueued.mock.calls[0][1]).toEqual(['submit', '--all-videos', '--video-id', 'a', '--delay', '0']);
    expect(deps.logUsage).toHaveBeenCalledWith(USER, `${CHANNEL.url} (2 video, 10 yêu cầu)`, 'done');
    expect(deps.removeAudio).toHaveBeenCalledTimes(1);
    expect(done.stoppedEarly).toBe(false);
    expect(done.progress).toEqual({ done: 2, total: 2 });
  });

  it('gửi đoạn ngắn thì truyền số đoạn và tính theo số đoạn', async () => {
    const { deps, runner } = setup();
    const scan = await startedAtGate(runner, { ...MUSIC_ONLY, clips: 8 });
    expect(scan.gate?.requests).toBe(4);
    await runner.send(USER, scan.id);
    await waitForStatus(runner, 'done');
    expect(deps.runQueued.mock.calls[0][1]).toContain('--clips');
  });

  it('vượt trần thì từ chối và không gửi gì', async () => {
    const { deps, runner } = setup({ maxRequests: 9 });
    const scan = await startedAtGate(runner);
    await expect(runner.send(USER, scan.id)).rejects.toThrow('vượt trần 9');
    expect(deps.runQueued).not.toHaveBeenCalled();
  });

  it('không gửi được khi chưa tới bước xác nhận', async () => {
    const { deps, runner } = setup();
    await runner.create(USER, CHANNEL, false);
    const scan = await waitForStatus(runner, 'ready');
    await expect(runner.send(USER, scan.id)).rejects.toBeInstanceOf(ChannelError);
    expect(deps.runQueued).not.toHaveBeenCalled();
  });

  it('một video lỗi không làm dừng các video sau', async () => {
    const runQueued = vi.fn().mockResolvedValueOnce('Lỗi với https://x: hỏng').mockResolvedValue('Xong');
    const { runner } = setup({ runQueued });
    const scan = await startedAtGate(runner);
    await runner.send(USER, scan.id);
    const done = await waitForStatus(runner, 'done');
    expect(runQueued).toHaveBeenCalledTimes(2);
    expect(done.failed).toBe(1);
  });

  it('lỗi tài khoản AudD thì dừng, chạy tiếp gửi lại đúng video đó', async () => {
    const runQueued = vi.fn().mockResolvedValueOnce('Đây là lỗi tài khoản AudD, các video sau cũng sẽ lỗi.').mockResolvedValue('Xong');
    const { runner } = setup({ runQueued });
    const scan = await startedAtGate(runner);
    await runner.send(USER, scan.id);
    const paused = await waitForStatus(runner, 'paused');
    expect(paused.pauseReason).toContain('lỗi tài khoản');
    expect(runQueued).toHaveBeenCalledTimes(1);
    await runner.resume(USER, scan.id);
    await waitForStatus(runner, 'done');
    expect(runQueued.mock.calls.map(([, args]) => args[3])).toEqual(['a', 'a', 'b']);
  });

  it('YouTube chặn thì tạm dừng, chạy tiếp thì tải lại', async () => {
    let attempts = 0;
    const runStep = vi.fn((_workdir: string, args: string[]) => {
      attempts += args[0] === 'download-audio' ? 1 : 0;
      const failed = args[0] === 'download-audio' && attempts === 1;
      return { done: failed ? Promise.reject(new Error(BLOCKED)) : Promise.resolve(), stop: vi.fn() };
    });
    const { runner } = setup({ runStep });
    await runner.create(USER, CHANNEL, false);
    const scan = await waitForStatus(runner, 'ready');
    await runner.start(USER, scan.id, MUSIC_ONLY);
    const paused = await waitForStatus(runner, 'paused');
    expect(paused.pauseReason).toBe(BLOCKED);
    await runner.resume(USER, scan.id);
    await waitForStatus(runner, 'awaiting');
    expect(attempts).toBe(2);
  });

  it('tạm dừng thì ngắt tiến trình đang chạy và không báo lỗi', async () => {
    let reject: (error: Error) => void = () => undefined;
    const stop = vi.fn(() => reject(new Error('bị ngắt')));
    const runStep = vi.fn((_workdir: string, args: string[]) =>
      args[0] === 'download-audio'
        ? { done: new Promise<void>((_resolve, rejectDone) => { reject = rejectDone; }), stop }
        : { done: Promise.resolve(), stop: vi.fn() },
    );
    const { runner } = setup({ runStep });
    await runner.create(USER, CHANNEL, false);
    const scan = await waitForStatus(runner, 'ready');
    await runner.start(USER, scan.id, MUSIC_ONLY);
    await vi.waitFor(() => expect(stepNames({ runStep } as never)).toContain('download-audio'));
    await runner.pause(USER, scan.id);
    expect(stop).toHaveBeenCalledTimes(1);
    const paused = await waitForStatus(runner, 'paused');
    expect(paused.pauseReason).toBeUndefined();
  });

  it('khởi động lại thì không tự chạy tiếp', async () => {
    const first = setup({ runQueued: vi.fn(() => new Promise<string>(() => undefined)) });
    const scan = await startedAtGate(first.runner);
    await first.runner.send(USER, scan.id);
    await waitForStatus(first.runner, 'identifying');
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(first.deps.getFilePath(), 'utf8')) as ChannelScan[];
      expect(saved[0].status).toBe('identifying');
    });

    const second = setup();
    const paused = await waitForStatus(second.runner, 'paused');
    expect(paused.pausedFrom).toBe('identifying');
    expect(second.deps.runQueued).not.toHaveBeenCalled();
  });

  it('dừng ở bước xác nhận thì không tốn lượt và vẫn xem được báo cáo', async () => {
    const { deps, runner } = setup();
    const scan = await startedAtGate(runner);
    await runner.stop(USER, scan.id);
    const done = await waitForStatus(runner, 'done');
    expect(done.stoppedEarly).toBe(true);
    expect(deps.runQueued).not.toHaveBeenCalled();
    await runner.report(USER, scan.id);
    expect(deps.readJson).toHaveBeenLastCalledWith(join(folder, '@kenh'), ['channel-report']);
  });

  it('người khác không thấy và không điều khiển được lần quét', async () => {
    const { runner } = setup();
    const scan = await startedAtGate(runner);
    expect((await runner.current('khac@example.com')).scan).toBeNull();
    await expect(runner.send('khac@example.com', scan.id)).rejects.toMatchObject({ status: 404 });
    await expect(runner.report('khac@example.com', scan.id)).rejects.toMatchObject({ status: 404 });
  });

  it('mỗi người chỉ có một lần quét dở, và máy chủ chỉ chạy một kênh một lúc', async () => {
    const runQueued = vi.fn(() => new Promise<string>(() => undefined));
    const { runner } = setup({ runQueued });
    const scan = await startedAtGate(runner);
    await expect(runner.create(USER, CHANNEL, false)).rejects.toMatchObject({ status: 409 });
    await runner.send(USER, scan.id);
    await waitForStatus(runner, 'identifying');

    await runner.create('khac@example.com', { url: 'https://www.youtube.com/@khac', key: '@khac' }, false);
    const other = await waitForStatus(runner, 'ready', 'khac@example.com');
    await expect(runner.start('khac@example.com', other.id, MUSIC_ONLY)).rejects.toMatchObject({ status: 409 });
  });
});
