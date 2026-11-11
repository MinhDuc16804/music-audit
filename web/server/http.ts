/** Phần HTTP dùng chung của các đường dẫn quét: kiểm nguồn yêu cầu, đọc thân yêu cầu, nhận file tải lên, trả JSON. */

import { createWriteStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from '../src/uploadLimit.ts';

const MAX_BODY_BYTES = 2048;
const MAX_NAME_LENGTH = 120;
const UPLOAD_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.mp4', '.mov', '.mkv', '.webm']);

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

export function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

export function readBody(request: IncomingMessage): Promise<string> {
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

export function saveUpload(request: IncomingMessage, targetPath: string): Promise<void> {
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

/** Tên máy luôn được nhận: chính máy đang chạy app. */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];

/** Danh sách tên máy được phép: máy này cộng các tên miền trong APP_HOSTNAMES (cách nhau bằng dấu phẩy), như tên miền đi qua Cloudflare Tunnel. */
export function parseAllowedHosts(value: string | undefined): Set<string> {
  const extra = (value ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
    .filter(Boolean);
  return new Set([...LOCAL_HOSTNAMES, ...extra]);
}

/** Tên máy trong header Host, bỏ cổng. "[::1]:8080" thành "::1". */
export function getHostname(host: string | undefined): string {
  const value = (host ?? '').trim().toLowerCase();
  if (value.startsWith('[')) {
    return value.slice(1, value.indexOf(']') > 0 ? value.indexOf(']') : undefined);
  }
  return value.replace(/:\d+$/, '');
}

/**
 * Chống DNS rebinding: trang độc có thể trỏ tên miền của nó về 127.0.0.1 rồi gọi API, khi đó Origin và Host cùng là tên miền độc
 * nên kiểm cùng nguồn không chặn được. Chỉ trả lời khi Host là tên máy được phép.
 */
export function isAllowedHost(host: string | undefined, allowed: Set<string>): boolean {
  const name = getHostname(host);
  return name !== '' && allowed.has(name);
}

type Handler = (request: IncomingMessage, response: ServerResponse) => unknown;

/** Bọc mọi đường dẫn quét: kiểm tên máy, kiểm Cloudflare Access, và bắt mọi lỗi để server không sập. */
export function createGuard(allowedHosts: Set<string>, allowAccess: (request: IncomingMessage) => Promise<boolean>) {
  return (handler: Handler) =>
    async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (!isAllowedHost(request.headers.host, allowedHosts)) {
        request.resume();
        sendJson(response, 403, { error: 'Tên miền này chưa được phép dùng app. Người quản trị cần thêm nó vào APP_HOSTNAMES trong .env.' });
        return;
      }
      if (!(await allowAccess(request))) {
        request.resume();
        sendJson(response, 401, { error: 'Chưa đăng nhập qua Cloudflare Access hoặc phiên đã hết hạn. Hãy tải lại trang.' });
        return;
      }
      try {
        await handler(request, response);
      } catch (error) {
        // Lỗi bất ngờ, ví dụ đĩa đầy không tạo được thư mục tạm: trả lỗi cho yêu cầu này thay vì để Node thoát và mất mọi lượt đang quét.
        console.error(`Lỗi khi xử lý ${request.method} ${request.url}: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) {
          sendJson(response, 500, { error: 'Máy chủ gặp lỗi khi xử lý yêu cầu. Hãy thử lại sau, nếu vẫn lỗi thì báo người quản trị.' });
        } else {
          response.end();
        }
      }
    };
}

