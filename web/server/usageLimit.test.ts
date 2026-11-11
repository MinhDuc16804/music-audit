import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendUsage, getUserEmail } from './usageLimit.ts';

describe('getUserEmail', () => {
  it('đọc email từ Cloudflare Access và chuẩn hóa', () => {
    expect(getUserEmail({ 'cf-access-authenticated-user-email': ' An@Cong-Ty.vn ' })).toBe('an@cong-ty.vn');
  });

  it('không có header thì là người không rõ', () => {
    expect(getUserEmail({})).toBe('khong-ro');
  });
});

describe('appendUsage', () => {
  const entry = { time: 't', user: 'a', kind: 'file', target: 'bai.mp3', outcome: 'done' } as const;

  it('tạo thư mục và ghi mỗi lượt một dòng', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usage-'));
    const logPath = join(folder, 'out', 'usage.jsonl');
    await appendUsage(logPath, entry);
    await appendUsage(logPath, entry);
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry);
    await rm(folder, { recursive: true, force: true });
  });

  it('lỗi ghi file không làm hỏng lượt quét', async () => {
    await expect(appendUsage(join(tmpdir(), 'usage-\0-sai', 'usage.jsonl'), entry)).resolves.toBeUndefined();
  });
});
