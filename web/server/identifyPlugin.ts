/**
 * Thêm /api/identify vào server của Vite. Trình duyệt không được giữ token AudD, nên server gọi
 * lệnh identify của music-audit, lệnh này tự đọc token trong .env.
 *
 * Cấu hình qua biến môi trường: MUSIC_AUDIT_PYTHON (đường dẫn Python), MUSIC_AUDIT_WORKDIR (nơi lưu out/),
 * MAX_CHANNEL_SCAN_REQUESTS (trần yêu cầu AudD mỗi lần quét cả kênh),
 * AUDD_MONTHLY_BUDGET và các biến gói AudD (trần chi phí mỗi tháng cho cả app, xem monthlyBudget.ts). App không giới hạn theo ngày.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from '../src/uploadLimit.ts';
import { DEFAULT_MAX_SCAN_SECONDS } from '../src/batchScan.ts';
import type { BatchCurrentResponse, BatchEstimateResponse } from '../src/batchScan.ts';
import type { HistoryResponse, HistoryResult } from '../src/history.ts';
import type { QuotaResponse } from '../src/quota.ts';
import type { IdentifyResult } from '../src/videoCheck.ts';
import { getVideoUrl, parseYoutubeVideoId } from '../src/youtubeLink.ts';
import { parseAllowedChannels, parseChannelInput, parseChannelOptions } from '../src/channelScan.ts';
import type { ChannelHistoryResponse } from '../src/channelScan.ts';
import { BATCH_ROUTE, BatchError, createBatchRunner, matchBatchRoute, parseBatchVideoIds } from './batchRunner.ts';
import { CHANNEL_ROUTE, ChannelError, createChannelRunner, matchChannelRoute, parseMaxRequests } from './channelRunner.ts';
import { HISTORY_ROUTE, readHistory } from './history.ts';
import { createAccessGuard, parseAccessConfig } from './accessAuth.ts';
import { createQuotaReader, QUOTA_ROUTE } from './quota.ts';
import type { ScanJobStarted, ScanJobView } from '../src/scanJob.ts';
import { createInFlight } from './inFlight.ts';
import { createScanJobs, JOB_ROUTE, parseJobId } from './scanJobs.ts';
import { createUploadSlots, parseMaxUploads } from './uploadSlots.ts';
import { appendUsage, getUserEmail } from './usageLimit.ts';
import type { UsageEntry } from './usageLimit.ts';
import type { BudgetHold } from './monthlyBudget.ts';
import { requestsForSeconds } from '../src/budget.ts';
import { CHANNEL_ENV, parseAuditOutput, runAudit, runAuddCommand, startAudit } from './auditProcess.ts';
import { BudgetError, createBudgetGuard } from './budgetGuard.ts';
import { isSameOriginJson, isSameOriginUpload, parseUploadName, readBody, saveUpload, sendJson } from './http.ts';

export const ROUTE = '/api/identify';
export const FILE_ROUTE = '/api/identify-file';


/** Quét lại tốn yêu cầu AudD, nên chỉ bật khi yêu cầu ghi rõ rescan là true. */
export function parseLinkRequest(body: string): { videoId: string; rescan: boolean } {
  try {
    const { url, rescan } = JSON.parse(body) as { url?: unknown; rescan?: unknown };
    return { videoId: typeof url === 'string' ? parseYoutubeVideoId(url) : '', rescan: rescan === true };
  } catch {
    return { videoId: '', rescan: false };
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

  const getOutFolder = () => join(process.env.MUSIC_AUDIT_WORKDIR ?? getAuditRoot(), 'out');
  // audit.py lưu kết quả AudD theo mã video, nên có file này nghĩa là quét lại không tốn thêm.
  const isCached = (videoId: string) => existsSync(join(getOutFolder(), 'audd', `${videoId}.json`));
  const { budget, budgetView, reserveBudget, reserveVideo, withBudget } = createBudgetGuard({
    getOutFolder,
    isCached,
    readDurations: (videoId) => runAudit(getAuditRoot(), ['durations', '--', videoId]) as Promise<{ max_seconds?: number; videos?: Record<string, number> }>,
  });


  const logUsage = (user: string, kind: UsageEntry['kind'], target: string, outcome: UsageEntry['outcome'], resultId?: string, rescan = false) =>
    appendUsage(join(getOutFolder(), 'usage.jsonl'), {
      time: new Date().toISOString(),
      user,
      kind,
      target,
      outcome,
      ...(resultId ? { resultId } : {}),
      ...(rescan ? { rescan: true as const } : {}),
    });

  const handleHistory = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Chỉ nhận GET' });
      return;
    }
    const entries = await readHistory({
      readLog: () => readFile(join(getOutFolder(), 'usage.jsonl'), 'utf8').catch(() => ''),
      // "--" để mã bắt đầu bằng "-" không bị Python hiểu nhầm là tùy chọn.
      readResults: async (keys) => (await runAudit(getAuditRoot(), ['history', '--', ...keys])) as Record<string, HistoryResult>,
    });
    sendJson(response, 200, { entries, user: getUserEmail(request.headers) } satisfies HistoryResponse);
  };

  const batchRunner = createBatchRunner({
    getFilePath: () => join(getOutFolder(), 'batches.json'),
    isCached,
    scan: async (url, user) => {
      const hold = await reserveVideo(user, 'batch', parseYoutubeVideoId(url), false);
      return withBudget(hold, () => enqueue(['identify', url, '--extract']) as Promise<IdentifyResult>);
    },
    logResult: (user, target, outcome) => logUsage(user, 'batch', target, outcome),
  });

  const maxChannelRequests = parseMaxRequests(process.env.MAX_CHANNEL_SCAN_REQUESTS);
  // Chỉ quét kênh của công ty: vừa giữ ngân sách, vừa không tải âm thanh của kênh người khác. Để trống ALLOWED_CHANNELS thì không giới hạn.
  const allowedChannels = parseAllowedChannels(process.env.ALLOWED_CHANNELS);
  if (allowedChannels?.invalid.length) {
    console.error(`ALLOWED_CHANNELS có mục không đọc được, đã bỏ qua: ${allowedChannels.invalid.join(', ')}`);
  }
  const channelHolds = new Map<string, BudgetHold>();
  const quotaReader = createQuotaReader({ run: runAuddCommand });

  const handleQuota = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Chỉ nhận GET' });
      return;
    }
    const { originalUrl } = request as IncomingMessage & { originalUrl?: string };
    const { searchParams } = new URL(originalUrl ?? request.url ?? '/', 'http://localhost');
    sendJson(response, 200, {
      ...(await quotaReader.read(searchParams.has('refresh'))),
      maxChannelRequests,
      budget: budgetView(),
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
    logUsage: (user, target, outcome, scanId) => logUsage(user, 'channel', target, outcome, scanId),
    maxRequests: maxChannelRequests,
    reserveRequests: (user, count, scanId) => {
      try {
        const hold = reserveBudget(user, 'channel', count);
        if (hold) {
          channelHolds.set(scanId, hold);
        }
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'Không đủ ngân sách.';
      }
    },
    releaseRequests: (_user, count, scanId) => {
      const hold = channelHolds.get(scanId) ?? null;
      channelHolds.delete(scanId);
      budget?.settle(hold, (hold?.requests ?? 0) - count);
    },
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
    const sendCurrent = async (status = 200) => sendJson(response, status, { ...(await channelRunner.current(user)), budget: budgetView() });
    try {
      if (route.action === 'current') {
        await sendCurrent();
      } else if (route.action === 'requirements') {
        sendJson(response, 200, await startAudit(getAuditRoot(), ['channel-check']).done.then(parseAuditOutput));
      } else if (route.action === 'report') {
        sendJson(response, 200, await channelRunner.report(route.scanId));
      } else if (route.action === 'history') {
        sendJson(response, 200, { scans: await channelRunner.history() } satisfies ChannelHistoryResponse);
      } else if (route.action === 'create') {
        const { channel, skipShorts } = JSON.parse(await readBody(request)) as { channel?: unknown; skipShorts?: unknown };
        const parsed = typeof channel === 'string' ? parseChannelInput(channel) : null;
        if (!parsed) {
          sendJson(response, 400, { error: 'Chỉ nhận link kênh có @handle hoặc mã UC…, không nhận link video hay playlist.' });
          return;
        }
        if (allowedChannels && !allowedChannels.keys.has(parsed.key)) {
          sendJson(response, 403, {
            error: 'Kênh này không nằm trong danh sách kênh của công ty được phép quét. Nhờ người quản trị thêm kênh vào ALLOWED_CHANNELS nếu cần.',
          });
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
    const info = (pending.length ? await runAudit(getAuditRoot(), ['durations', '--', ...pending]).catch(() => null) : null) as
      | { max_seconds?: number; videos?: Record<string, number> }
      | null;
    return {
      maxSeconds: info?.max_seconds ?? DEFAULT_MAX_SCAN_SECONDS,
      videos: videoIds.map((videoId) => ({ videoId, cached: isCached(videoId), seconds: info?.videos?.[videoId] ?? 0 })),
    };
  };

  const getBatchState = async (user: string): Promise<BatchCurrentResponse> => ({
    batch: await batchRunner.current(user),
    budget: budgetView(),
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

  const scanJobs = createScanJobs();
  const linkScans = createInFlight<IdentifyResult>();
  const uploadSlots = createUploadSlots(parseMaxUploads(process.env.MAX_ACTIVE_UPLOADS));

  /** Giữ chỗ ngân sách cho lượt quét lẻ. Không đủ thì báo lỗi 429 và trả về false. */
  const checkBudget = async (response: ServerResponse, user: string, kind: 'link' | 'file', target: string, reserve: () => Promise<BudgetHold | null>) => {
    try {
      return { hold: await reserve() };
    } catch (error) {
      if (!(error instanceof BudgetError)) {
        throw error;
      }
      await logUsage(user, kind, target, 'limited');
      sendJson(response, 429, { error: error.message });
      return false;
    }
  };

  /** Quét một nội dung ở nền rồi ghi nhật ký. */
  const runScan = async (
    user: string,
    kind: 'link' | 'file',
    target: string,
    rescan: boolean,
    hold: BudgetHold | null,
    scan: () => Promise<IdentifyResult>,
  ) => {
    try {
      const result = await withBudget(hold, scan);
      await logUsage(user, kind, target, 'done', kind === 'file' ? result.video_id : undefined, rescan);
      return result;
    } catch (error) {
      await logUsage(user, kind, target, 'error', undefined, rescan);
      throw error;
    }
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
      const { videoId, rescan } = parseLinkRequest(await readBody(request));
      if (!videoId) {
        sendJson(response, 400, { error: 'Chỉ nhận link của một video YouTube, không nhận link kênh hay playlist.' });
        return;
      }
      target = getVideoUrl(videoId);
      // Cùng video đang quét (bấm hai lần, hai tab, hai người) thì dùng chung kết quả, không giữ ngân sách hay gửi AudD lần nữa.
      const running = linkScans.get(videoId);
      if (running) {
        sendJson(response, 202, { jobId: scanJobs.start(user, () => running) } satisfies ScanJobStarted);
        return;
      }
      // Ghi nhận lượt quét ngay, trước mọi lệnh await kể cả bước giữ chỗ ngân sách, để yêu cầu tới sau thấy được.
      const reservation = reserveVideo(user, 'link', videoId, rescan);
      // Server tự tách mp3 rồi gửi file cho AudD, nên không cần AudD đọc được link YouTube.
      const args = ['identify', target, '--extract', ...(rescan ? ['--rescan'] : [])];
      const scan = linkScans.run(videoId, async () =>
        runScan(user, 'link', target, rescan, await reservation, () => enqueue(args) as Promise<IdentifyResult>),
      );
      const reserved = await checkBudget(response, user, 'link', target, () => reservation);
      if (!reserved) {
        return;
      }
      sendJson(response, 202, { jobId: scanJobs.start(user, () => scan) } satisfies ScanJobStarted);
    } catch (error) {
      sendJson(response, 502, { error: error instanceof Error ? error.message : 'Lỗi không xác định' });
    }
  };

  const handleJob = (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Chỉ nhận GET' });
      return;
    }
    const { originalUrl } = request as IncomingMessage & { originalUrl?: string };
    const { pathname } = new URL(originalUrl ?? request.url ?? '/', 'http://localhost');
    const job = scanJobs.get(getUserEmail(request.headers), parseJobId(pathname));
    sendJson(
      response,
      200,
      job ?? ({ status: 'error', error: 'Không còn thấy lần quét này, có thể app vừa khởi động lại. Hãy bấm Kiểm tra lại, nội dung đã quét xong không bị tính phí lần nữa.' } satisfies ScanJobView),
    );
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

    // File quá lớn thì báo ngay theo độ dài khai trong header, trước khi tính lượt và trước khi nhận file.
    if (Number(request.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
      request.resume();
      sendJson(response, 413, { error: UPLOAD_TOO_LARGE_MESSAGE });
      return;
    }

    const user = getUserEmail(request.headers);
    const releaseSlot = uploadSlots.take();
    if (!releaseSlot) {
      request.resume();
      sendJson(response, 429, { error: 'Máy chủ đang nhận và quét nhiều file cùng lúc. Hãy thử lại sau ít phút.' });
      return;
    }
    // Chưa biết độ dài file trước khi nhận, nên giữ chỗ theo trần mỗi lần quét. Quét xong trả lại phần thừa.
    const reserved = await checkBudget(response, user, 'file', fileName, async () => reserveBudget(user, 'file', requestsForSeconds(0, DEFAULT_MAX_SCAN_SECONDS))).catch((error: unknown) => {
      releaseSlot();
      throw error;
    });
    if (!reserved) {
      releaseSlot();
      request.resume();
      return;
    }

    const folder = await mkdtemp(join(tmpdir(), 'credit-checker-')).catch((error: unknown) => {
      // Không tạo được thư mục tạm, ví dụ đĩa đầy: chưa nhận file nên nhả chỗ và hoàn ngân sách.
      releaseSlot();
      budget?.settle(reserved.hold, 0);
      throw error;
    });
    const removeFolder = () => rm(folder, { recursive: true, force: true }).catch(() => undefined).finally(releaseSlot);
    const uploadPath = join(folder, `upload${extname(fileName).toLowerCase()}`);
    try {
      await saveUpload(request, uploadPath);
    } catch (error) {
      // File chưa tới nơi thì chưa gửi gì cho AudD, nên hoàn ngân sách.
      budget?.settle(reserved.hold, 0);
      await removeFolder();
      await logUsage(user, 'file', fileName, 'error');
      sendJson(response, 502, { error: error instanceof Error ? error.message : 'Lỗi không xác định' });
      return;
    }
    const rescan = request.headers['x-rescan'] === '1';
    const args = ['identify-file', uploadPath, `--name=${fileName}`, ...(rescan ? ['--rescan'] : [])];
    const jobId = scanJobs.start(user, () => runScan(user, 'file', fileName, rescan, reserved.hold, () => enqueue(args) as Promise<IdentifyResult>).finally(removeFolder));
    sendJson(response, 202, { jobId } satisfies ScanJobStarted);
  };

  // Bật CF_ACCESS_TEAM_DOMAIN và CF_ACCESS_AUD thì mọi đường dẫn quét đều phải có token Cloudflare Access hợp lệ.
  const allowAccess = createAccessGuard(parseAccessConfig(process.env.CF_ACCESS_TEAM_DOMAIN, process.env.CF_ACCESS_AUD));
  const guard =
    (handler: (request: IncomingMessage, response: ServerResponse) => unknown) =>
    async (request: IncomingMessage, response: ServerResponse) => {
      if (!(await allowAccess(request))) {
        request.resume();
        sendJson(response, 401, { error: 'Chưa đăng nhập qua Cloudflare Access hoặc phiên đã hết hạn. Hãy tải lại trang.' });
        return;
      }
      await handler(request, response);
    };

  return {
    handleLink: guard(handleLink),
    handleFile: guard(handleFile),
    handleJob: guard(handleJob),
    handleBatch: guard(handleBatch),
    handleChannel: guard(handleChannel),
    handleQuota: guard(handleQuota),
    handleHistory: guard(handleHistory),
    startBatches: batchRunner.start,
  };
}

export function identifyPlugin(): Plugin {
  let auditRoot = '';
  const { handleLink, handleFile, handleJob, handleBatch, handleChannel, handleQuota, handleHistory, startBatches } = createHandlers(() => auditRoot);

  return {
    name: 'music-audit-identify',
    configResolved(config) {
      auditRoot = resolve(config.root, '..');
    },
    configureServer(server) {
      server.middlewares.use(FILE_ROUTE, handleFile);
      server.middlewares.use(ROUTE, handleLink);
      server.middlewares.use(JOB_ROUTE, handleJob);
      server.middlewares.use(BATCH_ROUTE, handleBatch);
      server.middlewares.use(CHANNEL_ROUTE, handleChannel);
      server.middlewares.use(QUOTA_ROUTE, handleQuota);
      server.middlewares.use(HISTORY_ROUTE, handleHistory);
      void startBatches();
    },
    configurePreviewServer(server) {
      server.middlewares.use(FILE_ROUTE, handleFile);
      server.middlewares.use(ROUTE, handleLink);
      server.middlewares.use(JOB_ROUTE, handleJob);
      server.middlewares.use(BATCH_ROUTE, handleBatch);
      server.middlewares.use(CHANNEL_ROUTE, handleChannel);
      server.middlewares.use(QUOTA_ROUTE, handleQuota);
      server.middlewares.use(HISTORY_ROUTE, handleHistory);
      void startBatches();
    },
  };
}
