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
