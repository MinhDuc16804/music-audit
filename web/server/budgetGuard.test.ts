import { describe, expect, it } from 'vitest';
import { getMaxScanSeconds } from './budgetGuard.ts';

describe('getMaxScanSeconds', () => {
  it('theo AUDD_MAX_CHUNKS, mỗi đoạn 12 giây', () => {
    expect(getMaxScanSeconds({ AUDD_MAX_CHUNKS: '600' })).toBe(7200);
    expect(getMaxScanSeconds({ AUDD_MAX_CHUNKS: ' 25 ' })).toBe(300);
  });

  it('trống hoặc sai thì dùng mặc định 60 phút, không bao giờ ra 0', () => {
    for (const value of [undefined, '', '0', '-1', 'abc', '1.5']) {
      expect(getMaxScanSeconds({ AUDD_MAX_CHUNKS: value })).toBe(3600);
    }
  });
});
