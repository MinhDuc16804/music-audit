import { describe, expect, it } from 'vitest';
import { audioLeftText, daysLeft, formatQuotaDate, isQuotaLow, percentUsed } from './quota';
import type { QuotaAccount } from './quota';

const account = (used: number, total = 1000): QuotaAccount => ({ planName: 'G', total, used, remaining: total - used, cycleStart: '', cycleEnd: '' });

describe('percentUsed', () => {
  it('làm tròn phần trăm và không vượt 100', () => {
    expect(percentUsed(account(624))).toBe(62);
    expect(percentUsed(account(1500))).toBe(100);
  });

  it('chưa biết tổng gói thì là 0', () => {
    expect(percentUsed(account(5, 0))).toBe(0);
  });
});

describe('isQuotaLow', () => {
  it('sắp hết từ 90%', () => {
    expect(isQuotaLow(account(899))).toBe(false);
    expect(isQuotaLow(account(900))).toBe(true);
  });

  it('gói nhỏ còn ít yêu cầu thì cũng là sắp hết', () => {
    expect(isQuotaLow(account(266, 300))).toBe(true);
  });

  it('gói lớn dưới 90% thì chưa sắp hết', () => {
    expect(isQuotaLow(account(6240, 10000))).toBe(false);
  });
});

describe('audioLeftText', () => {
  it('dưới một giờ thì tính theo phút', () => {
    expect(audioLeftText(34)).toBe('khoảng 7 phút âm thanh');
  });

  it('từ một giờ thì tính theo giờ', () => {
    expect(audioLeftText(300)).toBe('khoảng 1 giờ âm thanh');
    expect(audioLeftText(3760)).toBe('khoảng 12,5 giờ âm thanh');
  });
});

describe('ngày', () => {
  it('định dạng ngày và bỏ qua giá trị lạ', () => {
    expect(formatQuotaDate('2026-11-30T12:00:00')).toBe('30/11/2026');
    expect(formatQuotaDate('')).toBe('');
    expect(formatQuotaDate('khong-phai-ngay')).toBe('');
  });

  it('đếm số ngày còn lại', () => {
    expect(daysLeft('2026-11-30T00:00:00Z', new Date('2026-11-09T00:00:00Z'))).toBe(21);
    expect(daysLeft('2026-11-01T00:00:00Z', new Date('2026-11-09T00:00:00Z'))).toBe(0);
    expect(daysLeft('', new Date())).toBeNull();
  });
});
