import { describe, expect, it } from 'vitest';
import { getRescanCost, savedResultNote } from './rescan.ts';

describe('savedResultNote', () => {
  it('ghi ngày quét theo giờ Việt Nam', () => {
    expect(savedResultNote('2026-11-02T18:30:00+00:00')).toBe('Kết quả đã lưu từ lần quét ngày 03/11/2026.');
  });

  it('không đọc được ngày thì không ghi ngày', () => {
    expect(savedResultNote()).toBe('Kết quả đã lưu từ lần quét trước.');
    expect(savedResultNote('hôm qua')).toBe('Kết quả đã lưu từ lần quét trước.');
  });
});

describe('getRescanCost', () => {
  it('tính theo độ dài video, mỗi 12 giây một yêu cầu', () => {
    expect(getRescanCost({ duration_seconds: 252, max_seconds: 3600 })).toEqual({ requests: 21, isUpperBound: false });
  });

  it('video dài hơn giới hạn thì chỉ tính phần được quét', () => {
    expect(getRescanCost({ duration_seconds: 7200, max_seconds: 600 })).toEqual({ requests: 50, isUpperBound: false });
  });

  it('chưa biết độ dài thì báo mức tối đa', () => {
    expect(getRescanCost({ max_seconds: 600 })).toEqual({ requests: 50, isUpperBound: true });
    expect(getRescanCost({})).toEqual({ requests: 300, isUpperBound: true });
  });
});
