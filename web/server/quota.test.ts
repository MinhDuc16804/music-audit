import { describe, expect, it, vi } from 'vitest';
import { AuddCommandError, createQuotaReader, parsePlanName, parseUsage } from './quota';

const ACCOUNT = JSON.stringify({ plan: { name: 'Gói A' }, status: 'active' });
const USAGE = JSON.stringify({ cycle_start: '2026-11-01', cycle_end: '2026-11-30', used_this_cycle: 6240, allowance: 10000, remaining: 3760 });

describe('parsePlanName', () => {
  it('đọc được các dạng tên gói', () => {
    expect(parsePlanName(ACCOUNT)).toBe('Gói A');
    expect(parsePlanName(JSON.stringify({ plan: 'Gói B' }))).toBe('Gói B');
    expect(parsePlanName(JSON.stringify({ result: { plan: { name: 'Gói C' } } }))).toBe('Gói C');
    expect(parsePlanName('{}')).toBe('');
  });

  it('đọc đúng dạng thật của audd account', () => {
    expect(parsePlanName(JSON.stringify({ schema_version: 1, account: {}, status: { plan: { name: 'Gói D' }, status: 'active' } }))).toBe('Gói D');
    expect(parsePlanName(JSON.stringify({ schema_version: 1, account: {}, status: { plan: null, status: 'lapsed_settled' } }))).toBe('');
  });
});

describe('parseUsage', () => {
  it('đọc đủ số liệu', () => {
    expect(parseUsage(USAGE, 'G')).toEqual({ planName: 'G', total: 10000, used: 6240, remaining: 3760, cycleStart: '2026-11-01', cycleEnd: '2026-11-30' });
  });

  it('mở lớp bọc ngoài', () => {
    expect(parseUsage(JSON.stringify({ result: JSON.parse(USAGE) }), 'G').used).toBe(6240);
  });

  it('thiếu số còn lại thì tính từ tổng gói', () => {
    expect(parseUsage(JSON.stringify({ used_this_cycle: 10, allowance: 30 }), 'G').remaining).toBe(20);
  });

  it('thiếu tổng gói thì cộng từ đã dùng và còn lại', () => {
    expect(parseUsage(JSON.stringify({ used_this_cycle: '10', remaining: '5' }), 'G').total).toBe(15);
  });

  it('dùng vượt gói thì còn lại là 0', () => {
    expect(parseUsage(JSON.stringify({ used_this_cycle: 12, allowance: 10 }), 'G').remaining).toBe(0);
  });

  it('dữ liệu lạ thì báo lỗi, không đoán số', () => {
    expect(() => parseUsage('khong-phai-json', 'G')).toThrow(AuddCommandError);
    expect(() => parseUsage(JSON.stringify({ used_this_cycle: 10 }), 'G')).toThrow(AuddCommandError);
  });
});

function setup(run: (args: string[]) => Promise<string>) {
  let time = 1_000_000;
  const clock = { advance: (ms: number) => (time += ms) };
  return { clock, reader: createQuotaReader({ run, now: () => time }) };
}

const okRun = () => vi.fn(async (args: string[]) => (args[0] === 'account' ? ACCOUNT : USAGE));

describe('createQuotaReader', () => {
  it('ghép tên gói với số liệu', async () => {
    const { reader } = setup(okRun());
    expect(await reader.read(false)).toMatchObject({ status: 'ok', account: { planName: 'Gói A', remaining: 3760 } });
  });

  it('dùng lại kết quả trong một phút', async () => {
    const run = okRun();
    const { reader, clock } = setup(run);
    await reader.read(false);
    clock.advance(59_000);
    await reader.read(false);
    expect(run).toHaveBeenCalledTimes(2);
    clock.advance(2_000);
    await reader.read(false);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('bấm cập nhật thì đọc lại, nhưng không dồn dập', async () => {
    const run = okRun();
    const { reader, clock } = setup(run);
    await reader.read(false);
    clock.advance(5_000);
    await reader.read(true);
    expect(run).toHaveBeenCalledTimes(2);
    clock.advance(6_000);
    await reader.read(true);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('nhiều yêu cầu cùng lúc chỉ chạy một lần', async () => {
    const run = okRun();
    const { reader } = setup(run);
    await Promise.all([reader.read(false), reader.read(false)]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('báo đúng trạng thái khi chưa đăng nhập hoặc chưa có công cụ', async () => {
    expect(await setup(async () => { throw new AuddCommandError('login'); }).reader.read(false)).toMatchObject({ status: 'login' });
    expect(await setup(async () => { throw new AuddCommandError('missing'); }).reader.read(false)).toMatchObject({ status: 'missing' });
  });

  it('lỗi khác không làm hỏng tab và không kèm số liệu', async () => {
    const reading = await setup(async () => { throw new Error('bí mật trong lỗi'); }).reader.read(false);
    expect(reading.status).toBe('error');
    expect(reading.account).toBeUndefined();
    expect(JSON.stringify(reading)).not.toContain('bí mật');
  });
});
