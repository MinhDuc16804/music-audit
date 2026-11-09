/** Tìm file tĩnh cho server chạy thật. Không cho đi ra ngoài thư mục dist. */

import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Trả về đường dẫn file trong root, hoặc chuỗi rỗng nếu đường dẫn hỏng hay đi ra ngoài root. */
export function resolveStaticPath(root: string, pathname: string): string {
  let decoded = '';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return '';
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return '';
  }
  const target = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  return target.startsWith(`${resolve(root)}${sep}`) ? target : '';
}

export function getContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}
