import { describe, expect, it, vi } from 'vitest';
import { createInFlight } from './inFlight.ts';

describe('createInFlight', () => {
  it('ghi nhận việc ngay khi bắt đầu, yêu cầu sau thấy và dùng chung', async () => {
    const inFlight = createInFlight<string>();
    let finish: (value: string) => void = () => undefined;
    const work = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const first = inFlight.run('video-a', work);
    expect(inFlight.get('video-a')).toBe(first);
    finish('ket-qua');
    await expect(inFlight.get('video-a')).resolves.toBe('ket-qua');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('xong thì xóa khóa, lần sau chạy việc mới', async () => {
    const inFlight = createInFlight<number>();
    await inFlight.run('video-a', async () => 1);
    await Promise.resolve();
    expect(inFlight.get('video-a')).toBeUndefined();
  });

  it('lỗi vẫn trả cho người gọi, khóa được xóa, không ai chờ cũng không thành lỗi chưa xử lý', async () => {
    const inFlight = createInFlight<number>();
    const failed = inFlight.run('video-a', async () => {
      throw new Error('hết ngân sách');
    });
    await expect(failed).rejects.toThrow('hết ngân sách');
    await Promise.resolve();
    expect(inFlight.get('video-a')).toBeUndefined();
    inFlight.run('video-b', async () => {
      throw new Error('không ai chờ');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('khóa khác nhau chạy riêng', () => {
    const inFlight = createInFlight<number>();
    const a = inFlight.run('a', () => new Promise(() => undefined));
    const b = inFlight.run('b', () => new Promise(() => undefined));
    expect(a).not.toBe(b);
  });
});
