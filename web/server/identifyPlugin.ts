/**
 * Thêm /api/identify vào server của Vite. Trình duyệt không được giữ token AudD, nên server gọi
 * lệnh identify của music-audit, lệnh này tự đọc token trong .env.
 *
 * Cấu hình qua biến môi trường: MUSIC_AUDIT_PYTHON (đường dẫn Python), MUSIC_AUDIT_WORKDIR (nơi lưu out/),
 * MAX_SCANS_PER_USER_PER_DAY (số lượt quét mỗi người mỗi ngày), MAX_CHANNEL_SCAN_REQUESTS (trần yêu cầu AudD mỗi lần quét cả kênh).
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from '../src/uploadLimit.ts';
import { DEFAULT_MAX_SCAN_SECONDS } from '../src/batchScan.ts';
import type { BatchCurrentResponse, BatchEstimateResponse } from '../src/batchScan.ts';
import type { QuotaResponse } from '../src/quota.ts';
import type { IdentifyResult } from '../src/videoCheck.ts';
import { getVideoUrl, parseYoutubeVideoId } from '../src/youtubeLink.ts';
import { parseChannelInput, parseChannelOptions } from '../src/channelScan.ts';
import { BATCH_ROUTE, BatchError, createBatchRunner, matchBatchRoute, parseBatchVideoIds } from './batchRunner.ts';
import { CHANNEL_ROUTE, ChannelError, createChannelRunner, matchChannelRoute, parseMaxRequests } from './channelRunner.ts';
import { AuddCommandError, createQuotaReader, QUOTA_ROUTE } from './quota.ts';
import { appendUsage, createDailyLimiter, getUserEmail, parseDailyLimit } from './usageLimit.ts';
import type { UsageEntry } from './usageLimit.ts';

export const ROUTE = '/api/identify';
export const FILE_ROUTE = '/api/identify-file';
const MAX_BODY_BYTES = 2048;
// AudD trả kết quả ngay trong yêu cầu, file dài có thể mất vài phút.
const PROCESS_TIMEOUT_MS = 15 * 60_000;
const AUDD_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_NAME_LENGTH = 120;
const UPLOAD_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.mp4', '.mov', '.mkv', '.webm']);

function getPythonCommand(): string {
  const installed = join(process.env.LOCALAPPDATA ?? '', 'Python', 'bin', 'python.exe');
  return process.env.MUSIC_AUDIT_PYTHON ?? (existsSync(installed) ? installed : 'python');
}

function isSameOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Chỉ nhận yêu cầu từ chính app, để trang web khác không dùng được lượt quét. */
export function isSameOriginJson(contentType: string | undefined, origin: string | undefined, host: string | undefined) {
  return Boolean(contentType?.startsWith('application/json')) && isSameOrigin(origin, host);
}

export function isSameOriginUpload(contentType: string | undefined, origin: string | undefined, host: string | undefined) {
  return Boolean(contentType?.startsWith('application/octet-stream')) && isSameOrigin(origin, host);
}

/** Lấy tên file an toàn từ header, chỉ giữ tên, bỏ mọi đường dẫn. Trả về chuỗi rỗng nếu không nhận loại file này. */
export function parseUploadName(header: string | undefined): string {
  let name = '';
  try {
    name = decodeURIComponent(header ?? '');
  } catch {
    return '';
  }
  const fileName = basename(name.replace(/\\/g, '/')).slice(-MAX_NAME_LENGTH);
  return UPLOAD_EXTENSIONS.has(extname(fileName).toLowerCase()) ? fileName : '';
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Yêu cầu quá lớn'));
        request.destroy();
      }
    });
    request.on('end', () => resolveBody(body));
    request.on('error', reject);
  });
}

function saveUpload(request: IncomingMessage, targetPath: string): Promise<void> {
  return new Promise((resolveSave, reject) => {
    const target = createWriteStream(targetPath);
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        target.destroy();
        request.destroy();
        reject(new Error(UPLOAD_TOO_LARGE_MESSAGE));
      }
    });
    request.on('error', reject);
    target.on('error', reject);
    target.on('finish', () => resolveSave());
    request.pipe(target);
  });
}

