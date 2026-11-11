import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAuditRoot, loadAuditEnv } from './loadEnv.ts';

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'load-env-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('loadAuditEnv', () => {
  it('nạp biến chưa có, bỏ qua chú thích tiếng Việt và dòng trống', async () => {
    const path = join(folder, '.env');
    await writeFile(path, '# Ngân sách AudD\nAUDD_MONTHLY_BUDGET=200\n\nALLOWED_CHANNELS=@a,@b\nCF_ACCESS_AUD=\n', 'utf8');
    const env: Record<string, string | undefined> = {};
    expect(loadAuditEnv(path, env).sort()).toEqual(['ALLOWED_CHANNELS', 'AUDD_MONTHLY_BUDGET', 'CF_ACCESS_AUD']);
    expect(env).toEqual({ AUDD_MONTHLY_BUDGET: '200', ALLOWED_CHANNELS: '@a,@b', CF_ACCESS_AUD: '' });
  });

  it('không ghi đè biến đã đặt sẵn, như biến của Docker', async () => {
    const path = join(folder, '.env');
    await writeFile(path, 'AUDD_MONTHLY_BUDGET=200\n', 'utf8');
    const env: Record<string, string | undefined> = { AUDD_MONTHLY_BUDGET: '20' };
    expect(loadAuditEnv(path, env)).toEqual([]);
    expect(env.AUDD_MONTHLY_BUDGET).toBe('20');
  });

  it('không có file .env thì không làm gì', () => {
    expect(loadAuditEnv(join(folder, 'khong-co.env'), {})).toEqual([]);
  });
});

describe('getAuditRoot', () => {
  it('ưu tiên MUSIC_AUDIT_ROOT, không có thì là thư mục cha của web', () => {
    expect(getAuditRoot({ MUSIC_AUDIT_ROOT: '/data/app' })).toBe('/data/app');
    expect(getAuditRoot({}).replace(/\\/g, '/')).toMatch(/music-audit\/?$/);
  });
});
