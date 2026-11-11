import { describe, expect, it } from 'vitest';
import { createUploadSlots, DEFAULT_MAX_ACTIVE_UPLOADS, parseMaxUploads } from './uploadSlots.ts';

describe('parseMaxUploads', () => {
  it('đọc số nguyên dương, trống hoặc sai thì dùng mặc định', () => {
    expect(parseMaxUploads('5')).toBe(5);
    for (const value of [undefined, '', '0', '-1', '2.5', 'abc']) {
      expect(parseMaxUploads(value)).toBe(DEFAULT_MAX_ACTIVE_UPLOADS);
    }
  });
});

describe('createUploadSlots', () => {
  it('hết chỗ thì từ chối, nhả chỗ thì nhận tiếp', () => {
    const slots = createUploadSlots(2);
    const first = slots.take();
    const second = slots.take();
    expect(first && second).toBeTruthy();
    expect(slots.take()).toBeNull();
    first?.();
    expect(slots.take()).not.toBeNull();
  });

  it('nhả hai lần cùng một chỗ chỉ tính một lần', () => {
    const slots = createUploadSlots(1);
    const release = slots.take();
    release?.();
    release?.();
    expect(slots.active()).toBe(0);
    slots.take();
    expect(slots.take()).toBeNull();
  });
});