interface AuditRun {
  /** Thư mục data/ và out/ riêng, mặc định theo MUSIC_AUDIT_WORKDIR. */
  workdir?: string;
  /** Tiến trình dài như tải cả kênh thì không đặt giới hạn thời gian. */
  noTimeout?: boolean;
  onLine?: (line: string) => void;
}

/** Quét cả kênh luôn dùng AudD như các màn hình khác, kể cả khi .env có khóa ACRCloud. */
const CHANNEL_ENV = { MUSIC_SERVICE: 'audd' };

function startAudit(auditRoot: string, commandArgs: string[], run: AuditRun = {}, extraEnv: Record<string, string> = {}) {
  const workdir = run.workdir ?? process.env.MUSIC_AUDIT_WORKDIR;
  const args = ['audit.py', ...(workdir ? ['--workdir', workdir] : []), ...commandArgs];
  const child = spawn(getPythonCommand(), args, {
    cwd: auditRoot,
    windowsHide: true,
    timeout: run.noTimeout ? undefined : PROCESS_TIMEOUT_MS,
    env: { ...process.env, PYTHONUTF8: '1', ...extraEnv },
  });

  const done = new Promise<string>((resolveResult, reject) => {
    let output = '';
    let partial = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (run.onLine) {
        const lines = `${partial}${chunk}`.split('\n');
        partial = lines.pop() ?? '';
        lines.forEach(run.onLine);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errorOutput += chunk));
    child.on('error', () => reject(new Error('Không chạy được Python. Hãy kiểm tra Python đã được cài.')));
    child.on('close', (code) => {
      if (code !== 0) {
        const lastLine = errorOutput.trim().split('\n').at(-1) ?? '';
        reject(new Error(lastLine.slice(0, MAX_MESSAGE_LENGTH) || 'Lệnh quét không chạy xong.'));
        return;
      }
      resolveResult(output);
    });
  });
  return { done, stop: () => child.kill() };
}

/** Không đưa nguyên văn lỗi của công cụ ra ngoài, chỉ phân loại để tab báo đúng việc cần làm. */
function runAuddCommand(args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.AUDD_CLI ?? 'audd', args, {
      windowsHide: true,
      timeout: AUDD_TIMEOUT_MS,
      env: { ...process.env, CI: '1', AUDD_NO_UPDATE_CHECK: '1' },
    });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errorOutput += chunk));
    child.on('error', () => reject(new AuddCommandError('missing')));
    child.on('close', (code) => {
      if (code === 0) {
        resolveResult(output);
      } else {
        reject(new AuddCommandError(/log\s?in|sign.?in|unauthenticated/i.test(`${errorOutput}${output}`) ? 'login' : 'error'));
      }
    });
  });
}

function parseAuditOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Không đọc được kết quả của lệnh quét.');
  }
}

function runAudit(auditRoot: string, commandArgs: string[]): Promise<unknown> {
  return startAudit(auditRoot, commandArgs).done.then(parseAuditOutput);
}

function parseRequestedVideoId(body: string): string {
  try {
    const { url } = JSON.parse(body) as { url?: unknown };
    return typeof url === 'string' ? parseYoutubeVideoId(url) : '';
  } catch {
    return '';
  }
}

