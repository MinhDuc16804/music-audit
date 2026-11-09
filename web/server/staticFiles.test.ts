import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getContentType, resolveStaticPath } from './staticFiles.ts';

const ROOT = resolve('dist');

describe('resolveStaticPath', () => {
  it('trang chủ là index.html', () => {
    expect(resolveStaticPath(ROOT, '/')).toBe(join(ROOT, 'index.html'));
  });

  it('tìm được file trong thư mục con', () => {
    expect(resolveStaticPath(ROOT, '/assets/index.js')).toBe(join(ROOT, 'assets', 'index.js'));
  });

  it('không cho đi ra ngoài thư mục', () => {
    for (const path of ['/../.env', '/%2e%2e/.env', '/assets/../../.env', '/%2e%2e%2f.env']) {
      expect(resolveStaticPath(ROOT, path)).toBe('');
    }
  });

  it('từ chối dấu gạch ngược, ký tự rỗng và đường dẫn hỏng', () => {
    for (const path of ['/..\\.env', '/%5c..%5c.env', '/bai%00.png', '/%E0%A4%A']) {
      expect(resolveStaticPath(ROOT, path)).toBe('');
    }
  });
});

describe('getContentType', () => {
  it('nhận các loại file của app, không phân biệt hoa thường', () => {
    expect(getContentType('index.HTML')).toContain('text/html');
    expect(getContentType('audio-library.json')).toContain('application/json');
  });

  it('loại lạ thì dùng kiểu nhị phân', () => {
    expect(getContentType('file.xyz')).toBe('application/octet-stream');
  });
});
