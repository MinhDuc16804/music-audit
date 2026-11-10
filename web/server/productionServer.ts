/**
 * Server chạy thật, thay cho chế độ xem thử của Vite. Phục vụ thư mục dist và các đường dẫn quét.
 * Không có đăng nhập, nên không được mở trực tiếp ra Internet.
 *
 * Cấu hình qua biến môi trường: HOST, PORT, MUSIC_AUDIT_ROOT (nơi có audit.py), và các biến trong identifyPlugin.ts.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { BATCH_ROUTE } from './batchRunner.ts';
import { CHANNEL_ROUTE } from './channelRunner.ts';
import { createHandlers, FILE_ROUTE, ROUTE } from './identifyPlugin.ts';
import { HISTORY_ROUTE } from './history.ts';
import { QUOTA_ROUTE } from './quota.ts';
import { JOB_ROUTE } from './scanJobs.ts';
import { getContentType, resolveStaticPath } from './staticFiles.ts';

const APP_ROOT = resolve(import.meta.dirname, '..');
const DIST_ROOT = join(APP_ROOT, 'dist');
const AUDIT_ROOT = process.env.MUSIC_AUDIT_ROOT ?? resolve(APP_ROOT, '..');
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8080);
const HEALTH_ROUTE = '/api/health';
// Tải lên file lớn qua mạng chậm có thể mất nhiều phút.
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

const { handleLink, handleFile, handleJob, handleBatch, handleChannel, handleQuota, handleHistory, startBatches } = createHandlers(() => AUDIT_ROOT);

async function sendStaticFile(request: IncomingMessage, response: ServerResponse, pathname: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  const path = resolveStaticPath(DIST_ROOT, pathname);
  const file = path ? await stat(path).catch(() => null) : null;
  if (!file?.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': getContentType(path),
    'Content-Length': file.size,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(path).on('error', () => response.destroy()).pipe(response);
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === HEALTH_ROUTE) {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"status":"ok"}');
  } else if (pathname === FILE_ROUTE) {
    void handleFile(request, response);
  } else if (pathname === ROUTE) {
    void handleLink(request, response);
  } else if (pathname.startsWith(`${JOB_ROUTE}/`)) {
    void handleJob(request, response);
  } else if (pathname === BATCH_ROUTE || pathname.startsWith(`${BATCH_ROUTE}/`)) {
    void handleBatch(request, response);
  } else if (pathname === CHANNEL_ROUTE || pathname.startsWith(`${CHANNEL_ROUTE}/`)) {
    void handleChannel(request, response);
  } else if (pathname === QUOTA_ROUTE) {
    void handleQuota(request, response);
  } else if (pathname === HISTORY_ROUTE) {
    void handleHistory(request, response);
  } else {
    void sendStaticFile(request, response, pathname);
  }
});

server.requestTimeout = UPLOAD_TIMEOUT_MS;
server.listen(PORT, HOST, () => {
  console.log(`App đang chạy tại http://${HOST}:${PORT}`);
  void startBatches();
});

// Khi chạy trong Docker, server là tiến trình chính nên phải tự xử lý tín hiệu dừng.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0));
}