export function createHandlers(getAuditRoot: () => string) {
  // Lệnh identify đọc rồi ghi lại out/submissions.json, chạy song song có thể làm mất dữ liệu và quét trùng.
  let queue: Promise<unknown> = Promise.resolve();

  const enqueueJob = <T,>(work: () => Promise<T>) => {
    const job = queue.then(work);
    queue = job.catch(() => undefined);
    return job;
  };

  const enqueue = (commandArgs: string[]) => enqueueJob(() => runAudit(getAuditRoot(), commandArgs));

  const allowScan = createDailyLimiter(parseDailyLimit(process.env.MAX_SCANS_PER_USER_PER_DAY));
  const getOutFolder = () => join(process.env.MUSIC_AUDIT_WORKDIR ?? getAuditRoot(), 'out');

  const logUsage = (user: string, kind: UsageEntry['kind'], target: string, outcome: UsageEntry['outcome']) =>
    appendUsage(join(getOutFolder(), 'usage.jsonl'), { time: new Date().toISOString(), user, kind, target, outcome });

  // audit.py lưu kết quả AudD theo mã video, nên có file này nghĩa là quét lại không tốn thêm.
  const isCached = (videoId: string) => existsSync(join(getOutFolder(), 'audd', `${videoId}.json`));

  const batchRunner = createBatchRunner({
    getFilePath: () => join(getOutFolder(), 'batches.json'),
    isCached,
    scan: (url) => enqueue(['identify', url, '--extract']) as Promise<IdentifyResult>,
    reserve: allowScan,
    release: allowScan.release,
    logResult: (user, target, outcome) => logUsage(user, 'batch', target, outcome),
  });

  const maxChannelRequests = parseMaxRequests(process.env.MAX_CHANNEL_SCAN_REQUESTS);
  const quotaReader = createQuotaReader({ run: runAuddCommand });

  const handleQuota = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Chỉ nhận GET' });
      return;
    }
    const { originalUrl } = request as IncomingMessage & { originalUrl?: string };
    const { searchParams } = new URL(originalUrl ?? request.url ?? '/', 'http://localhost');
    const user = getUserEmail(request.headers);
    sendJson(response, 200, {
      ...(await quotaReader.read(searchParams.has('refresh'))),
      remainingScans: allowScan.remaining(user),
      dailyLimit: allowScan.maxPerDay,
      maxChannelRequests,
    } satisfies QuotaResponse);
  };

  const channelRunner = createChannelRunner({
    getFilePath: () => join(getOutFolder(), 'channel-scans.json'),
    getWorkdir: (channelKey) => join(getOutFolder(), 'channels', channelKey),
    runStep: (workdir, args, onLine) => {
      const ready = mkdir(workdir, { recursive: true });
      let stop = () => undefined as unknown;
      const done = ready
        .then(() => {
          const step = startAudit(getAuditRoot(), args, { workdir, noTimeout: true, onLine }, CHANNEL_ENV);
          stop = step.stop;
          return step.done;
        })
        .then(() => undefined);
      return { done, stop: () => stop() };
    },
    runQueued: (workdir, args) => enqueueJob(() => startAudit(getAuditRoot(), args, { workdir }, CHANNEL_ENV).done),
    readJson: (workdir, args) => startAudit(getAuditRoot(), args, { workdir }, CHANNEL_ENV).done.then(parseAuditOutput),
    removeAudio: (workdir) => rm(join(workdir, 'data', 'audio'), { recursive: true, force: true }),
    logUsage: (user, target, outcome) => logUsage(user, 'channel', target, outcome),
    maxRequests: maxChannelRequests,
  });

  const handleChannel = async (request: IncomingMessage, response: ServerResponse) => {
    const { originalUrl } = request as IncomingMessage & { originalUrl?: string };
    const { pathname } = new URL(originalUrl ?? request.url ?? '/', 'http://localhost');
    const route = matchChannelRoute(request.method, pathname);
    if (!route) {
      sendJson(response, 404, { error: 'Không tìm thấy' });
      return;
    }
    if (request.method === 'POST' && !isSameOriginJson(request.headers['content-type'], request.headers.origin, request.headers.host)) {
      sendJson(response, 403, { error: 'Yêu cầu không hợp lệ' });
      return;
    }

    const user = getUserEmail(request.headers);
    const sendCurrent = async (status = 200) => sendJson(response, status, await channelRunner.current(user));
    try {
      if (route.action === 'current') {
        await sendCurrent();
      } else if (route.action === 'requirements') {
        sendJson(response, 200, await startAudit(getAuditRoot(), ['channel-check']).done.then(parseAuditOutput));
      } else if (route.action === 'report') {
        sendJson(response, 200, await channelRunner.report(user, route.scanId));
      } else if (route.action === 'create') {
        const { channel, skipShorts } = JSON.parse(await readBody(request)) as { channel?: unknown; skipShorts?: unknown };
        const parsed = typeof channel === 'string' ? parseChannelInput(channel) : null;
        if (!parsed) {
          sendJson(response, 400, { error: 'Chỉ nhận link kênh có @handle hoặc mã UC…, không nhận link video hay playlist.' });
          return;
        }
        await channelRunner.create(user, parsed, skipShorts === true);
        await sendCurrent(201);
      } else if (route.action === 'start') {
        const options = parseChannelOptions(JSON.parse(await readBody(request)));
        if (!options) {
          sendJson(response, 400, { error: 'Cách quét không hợp lệ.' });
          return;
        }
        await channelRunner.start(user, route.scanId, options);
        await sendCurrent();
      } else {
        await channelRunner[route.action](user, route.scanId);
        await sendCurrent();
      }
    } catch (error) {
      const status = error instanceof ChannelError ? error.status : error instanceof SyntaxError ? 400 : 502;
      sendJson(response, status, { error: error instanceof Error ? error.message : 'Lỗi không xác định' });
    }
  };

  /** Không qua hàng đợi vì chỉ đọc độ dài video, không nên phải chờ các lượt quét đang chạy. */
  const estimateBatch = async (videoIds: string[]): Promise<BatchEstimateResponse> => {
    const pending = videoIds.filter((videoId) => !isCached(videoId));
    const info = (pending.length ? await runAudit(getAuditRoot(), ['durations', ...pending]).catch(() => null) : null) as
      | { max_seconds?: number; videos?: Record<string, number> }
      | null;
    return {
      maxSeconds: info?.max_seconds ?? DEFAULT_MAX_SCAN_SECONDS,
      videos: videoIds.map((videoId) => ({ videoId, cached: isCached(videoId), seconds: info?.videos?.[videoId] ?? 0 })),
    };
  };

  const getBatchState = async (user: string): Promise<BatchCurrentResponse> => ({
    batch: await batchRunner.current(user),
    remainingScans: allowScan.remaining(user),
    dailyLimit: allowScan.maxPerDay,
  });

  const handleBatch = async (request: IncomingMessage, response: ServerResponse) => {
    // Server của Vite cắt tiền tố khỏi request.url nhưng giữ đường dẫn gốc ở originalUrl.
    const { originalUrl } = request as IncomingMessage & { originalUrl?: string };
    const { pathname } = new URL(originalUrl ?? request.url ?? '/', 'http://localhost');
    const route = matchBatchRoute(request.method, pathname);
    if (!route) {
      sendJson(response, 404, { error: 'Không tìm thấy' });
      return;
    }
    if (request.method === 'POST' && !isSameOriginJson(request.headers['content-type'], request.headers.origin, request.headers.host)) {
      sendJson(response, 403, { error: 'Yêu cầu không hợp lệ' });
      return;
    }

    const user = getUserEmail(request.headers);
    try {
      if (route.action === 'current') {
        sendJson(response, 200, await getBatchState(user));
      } else if (route.action === 'create' || route.action === 'estimate') {
        const videoIds = parseBatchVideoIds(await readBody(request));
        if (!videoIds) {
          sendJson(response, 400, { error: 'Danh sách video không hợp lệ.' });
        } else if (route.action === 'estimate') {
          sendJson(response, 200, await estimateBatch(videoIds));
        } else {
          await batchRunner.create(user, videoIds);
          sendJson(response, 202, await getBatchState(user));
        }
      } else {
        if (route.action === 'retry') {
          await batchRunner.retry(user, route.batchId, route.videoId);
        } else if (route.action === 'cancel') {
          await batchRunner.cancel(user, route.batchId);
        } else {
          await batchRunner.resume(user, route.batchId);
        }
        sendJson(response, 200, await getBatchState(user));
      }
    } catch (error) {
      if (error instanceof BatchError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        sendJson(response, 500, { error: error instanceof Error ? error.message : 'Lỗi không xác định' });
      }
    }
  };

  /** Hết lượt thì báo lỗi và trả về false. */
  const checkLimit = async (response: ServerResponse, user: string, kind: UsageEntry['kind'], target: string) => {
    if (allowScan(user)) {
      return true;
    }
    await logUsage(user, kind, target, 'limited');
    sendJson(response, 429, { error: 'Đã hết lượt quét hôm nay. Hãy thử lại vào ngày mai hoặc liên hệ người quản trị.' });
    return false;
  };

  const handleLink = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Chỉ nhận POST' });
      return;
    }
    if (!isSameOriginJson(request.headers['content-type'], request.headers.origin, request.headers.host)) {
      sendJson(response, 403, { error: 'Yêu cầu không hợp lệ' });
      return;
    }

    const user = getUserEmail(request.headers);
    let target = '';
    try {
      const videoId = parseRequestedVideoId(await readBody(request));
      if (!videoId) {
        sendJson(response, 400, { error: 'Chỉ nhận link của một video YouTube, không nhận link kênh hay playlist.' });
        return;
      }
      target = getVideoUrl(videoId);
      if (!(await checkLimit(response, user, 'link', target))) {
        return;
      }
      // Server tự tách mp3 rồi gửi file cho AudD, nên không cần AudD đọc được link YouTube.
      const result = await enqueue(['identify', target, '--extract']);
      await logUsage(user, 'link', target, 'done');
      sendJson(response, 200, result);
    } catch (error) {
      await logUsage(user, 'link', target, 'error');
      sendJson(response, 502, { error: error instanceof Error ? error.message : 'Lỗi không xác định' });
    }
  };

  const handleFile = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Chỉ nhận POST' });
      return;
    }
    if (!isSameOriginUpload(request.headers['content-type'], request.headers.origin, request.headers.host)) {
      sendJson(response, 403, { error: 'Yêu cầu không hợp lệ' });
      return;
    }
    const nameHeader = request.headers['x-file-name'];
    const fileName = parseUploadName(Array.isArray(nameHeader) ? nameHeader[0] : nameHeader);
    if (!fileName) {
      sendJson(response, 400, { error: 'Chỉ nhận file âm thanh hoặc video như mp3, wav, m4a, mp4, mov.' });
      return;
    }

    const user = getUserEmail(request.headers);
    if (!(await checkLimit(response, user, 'file', fileName))) {
      request.resume();
      return;
    }

    const folder = await mkdtemp(join(tmpdir(), 'credit-checker-'));
    try {
      const uploadPath = join(folder, `upload${extname(fileName).toLowerCase()}`);
      await saveUpload(request, uploadPath);
      const result = await enqueue(['identify-file', uploadPath, `--name=${fileName}`]);
      await logUsage(user, 'file', fileName, 'done');
      sendJson(response, 200, result);
    } catch (error) {
      await logUsage(user, 'file', fileName, 'error');
      sendJson(response, 502, { error: error instanceof Error ? error.message : 'Lỗi không xác định' });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  return { handleLink, handleFile, handleBatch, handleChannel, handleQuota, startBatches: batchRunner.start };
}

export function identifyPlugin(): Plugin {
  let auditRoot = '';
  const { handleLink, handleFile, handleBatch, handleChannel, handleQuota, startBatches } = createHandlers(() => auditRoot);

  return {
    name: 'music-audit-identify',
    configResolved(config) {
      auditRoot = resolve(config.root, '..');
    },
    configureServer(server) {
      server.middlewares.use(FILE_ROUTE, handleFile);
      server.middlewares.use(ROUTE, handleLink);
      server.middlewares.use(BATCH_ROUTE, handleBatch);
      server.middlewares.use(CHANNEL_ROUTE, handleChannel);
      server.middlewares.use(QUOTA_ROUTE, handleQuota);
      void startBatches();
    },
    configurePreviewServer(server) {
      server.middlewares.use(FILE_ROUTE, handleFile);
      server.middlewares.use(ROUTE, handleLink);
      server.middlewares.use(BATCH_ROUTE, handleBatch);
      server.middlewares.use(CHANNEL_ROUTE, handleChannel);
      server.middlewares.use(QUOTA_ROUTE, handleQuota);
      void startBatches();
    },
  };
}
