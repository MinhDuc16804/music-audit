/**
 * Thêm /api/identify vào server của Vite. Trình duyệt không được giữ token AudD, nên server gọi
 * lệnh identify của music-audit, lệnh này tự đọc token trong .env.
 *
 * Cấu hình qua biến môi trường: MUSIC_AUDIT_PYTHON (đường dẫn Python), MUSIC_AUDIT_WORKDIR (nơi lưu out/),
 * MAX_SCANS_PER_USER_PER_DAY (số lượt quét mỗi người mỗi ngày).
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from '../src/uploadLimit.ts';
import { getVideoUrl, parseYoutubeVideoId } from '../src/youtubeLink.ts';
import { appendUsage, createDailyLimiter, getUserEmail, parseDailyLimit } from './usageLimit.ts';
import type { UsageEntry } from './usageLimit.ts';

export const ROUTE = '/api/identify';
export const FILE_ROUTE = '/api/identify-file';
const MAX_BODY_BYTES = 2048;
// AudD trả kết quả ngay trong yêu cầu, file dài có thể mất vài phút.
const PROCESS_TIMEOUT_MS = 15 * 60_000;
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

function runAudit(auditRoot: string, commandArgs: string[]): Promise<unknown> {
  const workdir = process.env.MUSIC_AUDIT_WORKDIR;
  const args = ['audit.py', ...(workdir ? ['--workdir', workdir] : []), ...commandArgs];

  return new Promise((resolveResult, reject) => {
    const child = spawn(getPythonCommand(), args, {
      cwd: auditRoot,
      windowsHide: true,
      timeout: PROCESS_TIMEOUT_MS,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errorOutput += chunk));
    child.on('error', () => reject(new Error('Không chạy được Python. Hãy kiểm tra Python đã được cài.')));
    child.on('close', (code) => {
      if (code !== 0) {
        const lastLine = errorOutput.trim().split('\n').at(-1) ?? '';
        reject(new Error(lastLine.slice(0, MAX_MESSAGE_LENGTH) || 'Lệnh identify không chạy xong.'));
        return;
      }
      try {
        resolveResult(JSON.parse(output));
      } catch {
        reject(new Error('Không đọc được kết quả của lệnh identify.'));
      }
    });
  });
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

  const enqueue = (commandArgs: string[] | (() => string[])) => {
    const job = queue.then(() => runAudit(getAuditRoot(), typeof commandArgs === 'function' ? commandArgs() : commandArgs));
    queue = job.catch(() => undefined);
    return job;
  };

  const allowScan = createDailyLimiter(parseDailyLimit(process.env.MAX_SCANS_PER_USER_PER_DAY));

  const logUsage = (user: string, kind: UsageEntry['kind'], target: string, outcome: UsageEntry['outcome']) => {
    const workdir = process.env.MUSIC_AUDIT_WORKDIR ?? getAuditRoot();
    return appendUsage(join(workdir, 'out', 'usage.jsonl'), { time: new Date().toISOString(), user, kind, target, outcome });
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

  return { handleLink, handleFile };
}

export function identifyPlugin(): Plugin {
  let auditRoot = '';
  const { handleLink, handleFile } = createHandlers(() => auditRoot);

  return {
    name: 'music-audit-identify',
    configResolved(config) {
      auditRoot = resolve(config.root, '..', '..');
    },
    configureServer(server) {
      server.middlewares.use(FILE_ROUTE, handleFile);
      server.middlewares.use(ROUTE, handleLink);
    },
    configurePreviewServer(server) {
      server.middlewares.use(FILE_ROUTE, handleFile);
      server.middlewares.use(ROUTE, handleLink);
    },
  };
}
