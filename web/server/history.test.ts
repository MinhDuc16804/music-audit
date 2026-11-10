import { describe, expect, it, vi } from 'vitest';
import { readHistory } from './history';

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const line = (target: string) => JSON.stringify({ time: '2026-11-10T01:00:00Z', user: 'u', kind: 'link', target, outcome: 'done' });
const LOG = [line(`https://youtu.be/${A}`), line(`https://youtu.be/${B}`), line(`https://youtu.be/${A}`)].join('\n');
const result = (title: string) => ({ url: '', video_id: A, status: 'done' as const, note: '', title });

describe('readHistory', () => {
  it('ghép kết quả đã lưu, mỗi mã chỉ đọc một lần', async () => {
    const readResults = vi.fn(async () => ({ [A]: result('Video A') }));
    const entries = await readHistory({ readLog: async () => LOG, readResults });
    expect(readResults).toHaveBeenCalledWith([A, B]);
    expect(entries.map((entry) => entry.result?.title)).toEqual(['Video A', undefined, 'Video A']);
  });

  it('chưa có nhật ký thì không gọi đọc kết quả', async () => {
    const readResults = vi.fn(async () => ({}));
    expect(await readHistory({ readLog: async () => '', readResults })).toEqual([]);
    expect(readResults).not.toHaveBeenCalled();
  });

  it('đọc kết quả lỗi thì vẫn trả về lịch sử', async () => {
    const entries = await readHistory({ readLog: async () => LOG, readResults: async () => Promise.reject(new Error('hỏng')) });
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => !entry.result)).toBe(true);
  });
});
