import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROCESS_TIMEOUT_MS } from './auditProcess.ts';

const PACKAGE = join(import.meta.dirname, '..', '..', 'music_audit');

/** Đọc một hằng số dạng TEN = 123 trong file Python. */
function pythonSeconds(file: string, name: string): number {
  const match = readFileSync(join(PACKAGE, file), 'utf8').match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm'));
  if (!match) {
    throw new Error(`Không thấy ${name} trong ${file}`);
  }
  return Number(match[1]);
}

/** Đọc thời gian chờ ghi thẳng trong lệnh gọi YouTube Data API. */
function youtubeSeconds(): number {
  const match = readFileSync(join(PACKAGE, 'youtube.py'), 'utf8').match(/urlopen\([^)]*timeout=(\d+)\)/);
  if (!match) {
    throw new Error('Không thấy thời gian chờ trong youtube.py');
  }
  return Number(match[1]);
}

describe('thời gian chờ của lệnh quét', () => {
  it('Node chờ lâu hơn tổng thời gian chờ bên Python, để không dừng lệnh khi AudD đang xử lý và tính phí', () => {
    const python = youtubeSeconds() + pythonSeconds('extract.py', 'TIMEOUT_SECONDS') + pythonSeconds('audd.py', 'REQUEST_TIMEOUT_SECONDS');
    const marginSeconds = 60;
    expect(PROCESS_TIMEOUT_MS / 1000).toBeGreaterThanOrEqual(python + marginSeconds);
  });
});
