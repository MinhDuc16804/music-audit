import { describe, expect, it } from 'vitest';
import { createScanJobs, parseJobId } from './scanJobs.ts';
import type { IdentifyResult } from '../src/videoCheck.ts';

const RESULT: IdentifyResult = { url: 'u', video_id: 'v', status: 'done', note: '' };
const settle = () => new Promise((resolveSettle) => setTimeout(resolveSettle, 0));

describe('parseJobId', () => {
  it('lấy mã từ đường dẫn', () => {
    expect(parseJobId('/api/scan-jobs/123e4567-e89b-42d3-a456-426614174000')).toBe('123e4567-e89b-42d3-a456-426614174000');
  });

  it('đường dẫn lạ hoặc mã sai thì trả về chuỗi rỗng', () => {
    for (const path of ['/api/scan-jobs', '/api/scan-jobs/', '/api/scan-jobs/abc', '/api/scan-jobs/../../etc/passwd', '/api/khac/123e4567-e89b-42d3-a456-426614174000']) {
      expect(parseJobId(path)).toBe('');
    }
  });
});

describe('createScanJobs', () => {
  it('trả mã ngay, đang quét thì báo running, xong thì có kết quả', async () => {
    const jobs = createScanJobs();
    let finish: (result: IdentifyResult) => void = () => undefined;
    const id = jobs.start('a', () => new Promise((resolveWork) => (finish = resolveWork)));
    await settle();
    expect(jobs.get('a', id)).toEqual({ status: 'running' });
    finish(RESULT);
    await settle();
    expect(jobs.get('a', id)).toEqual({ status: 'done', result: RESULT });
  });

  it('quét lỗi thì giữ câu báo lỗi', async () => {
    const jobs = createScanJobs();
    const id = jobs.start('a', () => Promise.reject(new Error('YouTube đang chặn')));
    await settle();
    expect(jobs.get('a', id)).toEqual({ status: 'error', error: 'YouTube đang chặn' });
  });

  it('việc quét ném lỗi ngay cũng không làm hỏng server', async () => {
    const jobs = createScanJobs();
    const id = jobs.start('a', () => {
      throw new Error('hỏng');
    });
    await settle();
    expect(jobs.get('a', id)).toEqual({ status: 'error', error: 'hỏng' });
  });

  it('người khác không hỏi được kết quả', async () => {
    const jobs = createScanJobs();
    const id = jobs.start('a', () => Promise.resolve(RESULT));
    await settle();
    expect(jobs.get('b', id)).toBeNull();
    expect(jobs.get('a', 'khong-co')).toBeNull();
  });

  it('xóa kết quả đã quá hạn giữ, không xóa lần đang quét', async () => {
    let now = 0;
    const jobs = createScanJobs(1000, () => now);
    const finished = jobs.start('a', () => Promise.resolve(RESULT));
    const running = jobs.start('a', () => new Promise(() => undefined));
    await settle();
    now = 1001;
    expect(jobs.get('a', finished)).toBeNull();
    expect(jobs.get('a', running)).toEqual({ status: 'running' });
  });
});
