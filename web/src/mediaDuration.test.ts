import { describe, expect, it } from 'vitest';
import { readMediaDuration } from './mediaDuration';
import type { MediaElementLike } from './mediaDuration';

const file = new File(['am thanh'], 'bai.mp3', { type: 'audio/mpeg' });

function createFakeElement(duration: number): MediaElementLike {
  return { preload: '', src: '', duration, onloadedmetadata: null, onerror: null };
}

describe('readMediaDuration', () => {
  it('trả về độ dài khi đọc được', async () => {
    const element = createFakeElement(95.5);
    const reading = readMediaDuration(file, () => element);
    element.onloadedmetadata?.();
    await expect(reading).resolves.toBe(95.5);
    expect(element.preload).toBe('metadata');
  });

  it('độ dài vô hạn hoặc bằng 0 là chưa biết', async () => {
    for (const duration of [Infinity, Number.NaN, 0]) {
      const element = createFakeElement(duration);
      const reading = readMediaDuration(file, () => element);
      element.onloadedmetadata?.();
      await expect(reading).resolves.toBeUndefined();
    }
  });

  it('định dạng không đọc được là chưa biết', async () => {
    const element = createFakeElement(10);
    const reading = readMediaDuration(file, () => element);
    element.onerror?.();
    await expect(reading).resolves.toBeUndefined();
  });
});
